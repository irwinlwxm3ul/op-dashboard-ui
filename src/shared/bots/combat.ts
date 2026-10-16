// Bot combat: aim controller (turn-rate limited, converging aim error, tracking lag, partial
// recoil control), fire discipline by weapon and range, ADS, strafing / crouch-peeking, weapon
// switching by range, reloads, frags at enemies behind cover, cover seeking when hurt and
// finishing downed enemies.

import { GRAVITY } from '../constants';
import { THROWABLES, WEAPONS } from '../items';
import { angleDiff, clamp, wrapAngle } from '../math';
import type { PlayerState, RockDef, TreeDef, WeaponDef, WorldBox } from '../types';
import { BTN } from '../types';
import {
  WEAPON_RANGE, bestSlotForRange, bestSlotOverall, holdOver, rangeSuitability, slotRounds, timeOfFlight, weaponAt,
} from './aim';
import { clearDest, setDest } from './movement';
import { NF_BLOCKED } from './nav';
import { chestHeight, findContact, headHeight } from './perception';
import { MAX_CONTACTS, type BotState, type Contact } from './state';
import type { BotSystem } from './system';

export const CM_HOLD = 0;
export const CM_ADVANCE = 1;
export const CM_RETREAT = 2;
export const CM_PUSH = 3;
export const CM_COVER = 4;

/** Upward bias the simulation adds to throws (sim tuning THROW_UP_BIAS). */
const FRAG_UP_BIAS = 0.17;
const FRAG_MAX_RANGE = 30;
const DEG = Math.PI / 180;

const aimOut = { yaw: 0, pitch: 0, dist: 0 };
const boxScratch: WorldBox[] = [];
const treeScratch: TreeDef[] = [];
const rockScratch: RockDef[] = [];

export function activeWeapon(p: PlayerState): WeaponDef | null {
  const wi = weaponAt(p, p.activeSlot);
  return wi ? WEAPONS[wi.id] : null;
}

/** Turn the view toward (yaw, pitch) with the skill's gain and turn-rate limit. */
export function steerAim(sys: BotSystem, b: BotState, yaw: number, pitch: number, rateMul: number): void {
  const sk = sys.skill, dt = sys.dt;
  const k = Math.min(1, sk.aimGain * dt * (rateMul < 1 ? 0.6 : 1));
  const maxT = sk.turnRate * rateMul * dt;
  let dy = angleDiff(b.aimYaw, yaw) * k;
  if (dy > maxT) dy = maxT;
  else if (dy < -maxT) dy = -maxT;
  b.aimYaw = wrapAngle(b.aimYaw + dy);
  let dp = (pitch - b.aimPitch) * k;
  const maxP = maxT * 0.8;
  if (dp > maxP) dp = maxP;
  else if (dp < -maxP) dp = -maxP;
  b.aimPitch = clamp(b.aimPitch + dp, -1.45, 1.45);
}

/** Aim solution toward a contact (lead + hold-over for ballistic weapons). Writes aimOut. */
function solveAim(sys: BotSystem, b: BotState, c: Contact, q: PlayerState | null, w: WeaponDef | null): void {
  const eye = sys.sim.eyePos(b.id, sys.eye);
  let tx: number, ty: number, tz: number, vx = 0, vz = 0;
  if (c.visible && q) {
    tx = q.pos.x;
    tz = q.pos.z;
    ty = q.pos.y + (b.aimHead && !c.downed ? headHeight(q) - 0.06 : chestHeight(q));
    vx = q.vel.x;
    vz = q.vel.z;
  } else {
    // Pre-aim where the enemy was last seen (briefly extrapolated).
    const lost = Math.min(0.6, sys.now - c.lastSeen);
    tx = c.x + c.vx * lost;
    tz = c.z + c.vz * lost;
    ty = c.y + (c.downed ? 0.3 : 1.15);
  }
  let dx = tx - eye.x, dz = tz - eye.z;
  let horiz = Math.hypot(dx, dz);
  if (w && !w.hitscan && (vx !== 0 || vz !== 0)) {
    const lead = timeOfFlight(w, horiz) * sys.skill.leadAccuracy;
    dx += vx * lead;
    dz += vz * lead;
    horiz = Math.hypot(dx, dz);
  }
  const dy = ty - eye.y;
  aimOut.yaw = Math.atan2(-dx, -dz);
  aimOut.pitch = Math.atan2(dy, horiz) + (w ? holdOver(w, horiz) * (0.55 + 0.45 * sys.skill.leadAccuracy) : 0);
  aimOut.dist = Math.hypot(horiz, dy);
}

/** Aim error dynamics while tracking a visible target. */
function updateAimError(sys: BotSystem, b: BotState, bearing: number, selfMoving: boolean): void {
  const sk = sys.skill, t = sys.now, dt = sys.dt;
  if (t >= b.wobUntil) {
    const amp = sk.aimErrorMin * (selfMoving ? 1.6 : 1);
    b.wobYaw = b.rng.gauss() * amp;
    b.wobPitch = b.rng.gauss() * amp * 0.6;
    b.wobUntil = t + 0.25 + b.rng.next() * 0.35;
  }
  const k = Math.exp(-sk.aimConverge * dt);
  b.errYaw = b.wobYaw + (b.errYaw - b.wobYaw) * k;
  b.errPitch = b.wobPitch + (b.errPitch - b.wobPitch) * k;
  // Tracking lag: the aim trails a target sweeping across the view.
  const sweep = angleDiff(b.prevBearing, bearing);
  if (Math.abs(sweep) < 0.5) b.errYaw -= sweep * sk.trackingLag;
  b.prevBearing = bearing;
}

/** Is any other visible enemy still standing? */
function standingEnemyVisible(b: BotState): boolean {
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const c = b.contacts[i];
    if (c.id >= 0 && c.visible && !c.downed) return true;
  }
  return false;
}

/** Choose the active weapon slot (by range in combat, by quality otherwise). */
export function manageWeapon(sys: BotSystem, b: BotState, p: PlayerState, inCombat: boolean, dist: number): void {
  const t = sys.now;
  const cur = p.activeSlot;
  let want = b.wantSlot;
  if (want >= 0 && !weaponAt(p, want)) want = -1;
  if (inCombat) {
    const best = bestSlotForRange(p, dist);
    if (best >= 0 && best !== cur && t - b.lastSwitch > 2.5) {
      const cw = weaponAt(p, cur);
      const curOk = cw && slotRounds(p, cur) > 0;
      const bw = weaponAt(p, best);
      if (!curOk || (bw && cw && rangeSuitability(bw.id, dist) > rangeSuitability(cw.id, dist) * 1.35)) want = best;
    } else if (want < 0) {
      want = best;
    }
  } else {
    const best = bestSlotOverall(p);
    if (best >= 0 && (want < 0 || slotRounds(p, want) <= 0 || (best !== want && t - b.lastSwitch > 4))) want = best;
  }
  if (want !== b.wantSlot) {
    b.wantSlot = want;
    b.lastSwitch = t;
  }
}

/** Should the bot press reload now? */
export function wantReload(sys: BotSystem, b: BotState, p: PlayerState, quiet: boolean): boolean {
  if (p.reloadTimer > 0 || p.drawTimer > 0 || p.use) return false;
  const wi = weaponAt(p, p.activeSlot);
  if (!wi) return false;
  const w = WEAPONS[wi.id];
  if (wi.mag >= w.magSize) return false;
  const reserve = sys.sim.config.infiniteAmmo ? 1 : p.ammo[w.ammo] || 0;
  if (reserve <= 0) return false;
  if (sys.now - b.reloadPressAt < 0.6) return false;
  return wi.mag === 0 || (quiet && wi.mag < w.magSize * 0.6);
}

/** Find a cover spot that puts an obstacle between the bot and the threat. */
export function findCover(sys: BotSystem, b: BotState, p: PlayerState, tx: number, tz: number): boolean {
  const w = sys.world, g = sys.grid;
  const R = 16;
  const px = p.pos.x, pz = p.pos.z, py = p.pos.y;
  const dThreat = Math.hypot(px - tx, pz - tz);
  let bestS = Infinity, bx = 0, bz = 0;
  const consider = (cx: number, cz: number, ext: number, penalty: number): void => {
    let ux = cx - tx, uz = cz - tz;
    const l = Math.hypot(ux, uz);
    if (l < 1e-3) return;
    ux /= l;
    uz /= l;
    const qx = cx + ux * (ext + 0.85), qz = cz + uz * (ext + 0.85);
    const d = Math.hypot(qx - px, qz - pz);
    if (d > 20) return;
    if (g.flagsAt(qx, qz, false) & NF_BLOCKED) return;
    const toThreat = Math.hypot(qx - tx, qz - tz);
    const s = d + penalty + (toThreat < dThreat * 0.6 ? 25 : 0);
    if (s < bestS) {
      bestS = s;
      bx = qx;
      bz = qz;
    }
  };
  boxScratch.length = 0;
  const boxes = w.queryBoxes(px - R, pz - R, px + R, pz + R, boxScratch);
  for (let i = 0; i < boxes.length; i++) {
    const bb = boxes[i];
    if (!bb.blocksBullets || bb.max.y < py + 1.1 || bb.min.y > py + 0.5) continue;
    const hx = (bb.max.x - bb.min.x) / 2, hz = (bb.max.z - bb.min.z) / 2;
    if (hx + hz < 0.5) continue;
    const cx = bb.min.x + hx, cz = bb.min.z + hz;
    let ux = cx - tx, uz = cz - tz;
    const l = Math.hypot(ux, uz) || 1;
    ux /= l;
    uz /= l;
    consider(cx, cz, Math.abs(ux) * hx + Math.abs(uz) * hz, 0);
  }
  rockScratch.length = 0;
  const rocks = w.queryRocks(px - R, pz - R, px + R, pz + R, rockScratch);
  for (let i = 0; i < rocks.length; i++) {
    const r = rocks[i];
    if (r.r >= 0.7 && r.h >= 1.0) consider(r.x, r.z, r.r, 0);
  }
  treeScratch.length = 0;
  const trees = w.queryTrees(px - R, pz - R, px + R, pz + R, treeScratch);
  for (let i = 0; i < trees.length; i++) {
    const tr = trees[i];
    if (tr.r >= 0.3) consider(tr.x, tr.z, tr.r, 6);
  }
  if (bestS === Infinity) return false;
  b.coverX = bx;
  b.coverZ = bz;
  return true;
}

/** Combat decisions at think rate. */
export function combatThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const c = findContact(b, b.targetId);
  if (!c) return;
  const sk = sys.skill, t = sys.now;
  const d = Math.hypot(c.x - p.pos.x, c.z - p.pos.z);
  manageWeapon(sys, b, p, true, d);
  const w = activeWeapon(p);
  const armed = w !== null && slotRounds(p, p.activeSlot) > 0;
  const ideal = w ? WEAPON_RANGE[w.id].ideal : 5;
  const lostFor = t - c.lastSeen;

  // Cover when hurt.
  if (c.visible && armed && p.health < sk.coverHealth && t - b.coverDecided > 5) {
    b.coverDecided = t;
    if (b.rng.chance(sk.useCover) && findCover(sys, b, p, c.x, c.z)) {
      b.coverValid = true;
      b.coverUntil = t + 7;
    }
  }
  if (b.coverValid && (t > b.coverUntil || Math.hypot(b.coverX - p.pos.x, b.coverZ - p.pos.z) < 0.9)) {
    if (t > b.coverUntil) b.coverValid = false;
  }

  let mode = CM_HOLD;
  if (b.coverValid) mode = CM_COVER;
  else if (!armed) mode = CM_RETREAT;
  else if (c.visible) {
    if (c.downed && !standingEnemyVisible(b) ? d > 10 : d > Math.max(ideal * 2.2, 30)) mode = CM_ADVANCE;
    else if ((w!.id === 'sniper' || w!.id === 'dmr') && d < ideal * 0.3 && bestSlotForRange(p, d) === p.activeSlot) mode = CM_RETREAT;
  } else if (lostFor > 1.2 + (1 - sk.aggression) * 6) {
    mode = CM_PUSH;
  }
  b.combatMode = mode;

  // Frag at an enemy that ducked behind cover.
  if (!c.visible && !c.downed && lostFor > 0.8 && lostFor < 6 && d > 8 && d < FRAG_MAX_RANGE &&
      (p.items.frag || 0) > 0 && p.throwCooldown <= 0 && t > b.fragUntil + 4 && b.rng.chance(sk.fragChance * 2.5)) {
    b.fragUntil = t + 0.7;
    b.fragX = c.x;
    b.fragY = c.y;
    b.fragZ = c.z;
  }

  // Strafe / crouch rhythm.
  if (t >= b.strafeUntil) {
    b.strafeDir = b.rng.chance(sk.strafe) ? (b.rng.chance(0.5) ? 1 : -1) : 0;
    b.strafeUntil = t + 0.4 + b.rng.next() * (1.4 - sk.strafe * 0.6);
  }
  if (mode === CM_HOLD && c.visible && d > 30 && t >= b.crouchUntil && b.rng.chance(sk.strafe * 0.35)) {
    b.crouchUntil = t + 1.2 + b.rng.next() * 2;
  }

  switch (mode) {
    case CM_COVER:
      setDest(sys, b, p, b.coverX, b.coverZ, 0.6, true);
      break;
    case CM_ADVANCE:
      setDest(sys, b, p, c.x, c.z, c.downed ? 2.5 : Math.max(4, ideal * 0.8), false);
      break;
    case CM_PUSH:
      setDest(sys, b, p, c.x, c.z, 3, false);
      b.walk = true;
      break;
    case CM_RETREAT: {
      let ax = p.pos.x - c.x, az = p.pos.z - c.z;
      const l = Math.hypot(ax, az) || 1;
      ax /= l;
      az /= l;
      const fx = p.pos.x + ax * 14, fz = p.pos.z + az * 14;
      if (sys.grid.nearestFree(fx, fz, 4, sys.xz, false)) setDest(sys, b, p, sys.xz.x, sys.xz.z, 1.5, true);
      else setDest(sys, b, p, fx, fz, 1.5, true);
      break;
    }
    default:
      if (b.hasDest) clearDest(sys, b);
  }
}

/** Per-tick combat: aim, fire, ADS, strafe, crouch, frag throw. Returns input buttons. */
export function combatAct(sys: BotSystem, b: BotState, p: PlayerState): number {
  const c = findContact(b, b.targetId);
  if (!c) return 0;
  const t = sys.now, sk = sys.skill;
  const q = sys.sim.players.get(c.id) ?? null;
  const w = activeWeapon(p);
  let buttons = 0;

  // Frag throw sequence: aim the lob, then throw.
  if (t < b.fragUntil && (p.items.frag || 0) > 0) {
    const eye = sys.sim.eyePos(b.id, sys.eye);
    const dx = b.fragX - eye.x, dz = b.fragZ - eye.z;
    const d = Math.min(FRAG_MAX_RANGE, Math.hypot(dx, dz));
    const v = THROWABLES.frag.throwSpeed;
    const theta = 0.5 * Math.asin(Math.min(1, (GRAVITY * d) / (v * v)));
    const yaw = Math.atan2(-dx, -dz), pitch = theta - FRAG_UP_BIAS;
    steerAim(sys, b, yaw, pitch, 1);
    if (Math.abs(angleDiff(b.aimYaw, yaw)) < 0.06 && Math.abs(b.aimPitch - pitch) < 0.06 && b.fragUntil - t < 0.45) {
      b.actions.push({ a: 'throw' });
      b.fragUntil = 0;
    }
    b.triggerHeld = false;
    return 0;
  }

  solveAim(sys, b, c, q, w);
  const bearing = aimOut.yaw, dist = aimOut.dist;
  const moving = b.moveScale > 0.2 || b.strafeDir !== 0;
  if (c.visible) updateAimError(sys, b, bearing, moving);
  const wantYaw = bearing + b.errYaw, wantPitch = aimOut.pitch + b.errPitch;
  steerAim(sys, b, wantYaw, wantPitch, 1);

  // Strafe while shooting (lateral to the target bearing), crouch-peek at range.
  if (c.visible && b.combatMode !== CM_COVER && b.strafeDir !== 0 && t >= b.crouchUntil) {
    const rx = Math.cos(bearing) * b.strafeDir, rz = -Math.sin(bearing) * b.strafeDir;
    let mx = rx, mz = rz;
    if (b.moveScale > 0) {
      mx = b.moveX * 0.75 + rx * 0.65;
      mz = b.moveZ * 0.75 + rz * 0.65;
    }
    const l = Math.hypot(mx, mz) || 1;
    // Do not strafe into walls.
    if (sys.grid.freeAt(p.pos.x + (mx / l) * 1.2, p.pos.z + (mz / l) * 1.2, false)) {
      b.moveX = mx / l;
      b.moveZ = mz / l;
      b.moveScale = Math.max(b.moveScale, 0.85);
    } else {
      b.strafeDir = -b.strafeDir;
    }
  }

  if (!w) {
    b.triggerHeld = false;
    return 0;
  }
  // ADS beyond close range (scoped weapons a bit earlier).
  const scoped = w.scope === 'x4' || w.scope === 'x8';
  if ((c.visible || t - c.lastSeen < 1.5) && p.reloadTimer <= 0 && ((dist > 25 && w.id !== 'shotgun') || (scoped && dist > 12))) {
    buttons |= BTN.ADS;
  }

  // Fire discipline.
  const wi = weaponAt(p, p.activeSlot)!;
  const ready = c.visible && t >= c.ready && p.drawTimer <= 0 && p.reloadTimer <= 0 && !p.use && wi.mag > 0;
  const tol = Math.max(w.fireMode === 'bolt' ? 0.45 * DEG : 0.9 * DEG, Math.atan2(0.42, dist)) * (w.fireMode === 'auto' && dist < 18 ? 1.8 : 1);
  const onTarget = Math.abs(angleDiff(b.aimYaw, wantYaw)) < tol && Math.abs(b.aimPitch - wantPitch) < tol * 1.3;
  const shots = p.shotCounter - b.lastShotCounter;
  b.lastShotCounter = p.shotCounter;
  if (!ready || !onTarget) {
    b.triggerHeld = false;
    if (shots > 0 && b.burstLeft > 0) b.burstLeft = Math.max(0, b.burstLeft - shots);
    return buttons;
  }
  if (w.fireMode === 'auto') {
    if (dist < 18) {
      b.triggerHeld = true;
    } else {
      if (b.burstLeft > 0) b.burstLeft -= shots;
      if (b.triggerHeld && b.burstLeft <= 0) {
        // Burst done: pause (longer at range).
        b.triggerHeld = false;
        b.burstPauseUntil = t + sk.burstPause * (dist > 70 ? 1.6 : 1) * (0.7 + 0.6 * b.rng.next());
      } else if (!b.triggerHeld && t >= b.burstPauseUntil) {
        b.burstLeft = dist > 70 ? b.rng.int(1, 2) : b.rng.int(sk.burstMin, sk.burstMax);
        b.triggerHeld = true;
      }
    }
  } else if (b.triggerHeld) {
    b.triggerHeld = false; // release for the next trigger edge
  } else if (p.fireCooldown <= 0) {
    const gap = dist < 20 ? 0 : sk.tapInterval * clamp(dist / 60, 0.5, 2.2);
    if (t - b.lastTapTime >= gap) {
      b.triggerHeld = true;
      b.lastTapTime = t;
    }
  }
  if (b.triggerHeld) buttons |= BTN.FIRE;
  return buttons;
}
