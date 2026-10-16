// Vehicles: pick a vehicle for long rotations (or a squadmate's free seat), walk to it and enter,
// drive toward the rotation target with throttle/steer, probing headings against the vehicle's
// real colliders and braking for the stopping distance, turns, crests and towns; recover from
// getting stuck by reversing, and exit when close, stuck, out of fuel, burning, or when a
// teammate is down (passengers also when the driver is knocked).

import { VEHICLE_ENTER_RANGE } from '../constants';
import { angleDiff, clamp } from '../math';
import type { PlayerState, RockDef, TreeDef, VehicleState, WorldBox } from '../types';
import { BTN } from '../types';
import { HANDLING, VEHICLES } from '../vehicles';
import { steerAim } from './combat';
import { setDest } from './movement';
import type { BotState } from './state';
import type { BotSystem } from './system';
import { insideNext, outsideCurrent, updateZoneTarget, zoneActive } from './zone';
import { findContact } from './perception';
import { slotRounds } from './aim';
import { hyp } from './util';

/** Rotations longer than this prefer a vehicle (m). */
export const VEHICLE_TRIP = 250;
/** Seconds a vehicle the bot gave up on is ignored. */
export const VEHICLE_BLACKLIST_TIME = 90;
const ARRIVE_DIST = 35;
/** Enemies closer than this make a slow driver get out and fight. */
const THREAT_EXIT_DIST = 45;

export function freeSeat(v: VehicleState, driver: boolean): number {
  if (driver) return v.seats[0] === null ? 0 : -1;
  for (let i = 1; i < v.seats.length; i++) if (v.seats[i] === null) return i;
  return -1;
}

function usable(sys: BotSystem, v: VehicleState): boolean {
  const def = VEHICLES[v.type];
  if (v.destroyed || v.health < def.health * 0.25) return false;
  return sys.world.heightAt(v.pos.x, v.pos.z) > sys.world.waterLevel - 0.6;
}

/** Find a vehicle to take within `radius`: a free driver seat, or a seat next to a teammate driver. */
export function findVehicle(sys: BotSystem, b: BotState, p: PlayerState, radius: number, needDriverSeat: boolean): VehicleState | null {
  const near = sys.sim.vehiclesNear(p.pos.x, p.pos.z, radius, sys.vehicleBuf);
  let best: VehicleState | null = null, bestS = Infinity;
  for (let i = 0; i < near.length; i++) {
    const v = near[i];
    const until = b.vehicleBlacklist.get(v.id);
    if ((until !== undefined && until > sys.now) || !usable(sys, v)) continue;
    const def = VEHICLES[v.type];
    const d = hyp(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
    const driver = v.seats[0];
    let s = Infinity;
    if (driver === null) {
      if (needDriverSeat && v.fuel > def.fuelMax * 0.06) s = d;
    } else if (sys.sim.sameTeam(b.id, driver) && freeSeat(v, false) >= 0) {
      s = d - 15;
    }
    if (s < bestS) {
      bestS = s;
      best = v;
    }
  }
  return best;
}

/** Walk to the chosen vehicle and enter it. Returns false when the plan is abandoned. */
export function approachVehicle(sys: BotSystem, b: BotState, p: PlayerState): boolean {
  const t = sys.now;
  const v = sys.sim.vehicles.get(b.vehicleId);
  if (!v || !usable(sys, v) || t - b.vehicleSince > 25) {
    b.vehicleBlacklist.set(b.vehicleId, t + VEHICLE_BLACKLIST_TIME);
    b.vehicleId = -1;
    return false;
  }
  const driver = v.seats[0];
  let seat: number;
  if (driver === null) seat = 0;
  else if (sys.sim.sameTeam(b.id, driver)) seat = freeSeat(v, false);
  else seat = -1;
  if (seat < 0) {
    b.vehicleBlacklist.set(v.id, t + VEHICLE_BLACKLIST_TIME);
    b.vehicleId = -1;
    return false;
  }
  const d = hyp(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
  if (d < VEHICLE_ENTER_RANGE - 0.9) {
    if (t - b.vehicleActionAt > 0.6) {
      b.actions.push({ a: 'enter', id: v.id, seat });
      b.vehicleActionAt = t;
    }
    b.moveScale = 0;
  } else {
    setDest(sys, b, p, v.pos.x, v.pos.z, VEHICLE_ENTER_RANGE - 1.2, true);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Driving probes
// ---------------------------------------------------------------------------
//
// The driver probes candidate headings against the vehicle's real colliders (the same boxes,
// trees and rocks the vehicle physics collides with, plus other vehicles and whole building
// footprints) instead of the character nav grid: low rocks a character steps over still wreck a
// buggy. Each probe is a ray against obstacles inflated by the vehicle's half width plus a
// margin. Terrain samples along the ray catch water and slopes too steep to drive.

/** Candidate heading offsets from the desired heading (rad), nearest first. */
const HEADINGS: readonly number[] = [0, 0.2, -0.2, 0.4, -0.4, 0.6, -0.6, 0.8, -0.8, 1.05, -1.05, 1.35, -1.35, 1.7, -1.7, 2.1, -2.1];
/** Clearance kept beside the body (m), plus this much per m/s of speed. */
const SIDE_MARGIN = 0.5;
const SIDE_MARGIN_PER_MS = 0.035;
/** Lateral acceleration assumed for turns (m/s^2). */
const TURN_ACCEL = 5.5;
/** Speeds (fractions of the current one, the first is the current) tried for the turn arc. */
const ROLLOUT_SPEEDS: readonly number[] = [1, 0.7, 0.45];
const ROLLOUT_STEP = 1.5;
/** Tightest turn a vehicle makes (1 / minimum turning radius, 1/m). */
const MAX_CURVATURE = 0.18;
/** How long a driver backs up to get out of a dead end (s). */
const REVERSE_TIME = 2;
/** Braking deceleration assumed for planning, as a fraction of the vehicle's service brake. */
const BRAKE_USE = 0.5;
/** Planning reaction time (s): one think interval plus throttle response. */
const REACTION = 0.3;
/** Distance kept to an obstacle when stopping in front of it (m, beyond the bumper). */
const STOP_MARGIN = 2.5;
/** Speed caps (m/s) near towns and for large heading errors. */
const TOWN_SPEED = 12;
/** Off-road cruise cap (m/s): bumps throw the wheels off the ground, which ruins braking. */
const OFFROAD_SPEED = 16;
const TOWN_MARGIN = 25;
/** Terrain sample spacing (m), water depth and grade (rise / run) a driver avoids. */
const TERRAIN_STEP = 2.5;
const MAX_WATER_DEPTH = 0.35;
const MAX_UPHILL = 0.6;
const MAX_DOWNHILL = 0.85;
/** Downed teammates within this range pull drivers and passengers out (matches the revive search). */
const DOWNED_EXIT_DIST = 120;
/** A bot driver keeps driving toward a downed teammate until it is this close (m). */
const DOWNED_DRIVE_DIST = 30;

const boxBuf: WorldBox[] = [];
const treeBuf: TreeDef[] = [];
const rockBuf: RockDef[] = [];
let obsN = 0;
/** Obstacles: kind 0 = rectangle (a,b)-(c,d), kind 1 = circle centre (a,b) radius c. */
let obsKind = new Uint8Array(256);
let obsA = new Float64Array(256);
let obsB = new Float64Array(256);
let obsC = new Float64Array(256);
let obsD = new Float64Array(256);
let buildingStamp = new Int32Array(0);
let stampGen = 0;

function pushObs(kind: number, a: number, b: number, c: number, d: number): void {
  if (obsN === obsKind.length) {
    const n = obsN * 2;
    const k2 = new Uint8Array(n); k2.set(obsKind); obsKind = k2;
    const a2 = new Float64Array(n); a2.set(obsA); obsA = a2;
    const b2 = new Float64Array(n); b2.set(obsB); obsB = b2;
    const c2 = new Float64Array(n); c2.set(obsC); obsC = c2;
    const d2 = new Float64Array(n); d2.set(obsD); obsD = d2;
  }
  obsKind[obsN] = kind;
  obsA[obsN] = a;
  obsB[obsN] = b;
  obsC[obsN] = c;
  obsD[obsN] = d;
  obsN++;
}

/** Collect the obstacles within `R` of the vehicle that would stop it. */
function gatherObstacles(sys: BotSystem, v: VehicleState, R: number): void {
  obsN = 0;
  const world = sys.world;
  const def = VEHICLES[v.type];
  const stepUp = HANDLING[v.type].stepUp;
  const bodyH = def.groundClearance + def.halfExtents.y * 2 + 0.3;
  const x = v.pos.x, z = v.pos.z;
  const nb = world.buildings.length;
  if (buildingStamp.length < nb) buildingStamp = new Int32Array(nb);
  stampGen++;
  boxBuf.length = 0;
  world.queryBoxes(x - R, z - R, x + R, z + R, boxBuf);
  for (let i = 0; i < boxBuf.length; i++) {
    const b = boxBuf[i];
    if (b.kind === 'ramp') continue;
    const bi = b.building;
    if (bi >= 0 && bi < nb) {
      // A building is one solid block for a vehicle (doors are too narrow to drive through).
      const bd = world.buildings[bi];
      if (buildingStamp[bi] !== stampGen) {
        buildingStamp[bi] = stampGen;
        pushObs(0, bd.min.x, bd.min.z, bd.max.x, bd.max.z);
      }
      const cx = (b.min.x + b.max.x) * 0.5, cz = (b.min.z + b.max.z) * 0.5;
      if (cx >= bd.min.x && cx <= bd.max.x && cz >= bd.min.z && cz <= bd.max.z) continue;
    }
    // Ground along the box (nearest point, centre and both ends: fences run down slopes): low
    // kerbs and steps are driven over, overhead boxes under.
    const cx = (b.min.x + b.max.x) * 0.5, cz = (b.min.z + b.max.z) * 0.5;
    const g0 = world.heightAt(clamp(x, b.min.x, b.max.x), clamp(z, b.min.z, b.max.z));
    const g1 = world.heightAt(cx, cz);
    const long = b.max.x - b.min.x > b.max.z - b.min.z;
    const g2 = long ? world.heightAt(b.min.x, cz) : world.heightAt(cx, b.min.z);
    const g3 = long ? world.heightAt(b.max.x, cz) : world.heightAt(cx, b.max.z);
    const gLo = Math.min(g0, g1, g2, g3), gHi = Math.max(g0, g1, g2, g3);
    if (b.max.y <= gLo + stepUp - 0.05 || b.min.y >= gHi + bodyH) continue;
    pushObs(0, b.min.x, b.min.z, b.max.x, b.max.z);
  }
  treeBuf.length = 0;
  world.queryTrees(x - R, z - R, x + R, z + R, treeBuf);
  for (let i = 0; i < treeBuf.length; i++) {
    const t = treeBuf[i];
    pushObs(1, t.x, t.z, t.r, 0);
  }
  rockBuf.length = 0;
  world.queryRocks(x - R, z - R, x + R, z + R, rockBuf);
  for (let i = 0; i < rockBuf.length; i++) {
    const k = rockBuf[i];
    // Same rule as the vehicle collider: rocks rising more than stepUp above the ground the
    // vehicle stands on when it touches them (on the side facing it) stop the vehicle.
    const dx = x - k.x, dz = z - k.z;
    const dl = Math.sqrt(dx * dx + dz * dz) || 1;
    const reach = k.r + def.halfExtents.x;
    const g = Math.min(world.heightAt(k.x, k.z), world.heightAt(k.x + (dx / dl) * reach, k.z + (dz / dl) * reach));
    if (k.y + k.h - Math.max(k.y, g) <= stepUp - 0.1) continue;
    pushObs(1, k.x, k.z, k.r, 0);
  }
  const near = sys.sim.vehiclesNear(x, z, R, sys.vehicleBuf);
  for (let i = 0; i < near.length; i++) {
    const o = near[i];
    if (o.id === v.id) continue;
    const he = VEHICLES[o.type].halfExtents;
    pushObs(1, o.pos.x, o.pos.z, Math.max(he.x, he.z), 0);
  }
}

/**
 * Free distance (m, up to L) along heading h from (x, z) for a body of half width w. Obstacles the
 * body already overlaps only block headings that lead further into them.
 */
function freeDist(sys: BotSystem, x: number, z: number, h: number, L: number, w: number): number {
  const fx = -Math.sin(h), fz = -Math.cos(h);
  let best = L;
  for (let i = 0; i < obsN; i++) {
    if (obsKind[i] === 0) {
      const x0 = obsA[i] - w, z0 = obsB[i] - w, x1 = obsC[i] + w, z1 = obsD[i] + w;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) {
        // Inside the inflated rectangle: blocked only when heading toward the real one.
        const nx = clamp(x, obsA[i], obsC[i]) - x, nz = clamp(z, obsB[i], obsD[i]) - z;
        const nl = Math.sqrt(nx * nx + nz * nz);
        if (nl < 1e-6 || nx * fx + nz * fz > 0.25 * nl) return 0;
        continue;
      }
      // Slab test.
      let tmin = 0, tmax = best;
      if (Math.abs(fx) < 1e-9) {
        if (x < x0 || x > x1) continue;
      } else {
        let t1 = (x0 - x) / fx, t2 = (x1 - x) / fx;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }
      if (Math.abs(fz) < 1e-9) {
        if (z < z0 || z > z1) continue;
      } else {
        let t1 = (z0 - z) / fz, t2 = (z1 - z) / fz;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }
      if (tmin < best) best = tmin;
    } else {
      const R = obsC[i] + w;
      const mx = x - obsA[i], mz = z - obsB[i];
      const bb = mx * fx + mz * fz;
      const c = mx * mx + mz * mz - R * R;
      if (c <= 0) {
        // Inside the inflated circle: blocked when heading toward the centre.
        const ml = Math.sqrt(mx * mx + mz * mz);
        if (ml < 1e-6 || -bb > 0.25 * ml) return 0;
        continue;
      }
      if (bb >= 0) continue;
      const disc = bb * bb - c;
      if (disc < 0) continue;
      const tt = -bb - Math.sqrt(disc);
      if (tt < best) best = tt;
    }
  }
  // Terrain: water and grades too steep to climb (or to drop down safely).
  const world = sys.world;
  const wl = world.waterLevel;
  let prev = world.heightAt(x, z);
  const lim = Math.min(best, 32);
  for (let s = TERRAIN_STEP; s <= lim; s += TERRAIN_STEP) {
    const hx = x + fx * s, hz = z + fz * s;
    if (!world.inBounds(hx, hz)) return Math.max(0, s - TERRAIN_STEP);
    const g = world.heightAt(hx, hz);
    const grade = (g - prev) / TERRAIN_STEP;
    if (g < wl - MAX_WATER_DEPTH || grade > MAX_UPHILL || grade < -MAX_DOWNHILL) return Math.max(0, s - TERRAIN_STEP);
    prev = g;
  }
  return best;
}

/**
 * Distance (m, up to L) the body travels along an arc that starts at heading h0 and turns toward
 * heading target as tightly as speed u allows, before its front collision circle (centre `nose`
 * ahead of the body centre, radius w) touches an obstacle.
 */
function rollout(x: number, z: number, h0: number, target: number, u: number, L: number, nose: number, w: number): number {
  const maxTurn = Math.min(TURN_ACCEL / Math.max(16, u * u), MAX_CURVATURE) * ROLLOUT_STEP;
  let h = h0;
  for (let s = ROLLOUT_STEP; s <= L; s += ROLLOUT_STEP) {
    const e = angleDiff(h, target);
    h += e > maxTurn ? maxTurn : e < -maxTurn ? -maxTurn : e;
    const fx = -Math.sin(h), fz = -Math.cos(h);
    x += fx * ROLLOUT_STEP;
    z += fz * ROLLOUT_STEP;
    if (pointBlocked(x + fx * nose, z + fz * nose, w)) return s - ROLLOUT_STEP;
  }
  return L;
}

function pointBlocked(x: number, z: number, w: number): boolean {
  const w2 = w * w;
  for (let i = 0; i < obsN; i++) {
    if (obsKind[i] === 0) {
      const dx = x < obsA[i] ? obsA[i] - x : x > obsC[i] ? x - obsC[i] : 0;
      const dz = z < obsB[i] ? obsB[i] - z : z > obsD[i] ? z - obsD[i] : 0;
      if (dx * dx + dz * dz < w2) return true;
    } else {
      const dx = x - obsA[i], dz = z - obsB[i], r = obsC[i] + w;
      if (dx * dx + dz * dz < r * r) return true;
    }
  }
  return false;
}

/**
 * Highest speed (m/s) at which the terrain along heading h stays under the wheels: convex crests
 * of curvature k throw a vehicle faster than sqrt(g / k) into the air.
 */
function crestSpeed(sys: BotSystem, x: number, z: number, h: number, L: number, decel: number): number {
  const world = sys.world;
  const fx = -Math.sin(h), fz = -Math.cos(h);
  const ds = TERRAIN_STEP;
  let h0 = world.heightAt(x, z), h1 = world.heightAt(x + fx * ds, z + fz * ds);
  let vmax2 = Infinity;
  for (let s = 2 * ds; s <= L; s += ds) {
    const h2 = world.heightAt(x + fx * s, z + fz * s);
    const k = -(h2 - 2 * h1 + h0) / (ds * ds);
    if (k > 0.004) {
      // Speed allowed now: the crest speed plus what braking sheds before reaching it.
      const v2 = (9.81 * 1.25) / k + 2 * decel * Math.max(0, s - ds - 3);
      if (v2 < vmax2) vmax2 = v2;
    }
    h0 = h1;
    h1 = h2;
  }
  return Math.sqrt(vmax2);
}

function nearTown(sys: BotSystem, x: number, z: number): boolean {
  const towns = sys.world.towns;
  for (let i = 0; i < towns.length; i++) {
    const tw = towns[i];
    const r = tw.r + TOWN_MARGIN;
    const dx = x - tw.x, dz = z - tw.z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

/** Nearest downed teammate (not p) within r, or null. */
function downedTeammateNear(sys: BotSystem, p: PlayerState, r: number): PlayerState | null {
  const mates = sys.teamMembers(p.team);
  let best: PlayerState | null = null, bestD = r;
  for (let i = 0; i < mates.length; i++) {
    const q = mates[i];
    if (q.id === p.id || q.life !== 'downed') continue;
    if (q.revivedBy !== null && q.revivedBy !== p.id) continue;
    const d = hyp(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Driver / passenger logic. Writes axes into out; returns buttons. */
export function vehicleTick(sys: BotSystem, b: BotState, p: PlayerState, think: boolean, out: { mx: number; mz: number }): number {
  const sim = sys.sim;
  const t = sys.now;
  out.mx = 0;
  out.mz = 0;
  const v = p.vehicleId !== null ? sim.vehicles.get(p.vehicleId) : undefined;
  if (!v) return 0;
  if (b.rideId !== v.id) {
    // Just got in: fresh per-ride state.
    b.rideId = v.id;
    b.vehicleId = v.id;
    b.vehicleSince = t;
    b.exitWanted = false;
    b.driveStuckCount = 0;
    b.driveStuckSince = -1;
    b.driveGoodSince = -1;
    b.reverseUntil = 0;
    b.driveHeading = v.yaw;
    b.driveTargetSpeed = 0;
    b.driveWaitUntil = p.seat === 0 && teammatesWalkingNear(sys, p, 35) ? t + 4 : t;
  }
  const def = VEHICLES[v.type];
  const speed = v.speed;
  let buttons = 0;

  if (p.life !== 'alive') {
    // Downed occupants cannot drive or shoot: get out once it is slow so teammates can revive.
    if (think && Math.abs(speed) < 6 && t - b.vehicleActionAt > 0.6) {
      b.actions.push({ a: 'exit' });
      b.vehicleActionAt = t;
    }
    return 0;
  }

  if (p.seat !== 0) {
    // Passenger: get out (when slow) if nobody able drives, the vehicle is wrecked, or a downed
    // teammate needs a revive (a knocked driver keeps the seat, so check the driver's state).
    if (think && Math.abs(speed) < 7 && t - b.vehicleActionAt > 0.6) {
      const did = v.seats[0];
      const dp = did !== null ? sim.players.get(did) : undefined;
      if (v.destroyed || !dp || dp.life !== 'alive' || downedTeammateNear(sys, p, DOWNED_EXIT_DIST)) {
        b.actions.push({ a: 'exit' });
        b.vehicleActionAt = t;
      }
    }
    return 0;
  }

  // ---- Driver ----
  const he = def.halfExtents;
  const decel = def.brake * BRAKE_USE;
  if (think) {
    // Destination: a downed teammate first, then the human squad leader, then the rotation.
    let tx: number, tz: number;
    const leader = sys.humanLeader(p);
    const hurt = downedTeammateNear(sys, p, DOWNED_EXIT_DIST);
    if (hurt) {
      tx = hurt.pos.x;
      tz = hurt.pos.z;
    } else if (leader) {
      tx = leader.pos.x;
      tz = leader.pos.z;
    } else {
      updateZoneTarget(sys, b, p);
      tx = zoneActive(sys) ? b.zoneX : b.destX;
      tz = zoneActive(sys) ? b.zoneZ : b.destZ;
    }
    const dist = hyp(tx - v.pos.x, tz - v.pos.z);
    const arrivedNow = hurt
      ? dist < DOWNED_DRIVE_DIST
      : dist < ARRIVE_DIST || (!leader && zoneActive(sys) && insideNext(sys, v.pos.x, v.pos.z, 20) && dist < 120);
    // Bail out to fight only when an enemy is close, the bot can shoot back and it is not
    // racing the zone.
    const c = findContact(b, b.targetId);
    const threatClose = !!c && c.visible && Math.abs(speed) < 8 && hyp(c.x - v.pos.x, c.z - v.pos.z) < THREAT_EXIT_DIST &&
      hasRounds(p) && !outsideCurrent(sys, v.pos.x, v.pos.z);
    if (arrivedNow || v.destroyed || v.health < def.health * 0.2 || v.fuel <= 0.05 || b.driveStuckCount >= 3 || threatClose) {
      b.exitWanted = true;
    }
    if (b.exitWanted && Math.abs(speed) < 3 && t - b.vehicleActionAt > 0.6) {
      b.actions.push({ a: 'exit' });
      b.vehicleActionAt = t;
      if (b.driveStuckCount >= 3 || v.fuel <= 0.05) b.vehicleBlacklist.set(v.id, t + VEHICLE_BLACKLIST_TIME);
    }

    // Heading: the candidate nearest the desired heading whose corridor is clear for the
    // stopping distance (plus some look-ahead); otherwise the most open one.
    const sp = Math.abs(speed);
    const stopDist = (sp * sp) / (2 * decel) + sp * REACTION;
    const L = clamp(stopDist + he.z + 12, 16, 48);
    const w = he.x + SIDE_MARGIN + SIDE_MARGIN_PER_MS * sp;
    gatherObstacles(sys, v, L + w + 1);
    const desired = Math.atan2(-(tx - v.pos.x), -(tz - v.pos.z));
    const need = Math.min(L, Math.max(stopDist + he.z + STOP_MARGIN + 4, 12), dist + he.z);
    let chosen = NaN, chosenF = 0;
    let fallback = NaN, fallbackF = 0, fallbackS = -Infinity;
    for (let k = 0; k < HEADINGS.length; k++) {
      const h = desired + HEADINGS[k];
      const F = freeDist(sys, v.pos.x, v.pos.z, h, L, w);
      if (F >= need) {
        chosen = h;
        chosenF = F;
        break;
      }
      const s = F - 4 * Math.abs(HEADINGS[k]);
      if (s > fallbackS) {
        fallbackS = s;
        fallback = h;
        fallbackF = F;
      }
    }
    if (Number.isNaN(chosen)) {
      chosen = fallback;
      chosenF = fallbackF;
    } else if (chosen !== b.driveHeading) {
      // Hysteresis: keep the previous heading while it is still clear and about as good.
      const prev = b.driveHeading;
      if (Math.abs(angleDiff(desired, prev)) <= Math.abs(angleDiff(desired, chosen)) + 0.3) {
        const F = freeDist(sys, v.pos.x, v.pos.z, prev, L, w);
        if (F >= need) {
          chosen = prev;
          chosenF = F;
        }
      }
    }
    // Along the current motion: the vehicle keeps going that way until the turn is made.
    const moveH = sp > 3 ? Math.atan2(-v.vel.x, -v.vel.z) : speed >= 0 ? v.yaw : v.yaw + Math.PI;
    const turn = Math.abs(angleDiff(moveH, chosen));
    const aheadF = turn > 0.1 ? freeDist(sys, v.pos.x, v.pos.z, moveH, L, w) : chosenF;
    b.driveHeading = chosen;
    const nose = he.z - he.x;
    if (t >= b.reverseUntil) {
      // Boxed in, or the tightest arc toward the chosen heading hits something right away
      // (nose against a tree with a sharp turn to make): back up, swinging the nose around.
      if (chosenF < he.z + 1.5 || (sp < 6 && rollout(v.pos.x, v.pos.z, speed >= -0.5 ? v.yaw : v.yaw + Math.PI, chosen, 3, 6, nose, he.x + 0.2) < 1.5)) {
        b.reverseUntil = t + REVERSE_TIME;
        b.driveStuckCount++;
      }
    } else if (speed < -0.5 && freeDist(sys, v.pos.x, v.pos.z, v.yaw + Math.PI, 6, he.x + 0.3) < he.z + 0.4) {
      // Backing into something: stop reversing.
      b.reverseUntil = t;
    }
    // Target speed: stop before the first obstacle on the chosen heading and on the current
    // line (while turning), slow for towns, crests and the destination.
    const onRoad = sys.world.surfaceAt(v.pos.x, v.pos.z) === 'road';
    const cruise = Math.min(def.maxSpeed * 0.7, def.isBike ? 18 : 22, onRoad ? Infinity : def.isBike ? OFFROAD_SPEED - 2 : OFFROAD_SPEED);
    let vt = cruise;
    // Downhill the brakes fight gravity.
    const grade = (sys.world.heightAt(v.pos.x - Math.sin(moveH) * 10, v.pos.z - Math.cos(moveH) * 10) - sys.world.heightAt(v.pos.x, v.pos.z)) / 10;
    const dEff = Math.max(2.5, decel + 9.81 * Math.min(0, grade));
    const lead = he.z + STOP_MARGIN + sp * REACTION;
    const avail = chosenF - lead;
    vt = Math.min(vt, Math.sqrt(2 * dEff * Math.max(0, avail)));
    if (turn > 0.1 || aheadF < chosenF) {
      // The body follows an arc from the current motion to the chosen heading (tighter when
      // slower): take the fastest of a few speeds whose arc stays clear for its stopping distance.
      const wHit = he.x + 0.35;
      let best = 0;
      for (let k = 0; k < ROLLOUT_SPEEDS.length; k++) {
        const u = k === 0 ? Math.max(sp, 4) : sp * ROLLOUT_SPEEDS[k];
        if (k > 0 && u < 4) break;
        const F = rollout(v.pos.x, v.pos.z, moveH, chosen, u, L, he.z - he.x, wHit);
        const a = Math.sqrt(2 * dEff * Math.max(0, F - (STOP_MARGIN * 0.6 + sp * REACTION)));
        const ok = k === 0 ? a : Math.min(u, a);
        if (ok > best) best = ok;
        if (a >= u) break;
      }
      vt = Math.min(vt, Math.max(3, best));
    }
    if (nearTown(sys, v.pos.x, v.pos.z)) vt = Math.min(vt, def.isBike ? TOWN_SPEED - 1 : TOWN_SPEED);
    vt = Math.min(vt, crestSpeed(sys, v.pos.x, v.pos.z, chosen, Math.min(L, 32), dEff));
    if (dist < 80) vt = Math.min(vt, Math.max(6, Math.sqrt(2 * dEff * Math.max(0, dist - ARRIVE_DIST * 0.7))));
    // Never crawl below walking pace when the way is open (obstacle contacts that slow are harmless).
    if (avail > 0) vt = Math.max(vt, 3);
    b.driveTargetSpeed = vt;
    const dbg = (globalThis as any).__vdbg; if (dbg) dbg({ t, x: v.pos.x, z: v.pos.z, sp, desired, chosen, chosenF, need, L, w, aheadF, turn, vt, obsN, dist, stuck: b.driveStuckCount, rev: b.reverseUntil > t ? 1 : 0, yaw: v.yaw });

    // Steady progress forgives earlier stuck episodes.
    if (sp > 6 && t >= b.reverseUntil) {
      if (b.driveGoodSince < 0) b.driveGoodSince = t;
      else if (t - b.driveGoodSince > 6) {
        if (b.driveStuckCount > 0) b.driveStuckCount--;
        b.driveGoodSince = t;
      }
    } else {
      b.driveGoodSince = -1;
    }
    // Stuck: throttling without moving.
    if (b.driveThrottle > 0.4 && Math.abs(speed) < 1.5 && t >= b.reverseUntil) {
      if (b.driveStuckSince < 0) b.driveStuckSince = t;
      else if (t - b.driveStuckSince > 1.5) {
        b.reverseUntil = t + REVERSE_TIME;
        b.driveStuckCount++;
        b.driveStuckSince = -1;
      }
    } else {
      b.driveStuckSince = -1;
    }
  }
  steerAim(sys, b, v.yaw, -0.05, 0.6);
  const yawErr = angleDiff(v.yaw, b.driveHeading);
  let throttle: number, steer: number;
  if (b.exitWanted) {
    throttle = Math.abs(speed) > 1 ? -Math.sign(speed) : 0;
    steer = 0;
    if (Math.abs(speed) < 8) buttons |= BTN.HANDBRAKE;
  } else if (t < b.driveWaitUntil && teammatesWalkingNear(sys, p, 35)) {
    throttle = 0;
    steer = 0;
  } else if (!v.onGround) {
    // Airborne: no throttle (wheels spin freely), keep the wheels straight for the landing.
    throttle = 0;
    steer = 0;
  } else if (t < b.reverseUntil) {
    throttle = speed > 2 ? -1 : -0.9;
    steer = clamp(yawErr * 2, -1, 1); // reversing swings the nose the other way
  } else {
    steer = clamp(-yawErr * 3, -1, 1);
    const ae = Math.abs(yawErr);
    // Corner speed: big heading errors mean a sharp turn ahead.
    const turnCap = ae > 1.5 ? 4 : ae > 0.9 ? 6.5 : ae > 0.4 ? (def.isBike ? 9 : 11) : Infinity;
    const target = Math.min(b.driveTargetSpeed, turnCap);
    if (speed > target + 1.5) {
      // Brake (negative throttle brakes while rolling forward).
      throttle = -clamp((speed - target) / 5, 0.3, 1);
    } else if (speed > target) {
      throttle = 0;
    } else if (target < 0.5) {
      throttle = 0;
    } else {
      throttle = clamp((target - speed) / 3, 0.35, 1);
      if (ae > 1.3) throttle = Math.min(throttle, 0.5);
    }
  }
  b.driveThrottle = throttle;
  out.mx = steer;
  out.mz = throttle;
  return buttons;
}

function hasRounds(p: PlayerState): boolean {
  return slotRounds(p, 0) > 0 || slotRounds(p, 1) > 0 || slotRounds(p, 2) > 0;
}

function teammatesWalkingNear(sys: BotSystem, p: PlayerState, r: number): boolean {
  const near = sys.sim.playersNear(p.pos.x, p.pos.z, r, sys.playerBuf2);
  for (let i = 0; i < near.length; i++) {
    const q = near[i];
    if (q.id !== p.id && q.life === 'alive' && q.mode !== 'vehicle' && q.isBot && sys.sim.sameTeam(p.id, q.id)) return true;
  }
  return false;
}
