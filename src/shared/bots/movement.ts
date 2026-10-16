// Bot locomotion: destinations, path following (A* waypoints with look-ahead), direct steering
// with grid feelers while a path is pending, walking around vehicle hulls (solid, but not part of
// the static nav grid), stuck detection with escalating recovery, and the conversion of a
// world-space move direction into PlayerInput axes.

import { PLAYER_RADIUS, STANCE_HEIGHT, STEP_HEIGHT } from '../constants';
import { angleDiff } from '../math';
import type { CharObstacle } from '../physics';
import type { PlayerState, VehicleState } from '../types';
import { vehicleObstacle } from '../vehicles';
import { NF_BLOCKED, NF_NEAR, NF_UNKNOWN } from './nav';
import { PATH_DONE, PATH_FAILED, PATH_IDLE } from './pathfind';
import type { BotState } from './state';
import type { BotSystem } from './system';
import { hyp } from './util';

/** Seconds without progress before the bot counts as stuck. */
const STUCK_TIME = 1.5;
const STUCK_MIN_MOVE = 0.8;
/** Repath when the destination moved this far from the planned goal. */
const REPATH_MOVE = 3;
/** Feet this far above the ground-level nav floor are on an upper floor / roof. */
const UPPER_MIN = 1.5;
/** Feet within this height of a destination are on its floor. */
const LEVEL_TOL = 1.6;
const FEELER_ANGLES: readonly number[] = [0.45, -0.45, 0.9, -0.9, 1.4, -1.4];

/**
 * Walk to (x, z). `y` is the destination's feet height when it may lie on an upper building
 * floor (loot, teammates, enemies); NaN means ground level.
 */
export function setDest(
  sys: BotSystem, b: BotState, p: PlayerState, x: number, z: number, arrive: number, sprint: boolean, y = NaN,
): void {
  b.arrive = arrive;
  b.sprint = sprint;
  b.walk = false;
  const sameLevel = Number.isNaN(y) ? Number.isNaN(b.destY) : !Number.isNaN(b.destY) && Math.abs(y - b.destY) < 1.5;
  if (b.hasDest && sameLevel && Math.abs(x - b.destX) < 0.5 && Math.abs(z - b.destZ) < 0.5) return;
  b.hasDest = true;
  b.destX = x;
  b.destZ = z;
  b.destY = y;
  const moved = hyp(x - b.pathGX, z - b.pathGZ);
  if (b.path.status === PATH_IDLE || b.path.status === PATH_FAILED || moved > REPATH_MOVE || !sameLevel) requestPath(sys, b, p);
}

/** Is a position above the ground-level nav floor (upper building floor, roof)? */
export function aboveGround(sys: BotSystem, x: number, y: number, z: number): boolean {
  return !Number.isNaN(y) && y - sys.grid.baseOr(x, z) > UPPER_MIN;
}

/** Is the bot on the destination's floor (ground for ground-level destinations)? */
function onDestLevel(sys: BotSystem, b: BotState, p: PlayerState): boolean {
  return Number.isNaN(b.destY) ? !aboveGround(sys, p.pos.x, p.pos.y, p.pos.z) : Math.abs(p.pos.y - b.destY) < LEVEL_TOL;
}

/** Walk straight to (x, z) without path planning (e.g. off a roof, where the ground grid does not apply). */
export function setDirectDest(sys: BotSystem, b: BotState, x: number, z: number, arrive: number): void {
  sys.planner.cancel(b.path);
  b.hasDest = true;
  b.destX = b.pathGX = x;
  b.destZ = b.pathGZ = z;
  b.arrive = arrive;
  b.sprint = false;
  b.walk = false;
  b.pathIdx = 0;
  b.pathTime = sys.now;
  b.path.pts[0] = x;
  b.path.pts[1] = z;
  b.path.count = 1;
  b.path.partial = false;
  b.path.status = PATH_DONE;
}

export function clearDest(sys: BotSystem, b: BotState): void {
  b.hasDest = false;
  b.moveScale = 0;
  sys.planner.cancel(b.path);
  b.path.status = PATH_IDLE;
  b.path.count = 0;
}

/** Destinations closer than this with a clear straight walk skip A* entirely. */
const DIRECT_DIST = 30;

export function requestPath(sys: BotSystem, b: BotState, p: PlayerState): void {
  b.pathIdx = 0;
  b.pathGX = b.destX;
  b.pathGZ = b.destZ;
  b.pathTime = sys.now;
  const px = p.pos.x, pz = p.pos.z;
  const upper = aboveGround(sys, px, p.pos.y, pz) || aboveGround(sys, b.destX, b.destY, b.destZ);
  if (!upper && hyp(b.destX - px, b.destZ - pz) <= DIRECT_DIST && sys.grid.lineOfWalk(px, pz, b.destX, b.destZ, false, false) &&
      sys.grid.clearSegment(px, pz, b.destX, b.destZ, 0.3)) {
    // Straight shot: a one-point "path" without touching the planner.
    sys.planner.cancel(b.path);
    b.path.pts[0] = b.destX;
    b.path.pts[1] = b.destZ;
    b.path.count = 1;
    b.path.partial = false;
    b.path.status = PATH_DONE;
    return;
  }
  sys.planner.request(b.path, px, pz, b.destX, b.destZ, upper ? p.pos.y : NaN, b.destY);
}

/** True when (x, z) is a destination the bot recently gave up on. */
export function isAvoided(sys: BotSystem, b: BotState, x: number, z: number): boolean {
  return sys.now < b.avoidUntil && Math.abs(x - b.avoidX) < 5 && Math.abs(z - b.avoidZ) < 5;
}

/**
 * Per-tick: compute the desired world move direction (b.moveX/moveZ/moveScale) toward the
 * destination along the planned path.
 */
export function followPath(sys: BotSystem, b: BotState, p: PlayerState): void {
  b.moveScale = 0;
  if (!b.hasDest) return;
  const px = p.pos.x, pz = p.pos.z;
  const dd = hyp(b.destX - px, b.destZ - pz);
  const sameLevel = onDestLevel(sys, b, p);
  if (dd <= b.arrive && sameLevel) return;
  let tx = b.destX, tz = b.destZ;
  const path = b.path;
  let direct = true;
  if (path.status === PATH_DONE && path.count > 0) {
    // Advance past reached waypoints; look ahead one waypoint when it is directly walkable.
    // Indoor routes (stairs, upper floors) have tight waypoints everywhere.
    const indoor = !Number.isNaN(b.destY) || aboveGround(sys, px, p.pos.y, pz);
    let i = b.pathIdx;
    while (i < path.count) {
      const wx = path.pts[i * 2], wz = path.pts[i * 2 + 1];
      const d = hyp(wx - px, wz - pz);
      // Tight waypoints (doorways, corners, stairs) must really be reached before turning; the
      // final one only counts on the destination's floor.
      const last = i === path.count - 1;
      const reach = last ? b.arrive : indoor || sys.grid.flagsAt(wx, wz, false) & NF_NEAR ? 0.45 : 0.75;
      if (last && !sameLevel) {
        // Right above / below the destination on another floor: the route was stale or
        // partial, plan again (through the stairs).
        if (d <= reach && sys.now - b.pathTime > 2) requestPath(sys, b, p);
        break;
      }
      if (d > reach) break;
      i++;
    }
    b.pathIdx = i;
    if (path.count === 1 && !path.partial) {
      // Straight-shot path: follow the live destination (it may drift a little, e.g. a target).
      direct = false;
    } else if (i < path.count) {
      tx = path.pts[i * 2];
      tz = path.pts[i * 2 + 1];
      direct = false;
    } else if (path.partial || dd > b.arrive + 1.5 || !sameLevel) {
      // Path exhausted short of the goal (long trip leg or partial result): plan the next leg.
      if (sys.now - b.pathTime > 0.5) requestPath(sys, b, p);
    }
  } else if (path.status === PATH_IDLE || (path.status === PATH_FAILED && sys.now - b.pathTime > 4)) {
    requestPath(sys, b, p);
  }
  let dx = tx - px, dz = tz - pz;
  const l = hyp(dx, dz);
  if (l < 1e-4) return;
  dx /= l;
  dz /= l;
  if (direct) {
    // No path yet (or none possible): steer straight with feelers around static obstacles.
    if (blockedAhead(sys, px, pz, dx, dz)) {
      for (let k = 0; k < FEELER_ANGLES.length; k++) {
        const a = FEELER_ANGLES[k] * (b.sidestepDir >= 0 ? 1 : -1);
        const c = Math.cos(a), s = Math.sin(a);
        const rx = dx * c - dz * s, rz = dx * s + dz * c;
        if (!blockedAhead(sys, px, pz, rx, rz)) {
          dx = rx;
          dz = rz;
          break;
        }
      }
    }
  }
  // Vehicle hulls in the way: walk around them (sliding along a hull hit head-on goes nowhere).
  if (avoidVehicles(sys, b, p, dx, dz, dd)) {
    dx = avoidX;
    dz = avoidZ;
  }
  if (sys.now < b.sidestepUntil) {
    // Recovery sidestep: perpendicular, slightly forward.
    const sx = -dz * b.sidestepDir, sz = dx * b.sidestepDir;
    dx = sx * 0.9 + dx * 0.3;
    dz = sz * 0.9 + dz * 0.3;
    const sl = hyp(dx, dz);
    dx /= sl;
    dz /= sl;
  }
  b.moveX = dx;
  b.moveZ = dz;
  // Slow down for the final approach so the bot stops on the spot.
  b.moveScale = dd < 2.5 ? Math.max(0.45, dd / 2.5) : 1;
}

/** How far ahead (m) a vehicle hull counts as in the way, and the clearance kept from it. */
const VEH_LOOK = 2;
const VEH_PAD = PLAYER_RADIUS + 0.1;
/** Seconds the chosen way around a hull is kept (no dithering at its corners). */
const VEH_SIDE_HOLD = 1.2;
const vehNear: VehicleState[] = [];
let avoidX = 0, avoidZ = 0;

/** Entry distance of the ray (x, z) + t (dx, dz), t in [0, len], into o's footprint grown by pad. */
function rayFootprint(o: CharObstacle, x: number, z: number, dx: number, dz: number, len: number, pad: number): number {
  const ox = x - o.x, oz = z - o.z;
  const lx = ox * o.c - oz * o.s, lz = ox * o.s + oz * o.c;
  const ldx = dx * o.c - dz * o.s, ldz = dx * o.s + dz * o.c;
  let t0 = 0, t1 = len;
  for (let axis = 0; axis < 2; axis++) {
    const p0 = axis === 0 ? lx : lz, d = axis === 0 ? ldx : ldz, h = (axis === 0 ? o.hx : o.hz) + pad;
    if (Math.abs(d) < 1e-9) {
      if (p0 < -h || p0 > h) return -1;
      continue;
    }
    let a = (-h - p0) / d, c = (h - p0) / d;
    if (a > c) { const tmp = a; a = c; c = tmp; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return -1;
  }
  return t0;
}

/**
 * Steer around the nearest vehicle hull that blocks the next VEH_LOOK metres toward the target
 * (`dist` away): along the hull (tangent of its outline) in a kept orbit sense, slightly outward.
 * Writes avoidX/avoidZ and returns true when steering is needed.
 */
function avoidVehicles(sys: BotSystem, b: BotState, p: PlayerState, dx: number, dz: number, dist: number): boolean {
  if (p.mode !== 'ground' && p.mode !== 'swim') return false;
  const look = Math.min(VEH_LOOK, dist);
  if (look < 0.05) return false;
  const px = p.pos.x, pz = p.pos.z;
  const near = sys.sim.vehiclesNear(px, pz, VEH_LOOK + 4, vehNear);
  let best: CharObstacle | null = null;
  let bestId = -1, bestT = Infinity;
  for (let i = 0; i < near.length; i++) {
    const o = vehicleObstacle(near[i]);
    // Only hulls the body bumps into (not one it stands on or walks under).
    if (o.y1 <= p.pos.y + STEP_HEIGHT || o.y0 >= p.pos.y + STANCE_HEIGHT[p.stance]) continue;
    const t = rayFootprint(o, px, pz, dx, dz, look, VEH_PAD);
    if (t >= 0 && t < bestT) {
      bestT = t;
      best = o;
      bestId = near[i].id;
    }
  }
  if (!best) return false;
  // Outward normal from the hull outline toward the bot.
  const ox = px - best.x, oz = pz - best.z;
  const lx = ox * best.c - oz * best.s, lz = ox * best.s + oz * best.c;
  const cx = lx < -best.hx ? -best.hx : lx > best.hx ? best.hx : lx;
  const cz = lz < -best.hz ? -best.hz : lz > best.hz ? best.hz : lz;
  let nlx = lx - cx, nlz = lz - cz;
  let nl = hyp(nlx, nlz);
  if (nl < 1e-6) { nlx = lx; nlz = lz; nl = hyp(nlx, nlz) || 1; }
  nlx /= nl; nlz /= nl;
  const nx = best.c * nlx + best.s * nlz, nz = -best.s * nlx + best.c * nlz;
  // Tangent for orbit sense +1 (rotating the normal by +90 degrees).
  const tx = -nz, tz = nx;
  if (b.vehAvoidId !== bestId || sys.now > b.vehAvoidUntil) {
    // The way the bot already leans to; head-on, the way toward the nearer end of the hull.
    const lean = tx * dx + tz * dz;
    b.vehAvoidSide = Math.abs(lean) > 0.1 ? (lean > 0 ? 1 : -1) : tx * ox + tz * oz >= 0 ? 1 : -1;
  }
  b.vehAvoidId = bestId;
  b.vehAvoidUntil = sys.now + VEH_SIDE_HOLD;
  const sx = tx * b.vehAvoidSide + nx * 0.3, sz = tz * b.vehAvoidSide + nz * 0.3;
  const sl = hyp(sx, sz) || 1;
  avoidX = sx / sl;
  avoidZ = sz / sl;
  return true;
}

function blockedAhead(sys: BotSystem, x: number, z: number, dx: number, dz: number): boolean {
  const g = sys.grid;
  for (let s = 0.8; s <= 2.01; s += 0.6) {
    const f = g.flagsAt(x + dx * s, z + dz * s, false);
    if (f !== NF_UNKNOWN && f & NF_BLOCKED) return true;
  }
  return false;
}

/**
 * Think-time stuck detection. Escalation: jump -> sidestep -> repath -> give up the destination.
 * Returns true when the destination was abandoned.
 */
export function checkStuck(sys: BotSystem, b: BotState, p: PlayerState): boolean {
  const t = sys.now;
  const wantsMove = b.hasDest && b.moveScale > 0.3 && (p.mode === 'ground' || p.mode === 'swim') && !p.use && !p.revive;
  if (!wantsMove) {
    b.stuckRefX = p.pos.x;
    b.stuckRefZ = p.pos.z;
    b.stuckRefTime = t;
    return false;
  }
  if (t - b.stuckRefTime < STUCK_TIME) return false;
  const moved = hyp(p.pos.x - b.stuckRefX, p.pos.z - b.stuckRefZ);
  b.stuckRefX = p.pos.x;
  b.stuckRefZ = p.pos.z;
  b.stuckRefTime = t;
  if (moved >= STUCK_MIN_MOVE) {
    if (moved > 2) b.stuckLevel = 0;
    return false;
  }
  b.stuckLevel++;
  switch (b.stuckLevel) {
    case 1:
      b.jumpNow = true;
      return false;
    case 2:
      b.sidestepDir = b.rng.chance(0.5) ? 1 : -1;
      b.sidestepUntil = t + 0.8;
      b.jumpNow = true;
      return false;
    case 3:
      b.sidestepDir = -b.sidestepDir;
      b.sidestepUntil = t + 0.6;
      requestPath(sys, b, p);
      return false;
    default:
      b.avoidX = b.destX;
      b.avoidZ = b.destZ;
      b.avoidUntil = t + 30;
      b.stuckLevel = 0;
      clearDest(sys, b);
      return true;
  }
}

/** Write mx/mz for a world move direction given the yaw the input will carry. */
export function moveAxes(b: BotState, yaw: number, out: { mx: number; mz: number }): void {
  const s = b.moveScale;
  if (s <= 0) {
    out.mx = 0;
    out.mz = 0;
    return;
  }
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  // right = (cos, 0, -sin), forward = (-sin, 0, -cos)
  out.mx = (b.moveX * c - b.moveZ * sn) * s;
  out.mz = (-b.moveX * sn - b.moveZ * c) * s;
}

/** Bearing (yaw) of the current move direction. */
export function moveYaw(b: BotState): number {
  return Math.atan2(-b.moveX, -b.moveZ);
}

/** Is the move direction roughly where the bot is looking (sprint allowed)? */
export function facingMove(b: BotState): boolean {
  return Math.abs(angleDiff(b.aimYaw, moveYaw(b))) < 0.6;
}
