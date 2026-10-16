// One simulation tick of one player: consume an input, aim, actions, movement (plane / drop /
// ground / vehicle seat), weapons, healing / revive progress, boost and bleeding.

import {
  AUTO_CHUTE_HEIGHT, DOWNED_BLEED_PER_SEC, FALL_DAMAGE_PER_MS, FALL_DAMAGE_SPEED, REVIVE_RANGE, REVIVE_TIME,
} from '../constants';
import { CONSUMABLES, boostSpeedMul, tickBoost } from '../items';
import { eyePosition, lineOfSight, stepCharacter, stepDrop } from '../physics';
import type { MoveEvents } from '../physics';
import type { PlayerState } from '../types';
import { BTN, STANCE_FROM_CODE } from '../types';
import { completeUse, handleAction, handleDeadAction, openChute } from './actions';
import { cancelRevive, damageInfo, damagePlayer, killPlayer } from './combat';
import type { GameSim } from './GameSim';
import { planePosition } from './plane';
import type { PlayerRt } from './players';
import { popInput } from './players';
import {
  ADS_MOVE_MUL, EVENT_RANGE, MOVE_DEADZONE, NOISE_FOOTSTEP_INTERVAL, NOISE_FOOTSTEP_RADIUS, PITCH_LIMIT,
  REVIVE_HEALTH, REVIVE_KEEP_SLACK, SPRINT_MIN_FORWARD,
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

export function updatePlayer(sim: GameSim, rt: PlayerRt, dt: number): void {
  const p = rt.p;
  if (popInput(rt)) p.lastSeq = rt.last.seq;
  const input = rt.last;
  const held = input.buttons;
  const pressed = held & ~p.lastButtons;
  rt.hasControls = false;
  if (rt.runOverCooldown > 0) rt.runOverCooldown -= dt;
  if (rt.giveCooldown > 0) rt.giveCooldown -= dt;

  // Base aim (recoil is added on top server side).
  p.yaw = wrapAngle(input.yaw);
  p.pitch = input.pitch > PITCH_LIMIT ? PITCH_LIMIT : input.pitch < -PITCH_LIMIT ? -PITCH_LIMIT : input.pitch;

  const acts = input.actions!;
  if (p.life === 'dead') {
    for (let i = 0; i < acts.length; i++) handleDeadAction(sim, rt, acts[i]);
    p.lastButtons = held;
    return;
  }

  for (let i = 0; i < acts.length; i++) {
    handleAction(sim, rt, acts[i]);
    if (isDead(p)) break;
  }
  if (isDead(p)) {
    p.lastButtons = held;
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
    p.lastButtons = held;
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
      && Math.hypot(t.pos.x - p.pos.x, t.pos.y - p.pos.y, t.pos.z - p.pos.z) <= REVIVE_RANGE + REVIVE_KEEP_SLACK;
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

  tickBoost(p, dt);

  // Bleeding out (paused while being revived).
  if (p.life === 'downed' && p.revivedBy === null) {
    p.downedHp -= DOWNED_BLEED_PER_SEC * (1 + 0.5 * (p.knockCount - 1)) * dt;
    if (p.downedHp <= 0) killPlayer(sim, p, p.lastAttacker, 'bleed', rt.knockHeadshot, rt.knockDistance, false);
  }
  p.lastButtons = held;
}
