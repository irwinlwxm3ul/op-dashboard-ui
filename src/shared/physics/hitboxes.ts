// Player hitboxes (capsules / spheres) built from a compact pose, plus exact ray tests.
//
// Layouts are authored in body-local space (x = right, y = up from the feet, z = forward) and
// transformed by the pose yaw. Lean shears the upper body sideways around a pivot at the pelvis so
// that the head ends up exactly where `eyePosition` puts the eye: whoever peeks also exposes the head.

import { forward, right } from '../math';
import type { HitPart, Hitbox, Vec3 } from '../types';
import type { HitboxPose } from './types';
import { LEAN_DROP, LEAN_OFFSET, PRONE_EYE_FORWARD, SEATED_EYE_HEIGHT } from './tuning';
import { EYE_HEIGHT } from '../constants';

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

interface PartSpec {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  r: number;
  part: HitPart;
  /** Upper body: follows the lean shear. */
  upper: boolean;
}

interface Layout {
  parts: PartSpec[];
  /** Lean shear pivot height and the eye height at which the shear equals LEAN_OFFSET. */
  pivotY: number;
  eyeY: number;
  /** Whether lean applies at all (not while lying). */
  canLean: boolean;
}

const sphere = (x: number, y: number, z: number, r: number, part: HitPart, upper: boolean): PartSpec =>
  ({ ax: x, ay: y, az: z, bx: x, by: y, bz: z, r, part, upper });
const capsule = (
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, part: HitPart, upper: boolean,
): PartSpec => ({ ax, ay, az, bx, by, bz, r, part, upper });

/** Standing, rifle-ready posture. Head top ~1.78 m (STANCE_HEIGHT.stand = 1.8). */
const STAND: Layout = {
  pivotY: 0.95,
  eyeY: EYE_HEIGHT.stand,
  canLean: true,
  parts: [
    sphere(0, 1.65, -0.02, 0.13, 'head', true),
    capsule(0, 1.0, 0, 0, 1.38, 0, 0.22, 'body', true),
    sphere(0, 0.9, 0, 0.18, 'body', false),
    capsule(0.11, 0.82, 0, 0.12, 0.12, 0.02, 0.11, 'limb', false),
    capsule(-0.11, 0.82, 0, -0.12, 0.12, 0.02, 0.11, 'limb', false),
    capsule(0.25, 1.4, 0, 0.16, 1.1, 0.3, 0.075, 'limb', true),
    capsule(-0.25, 1.4, 0, -0.12, 1.18, 0.38, 0.075, 'limb', true),
  ],
};

/** Crouched: torso leans forward a little, knees forward. Head top ~1.21 m. */
const CROUCH: Layout = {
  pivotY: 0.5,
  eyeY: EYE_HEIGHT.crouch,
  canLean: true,
  parts: [
    sphere(0, 1.08, 0.04, 0.13, 'head', true),
    capsule(0, 0.58, -0.02, 0, 0.82, 0.06, 0.21, 'body', true),
    sphere(0, 0.5, -0.1, 0.17, 'body', false),
    capsule(0.12, 0.48, -0.05, 0.14, 0.12, 0.28, 0.11, 'limb', false),
    capsule(-0.12, 0.48, -0.05, -0.14, 0.12, 0.28, 0.11, 'limb', false),
    capsule(0.24, 0.85, 0.02, 0.15, 0.6, 0.32, 0.075, 'limb', true),
    capsule(-0.24, 0.85, 0.02, -0.1, 0.68, 0.4, 0.075, 'limb', true),
  ],
};

/** Lying along the facing direction, head forward (prone and downed). The eye
 *  (EYE_HEIGHT.prone, PRONE_EYE_FORWARD ahead) sits inside the head sphere. */
const PRONE: Layout = {
  pivotY: 0,
  eyeY: EYE_HEIGHT.prone,
  canLean: false,
  parts: [
    sphere(0, 0.36, PRONE_EYE_FORWARD + 0.1, 0.13, 'head', true),
    capsule(0, 0.22, 0.15, 0, 0.2, -0.4, 0.2, 'body', true),
    sphere(0, 0.18, -0.55, 0.17, 'body', false),
    capsule(0.12, 0.13, -0.6, 0.18, 0.1, -1.35, 0.1, 'limb', false),
    capsule(-0.12, 0.13, -0.6, -0.18, 0.1, -1.35, 0.1, 'limb', false),
    capsule(0.22, 0.22, 0.18, 0.12, 0.18, 0.6, 0.07, 'limb', true),
    capsule(-0.22, 0.22, 0.18, -0.08, 0.2, 0.7, 0.07, 'limb', true),
  ],
};

/** Seated in a vehicle (pos = seat position): only head and torso are exposed. */
const SEATED: Layout = {
  pivotY: 0.6,
  eyeY: SEATED_EYE_HEIGHT,
  canLean: true,
  parts: [
    sphere(0, SEATED_EYE_HEIGHT + 0.03, -0.02, 0.13, 'head', true),
    capsule(0, 0.62, -0.02, 0, 0.88, 0, 0.22, 'body', true),
  ],
};

function layoutFor(pose: HitboxPose): Layout | null {
  if (pose.life === 'dead' || pose.mode === 'plane') return null;
  if (pose.mode === 'vehicle') return SEATED;
  if (pose.life === 'downed') return PRONE;
  // Drop modes and swimming use the upright layout.
  if (pose.mode !== 'ground') return STAND;
  return pose.stance === 'prone' ? PRONE : pose.stance === 'crouch' ? CROUCH : STAND;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

const fwdS: Vec3 = { x: 0, y: 0, z: 0 };
const rgtS: Vec3 = { x: 0, y: 0, z: 0 };

/** Number of hitboxes produced for this pose (0 for plane / dead). */
export function hitboxCount(pose: HitboxPose): number {
  const l = layoutFor(pose);
  return l ? l.parts.length : 0;
}

/**
 * Hitboxes for a pose in world space. Reuses the Hitbox objects already in `out` (no allocation
 * once warmed up) and truncates `out` to the produced count. Plane passengers and dead players
 * have no hitboxes (empty array).
 */
export function buildHitboxes(pose: HitboxPose, out: Hitbox[] = []): Hitbox[] {
  const layout = layoutFor(pose);
  if (!layout) {
    out.length = 0;
    return out;
  }
  forward(pose.yaw, fwdS);
  right(pose.yaw, rgtS);
  let lean = layout.canLean && Number.isFinite(pose.lean) ? pose.lean : 0;
  lean = lean < -1 ? -1 : lean > 1 ? 1 : lean;
  const absLean = lean < 0 ? -lean : lean;
  const span = layout.eyeY - layout.pivotY;
  const px = pose.pos.x, py = pose.pos.y, pz = pose.pos.z;
  const parts = layout.parts;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    let hb = out[i];
    if (!hb) {
      hb = { a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, r: s.r, part: s.part };
      out[i] = hb;
    }
    hb.r = s.r;
    hb.part = s.part;
    let ax = s.ax, ay = s.ay, bx = s.bx, by = s.by;
    if (s.upper && lean !== 0) {
      // Shear: displacement grows linearly from the pivot and equals the eye lean at eye height.
      const fa = ay > layout.pivotY ? (ay - layout.pivotY) / span : 0;
      const fb = by > layout.pivotY ? (by - layout.pivotY) / span : 0;
      ax += lean * LEAN_OFFSET * fa;
      ay -= absLean * LEAN_DROP * fa;
      bx += lean * LEAN_OFFSET * fb;
      by -= absLean * LEAN_DROP * fb;
    }
    hb.a.x = px + rgtS.x * ax + fwdS.x * s.az;
    hb.a.y = py + ay;
    hb.a.z = pz + rgtS.z * ax + fwdS.z * s.az;
    hb.b.x = px + rgtS.x * bx + fwdS.x * s.bz;
    hb.b.y = py + by;
    hb.b.z = pz + rgtS.z * bx + fwdS.z * s.bz;
  }
  out.length = parts.length;
  return out;
}

// ---------------------------------------------------------------------------
// Ray tests
// ---------------------------------------------------------------------------

/** Entry distance of a ray starting outside sphere (c, r), or -1. */
function raySphereEnter(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number): number {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const dd = d.x * d.x + d.y * d.y + d.z * d.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  if (c > 0 && b > 0) return -1; // outside and pointing away
  const disc = b * b - dd * c;
  if (disc < 0 || dd < 1e-18) return -1;
  const t = (-b - Math.sqrt(disc)) / dd;
  return t < 0 ? 0 : t;
}

/**
 * Exact ray vs capsule (segment a-b, radius r): the minimum of the ray entry into the infinite
 * cylinder clipped to the segment and the entries into the two end spheres. `d` must be
 * normalised. Returns the distance (0 when the origin is inside) or -1 if there is no hit within
 * maxDist.
 */
export function rayCapsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: number, maxDist: number): number {
  if (!(r > 0) || !(maxDist >= 0)) return -1;
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const r2 = r * r;

  // Origin inside the capsule: closest point on the segment within r.
  const s = baba > 1e-12 ? (baoa <= 0 ? 0 : baoa >= baba ? 1 : baoa / baba) : 0;
  const qx = oax - bax * s, qy = oay - bay * s, qz = oaz - baz * s;
  if (qx * qx + qy * qy + qz * qz <= r2) return 0;

  let best = Infinity;
  if (baba > 1e-12) {
    const bard = bax * d.x + bay * d.y + baz * d.z;
    const rdoa = d.x * oax + d.y * oay + d.z * oaz;
    const oaoa = oax * oax + oay * oay + oaz * oaz;
    const dd = d.x * d.x + d.y * d.y + d.z * d.z;
    const A = baba * dd - bard * bard;
    if (A > 1e-12 * baba) {
      const B = baba * rdoa - baoa * bard;
      const C = baba * oaoa - baoa * baoa - r2 * baba;
      const h = B * B - A * C;
      if (h >= 0) {
        const t = (-B - Math.sqrt(h)) / A;
        if (t >= 0) {
          const y = baoa + t * bard;
          if (y > 0 && y < baba) best = t;
        }
      }
    }
  }
  let t = raySphereEnter(o, d, a.x, a.y, a.z, r);
  if (t >= 0 && t < best) best = t;
  if (baba > 1e-12) {
    t = raySphereEnter(o, d, b.x, b.y, b.z, r);
    if (t >= 0 && t < best) best = t;
  }
  return best <= maxDist ? best : -1;
}

/** Nearest hitbox hit along a normalised ray, or null. */
export function raycastHitboxes(
  origin: Vec3, dir: Vec3, maxDist: number, boxes: Hitbox[],
): { t: number; part: HitPart } | null {
  let bestT = Infinity;
  let bestPart: HitPart = 'body';
  for (let i = 0; i < boxes.length; i++) {
    const hb = boxes[i];
    const t = rayCapsule(origin, dir, hb.a, hb.b, hb.r, bestT < maxDist ? bestT : maxDist);
    if (t >= 0 && t < bestT) {
      bestT = t;
      bestPart = hb.part;
    }
  }
  return bestT <= maxDist ? { t: bestT, part: bestPart } : null;
}

/** Conservative bounding sphere of a hitbox set (cheap broad phase for callers). */
export function hitboxBounds(boxes: Hitbox[], out: { x: number; y: number; z: number; r: number }): typeof out {
  if (boxes.length === 0) {
    out.x = out.y = out.z = 0;
    out.r = -1;
    return out;
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const hb = boxes[i];
    const r = hb.r;
    minX = Math.min(minX, hb.a.x - r, hb.b.x - r);
    minY = Math.min(minY, hb.a.y - r, hb.b.y - r);
    minZ = Math.min(minZ, hb.a.z - r, hb.b.z - r);
    maxX = Math.max(maxX, hb.a.x + r, hb.b.x + r);
    maxY = Math.max(maxY, hb.a.y + r, hb.b.y + r);
    maxZ = Math.max(maxZ, hb.a.z + r, hb.b.z + r);
  }
  out.x = (minX + maxX) * 0.5;
  out.y = (minY + maxY) * 0.5;
  out.z = (minZ + maxZ) * 0.5;
  out.r = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return out;
}
