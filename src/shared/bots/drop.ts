// Plane, freefall and parachute behaviour: choose a landing spot (weighted random town /
// loot-rich building near the flight path, shared by the squad; squads led by a human follow
// the human), jump near the closest point of the flight path, steer the freefall, open the
// chute early for far targets (or rely on the auto-open), and glide onto the target.

import { hyp } from './util';
import { MIN_CHUTE_DROP, PARACHUTE_DESCENT, PARACHUTE_HORIZONTAL } from '../constants';
import { angleDiff } from '../math';
import type { PlayerState } from '../types';
import { steerAim } from './combat';
import type { BotState } from './state';
import type { BotSystem } from './system';

/** Lateral distance (m) from the flight path that is comfortably reachable. */
const EASY_REACH = 320;
/** Landing spots keep this distance from the building footprint (chutes drift a few metres). */
const LANDING_CLEARANCE = 8;
const MAX_REACH = 520;

const dir = { x: 0, z: 0 };
const planePos = { x: 0, z: 0 };

function planeGeometry(sys: BotSystem): boolean {
  const plane = sys.sim.plane;
  if (!plane || plane.length <= 0) return false;
  dir.x = (plane.end.x - plane.start.x) / plane.length;
  dir.z = (plane.end.z - plane.start.z) / plane.length;
  const f = Math.min(1, plane.traveled / plane.length);
  planePos.x = plane.start.x + (plane.end.x - plane.start.x) * f;
  planePos.z = plane.start.z + (plane.end.z - plane.start.z) * f;
  return true;
}

/** Pick (or adopt the squad's) landing spot. */
export function chooseLanding(sys: BotSystem, b: BotState, p: PlayerState): void {
  const team = sys.teamPlan(p.team);
  const rng = b.rng;
  b.jumpLead = 15 + rng.next() * 70;
  b.chuteHeight = 125 + rng.next() * 70;
  if (team.hasLanding) {
    b.landX = team.landX + rng.gauss() * 7;
    b.landZ = team.landZ + rng.gauss() * 7;
    b.hasLanding = true;
    return;
  }
  const w = sys.world;
  const plane = sys.sim.plane;
  const havePath = planeGeometry(sys);
  const sx = plane ? plane.start.x : 0, sz = plane ? plane.start.z : 0;
  const len = plane ? plane.length : 1;
  const reach = (x: number, z: number): number => {
    if (!havePath) return 1;
    const rx = x - sx, rz = z - sz;
    const along = rx * dir.x + rz * dir.z;
    const lateral = Math.abs(rx * dir.z - rz * dir.x);
    let f = lateral < EASY_REACH ? 1 : lateral > MAX_REACH ? 0.03 : 1 - (lateral - EASY_REACH) / (MAX_REACH - EASY_REACH) * 0.97;
    if (along < len * 0.08 || along > len * 0.86) f *= 0.15;
    return f;
  };
  let x = 0, z = 0, chosen = false;
  const info = sys.info;
  if (w.towns.length > 0 && !rng.chance(0.15)) {
    let total = 0;
    const weights: number[] = [];
    for (let i = 0; i < w.towns.length; i++) {
      const t = w.towns[i];
      // Other teams already heading there make a town less attractive (spread the drops).
      let taken = 0;
      for (const plan of sys.teams.values()) {
        if (plan.hasLanding && (plan.landX - t.x) ** 2 + (plan.landZ - t.z) ** 2 < (t.r + 40) ** 2) taken++;
      }
      const wt = Math.pow(t.tier + 1, 1.3) * (0.5 + t.r / 60) * reach(t.x, t.z) * (0.6 + 0.8 * rng.next()) *
        (info.townBuildings[i].length > 0 ? 1 : 0.3) * Math.pow(0.4, taken);
      weights.push(wt);
      total += wt;
    }
    if (total > 0) {
      const ti = rng.weighted(w.towns.map((_, i) => i), weights);
      const bl = info.townBuildings[ti];
      if (bl.length > 0) {
        const bi = rng.pick(bl);
        landingNearBuilding(sys, b, bi);
        x = b.landX;
        z = b.landZ;
      } else {
        x = w.towns[ti].x + rng.gauss() * w.towns[ti].r * 0.3;
        z = w.towns[ti].z + rng.gauss() * w.towns[ti].r * 0.3;
      }
      chosen = true;
    }
  }
  if (!chosen && w.buildings.length > 0) {
    // A loot-rich standalone building within reach.
    let best = -1, bestW = 0;
    for (let k = 0; k < 24; k++) {
      const bi = rng.int(0, w.buildings.length - 1);
      const wt = reach(info.bCenter[bi * 2], info.bCenter[bi * 2 + 1]) * (0.5 + rng.next());
      if (wt > bestW) {
        bestW = wt;
        best = bi;
      }
    }
    if (best >= 0) {
      landingNearBuilding(sys, b, best);
      x = b.landX;
      z = b.landZ;
      chosen = true;
    }
  }
  if (!chosen) {
    if (havePath && plane) {
      const s = len * (0.25 + 0.5 * rng.next());
      x = plane.start.x + dir.x * s;
      z = plane.start.z + dir.z * s;
    }
  }
  b.landX = x;
  b.landZ = z;
  b.hasLanding = true;
  team.landX = x;
  team.landZ = z;
  team.hasLanding = true;
}

/** Landing point next to (never on top of) a building: open, dry ground with clearance. */
function landingNearBuilding(sys: BotSystem, b: BotState, bi: number): void {
  const info = sys.info;
  const cx = info.bCenter[bi * 2], cz = info.bCenter[bi * 2 + 1];
  const hx = info.bHalf[bi * 2], hz = info.bHalf[bi * 2 + 1];
  const a0 = b.rng.next() * Math.PI * 2;
  let bestX = cx + hx + LANDING_CLEARANCE, bestZ = cz;
  for (let k = 0; k < 8; k++) {
    const a = a0 + k * (Math.PI / 4);
    const ca = Math.cos(a), sa = Math.sin(a);
    // Distance from the centre to the footprint edge along the direction, plus clearance.
    const edge = Math.min(Math.abs(ca) > 1e-3 ? hx / Math.abs(ca) : Infinity, Math.abs(sa) > 1e-3 ? hz / Math.abs(sa) : Infinity);
    const x = cx + ca * (edge + LANDING_CLEARANCE), z = cz + sa * (edge + LANDING_CLEARANCE);
    bestX = x;
    bestZ = z;
    if (openGround(sys, x, z)) break;
  }
  b.landX = bestX;
  b.landZ = bestZ;
}

/** No box top (roof, container) within a few metres and not in water. */
function openGround(sys: BotSystem, x: number, z: number): boolean {
  const w = sys.world;
  const t = w.heightAt(x, z);
  if (t < w.waterLevel + 0.5) return false;
  for (let dz = -3; dz <= 3; dz += 3) {
    for (let dx = -3; dx <= 3; dx += 3) {
      if (w.groundAt(x + dx, z + dz) > w.heightAt(x + dx, z + dz) + 0.8) return false;
    }
  }
  return true;
}

/** Riding the plane: decide when to jump. */
export function planeTick(sys: BotSystem, b: BotState, p: PlayerState, think: boolean): void {
  if (!b.hasLanding) chooseLanding(sys, b, p);
  if (!planeGeometry(sys)) return;
  const plane = sys.sim.plane!;
  const t = sys.now;
  // Look toward the landing spot (purely cosmetic while aboard).
  steerAim(sys, b, Math.atan2(-(b.landX - planePos.x), -(b.landZ - planePos.z)), -0.3, 0.5);
  if (!think || t - b.planeActionAt < 0.4) return;
  if (!sys.world.inBounds(planePos.x, planePos.z)) return;
  let jump = false;
  const leader = sys.humanLeader(p);
  if (leader) {
    if (leader.mode !== 'plane') {
      if (b.jumpDelayUntil < 0) b.jumpDelayUntil = t + 0.3 + b.rng.next() * 1.2;
      jump = t >= b.jumpDelayUntil;
    }
  } else {
    const rx = b.landX - plane.start.x, rz = b.landZ - plane.start.z;
    const along = rx * dir.x + rz * dir.z;
    const lateral = Math.abs(rx * dir.z - rz * dir.x);
    const jumpAt = along - b.jumpLead - Math.min(80, lateral * 0.15);
    jump = plane.traveled >= jumpAt;
  }
  if (plane.traveled > plane.length * 0.86) jump = true;
  if (jump) {
    b.actions.push({ a: 'jump' });
    b.planeActionAt = t;
  }
}

/** Freefall / parachute steering. Writes the desired forward axis into b.moveScale (as mz). */
export function dropTick(sys: BotSystem, b: BotState, p: PlayerState, think: boolean, out: { mx: number; mz: number }): void {
  if (!b.hasLanding) chooseLanding(sys, b, p);
  const t = sys.now;
  let tx = b.landX, tz = b.landZ;
  const leader = sys.humanLeader(p);
  if (leader && leader.mode !== 'plane') {
    // Follow the human down, slightly offset so the squad does not stack.
    const a = (p.id % 8) * 0.785;
    tx = leader.pos.x + Math.cos(a) * 7;
    tz = leader.pos.z + Math.sin(a) * 7;
  }
  const dx = tx - p.pos.x, dz = tz - p.pos.z;
  const dist = hyp(dx, dz);
  const h = Math.max(0, p.pos.y - sys.world.heightAt(p.pos.x, p.pos.z));
  const yaw = Math.atan2(-dx, -dz);
  steerAim(sys, b, dist > 3 ? yaw : b.aimYaw, -0.5, 0.7);
  const facing = Math.abs(angleDiff(b.aimYaw, yaw)) < 0.5;
  let mz: number;
  if (p.mode === 'freefall') {
    const canChute = p.jumpY - p.pos.y >= MIN_CHUTE_DROP + 0.5;
    const glideNeed = dist / Math.max(1, h - 20);
    if (think && canChute && t - b.planeActionAt > 0.5 && (glideNeed > 0.8 || h < b.chuteHeight)) {
      b.actions.push({ a: 'chute' });
      b.planeActionAt = t;
    }
    mz = dist > 25 ? 1 : dist < 8 ? -0.6 : 0.2;
  } else {
    // Parachute: neutral drift covers ~0.45 * horizontal speed; full forward is the fastest.
    const timeLeft = h / PARACHUTE_DESCENT;
    const drift = timeLeft * PARACHUTE_HORIZONTAL * 0.45;
    if (dist > drift + 5) mz = 1;
    else if (dist < 4) mz = -1;
    else mz = Math.max(-1, Math.min(1, (dist - 4) / 25));
    // Never settle onto a roof: low over a box top, glide on toward open ground.
    const w = sys.world;
    if (h < 30 && w.groundAt(p.pos.x, p.pos.z) > w.heightAt(p.pos.x, p.pos.z) + 0.8) mz = 1;
  }
  out.mx = 0;
  out.mz = facing ? mz : mz * 0.3;
}
