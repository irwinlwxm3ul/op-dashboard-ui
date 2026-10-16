// Orientation helpers and spatial queries against a vehicle's oriented box: seat placement, exit
// spots, ray casts (bullets), point tests (run-over) and the hull as a character-controller
// obstacle (players on foot collide with vehicles).

import { PLAYER_RADIUS } from '../constants';
import type { CharObstacle } from '../physics';
import type { EntityId, RockDef, TreeDef, Vec3, VehicleState, World, WorldBox } from '../types';
import { VEHICLES, rideHeight } from './defs';

// ---------------------------------------------------------------------------
// Orientation basis
// ---------------------------------------------------------------------------

/**
 * World-space axes of a vehicle (columns of R = Ry(yaw) Rx(pitch) Rz(roll)).
 * `right` = local +X, `up` = local +Y, `back` = local +Z (forward is -back).
 */
export interface Basis {
  right: Vec3;
  up: Vec3;
  back: Vec3;
}

export function makeBasis(): Basis {
  return { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, back: { x: 0, y: 0, z: 1 } };
}

/** Fill `b` with the axes for the given Euler angles (three.js order 'YXZ'). */
export function basisFromAngles(yaw: number, pitch: number, roll: number, b: Basis): Basis {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  b.right.x = cy * cr + sy * sp * sr;
  b.right.y = cp * sr;
  b.right.z = -sy * cr + cy * sp * sr;
  b.up.x = -cy * sr + sy * sp * cr;
  b.up.y = cp * cr;
  b.up.z = sy * sr + cy * sp * cr;
  b.back.x = sy * cp;
  b.back.y = -sp;
  b.back.z = cy * cp;
  return b;
}

const basis = makeBasis();

/** Transform a local-space point of the vehicle into world space. */
export function localToWorld(v: VehicleState, local: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  basisFromAngles(v.yaw, v.pitch, v.roll, basis);
  const { right: r, up: u, back: k } = basis;
  const lx = local.x, ly = local.y, lz = local.z;
  out.x = v.pos.x + r.x * lx + u.x * ly + k.x * lz;
  out.y = v.pos.y + r.y * lx + u.y * ly + k.y * lz;
  out.z = v.pos.z + r.z * lx + u.z * ly + k.z * lz;
  return out;
}

/** Transform a world-space point into the vehicle's local frame. */
export function worldToLocal(v: VehicleState, p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  basisFromAngles(v.yaw, v.pitch, v.roll, basis);
  const dx = p.x - v.pos.x, dy = p.y - v.pos.y, dz = p.z - v.pos.z;
  const { right: r, up: u, back: k } = basis;
  out.x = dx * r.x + dy * r.y + dz * r.z;
  out.y = dx * u.x + dy * u.y + dz * u.z;
  out.z = dx * k.x + dy * k.y + dz * k.z;
  return out;
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * World position of a seated occupant's body origin (feet level, plays the role of
 * CharacterBody.pos). Out-of-range seats clamp to the nearest valid seat.
 */
export function seatWorldPosition(v: VehicleState, seat: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const offs = VEHICLES[v.type].seatOffsets;
  const i = seat < 0 || !Number.isFinite(seat) ? 0 : seat >= offs.length ? offs.length - 1 : Math.floor(seat);
  return localToWorld(v, offs[i], out);
}

// ---------------------------------------------------------------------------
// Ray cast / point test
// ---------------------------------------------------------------------------

/**
 * Ray versus the vehicle's oriented collision box. `dir` must be normalised. Returns the entry
 * distance along the ray (0 when the origin is inside the box) or -1 for a miss / beyond maxDist.
 */
export function raycastVehicle(v: VehicleState, origin: Vec3, dir: Vec3, maxDist: number): number {
  const he = VEHICLES[v.type].halfExtents;
  basisFromAngles(v.yaw, v.pitch, v.roll, basis);
  const { right: r, up: u, back: k } = basis;
  const dx = origin.x - v.pos.x, dy = origin.y - v.pos.y, dz = origin.z - v.pos.z;
  // Local origin / direction.
  const ox = dx * r.x + dy * r.y + dz * r.z;
  const oy = dx * u.x + dy * u.y + dz * u.z;
  const oz = dx * k.x + dy * k.y + dz * k.z;
  const lx = dir.x * r.x + dir.y * r.y + dir.z * r.z;
  const ly = dir.x * u.x + dir.y * u.y + dir.z * u.z;
  const lz = dir.x * k.x + dir.y * k.y + dir.z * k.z;
  let tmin = 0, tmax = maxDist;
  // Slab test per axis.
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? ox : axis === 1 ? oy : oz;
    const d = axis === 0 ? lx : axis === 1 ? ly : lz;
    const h = axis === 0 ? he.x : axis === 1 ? he.y : he.z;
    if (Math.abs(d) < 1e-12) {
      if (o < -h || o > h) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv, t2 = (h - o) * inv;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * Whether a point (e.g. a player's body centre) lies within the vehicle box inflated by `radius`.
 * The box is extended down to the ground (through the ground clearance) so a standing person in
 * front of the bumper is hit, not driven over.
 */
export function vehicleHitsPoint(v: VehicleState, p: Vec3, radius: number): boolean {
  const def = VEHICLES[v.type];
  const he = def.halfExtents;
  basisFromAngles(v.yaw, v.pitch, v.roll, basis);
  const { right: r, up: u, back: k } = basis;
  const dx = p.x - v.pos.x, dy = p.y - v.pos.y, dz = p.z - v.pos.z;
  const lx = dx * r.x + dy * r.y + dz * r.z;
  if (lx < -he.x - radius || lx > he.x + radius) return false;
  const lz = dx * k.x + dy * k.y + dz * k.z;
  if (lz < -he.z - radius || lz > he.z + radius) return false;
  const ly = dx * u.x + dy * u.y + dz * u.z;
  return ly >= -he.y - def.groundClearance - radius && ly <= he.y + radius;
}

// ---------------------------------------------------------------------------
// Character-controller obstacle (players on foot vs vehicle hulls)
// ---------------------------------------------------------------------------

/** Obstacle plus the pose it was built from (rebuilt only when the vehicle moved). */
interface CachedObstacle extends CharObstacle {
  kType: string;
  kx: number;
  ky: number;
  kz: number;
  kYaw: number;
  kPitch: number;
  kRoll: number;
}

const obstacleCache = new WeakMap<VehicleState, CachedObstacle>();

/**
 * The vehicle's hull as a character-controller obstacle: the oriented box projected onto its yaw
 * frame (footprint), extended down through the ground clearance like `vehicleHitsPoint` (nobody
 * crawls under a car), with the tilted roof plane as its top. Cached per vehicle object and
 * rebuilt when its pose changed, so parked vehicles cost nothing. Deterministic: the server and
 * client prediction get identical obstacles from identical vehicle states.
 */
export function vehicleObstacle(v: VehicleState): CharObstacle {
  let o = obstacleCache.get(v);
  if (o && o.kType === v.type && o.kx === v.pos.x && o.ky === v.pos.y && o.kz === v.pos.z
    && o.kYaw === v.yaw && o.kPitch === v.pitch && o.kRoll === v.roll) return o;
  if (!o) {
    o = {
      x: 0, z: 0, c: 1, s: 0, hx: 0, hz: 0, br: 0, y0: 0, y1: 0, top: 0, gx: 0, gz: 0,
      kType: '', kx: 0, ky: 0, kz: 0, kYaw: 0, kPitch: 0, kRoll: 0,
    };
    obstacleCache.set(v, o);
  }
  o.kType = v.type; o.kx = v.pos.x; o.ky = v.pos.y; o.kz = v.pos.z;
  o.kYaw = v.yaw; o.kPitch = v.pitch; o.kRoll = v.roll;
  const def = VEHICLES[v.type];
  const he = def.halfExtents;
  basisFromAngles(v.yaw, v.pitch, v.roll, basis);
  const { right: r, up: u, back: k } = basis;
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  // Box half extents along the yaw frame axes (+X = (c, 0, -s), +Z = (s, 0, c)) and vertically.
  const hx = Math.abs(r.x * c - r.z * s) * he.x + Math.abs(u.x * c - u.z * s) * he.y + Math.abs(k.x * c - k.z * s) * he.z;
  const hz = Math.abs(r.x * s + r.z * c) * he.x + Math.abs(u.x * s + u.z * c) * he.y + Math.abs(k.x * s + k.z * c) * he.z;
  const hy = Math.abs(r.y) * he.x + Math.abs(u.y) * he.y + Math.abs(k.y) * he.z;
  o.x = v.pos.x;
  o.z = v.pos.z;
  o.c = c;
  o.s = s;
  o.hx = hx;
  o.hz = hz;
  o.br = Math.sqrt(hx * hx + hz * hz);
  o.y0 = v.pos.y - hy - def.groundClearance;
  o.y1 = v.pos.y + hy;
  if (u.y > 0.5) {
    // Roof plane through the top face centre with normal `up`, as a height field over XZ.
    const tx = v.pos.x + u.x * he.y, ty = v.pos.y + u.y * he.y, tz = v.pos.z + u.z * he.y;
    o.gx = -u.x / u.y;
    o.gz = -u.z / u.y;
    o.top = ty + o.gx * (v.pos.x - tx) + o.gz * (v.pos.z - tz);
  } else {
    // On its side or upside down: the whole span is solid.
    o.gx = 0;
    o.gz = 0;
    o.top = o.y1;
  }
  return o;
}

/**
 * Collect the hull obstacles of the vehicles in `list` that a body at (x, z) can touch within
 * `reach` metres (its radius plus its travel this step), skipping vehicle `skip`. Writes `out`.
 */
export function vehicleObstacles(
  list: readonly VehicleState[], x: number, z: number, reach: number, out: CharObstacle[], skip: EntityId | null = null,
): CharObstacle[] {
  out.length = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.id === skip) continue;
    const he = VEHICLES[v.type].halfExtents;
    // Bounding radius of the box in any orientation.
    const R = Math.sqrt(he.x * he.x + he.y * he.y + he.z * he.z) + reach;
    const dx = v.pos.x - x, dz = v.pos.z - z;
    if (dx * dx + dz * dz >= R * R) continue;
    out.push(vehicleObstacle(v));
  }
  return out;
}

/**
 * The hull obstacles a body on foot at `pos` moving at `vel` can touch during a step of `dt`
 * seconds. The server's player tick and client prediction both use this, so they hand the
 * character controller the same obstacles for the same vehicle states.
 */
export function footObstacles(
  list: readonly VehicleState[], pos: Vec3, vel: Vec3, dt: number, out: CharObstacle[],
): CharObstacle[] {
  const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  return vehicleObstacles(list, pos.x, pos.z, PLAYER_RADIUS + (Number.isFinite(hs) ? hs : 0) * dt + 1.5, out);
}

// ---------------------------------------------------------------------------
// Exit position
// ---------------------------------------------------------------------------

const exitBoxBuf: WorldBox[] = [];
const exitTreeBuf: TreeDef[] = [];
const exitRockBuf: RockDef[] = [];
let exitBoxes: WorldBox[] = exitBoxBuf;
let exitTrees: TreeDef[] = exitTreeBuf;
let exitRocks: RockDef[] = exitRockBuf;
const segBoxes: WorldBox[] = [];
const rayO: Vec3 = { x: 0, y: 0, z: 0 };
const rayD: Vec3 = { x: 0, y: 0, z: 0 };
const seatScratch: Vec3 = { x: 0, y: 0, z: 0 };

/** Body height that must be free above an exit spot (standing). */
const EXIT_HEADROOM = 1.8;
/** Clearance between the vehicle side and the exiting player's capsule. */
const EXIT_GAP = 0.3;
/** Tree trunk collision height as a fraction of the tree height (matches the physics module). */
const TREE_TRUNK_FRAC = 0.6;
/** Box tops this far above the vehicle floor do not count as ground for the exit spot. */
const EXIT_STEP = 0.6;

/**
 * Where an occupant of `seat` is placed when leaving the vehicle: beside the seat, falling back to
 * the other side, behind, in front, and finally on top of the vehicle. The spot is free of world
 * colliders for a standing player, reachable from the seat without passing through a wall, and
 * at ground height (box tops such as floors/roofs count as ground).
 */
export function exitPosition(v: VehicleState, seat: number, world: World): Vec3 {
  const def = VEHICLES[v.type];
  const he = def.halfExtents;
  const offs = def.seatOffsets;
  const si = seat < 0 || !Number.isFinite(seat) ? 0 : seat >= offs.length ? offs.length - 1 : Math.floor(seat);
  const so = offs[si];
  const side = so.x > 0.05 ? 1 : so.x < -0.05 ? -1 : si % 2 === 0 ? -1 : 1;
  const sideX = he.x + PLAYER_RADIUS + EXIT_GAP;
  const endZ = he.z + PLAYER_RADIUS + EXIT_GAP;
  const sz = so.z;
  // Candidate exit spots in local XZ, in order of preference.
  const cands: number[] = [
    side * sideX, sz,
    -side * sideX, sz,
    side * sideX, sz + 1.0,
    side * sideX, sz - 1.0,
    -side * sideX, sz + 1.0,
    -side * sideX, sz - 1.0,
    0, endZ,
    0, -endZ,
    side * (sideX + 0.8), sz,
    -side * (sideX + 0.8), sz,
  ];
  const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
  const floorY = v.pos.y - rideHeight(def);
  const seatPos = seatWorldPosition(v, si, seatScratch);
  const lim = world.half - 1;
  let fallback: Vec3 | null = null;

  for (let i = 0; i < cands.length; i += 2) {
    const lx = cands[i], lz = cands[i + 1];
    // Local -> world on the horizontal plane (yaw only: the player stands upright).
    const x = v.pos.x + cy * lx + sy * lz;
    const z = v.pos.z - sy * lx + cy * lz;
    if (x < -lim || x > lim || z < -lim || z > lim) continue;
    gatherExit(world, x, z, PLAYER_RADIUS + 0.5);
    const g = exitGround(world, x, z, floorY + EXIT_STEP);
    if (spotBlocked(x, z, g)) continue;
    if (pathBlocked(world, seatPos, x, z, g)) continue;
    const y = waterAdjusted(world, g);
    // Prefer spots without a big drop (bridges, cliffs, roofs); keep the first such as fallback.
    if (floorY - g > 3) {
      if (!fallback) fallback = { x, y, z };
      continue;
    }
    return { x, y, z };
  }
  if (fallback) return fallback;
  // Last resort: stand on top of the vehicle.
  basisFromAngles(v.yaw, v.pitch, v.roll, basis);
  return {
    x: v.pos.x + basis.up.x * he.y,
    y: v.pos.y + basis.up.y * he.y + 0.05,
    z: v.pos.z + basis.up.z * he.y,
  };
}

function gatherExit(world: World, x: number, z: number, m: number): void {
  exitBoxBuf.length = 0;
  exitTreeBuf.length = 0;
  exitRockBuf.length = 0;
  exitBoxes = world.queryBoxes(x - m, z - m, x + m, z + m, exitBoxBuf);
  exitTrees = world.queryTrees(x - m, z - m, x + m, z + m, exitTreeBuf);
  exitRocks = world.queryRocks(x - m, z - m, x + m, z + m, exitRockBuf);
}

/** Highest terrain / box top under (x, z) at or below refY. */
function exitGround(world: World, x: number, z: number, refY: number): number {
  let g = world.heightAt(x, z);
  for (let i = 0; i < exitBoxes.length; i++) {
    const b = exitBoxes[i];
    const top = b.max.y;
    if (top > g && top <= refY && x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) g = top;
  }
  return g;
}

/** Whether a standing player capsule at (x, g, z) overlaps any gathered collider. */
function spotBlocked(x: number, z: number, g: number): boolean {
  const r = PLAYER_RADIUS + 0.05;
  const y0 = g + 0.05, y1 = g + EXIT_HEADROOM;
  for (let i = 0; i < exitBoxes.length; i++) {
    const b = exitBoxes[i];
    if (b.max.y <= y0 || b.min.y >= y1) continue;
    const cx = x < b.min.x ? b.min.x : x > b.max.x ? b.max.x : x;
    const cz = z < b.min.z ? b.min.z : z > b.max.z ? b.max.z : z;
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  for (let i = 0; i < exitTrees.length; i++) {
    const t = exitTrees[i];
    if (t.y + t.h * TREE_TRUNK_FRAC <= y0 || t.y >= y1) continue;
    const dx = x - t.x, dz = z - t.z, R = t.r + r;
    if (dx * dx + dz * dz < R * R) return true;
  }
  for (let i = 0; i < exitRocks.length; i++) {
    const k = exitRocks[i];
    if (k.y + k.h <= y0 || k.y >= y1) continue;
    const dx = x - k.x, dz = z - k.z, R = k.r + r;
    if (dx * dx + dz * dz < R * R) return true;
  }
  return false;
}

/** Whether a wall lies between the seat and the exit spot (tested at chest height). */
function pathBlocked(world: World, seat: Vec3, x: number, z: number, g: number): boolean {
  const y0 = seat.y + 0.9;
  const y1 = g + 1.0;
  rayO.x = seat.x; rayO.y = y0; rayO.z = seat.z;
  let dx = x - seat.x, dy = y1 - y0, dz = z - seat.z;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-6) return false;
  dx /= l; dy /= l; dz /= l;
  rayD.x = dx; rayD.y = dy; rayD.z = dz;
  const m = 0.2;
  segBoxes.length = 0;
  const minX = Math.min(seat.x, x) - m, maxX = Math.max(seat.x, x) + m;
  const minZ = Math.min(seat.z, z) - m, maxZ = Math.max(seat.z, z) + m;
  const boxes = world.queryBoxes(minX, minZ, maxX, maxZ, segBoxes);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (segmentHitsBox(rayO, rayD, l, b.min, b.max)) return true;
  }
  return false;
}

/** Slab test of a finite segment against an AABB (strictly entering it before `len`). */
function segmentHitsBox(o: Vec3, d: Vec3, len: number, mn: Vec3, mx: Vec3): boolean {
  let tmin = 0, tmax = len;
  for (let axis = 0; axis < 3; axis++) {
    const oo = axis === 0 ? o.x : axis === 1 ? o.y : o.z;
    const dd = axis === 0 ? d.x : axis === 1 ? d.y : d.z;
    const lo = axis === 0 ? mn.x : axis === 1 ? mn.y : mn.z;
    const hi = axis === 0 ? mx.x : axis === 1 ? mx.y : mx.z;
    if (Math.abs(dd) < 1e-12) {
      if (oo <= lo || oo >= hi) return false;
      continue;
    }
    const inv = 1 / dd;
    let t1 = (lo - oo) * inv, t2 = (hi - oo) * inv;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin >= tmax) return false;
  }
  return true;
}

function waterAdjusted(world: World, g: number): number {
  // In deep water place the player at swimming depth instead of on the sea floor.
  const surfaceFeet = world.waterLevel - 1.25;
  return g < surfaceFeet ? surfaceFeet : g;
}
