// Low-level collision queries against the static world: a vertical cylinder (circle in XZ plus a
// vertical span) versus axis-aligned boxes, tree trunks and rocks.
//
// The character controller and drop movement call `gatherNear` once per step (with a margin that
// covers everything the step can reach) and then run many queries against the gathered candidate
// lists. The candidate lists and result scratch objects are module-level so the per-tick hot path
// does not allocate. Nothing here is re-entrant across a `gatherNear` call, which is fine because
// JavaScript is single threaded and none of these functions call back into user code (other than
// the World query methods).

import { PLAYER_RADIUS, STANCE_HEIGHT, STEP_HEIGHT } from '../constants';
import type { RockDef, Stance, TreeDef, Vec3, World, WorldBox } from '../types';
import { CONTACT_SKIN, COS_MAX_SLOPE, TREE_TRUNK_FRAC } from './tuning';

// ---------------------------------------------------------------------------
// Candidate gathering
// ---------------------------------------------------------------------------

const boxBuf: WorldBox[] = [];
const treeBuf: TreeDef[] = [];
const rockBuf: RockDef[] = [];
let nearBoxes: WorldBox[] = boxBuf;
let nearTrees: TreeDef[] = treeBuf;
let nearRocks: RockDef[] = rockBuf;

/** Collect the colliders around (x, z) within `margin` (square region) into the module lists. */
export function gatherNear(world: World, x: number, z: number, margin: number): void {
  // World query implementations append into `out`; clear first so stale entries never leak in.
  boxBuf.length = 0;
  treeBuf.length = 0;
  rockBuf.length = 0;
  const x0 = x - margin, z0 = z - margin, x1 = x + margin, z1 = z + margin;
  nearBoxes = world.queryBoxes(x0, z0, x1, z1, boxBuf);
  nearTrees = world.queryTrees(x0, z0, x1, z1, treeBuf);
  nearRocks = world.queryRocks(x0, z0, x1, z1, rockBuf);
}

// ---------------------------------------------------------------------------
// Primitive tests
// ---------------------------------------------------------------------------

/** Circle (x, z, r) strictly overlaps the XZ rectangle of box b. */
export function circleOverlapsRect(x: number, z: number, r: number, b: WorldBox): boolean {
  if (r <= 0) return false;
  const cx = x < b.min.x ? b.min.x : x > b.max.x ? b.max.x : x;
  const cz = z < b.min.z ? b.min.z : z > b.max.z ? b.max.z : z;
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

// Push-out normal written by the penetration helpers.
let pnx = 0, pnz = 0;
/** Penetrations smaller than this are treated as touching (avoids endless re-pushing from
 *  floating point rounding after a body was placed exactly on a surface). */
const MIN_PEN = 1e-7;

/** Penetration depth of circle (x, z, r) into the XZ rectangle of b (0 if none); sets pnx/pnz. */
function penetrateBox(b: WorldBox, x: number, z: number, r: number): number {
  const cx = x < b.min.x ? b.min.x : x > b.max.x ? b.max.x : x;
  const cz = z < b.min.z ? b.min.z : z > b.max.z ? b.max.z : z;
  const dx = x - cx, dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return 0;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const pen = r - d;
    if (pen <= MIN_PEN) return 0;
    pnx = dx / d;
    pnz = dz / d;
    return pen;
  }
  // Centre inside the rectangle: leave through the nearest side (fixed tie-break order keeps
  // this deterministic).
  let m = x - b.min.x;
  pnx = -1; pnz = 0;
  const toMaxX = b.max.x - x, toMinZ = z - b.min.z, toMaxZ = b.max.z - z;
  if (toMaxX < m) { m = toMaxX; pnx = 1; pnz = 0; }
  if (toMinZ < m) { m = toMinZ; pnx = 0; pnz = -1; }
  if (toMaxZ < m) { m = toMaxZ; pnx = 0; pnz = 1; }
  return m + r;
}

/** Penetration of circle (x, z, r) into a vertical cylinder footprint (cx, cz, cr); sets pnx/pnz. */
function penetrateCylinder(cx: number, cz: number, cr: number, x: number, z: number, r: number): number {
  const dx = x - cx, dz = z - cz;
  const R = cr + r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= R * R) return 0;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const pen = R - d;
    if (pen <= MIN_PEN) return 0;
    pnx = dx / d;
    pnz = dz / d;
    return pen;
  }
  pnx = 1;
  pnz = 0;
  return R;
}

// ---------------------------------------------------------------------------
// Circle resolution
// ---------------------------------------------------------------------------

/** Result of the last `resolveCircle` call (reused scratch). */
export const resolved = {
  x: 0,
  z: 0,
  /** Total push applied (vector sum). */
  pushX: 0,
  pushZ: 0,
  /** Largest single penetration found. */
  maxDepth: 0,
  contacts: 0,
};

function clipVelocity(vel: Vec3 | null): void {
  if (!vel) return;
  const vn = vel.x * pnx + vel.z * pnz;
  if (vn < 0) {
    vel.x -= vn * pnx;
    vel.z -= vn * pnz;
  }
}

/**
 * Push the circle (x, z, r) out of every gathered collider whose vertical extent overlaps the open
 * span (y0, y1). Velocity (if given) loses its component into each contact normal so the body
 * slides along walls. Writes the result into `resolved`.
 */
export function resolveCircle(x: number, z: number, r: number, y0: number, y1: number, vel: Vec3 | null): void {
  let px = x, pz = z, tx = 0, tz = 0, maxDepth = 0, contacts = 0;
  for (let iter = 0; iter < 4; iter++) {
    let any = false;
    for (let i = 0; i < nearBoxes.length; i++) {
      const b = nearBoxes[i];
      if (b.max.y <= y0 || b.min.y >= y1) continue;
      const d = penetrateBox(b, px, pz, r);
      if (d > 0) {
        px += pnx * d; pz += pnz * d; tx += pnx * d; tz += pnz * d;
        if (d > maxDepth) maxDepth = d;
        contacts++;
        clipVelocity(vel);
        any = true;
      }
    }
    for (let i = 0; i < nearTrees.length; i++) {
      const t = nearTrees[i];
      if (t.y + t.h * TREE_TRUNK_FRAC <= y0 || t.y >= y1) continue;
      const d = penetrateCylinder(t.x, t.z, t.r, px, pz, r);
      if (d > 0) {
        px += pnx * d; pz += pnz * d; tx += pnx * d; tz += pnz * d;
        if (d > maxDepth) maxDepth = d;
        contacts++;
        clipVelocity(vel);
        any = true;
      }
    }
    for (let i = 0; i < nearRocks.length; i++) {
      const k = nearRocks[i];
      if (k.y + k.h <= y0 || k.y >= y1) continue;
      const d = penetrateCylinder(k.x, k.z, k.r, px, pz, r);
      if (d > 0) {
        px += pnx * d; pz += pnz * d; tx += pnx * d; tz += pnz * d;
        if (d > maxDepth) maxDepth = d;
        contacts++;
        clipVelocity(vel);
        any = true;
      }
    }
    if (!any) break;
  }
  resolved.x = px;
  resolved.z = pz;
  resolved.pushX = tx;
  resolved.pushZ = tz;
  resolved.maxDepth = maxDepth;
  resolved.contacts = contacts;
}

// ---------------------------------------------------------------------------
// Support (ground), ceilings, headroom
// ---------------------------------------------------------------------------

export const SUPPORT_TERRAIN = 0;
export const SUPPORT_BOX = 1;
export const SUPPORT_ROCK = 2;

/** Result of the last `supportHeight` call. */
export const support = { h: 0, kind: SUPPORT_TERRAIN as number };

/**
 * Highest standable surface under the footprint circle (x, z, rs) whose top is at or below
 * `refTop`: terrain under the centre, box tops (floors, roofs, crates, stair steps) and rock tops.
 */
export function supportHeight(world: World, x: number, z: number, refTop: number, rs: number): number {
  let h = world.heightAt(x, z);
  let kind = SUPPORT_TERRAIN;
  for (let i = 0; i < nearBoxes.length; i++) {
    const b = nearBoxes[i];
    const top = b.max.y;
    if (top > h && top <= refTop && circleOverlapsRect(x, z, rs, b)) {
      h = top;
      kind = SUPPORT_BOX;
    }
  }
  for (let i = 0; i < nearRocks.length; i++) {
    const k = nearRocks[i];
    const top = k.y + k.h;
    if (top > h && top <= refTop) {
      const dx = x - k.x, dz = z - k.z, R = k.r + rs;
      if (dx * dx + dz * dz < R * R) {
        h = top;
        kind = SUPPORT_ROCK;
      }
    }
  }
  support.h = h;
  support.kind = kind;
  return h;
}

const nScratch: Vec3 = { x: 0, y: 1, z: 0 };
/** Whether the support found by the last `supportHeight` call at (x, z) can be stood on. */
export function supportWalkable(world: World, x: number, z: number): boolean {
  if (support.kind !== SUPPORT_TERRAIN) return true;
  return world.normalAt(x, z, nScratch).y >= COS_MAX_SLOPE;
}

/** Lowest box underside at or above `fromY` overlapping the circle; Infinity if none. */
export function ceilingAbove(x: number, z: number, r: number, fromY: number): number {
  let c = Infinity;
  for (let i = 0; i < nearBoxes.length; i++) {
    const b = nearBoxes[i];
    if (b.min.y >= fromY && b.min.y < c && circleOverlapsRect(x, z, r, b)) c = b.min.y;
  }
  return c;
}

/** Whether any gathered collider overlaps the cylinder (x, z, r) over the open span (y0, y1). */
export function spanBlocked(x: number, z: number, r: number, y0: number, y1: number): boolean {
  for (let i = 0; i < nearBoxes.length; i++) {
    const b = nearBoxes[i];
    if (b.max.y > y0 && b.min.y < y1 && circleOverlapsRect(x, z, r, b)) return true;
  }
  for (let i = 0; i < nearTrees.length; i++) {
    const t = nearTrees[i];
    if (t.y + t.h * TREE_TRUNK_FRAC > y0 && t.y < y1) {
      const dx = x - t.x, dz = z - t.z, R = t.r + r;
      if (dx * dx + dz * dz < R * R) return true;
    }
  }
  for (let i = 0; i < nearRocks.length; i++) {
    const k = nearRocks[i];
    if (k.y + k.h > y0 && k.y < y1) {
      const dx = x - k.x, dz = z - k.z, R = k.r + r;
      if (dx * dx + dz * dz < R * R) return true;
    }
  }
  return false;
}

/** Headroom test against the already gathered colliders (see `canStand`). */
export function canStandGathered(x: number, y: number, z: number, stance: Stance): boolean {
  const h = STANCE_HEIGHT[stance];
  // Anything below the step height is floor or steppable clutter, not a ceiling.
  return !spanBlocked(x, z, PLAYER_RADIUS - 2 * CONTACT_SKIN, y + STEP_HEIGHT, y + h);
}

/** Whether a body standing at `pos` (feet) has headroom for `stance`. */
export function canStand(world: World, pos: Vec3, stance: Stance): boolean {
  gatherNear(world, pos.x, pos.z, PLAYER_RADIUS + 0.25);
  return canStandGathered(pos.x, pos.y, pos.z, stance);
}

/** Clamp a position to the playable map square (half - 1) and stop velocity pushing outward. */
export function clampToBounds(world: World, pos: Vec3, vel: Vec3 | null): void {
  const lim = world.half - 1;
  if (pos.x < -lim) { pos.x = -lim; if (vel && vel.x < 0) vel.x = 0; }
  else if (pos.x > lim) { pos.x = lim; if (vel && vel.x > 0) vel.x = 0; }
  if (pos.z < -lim) { pos.z = -lim; if (vel && vel.z < 0) vel.z = 0; }
  else if (pos.z > lim) { pos.z = lim; if (vel && vel.z > 0) vel.z = 0; }
}

// ---------------------------------------------------------------------------
// Public generic helper (also used by vehicles)
// ---------------------------------------------------------------------------

export interface CirclePush {
  pushed: boolean;
  /** Unit direction of the total push (XZ). */
  nx: number;
  nz: number;
  /** Length of the total push (m). */
  depth: number;
}

/**
 * Push a circle (pos.x/pos.z, radius) whose vertical extent is y0..y1 out of boxes, tree trunks
 * and rocks. **Mutates pos.x / pos.z** to the resolved position and returns the total push
 * direction and length (use the normal for velocity response, the depth for impact strength).
 * Returns a fresh object, so several results can be held at once.
 */
export function collideCircleXZ(world: World, pos: Vec3, radius: number, y0: number, y1: number): CirclePush {
  if (!(radius > 0) || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) {
    return { pushed: false, nx: 0, nz: 0, depth: 0 };
  }
  gatherNear(world, pos.x, pos.z, radius + 0.5);
  resolveCircle(pos.x, pos.z, radius, y0, y1, null);
  const tx = resolved.pushX, tz = resolved.pushZ;
  const l = Math.sqrt(tx * tx + tz * tz);
  if (resolved.contacts === 0 || l < 1e-9) return { pushed: false, nx: 0, nz: 0, depth: 0 };
  pos.x = resolved.x;
  pos.z = resolved.z;
  return { pushed: true, nx: tx / l, nz: tz / l, depth: l };
}
