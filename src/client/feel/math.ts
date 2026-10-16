// Small, pure math helpers for game feel: critically damped springs, trauma, smooth noise,
// heartbeat pulse shape, world -> screen projection and segment distance. No DOM, no audio, no
// allocations in the per-frame paths (callers pass scratch objects).

import { hashFloat } from '../../shared/rng';
import type { Vec3 } from '../../shared/types';

// ---------------------------------------------------------------------------
// Critically damped spring (relaxes toward 0)
// ---------------------------------------------------------------------------

/** 1D spring state: displacement `x` and velocity `v`. */
export interface Spring {
  x: number;
  v: number;
}

export const spring = (): Spring => ({ x: 0, v: 0 });

/**
 * Advances a critically damped spring toward 0 using the exact closed-form solution, so it is
 * unconditionally stable for any `dt` and frame-rate independent.
 *   x(t) = (x0 + (v0 + w x0) t) e^(-w t)
 * `omega` (rad/s) sets the stiffness: the response to an impulse peaks after 1/omega seconds.
 */
export function stepSpring(s: Spring, omega: number, dt: number): void {
  if (s.x === 0 && s.v === 0) return;
  const e = Math.exp(-omega * dt);
  const c = s.v + omega * s.x;
  const x = (s.x + c * dt) * e;
  s.v = (s.v - omega * c * dt) * e;
  s.x = x;
  // Snap tiny residuals to exactly zero so idle frames do no work and consumers see clean zeros.
  if (Math.abs(s.x) < 1e-6 && Math.abs(s.v) < 1e-5) {
    s.x = 0;
    s.v = 0;
  }
}

/**
 * Kicks a spring so that, starting from rest, its displacement peaks at roughly `peak`
 * (within ~7 %). `snap` (0..1) is the fraction applied instantly as displacement — the rest is a
 * velocity impulse — which gives a crisp onset without a visible one-frame jump.
 */
export function kickSpring(s: Spring, peak: number, omega: number, snap = 0.3): void {
  s.x += peak * snap;
  s.v += peak * (1 - snap) * omega * Math.E;
}

/** Clamps a spring's displacement to +-limit (keeps sustained automatic fire bounded). */
export function limitSpring(s: Spring, limit: number): void {
  if (s.x > limit) {
    s.x = limit;
    if (s.v > 0) s.v = 0;
  } else if (s.x < -limit) {
    s.x = -limit;
    if (s.v < 0) s.v = 0;
  }
}

// ---------------------------------------------------------------------------
// Trauma
// ---------------------------------------------------------------------------

/**
 * Adds trauma, never exceeding `cap` through this call (an existing higher trauma is kept).
 * Small repeated sources (gunfire) therefore cannot stack into an explosion-sized shake.
 */
export function addTrauma(current: number, amount: number, cap = 1): number {
  if (amount <= 0) return current;
  const limit = Math.min(1, cap);
  const next = Math.min(limit, current + amount);
  return next > current ? next : current;
}

/** Linear trauma decay (per second). */
export function decayTrauma(current: number, rate: number, dt: number): number {
  const next = current - rate * dt;
  return next > 0 ? next : 0;
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Smooth 1D value noise in [-1, 1] (hash lattice + smoothstep interpolation). */
export function valueNoise(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hashFloat(seed, i) * 2 - 1;
  const b = hashFloat(seed, i + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** Two octaves of value noise, roughly in [-1, 1]. Used for trauma shake per axis. */
export function shakeNoise(seed: number, t: number): number {
  return valueNoise(seed, t) * 0.72 + valueNoise(seed + 7919, t * 2.37 + 13.1) * 0.28;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * "Lub-dub" pulse shape for a phase in [0, 1): a strong beat at 0 and a softer echo shortly after,
 * then rest. Returns 0..1.
 */
export function heartbeatPulse(phase: number): number {
  const p = phase - Math.floor(phase);
  const d1 = (p - 0.04) / 0.055;
  const d2 = (p - 0.27) / 0.06;
  const lub = Math.exp(-d1 * d1);
  const dub = 0.62 * Math.exp(-d2 * d2);
  return lub > dub ? lub : dub;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Closest point on segment a->b to p. Writes it into `out` and returns the parameter t in [0, 1].
 */
export function closestOnSegment(a: Vec3, b: Vec3, p: Vec3, out: Vec3): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (l2 > 1e-12) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  out.x = a.x + dx * t;
  out.y = a.y + dy * t;
  out.z = a.z + dz * t;
  return t;
}

/** Screen-space projection result (CSS pixels). `visible` is false behind the camera. */
export interface ScreenPoint {
  x: number;
  y: number;
  /** Distance along the view axis (m) */
  depth: number;
  visible: boolean;
}

/** Minimal camera description needed for projection (subset of CameraState). */
export interface ProjectionCamera {
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical field of view in degrees */
  fov: number;
}

/**
 * Projects a world point to screen pixels for a camera using three.js conventions
 * (Euler order 'YXZ', camera looks down -Z, yaw 0 faces -Z, pitch > 0 looks up).
 * World -> camera space is the inverse rotation Rz(-roll) * Rx(-pitch) * Ry(-yaw).
 */
export function projectToScreen(
  cam: ProjectionCamera, p: Vec3, width: number, height: number, out: ScreenPoint,
): ScreenPoint {
  const dx = p.x - cam.pos.x, dy = p.y - cam.pos.y, dz = p.z - cam.pos.z;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  // Ry(-yaw)
  const x1 = dx * cy - dz * sy;
  const z1 = dx * sy + dz * cy;
  // Rx(-pitch)
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const y2 = dy * cp + z1 * sp;
  const z2 = -dy * sp + z1 * cp;
  // Rz(-roll)
  const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
  const x3 = x1 * cr + y2 * sr;
  const y3 = -x1 * sr + y2 * cr;
  const depth = -z2;
  out.depth = depth;
  if (depth < 0.05 || width <= 0 || height <= 0) {
    out.visible = false;
    return out;
  }
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
  const aspect = width / height;
  const ndcX = x3 / depth / (tanHalf * aspect);
  const ndcY = y3 / depth / tanHalf;
  out.x = (ndcX * 0.5 + 0.5) * width;
  out.y = (0.5 - ndcY * 0.5) * height;
  out.visible = ndcX > -1.2 && ndcX < 1.2 && ndcY > -1.2 && ndcY < 1.2;
  return out;
}
