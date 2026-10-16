// One simulation tick of one player.
//
// Input pacing: every queued input is applied exactly once, in order (client prediction replays
// the same inputs, so nothing may be invented or skipped). A tick with an empty queue pauses the
// player (no input-driven step) and banks one catch-up credit; after INPUT_PAUSE_MAX_TICKS the
// client counts as absent and the body is stepped with a neutral input so it still falls / lands.
// When a backlog persists (depth > CATCHUP_DEPTH for CATCHUP_DELAY_TICKS) two inputs are applied
// per tick, paid with credit, until the queue is shallow: latency never ratchets up after a stall,
// and because credit only comes from ticks the player did not move, catching up never yields
// more movement than real time allows.
//
// Per input: aim, actions, movement (plane / drop / ground / vehicle seat), weapons, healing and
// revive progress. Per tick: boost and bleeding. After the match ended only the aim updates.

import {
  AUTO_CHUTE_HEIGHT, DOWNED_BLEED_PER_SEC, FALL_DAMAGE_PER_MS, FALL_DAMAGE_SPEED, REVIVE_RANGE, REVIVE_TIME,
} from '../constants';
import { CONSUMABLES, boostSpeedMul, tickBoost } from '../items';
import { eyePosition, lineOfSight, stepCharacter, stepDrop } from '../physics';
import type { MoveEvents } from '../physics';
import type { PlayerState } from '../types';
import { BTN, STANCE_FROM_CODE } from '../types';
import { completeUse, handleAction, handleDeadAction, openChute, reviveLineOfSight } from './actions';
import { cancelRevive, damageInfo, damagePlayer, killPlayer } from './combat';
import type { GameSim } from './GameSim';
import { planePosition } from './plane';
import type { PlayerRt } from './players';
import { LAG_BUCKETS, LAG_BUCKET_TICKS, neutralize, popInput } from './players';
import {
  ADS_MOVE_MUL, CATCHUP_DELAY_TICKS, CATCHUP_DEPTH, EVENT_RANGE, INPUT_CREDIT_DECAY, INPUT_CREDIT_MAX,
  INPUT_DRIFT_CREDIT, INPUT_PAUSE_MAX_TICKS, MOVE_DEADZONE, NOISE_FOOTSTEP_INTERVAL, NOISE_FOOTSTEP_RADIUS,
  PITCH_LIMIT, REVIVE_HEALTH, REVIVE_KEEP_SLACK, SPRINT_MIN_FORWARD,
} from './tuning';
import { activeDef, cancelUse, updateWeapons } from './weapons';

const fallInfo = damageInfo(null, 'fall');
const eyeA = { x: 0, y: 0, z: 0 };
const eyeB = { x: 0, y: 0, z: 0 };

/** Life may change inside calls TypeScript cannot see through (damage, actions). */
function isDead(p: PlayerState): boolean {
  return p.life === 'dead';
}

function wrapAngle(a: number): number {
  if (a > Math.PI || a <= -Math.PI) {
    a = (a + Math.PI) % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    a -= Math.PI;
  }
  return a;
}

/** Landing bookkeeping shared by ground and drop movement. */
function onLanded(sim: GameSim, p: PlayerState, ev: MoveEvents, fromDrop: boolean): void {
  const speed = Math.round(ev.landSpeed * 10) / 10;
  sim.emit({ type: 'land', player: p.id, speed }, undefined, p.pos, EVENT_RANGE.movement);
  if (fromDrop) p.stats.spawnTime = sim.time;
  if (ev.landSpeed > FALL_DAMAGE_SPEED && p.life !== 'dead') {
    fallInfo.attacker = null;
    damagePlayer(sim, p, (ev.landSpeed - FALL_DAMAGE_SPEED) * FALL_DAMAGE_PER_MS, fallInfo);
  }
}

/** One tick of one player: input pacing (pause / catch-up), then per-tick effects. */
export function updatePlayer(sim: GameSim, rt: PlayerRt, dt: number): void {
  const p = rt.p;
  if (rt.runOverCooldown > 0) rt.runOverCooldown -= dt;
  if (rt.giveCooldown > 0) rt.giveCooldown -= dt;
  advanceLagBuckets(rt);
  if (sim.phase === 'ended') {
    // Match over: inputs are still consumed (acks) but only the aim follows them.
    rt.hasControls = false;
    if (popInput(rt)) {
      p.lastSeq = rt.last.seq;
      applyAim(p, rt);
    }
    return;
  }
  rt.credit = Math.min(INPUT_CREDIT_MAX, rt.credit + INPUT_DRIFT_CREDIT);
  if (rt.qLen === 0) {
    rt.starved++;
    rt.deepTicks = 0;
    rt.credit = Math.min(INPUT_CREDIT_MAX, rt.credit + 1);
    if (rt.starved <= INPUT_PAUSE_MAX_TICKS) {
      // Paused: the late input will be applied when it arrives. Plane riders still ride along and
      // a driver's vehicle keeps its last controls (rt.hasControls is left as it was).
      if (p.mode === 'plane' && sim.plane) planePosition(sim.plane, p.pos);
    } else {
      // Absent client: step the body with a neutral input (it falls, lands, stops).
      neutralize(rt);
      rt.curArrived = sim.time;
      applyInput(sim, rt, dt, false);
    }
  } else {
    rt.starved = 0;
    popInput(rt);
    applyInput(sim, rt, dt, true);
    if (rt.qLen > CATCHUP_DEPTH) rt.deepTicks++;
    else if (rt.qLen <= 1) rt.deepTicks = 0;
    if (rt.deepTicks >= CATCHUP_DELAY_TICKS && rt.qLen > 1 && rt.credit >= 1) {
      // Catching up: a second full input step this tick.
      rt.credit -= 1;
      popInput(rt);
      applyInput(sim, rt, dt, true);
      if (rt.qLen <= 1) rt.deepTicks = 0;
    } else if (rt.qLen <= 1 && rt.credit > 0) {
      rt.credit = Math.max(0, rt.credit - INPUT_CREDIT_DECAY);
    }
  }
  if (p.life === 'dead') return;
  tickBoost(p, dt);
  // Bleeding out (paused while being revived).
  if (p.life === 'downed' && p.revivedBy === null) {
    p.downedHp -= DOWNED_BLEED_PER_SEC * (1 + 0.5 * (p.knockCount - 1)) * dt;
    if (p.downedHp <= 0) killPlayer(sim, p, p.lastAttacker, 'bleed', rt.knockHeadshot, rt.knockDistance, false);
  }
}

/** Rotate the view-lag baseline buckets once per LAG_BUCKET_TICKS ticks. */
function advanceLagBuckets(rt: PlayerRt): void {
  if (++rt.lagBucketTicks < LAG_BUCKET_TICKS) return;
  rt.lagBucketTicks = 0;
  rt.lagBucketIdx = (rt.lagBucketIdx + 1) % LAG_BUCKETS;
  rt.lagBuckets[rt.lagBucketIdx] = Infinity;
}

/** Base aim (recoil is added on top server side). */
function applyAim(p: PlayerState, rt: PlayerRt): void {
  const input = rt.last;
  p.yaw = wrapAngle(input.yaw);
  p.pitch = input.pitch > PITCH_LIMIT ? PITCH_LIMIT : input.pitch < -PITCH_LIMIT ? -PITCH_LIMIT : input.pitch;
}

/** Sample the client's view lag and aim speed from a real (fresh) input. */
function observeInput(sim: GameSim, rt: PlayerRt): void {
  const input = rt.last;
  const now = sim.time * 1000;
  const wait = Math.max(0, now - rt.curArrived * 1000);
  const lag = Math.max(0, now - input.rt - wait);
  if (lag < rt.lagBuckets[rt.lagBucketIdx]) rt.lagBuckets[rt.lagBucketIdx] = lag;
  // Angle between consecutive base aim directions.
  const y = input.yaw, pt = input.pitch;
  let d = 0;
  if (rt.hasPrevAim) {
    const c = Math.sin(pt) * Math.sin(rt.prevPitch) + Math.cos(pt) * Math.cos(rt.prevPitch) * Math.cos(y - rt.prevYaw);
    d = Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
  }
  rt.prevYaw = y;
  rt.prevPitch = pt;
  rt.hasPrevAim = true;
  rt.aimDeltas[rt.aimIdx] = d;
  rt.aimIdx = (rt.aimIdx + 1) % rt.aimDeltas.length;
}

/** Apply one input step (`fresh` = a real client input, not a neutral stand-in). */
function applyInput(sim: GameSim, rt: PlayerRt, dt: number, fresh: boolean): void {
  const p = rt.p;
  if (fresh) {
    p.lastSeq = rt.last.seq;
    observeInput(sim, rt);
  }
  const input = rt.last;
  const held = input.buttons;
  const pressed = held & ~p.lastButtons;
  const nextLast = held;
  rt.hasControls = false;

  applyAim(p, rt);

  const acts = input.actions!;
  if (p.life === 'dead') {
    for (let i = 0; i < acts.length; i++) handleDeadAction(sim, rt, acts[i]);
    p.lastButtons = nextLast;
    return;
  }

  for (let i = 0; i < acts.length; i++) {
    handleAction(sim, rt, acts[i]);
    if (isDead(p)) break;
  }
  if (isDead(p)) {
    p.lastButtons = nextLast;
    return;
  }

  // Lean only on foot, standing or crouched.
  const leanR = (held & BTN.LEAN_R) !== 0, leanL = (held & BTN.LEAN_L) !== 0;
  p.lean = p.life === 'alive' && p.mode === 'ground' && p.stance !== 'prone' && leanR !== leanL ? (leanR ? 1 : -1) : 0;
  // No leaning through walls: the leaned eye must be visible from the upright eye.
  if (p.lean !== 0) {
    eyePosition(p, 0, p.yaw, eyeA);
    eyePosition(p, p.lean, p.yaw, eyeB);
    if (!lineOfSight(sim.world, eyeA, eyeB)) p.lean = 0;
  }

  const w = activeDef(p);
  rt.sprinting = false;
  switch (p.mode) {
    case 'plane': {
      if (sim.plane) planePosition(sim.plane, p.pos);
      p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
      break;
    }
    case 'freefall':
    case 'parachute': {
      if (p.mode === 'freefall') {
        const g = Math.max(sim.world.groundAt(p.pos.x, p.pos.z, p.pos.y), sim.world.waterLevel);
        if (p.pos.y - g <= AUTO_CHUTE_HEIGHT) openChute(sim, p);
      }
      const it = rt.intent;
      it.mx = input.mx;
      it.mz = input.mz;
      it.yaw = p.yaw;
      it.sprint = false;
      it.walk = false;
      it.jumpPressed = false;
      it.wantStance = 'stand';
      it.speedMul = 1;
      it.downed = false;
      it.dive = input.mz;
      const ev = stepDrop(p, it, dt, sim.world, p.parachuteOpen, rt.moveEv);
      if (ev.landed || (p.mode !== 'freefall' && p.mode !== 'parachute')) {
        p.parachuteOpen = false;
        onLanded(sim, p, ev, true);
      }
      break;
    }
    case 'vehicle': {
      if (p.seat === 0 && p.life === 'alive') {
        const ctl = rt.controls;
        ctl.throttle = input.mz;
        ctl.steer = input.mx; // vehicles: steer > 0 = right, like mx
        ctl.handbrake = (held & (BTN.JUMP | BTN.HANDBRAKE)) !== 0;
        ctl.boost = (held & (BTN.SPRINT | BTN.BOOST)) !== 0;
        rt.hasControls = true;
      }
      break;
    }
    default: {
      // ground / swim
      const downed = p.life === 'downed';
      const firingIntent = (held & BTN.FIRE) !== 0 && w !== null && !downed;
      const wantSprint = (held & BTN.SPRINT) !== 0 && !firingIntent && !downed;
      const wantStance = downed ? 'prone' : STANCE_FROM_CODE[input.stance] ?? 'stand';
      rt.sprinting = wantSprint && p.mode === 'ground' && p.stance === 'stand' && wantStance === 'stand'
        && input.mz > SPRINT_MIN_FORWARD && (held & BTN.WALK) === 0;
      if (p.use && (rt.sprinting || (pressed & BTN.JUMP) !== 0)) cancelUse(p);
      const adsMul = 1 + (ADS_MOVE_MUL - 1) * p.ads;
      const useMul = p.use ? CONSUMABLES[p.use.item].moveMul : 1;
      const it = rt.intent;
      it.mx = input.mx;
      it.mz = input.mz;
      it.yaw = p.yaw;
      it.sprint = wantSprint;
      it.walk = (held & BTN.WALK) !== 0;
      it.jumpPressed = (pressed & BTN.JUMP) !== 0 && !downed;
      it.wantStance = wantStance;
      it.speedMul = (w ? w.moveSpeedMul : 1) * adsMul * useMul * boostSpeedMul(p.boost);
      it.downed = downed;
      it.dive = 0;
      const ev = stepCharacter(p, it, dt, sim.world, rt.moveEv);
      if (ev.jumped) {
        cancelUse(p);
        sim.emit({ type: 'jump', player: p.id }, undefined, p.pos, EVENT_RANGE.movement);
      }
      if (ev.landed) onLanded(sim, p, ev, false);
      if (rt.sprinting) {
        rt.stepNoiseTimer -= dt;
        if (rt.stepNoiseTimer <= 0) {
          rt.stepNoiseTimer = NOISE_FOOTSTEP_INTERVAL;
          sim.addNoise(p.pos, p.id, 'footstep', NOISE_FOOTSTEP_RADIUS);
        }
      }
      break;
    }
  }
  if (isDead(p)) {
    p.lastButtons = nextLast;
    return;
  }

  updateWeapons(sim, rt, input, pressed, dt);

  // Healing / boosting item in progress.
  if (p.use) {
    if (p.life !== 'alive') p.use = null;
    else {
      p.use.elapsed += dt;
      if (p.use.elapsed >= p.use.total) completeUse(sim, p);
    }
  }

  // Revive in progress: hold INTERACT, stand still, do not shoot, stay close.
  if (p.revive) {
    const t = sim.players.get(p.revive.target);
    const still = Math.abs(input.mx) < MOVE_DEADZONE && Math.abs(input.mz) < MOVE_DEADZONE;
    const shooting = (held & BTN.FIRE) !== 0 && w !== null;
    const ok = !!t && t.life === 'downed' && p.life === 'alive' && p.mode === 'ground'
      && (held & BTN.INTERACT) !== 0 && still && !shooting
      && Math.hypot(t.pos.x - p.pos.x, t.pos.y - p.pos.y, t.pos.z - p.pos.z) <= REVIVE_RANGE + REVIVE_KEEP_SLACK
      && reviveLineOfSight(sim, p, t);
    if (!ok) cancelRevive(sim, p);
    else {
      p.revive.elapsed += dt;
      if (p.revive.elapsed >= REVIVE_TIME) {
        const target = t!;
        p.revive = null;
        target.revivedBy = null;
        target.life = 'alive';
        target.health = REVIVE_HEALTH;
        target.downedHp = 0;
        target.stance = 'crouch';
        p.stats.revives++;
        sim.emit({ type: 'revived', reviver: p.id, target: target.id });
      }
    }
  }

  p.lastButtons = nextLast;
}
