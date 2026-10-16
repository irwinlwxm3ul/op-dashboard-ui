// Player state construction, per-player runtime data (never networked) and the input queue.
//
// Every input a client sends is applied exactly once, in order (client prediction replays the very
// same inputs). A tick with an empty queue does not invent input: the player is paused and earns
// one catch-up credit; once a backlog has built up the player tick consumes two inputs per tick
// (paid with credit) until the queue is shallow again — see playerTick.ts.

import { MAX_HEALTH } from '../constants';
import { emptyInventory } from '../items';
import { createMoveEvents, createMoveIntent } from '../physics';
import type { MoveEvents, MoveIntent } from '../physics';
import type { VehicleControls } from '../vehicles';
import type { ClientAction, EntityId, PlayerInput, PlayerState, TeamId, Vec3 } from '../types';
import { BTN } from '../types';
import {
  FLAG_HS_WINDOW, FLAG_SNAP_COUNT, FLAG_SNAP_WINDOW, GIVE_BURST, INPUT_CREDIT_MAX, INPUT_QUEUE_CAPACITY,
} from './tuning';

/** Buttons that act on their press only (kept when an input's movement part has to be merged away). */
export const EDGE_BUTTONS = BTN.JUMP | BTN.RELOAD;
/** Max discrete actions carried by one queued input (merged extras beyond are dropped). */
const MAX_ACTIONS = 8;
/** View-lag baseline: buckets of LAG_BUCKET_TICKS ticks (6 x 0.5 s = 3 s window). */
export const LAG_BUCKETS = 6;
export const LAG_BUCKET_TICKS = 15;
const PITCH_LIM = (89 * Math.PI) / 180;

/** Server-side bookkeeping for one player (not part of the networked PlayerState). */
export interface PlayerRt {
  p: PlayerState;
  /** Ring buffer of queued inputs (objects are reused). */
  queue: PlayerInput[];
  /** Sim time each queue slot's input arrived (parallel to `queue`). */
  arrivedAt: Float64Array;
  qStart: number;
  qLen: number;
  /** Input being / last processed (aim and stance survive pauses). */
  last: PlayerInput;
  /** Arrival sim time of `last` (server-measured queue wait for lag compensation). */
  curArrived: number;
  /** Consecutive ticks without a queued input. */
  starved: number;
  /** Banked catch-up credit (inputs known to have been delayed in flight, plus clock drift). */
  credit: number;
  /** Ticks starved in the current stretch whose inputs have not shown up yet. */
  owed: number;
  /** First input after a starved stretch has arrived (later ones in the burst earn credit). */
  burstSeen: boolean;
  /** Consecutive ticks the queue was deeper than CATCHUP_DEPTH. */
  deepTicks: number;
  /** Transport-measured round trip time (ms) or -1 when unknown. */
  rttMs: number;
  /** Per-bucket minimum view lag (raw rewind minus queue wait, ms) over the last 3 s. */
  lagBuckets: Float64Array;
  lagBucketIdx: number;
  lagBucketTicks: number;
  /** Aim heuristics: base-aim change of the most recent inputs (rad), previous aim. */
  aimDeltas: Float64Array;
  aimIdx: number;
  hasPrevAim: boolean;
  prevYaw: number;
  prevPitch: number;
  /** Rolling window of player hits (1 = head). */
  hsRing: Uint8Array;
  hsIdx: number;
  hsCount: number;
  /** Sim times of the most recent snap-hits. */
  snapTimes: Float64Array;
  snapIdx: number;
  /** Sim time of the last flag per kind. */
  lastSnapFlag: number;
  lastHsFlag: number;
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
  /** Training `give` token bucket. */
  giveTokens: number;
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
  for (let i = 0; i < INPUT_QUEUE_CAPACITY; i++) queue.push(neutralInput());
  const last = neutralInput();
  last.yaw = p.yaw;
  return {
    p,
    queue,
    arrivedAt: new Float64Array(INPUT_QUEUE_CAPACITY),
    qStart: 0,
    qLen: 0,
    last,
    curArrived: 0,
    starved: 0,
    credit: 0,
    owed: 0,
    burstSeen: false,
    deepTicks: 0,
    rttMs: -1,
    lagBuckets: new Float64Array(LAG_BUCKETS).fill(Infinity),
    lagBucketIdx: 0,
    lagBucketTicks: 0,
    aimDeltas: new Float64Array(FLAG_SNAP_WINDOW),
    aimIdx: 0,
    hasPrevAim: false,
    prevYaw: 0,
    prevPitch: 0,
    hsRing: new Uint8Array(FLAG_HS_WINDOW),
    hsIdx: 0,
    hsCount: 0,
    snapTimes: new Float64Array(FLAG_SNAP_COUNT).fill(-Infinity),
    snapIdx: 0,
    lastSnapFlag: -Infinity,
    lastHsFlag: -Infinity,
    lastQueuedSeq: -1,
    intent: createMoveIntent(p.yaw),
    moveEv: createMoveEvents(),
    releaseTime: 1e9,
    lastShotTime: -1e9,
    sprinting: false,
    stepNoiseTimer: 0,
    runOverCooldown: 0,
    respawnTimer: 0,
    giveTokens: GIVE_BURST,
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
  if (src.actions) for (let i = 0; i < src.actions.length && i < MAX_ACTIONS; i++) acts.push(src.actions[i] as ClientAction);
}

/** Fold the discrete parts of `src` (actions, edge buttons) into `dst` (whose movement wins). */
export function mergeExtras(dst: PlayerInput, src: PlayerInput): void {
  dst.buttons |= (src.buttons | 0) & EDGE_BUTTONS;
  const acts = dst.actions!;
  if (src.actions) for (let i = 0; i < src.actions.length && acts.length < MAX_ACTIONS; i++) acts.push(src.actions[i]);
}

function validInput(input: PlayerInput): boolean {
  return !!input && finite(input.seq) && finite(input.mx) && finite(input.mz) && finite(input.yaw)
    && finite(input.pitch) && finite(input.rt) && finite(input.buttons);
}

/**
 * Queue an input arriving at sim time `now` (defensive validation: non-finite values rejected,
 * axes / pitch clamped, old or duplicate seq dropped). The ring holds INPUT_QUEUE_CAPACITY inputs;
 * on overflow (only reachable by a client flooding past its token bucket, or a stall of more than
 * a second) the oldest input's movement is discarded but its actions and edge buttons are merged
 * into the next one, so no discrete action is ever lost.
 */
export function pushInput(rt: PlayerRt, input: PlayerInput, now: number): boolean {
  if (!validInput(input)) return false;
  if (input.seq <= rt.lastQueuedSeq) return false;
  rt.lastQueuedSeq = input.seq;
  const cap = rt.queue.length;
  if (rt.qLen === cap) {
    const oldest = rt.queue[rt.qStart];
    rt.qStart = (rt.qStart + 1) % cap;
    rt.qLen--;
    mergeExtras(rt.queue[rt.qStart], oldest);
    oldest.actions!.length = 0;
  }
  const idx = (rt.qStart + rt.qLen) % cap;
  copyInput(rt.queue[idx], input);
  rt.arrivedAt[idx] = now;
  rt.qLen++;
  noteArrival(rt);
  return true;
}

/**
 * Credit for delayed inputs: while a starved stretch is open, every input after the first one
 * arriving in the resumption burst stands for a tick the player was paused (its input was in
 * flight), up to the number of starved ticks. A client that simply stopped sending resumes at one
 * input per tick and earns nothing, so idling never buys a later speed burst.
 */
function noteArrival(rt: PlayerRt): void {
  if (rt.owed <= 0) return;
  if (!rt.burstSeen) {
    rt.burstSeen = true;
    return;
  }
  rt.owed--;
  if (rt.credit < INPUT_CREDIT_MAX) rt.credit = Math.min(INPUT_CREDIT_MAX, rt.credit + 1);
}

/**
 * Merge only the discrete parts (actions, edge buttons) of an input into the newest queued one —
 * used when a client exceeds its input rate: the movement is dropped, the intent is kept. When
 * nothing is queued the input is queued normally.
 */
export function mergeInput(rt: PlayerRt, input: PlayerInput, now: number): boolean {
  if (!validInput(input)) return false;
  if (input.seq <= rt.lastQueuedSeq) return false;
  if (rt.qLen === 0) return pushInput(rt, input, now);
  rt.lastQueuedSeq = input.seq;
  mergeExtras(rt.queue[(rt.qStart + rt.qLen - 1) % rt.queue.length], input);
  return true;
}

/** Consume the next queued input into rt.last. Returns false when the queue is empty. */
export function popInput(rt: PlayerRt): boolean {
  if (rt.qLen === 0) return false;
  const idx = rt.qStart;
  const src = rt.queue[idx];
  rt.qStart = (rt.qStart + 1) % rt.queue.length;
  rt.qLen--;
  copyInput(rt.last, src);
  rt.curArrived = rt.arrivedAt[idx];
  src.actions!.length = 0;
  return true;
}

/** Turn rt.last into a neutral input (no movement, no buttons, no actions; aim and stance kept). */
export function neutralize(rt: PlayerRt): void {
  const l = rt.last;
  l.mx = 0;
  l.mz = 0;
  l.buttons = 0;
  l.actions!.length = 0;
}

/** Clear queued input and pacing state (control handover to a bot). */
export function resetInput(rt: PlayerRt): void {
  rt.qLen = 0;
  rt.qStart = 0;
  rt.lastQueuedSeq = -1;
  rt.starved = 0;
  rt.credit = 0;
  rt.owed = 0;
  rt.burstSeen = false;
  rt.deepTicks = 0;
  rt.rttMs = -1;
  rt.lagBuckets.fill(Infinity);
  const yaw = rt.p.yaw, pitch = rt.p.pitch, slot = rt.p.activeSlot;
  const l = rt.last;
  l.mx = 0; l.mz = 0; l.buttons = 0; l.actions!.length = 0;
  l.yaw = yaw; l.pitch = pitch; l.slot = slot;
  l.stance = rt.p.stance === 'crouch' ? 1 : rt.p.stance === 'prone' ? 2 : 0;
}
