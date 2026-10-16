// Player state construction, per-player runtime data (never networked) and the bounded input
// queue (one input consumed per tick; missing inputs repeat the last one without edges/actions).

import { MAX_HEALTH, MAX_INPUT_QUEUE } from '../constants';
import { emptyInventory } from '../items';
import { createMoveEvents, createMoveIntent } from '../physics';
import type { MoveEvents, MoveIntent } from '../physics';
import type { VehicleControls } from '../vehicles';
import type { ClientAction, EntityId, PlayerInput, PlayerState, TeamId, Vec3 } from '../types';
import { BTN } from '../types';

/** Buttons that act on their press only; they are cleared when an input is repeated. */
export const EDGE_BUTTONS = BTN.JUMP | BTN.RELOAD;
const PITCH_LIM = (89 * Math.PI) / 180;

/** Server-side bookkeeping for one player (not part of the networked PlayerState). */
export interface PlayerRt {
  p: PlayerState;
  /** Ring buffer of queued inputs (objects are reused). */
  queue: PlayerInput[];
  qStart: number;
  qLen: number;
  /** Last consumed input (repeated when nothing is queued). */
  last: PlayerInput;
  /** Highest seq accepted into the queue (older / duplicate inputs are dropped). */
  lastQueuedSeq: number;
  intent: MoveIntent;
  moveEv: MoveEvents;
  /** Seconds the trigger has been released (spray reset). */
  releaseTime: number;
  /** Sim time of the last shot (PF.FIRING). */
  lastShotTime: number;
  /** Effective sprint state this tick. */
  sprinting: boolean;
  /** Bot hearing: footstep noise timer. */
  stepNoiseTimer: number;
  runOverCooldown: number;
  /** Training: seconds until auto-respawn after death (<= 0 = inactive). */
  respawnTimer: number;
  giveCooldown: number;
  /** Distance / headshot of the knock (credited when the player bleeds out). */
  knockDistance: number;
  knockHeadshot: boolean;
  /** Training spawn slot. */
  spawnIndex: number;
  /** Driver controls produced by the last input (consumed by the vehicle step). */
  controls: VehicleControls;
  hasControls: boolean;
}

export function neutralInput(): PlayerInput {
  return { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: -1, rt: 0, actions: [] };
}

export function createPlayerState(
  id: EntityId, name: string, team: TeamId, isBot: boolean, pos: Vec3, yaw: number,
): PlayerState {
  const inv = emptyInventory();
  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: false,
    airTime: 0,
    jumpBuffer: 0,
    stance: 'stand',
    mode: 'plane',
    fallSpeed: 0,
    id,
    name,
    team,
    isBot,
    connected: !isBot,
    yaw,
    pitch: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    lean: 0,
    life: 'alive',
    health: MAX_HEALTH,
    boost: 0,
    downedHp: 0,
    knockCount: 0,
    armor: { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 },
    weapons: [null, null, null],
    activeSlot: -1,
    ammo: inv.ammo,
    items: inv.items,
    fireCooldown: 0,
    reloadTimer: 0,
    reloadTotal: 0,
    drawTimer: 0,
    ads: 0,
    sprayCount: 0,
    bloom: 0,
    shotCounter: 0,
    use: null,
    revive: null,
    revivedBy: null,
    vehicleId: null,
    seat: -1,
    parachuteOpen: false,
    jumpY: 0,
    lastSeq: 0,
    lastButtons: 0,
    throwCooldown: 0,
    stats: {
      kills: 0, knocks: 0, damage: 0, headshots: 0, revives: 0, longestKill: 0,
      shotsFired: 0, shotsHit: 0, spawnTime: 0, deathTime: 0,
    },
    placement: 0,
    killerId: null,
    spectating: null,
    lastAttacker: null,
    lastAttackerWeapon: null,
  };
}

export function createPlayerRt(p: PlayerState, spawnIndex: number): PlayerRt {
  const queue: PlayerInput[] = [];
  for (let i = 0; i < MAX_INPUT_QUEUE; i++) queue.push(neutralInput());
  const last = neutralInput();
  last.yaw = p.yaw;
  return {
    p,
    queue,
    qStart: 0,
    qLen: 0,
    last,
    lastQueuedSeq: -1,
    intent: createMoveIntent(p.yaw),
    moveEv: createMoveEvents(),
    releaseTime: 1e9,
    lastShotTime: -1e9,
    sprinting: false,
    stepNoiseTimer: 0,
    runOverCooldown: 0,
    respawnTimer: 0,
    giveCooldown: 0,
    knockDistance: 0,
    knockHeadshot: false,
    spawnIndex,
    controls: { throttle: 0, steer: 0, handbrake: false, boost: false },
    hasControls: false,
  };
}

function finite(x: number): boolean {
  return typeof x === 'number' && Number.isFinite(x);
}

function copyInput(dst: PlayerInput, src: PlayerInput): void {
  dst.seq = src.seq;
  let mx = src.mx < -1 ? -1 : src.mx > 1 ? 1 : src.mx;
  let mz = src.mz < -1 ? -1 : src.mz > 1 ? 1 : src.mz;
  const l = Math.sqrt(mx * mx + mz * mz);
  if (l > 1) { mx /= l; mz /= l; }
  dst.mx = mx;
  dst.mz = mz;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch < -PITCH_LIM ? -PITCH_LIM : src.pitch > PITCH_LIM ? PITCH_LIM : src.pitch;
  dst.buttons = src.buttons | 0;
  dst.stance = src.stance === 1 || src.stance === 2 ? src.stance : 0;
  dst.slot = src.slot === 0 || src.slot === 1 || src.slot === 2 ? src.slot : -1;
  dst.rt = src.rt;
  const acts = dst.actions!;
  acts.length = 0;
  if (src.actions) for (let i = 0; i < src.actions.length && i < 8; i++) acts.push(src.actions[i] as ClientAction);
}

/**
 * Queue an input (defensive validation: non-finite values are rejected, axes / pitch clamped,
 * old or duplicate seq dropped, queue bounded with drop-oldest).
 */
export function pushInput(rt: PlayerRt, input: PlayerInput): boolean {
  if (!input || !finite(input.seq) || !finite(input.mx) || !finite(input.mz) || !finite(input.yaw)
    || !finite(input.pitch) || !finite(input.rt) || !finite(input.buttons)) return false;
  if (input.seq <= rt.lastQueuedSeq) return false;
  rt.lastQueuedSeq = input.seq;
  const cap = rt.queue.length;
  if (rt.qLen === cap) {
    // Drop the oldest.
    rt.qStart = (rt.qStart + 1) % cap;
    rt.qLen--;
  }
  const slot = rt.queue[(rt.qStart + rt.qLen) % cap];
  copyInput(slot, input);
  rt.qLen++;
  return true;
}

/**
 * Input to process this tick: the next queued one (copied into rt.last, so it becomes the repeat
 * template) or, when the queue is empty, the last input with actions and edge buttons cleared.
 * Returns whether a fresh input was consumed.
 */
export function popInput(rt: PlayerRt): boolean {
  const last = rt.last;
  if (rt.qLen === 0) {
    last.buttons &= ~EDGE_BUTTONS;
    last.actions!.length = 0;
    return false;
  }
  const src = rt.queue[rt.qStart];
  rt.qStart = (rt.qStart + 1) % rt.queue.length;
  rt.qLen--;
  copyInput(last, src);
  src.actions!.length = 0;
  return true;
}

/** Clear queued input and reset to a neutral repeat template (control handover to a bot). */
export function resetInput(rt: PlayerRt): void {
  rt.qLen = 0;
  rt.qStart = 0;
  rt.lastQueuedSeq = -1;
  const yaw = rt.p.yaw, pitch = rt.p.pitch, slot = rt.p.activeSlot;
  const l = rt.last;
  l.mx = 0; l.mz = 0; l.buttons = 0; l.actions!.length = 0;
  l.yaw = yaw; l.pitch = pitch; l.slot = slot;
  l.stance = rt.p.stance === 'crouch' ? 1 : rt.p.stance === 'prone' ? 2 : 0;
}
