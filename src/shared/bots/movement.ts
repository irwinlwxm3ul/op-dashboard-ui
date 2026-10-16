// Bot locomotion: destinations, path following (A* waypoints with look-ahead), direct steering
// with grid feelers while a path is pending, stuck detection with escalating recovery, and the
// conversion of a world-space move direction into PlayerInput axes.

import { hyp } from './util';
import { angleDiff } from '../math';
import type { PlayerState } from '../types';
import { NF_BLOCKED, NF_NEAR, NF_UNKNOWN } from './nav';
import { MAX_PLAN_DIST, PATH_DONE, PATH_FAILED, PATH_IDLE } from './pathfind';
import type { BotState } from './state';
import type { BotSystem } from './system';

/** Seconds without progress before the bot counts as stuck. */
const STUCK_TIME = 1.5;
const STUCK_MIN_MOVE = 0.8;
/** Repath when the destination moved this far from the planned goal. */
const REPATH_MOVE = 3;
const FEELER_ANGLES: readonly number[] = [0.45, -0.45, 0.9, -0.9, 1.4, -1.4];

export function setDest(sys: BotSystem, b: BotState, p: PlayerState, x: number, z: number, arrive: number, sprint: boolean): void {
  b.arrive = arrive;
  b.sprint = sprint;
  b.walk = false;
  if (b.hasDest && Math.abs(x - b.destX) < 0.5 && Math.abs(z - b.destZ) < 0.5) return;
  b.hasDest = true;
  b.destX = x;
  b.destZ = z;
  const moved = hyp(x - b.pathGX, z - b.pathGZ);
  if (b.path.status === PATH_IDLE || b.path.status === PATH_FAILED || moved > REPATH_MOVE) requestPath(sys, b, p);
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
  if (hyp(b.destX - px, b.destZ - pz) <= DIRECT_DIST && sys.grid.lineOfWalk(px, pz, b.destX, b.destZ, false, false) &&
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
  sys.planner.request(b.path, px, pz, b.destX, b.destZ);
}

/** Distance to the current destination (XZ), Infinity without one. */
export function destDistance(b: BotState, p: PlayerState): number {
  return b.hasDest ? hyp(b.destX - p.pos.x, b.destZ - p.pos.z) : Infinity;
}

export function arrived(b: BotState, p: PlayerState): boolean {
  return b.hasDest && destDistance(b, p) <= b.arrive;
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
  if (dd <= b.arrive) return;
  let tx = b.destX, tz = b.destZ;
  const path = b.path;
  let direct = true;
  if (path.status === PATH_DONE && path.count > 0) {
    // Advance past reached waypoints; look ahead one waypoint when it is directly walkable.
    let i = b.pathIdx;
    while (i < path.count) {
      const wx = path.pts[i * 2], wz = path.pts[i * 2 + 1];
      const d = hyp(wx - px, wz - pz);
      // Tight waypoints (doorways, corners) must really be reached before turning.
      const reach = i === path.count - 1 ? b.arrive : sys.grid.flagsAt(wx, wz, false) & NF_NEAR ? 0.4 : 0.75;
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
    } else if (path.partial || dd > b.arrive + 1.5) {
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

/** Long trips are planned in legs; true when the destination is beyond one A* window. */
export function isLongTrip(b: BotState, p: PlayerState): boolean {
  return destDistance(b, p) > MAX_PLAN_DIST;
}
