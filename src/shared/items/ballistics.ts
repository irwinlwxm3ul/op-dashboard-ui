// Ballistics for projectile weapons (DMR, sniper): gravity + linear drag.
//
// The equation of motion v' = g - k v (g = gravity vector scaled by gravityScale, k = drag) has a
// closed-form solution over a step, so stepBallistic is exact and unconditionally stable for any
// dt. It still advances in sub-steps of at most 1/120 s so callers that advance in different
// increments (server ticks, client frames, bot predictions) land on the same curve within float
// precision. simulateTrajectory / zeroAngle integrate with the very same step.

import { GRAVITY } from '../constants';
import type { Vec3, WeaponDef } from '../types';
import { ZERO_RANGE } from './defs';

/** Max internal integration sub-step (s). */
export const BALLISTIC_SUBSTEP = 1 / 120;
/** Step used by simulateTrajectory / zeroAngle (s). */
const TRAJ_STEP = 1 / 240;
/** Flights longer than this are considered out of range (s). */
const MAX_FLIGHT_TIME = 8;

/**
 * Advance a projectile by dt (mutates pos and vel). Exact closed-form integration of gravity and
 * linear drag, applied in sub-steps <= BALLISTIC_SUBSTEP.
 */
export function stepBallistic(pos: Vec3, vel: Vec3, w: WeaponDef, dt: number): void {
  if (!(dt > 0)) return;
  const n = Math.max(1, Math.ceil(dt / BALLISTIC_SUBSTEP - 1e-9));
  const h = dt / n;
  const g = GRAVITY * w.gravityScale;
  const k = w.drag;
  if (k > 1e-9) {
    const e = Math.exp(-k * h);
    const a = (1 - e) / k; // ∫0^h e^{-k s} ds
    const gk = g / k; // terminal fall speed
    const gy = gk * h;
    for (let i = 0; i < n; i++) {
      pos.x += vel.x * a;
      pos.z += vel.z * a;
      pos.y += (vel.y + gk) * a - gy;
      vel.x *= e;
      vel.z *= e;
      vel.y = (vel.y + gk) * e - gk;
    }
  } else {
    const hg = 0.5 * g * h * h;
    for (let i = 0; i < n; i++) {
      pos.x += vel.x * h;
      pos.z += vel.z * h;
      pos.y += vel.y * h - hg;
      vel.y -= g * h;
    }
  }
}

/** Result scratch for flyTo (module-local, never returned to callers). */
const fly = { time: 0, y: 0 };

/**
 * Numerically integrate a shot launched from the origin in a vertical plane with initial velocity
 * (vx, vy) until it has travelled `range` horizontally. Writes time and height into `fly`;
 * Infinity when the range is never reached.
 */
function flyTo(w: WeaponDef, vx: number, vy: number, range: number): void {
  if (range <= 0) {
    fly.time = 0;
    fly.y = 0;
    return;
  }
  if (!(vx > 0)) {
    fly.time = Infinity;
    fly.y = -Infinity;
    return;
  }
  const h = TRAJ_STEP;
  const g = GRAVITY * w.gravityScale;
  const k = w.drag;
  const drag = k > 1e-9;
  const e = drag ? Math.exp(-k * h) : 1;
  const a = drag ? (1 - e) / k : h;
  const gk = drag ? g / k : 0;
  const hg = 0.5 * g * h * h;
  let x = 0, y = 0, t = 0;
  const maxSteps = Math.ceil(MAX_FLIGHT_TIME / h);
  for (let i = 0; i < maxSteps; i++) {
    const px = x, py = y;
    if (drag) {
      x += vx * a;
      y += (vy + gk) * a - gk * h;
      vx *= e;
      vy = (vy + gk) * e - gk;
    } else {
      x += vx * h;
      y += vy * h - hg;
      vy -= g * h;
    }
    t += h;
    if (x >= range) {
      // Interpolate the crossing inside the last step (curvature error is ~1e-5 m).
      const f = (range - px) / (x - px);
      fly.time = t - h + h * f;
      fly.y = py + (y - py) * f;
      return;
    }
  }
  fly.time = Infinity;
  fly.y = -Infinity;
}

/**
 * Time of flight and bullet drop (m, positive = below) at a horizontal range for a level,
 * unzeroed shot, relative to the initial straight line. Hitscan weapons have no drop.
 */
export function simulateTrajectory(w: WeaponDef, range: number): { time: number; drop: number } {
  flyTo(w, w.muzzleVelocity, 0, range);
  return { time: fly.time, drop: -fly.y };
}

/**
 * Elevation (radians) to add to the aim so the bullet crosses the sight line at `zeroRange`.
 * Solved by bisection on the numerically integrated trajectory.
 */
export function zeroAngle(w: WeaponDef, zeroRange: number): number {
  if (w.gravityScale <= 0 || zeroRange <= 0 || w.muzzleVelocity <= 0) return 0;
  const v = w.muzzleVelocity;
  let lo = 0, hi = 0.3;
  flyTo(w, v * Math.cos(hi), v * Math.sin(hi), zeroRange);
  if (!(fly.y >= 0)) return hi; // unreachable even with a steep lob: best effort
  for (let i = 0; i < 48; i++) {
    const mid = 0.5 * (lo + hi);
    flyTo(w, v * Math.cos(mid), v * Math.sin(mid), zeroRange);
    if (fly.y < 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return 0.5 * (lo + hi);
}

interface ZeroCache { v: number; k: number; g: number; angle: number; }
const zeroCache = new WeakMap<WeaponDef, ZeroCache>();

/** zeroAngle(w, ZERO_RANGE), cached per weapon definition. */
export function sightZeroAngle(w: WeaponDef): number {
  let c = zeroCache.get(w);
  if (!c || c.v !== w.muzzleVelocity || c.k !== w.drag || c.g !== w.gravityScale) {
    c = { v: w.muzzleVelocity, k: w.drag, g: w.gravityScale, angle: zeroAngle(w, ZERO_RANGE) };
    zeroCache.set(w, c);
  }
  return c.angle;
}

/**
 * Initial projectile velocity for a shot along `dir`: muzzle velocity along dir, rotated upward
 * (in the vertical plane of dir) by the sight zero angle for ballistic weapons so the sight is
 * zeroed at ZERO_RANGE (100 m). Hitscan weapons get the plain direction (tracer velocity).
 */
export function launchVelocity(w: WeaponDef, dir: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  const v = w.muzzleVelocity;
  if (l < 1e-12) {
    out.x = 0; out.y = 0; out.z = 0;
    return out;
  }
  const dx = dir.x / l, dy = dir.y / l, dz = dir.z / l;
  const theta = w.hitscan ? 0 : sightZeroAngle(w);
  const hl = Math.sqrt(dx * dx + dz * dz);
  if (theta === 0 || hl < 1e-9) {
    out.x = dx * v; out.y = dy * v; out.z = dz * v;
    return out;
  }
  // Unit vector perpendicular to dir, in its vertical plane, pointing "up".
  const ux = (-dy * dx) / hl, uy = hl, uz = (-dy * dz) / hl;
  const c = Math.cos(theta), s = Math.sin(theta);
  out.x = (dx * c + ux * s) * v;
  out.y = (dy * c + uy * s) * v;
  out.z = (dz * c + uz * s) * v;
  return out;
}

/**
 * Height (m) of the bullet below the sight line at a horizontal range for a level shot fired with
 * launchVelocity (i.e. zeroed at 100 m): negative before the zero range (bullet above the line),
 * positive beyond. Bots and the training read-out use it to hold over.
 */
export function sightDrop(w: WeaponDef, range: number): number {
  if (w.hitscan) return 0;
  const theta = sightZeroAngle(w);
  const v = w.muzzleVelocity;
  flyTo(w, v * Math.cos(theta), v * Math.sin(theta), range);
  return -fly.y;
}
