// Pure camera / animation math used by the view rig and the viewmodel (no three.js, testable).

import { clamp } from '../../../shared/math';

const RAD = Math.PI / 180;
/** Reference aspect for the FOV setting: the setting is the horizontal FOV at 16:9 (Hor+). */
export const FOV_REF_ASPECT = 16 / 9;

/** Vertical FOV (deg) from the horizontal-ish FOV setting (deg, at 16:9). */
export function verticalFovFromSetting(hDeg: number): number {
  return (2 * Math.atan(Math.tan((hDeg * RAD) / 2) / FOV_REF_ASPECT)) / RAD;
}

/**
 * Apply an optical zoom factor (tan-space) to a vertical FOV.
 * zoomMul = 0.25 shows a quarter of the view height (4x magnification).
 */
export function zoomFov(vDeg: number, zoomMul: number): number {
  return (2 * Math.atan(Math.tan((vDeg * RAD) / 2) * zoomMul)) / RAD;
}

/**
 * ADS zoom multiplier blended by the ADS amount. Interpolated in log space so 1x -> 8x feels
 * uniform. For magnified optics most of the zoom happens in the last part of the blend (when the
 * scope reaches the eye), for iron/red-dot sights it follows the blend directly.
 */
export function adsZoomMul(adsZoom: number, ads: number, magnified: boolean): number {
  const a = clamp(ads, 0, 1);
  const t = magnified ? smooth01((a - 0.45) / 0.55) : smooth01(a);
  return Math.exp(Math.log(Math.max(1e-3, adsZoom)) * t);
}

export function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

export function smoother01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function easeOutCubic(x: number): number {
  const t = 1 - clamp(x, 0, 1);
  return 1 - t * t * t;
}

export function easeInOutSine(x: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1));
}

/** Overshooting ease (raise animations). */
export function easeOutBack(x: number, s = 1.4): number {
  const t = clamp(x, 0, 1) - 1;
  return 1 + t * t * ((s + 1) * t + s);
}

/** 0 -> 1 ramp between a and b. */
export function ramp(x: number, a: number, b: number): number {
  return clamp((x - a) / (b - a), 0, 1);
}

/** Trapezoid: rises over [a,b], holds, falls over [c,d] (smoothed). */
export function window4(x: number, a: number, b: number, c: number, d: number): number {
  if (x <= a || x >= d) return 0;
  if (x < b) return smooth01((x - a) / (b - a));
  if (x <= c) return 1;
  return 1 - smooth01((x - c) / (d - c));
}

/** Smooth pulse 0 -> 1 -> 0 over [a, b]. */
export function pulse(x: number, a: number, b: number): number {
  if (x <= a || x >= b) return 0;
  return Math.sin(((x - a) / (b - a)) * Math.PI);
}

/**
 * Critically damped spring step (semi-implicit). State is [value, velocity]; returns nothing,
 * mutates `s`. `freq` in Hz. Stable for any dt.
 */
export interface Spring1 {
  x: number;
  v: number;
}
export function springStep(s: Spring1, target: number, freq: number, dt: number): void {
  const w = 2 * Math.PI * freq;
  // Exact critically damped solution over dt.
  const x0 = s.x - target;
  const e = Math.exp(-w * dt);
  const c = s.v + w * x0;
  s.x = target + (x0 + c * dt) * e;
  s.v = (c - w * (x0 + c * dt)) * e;
}

/** Smooth layered-sine noise in [-1, 1] (cheap, continuous), different per seed. */
export function sineNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 1.31 + seed * 1.7) * 0.5 +
    Math.sin(t * 2.47 + seed * 3.1) * 0.3 +
    Math.sin(t * 4.13 + seed * 5.3) * 0.2
  );
}

/**
 * Two-bone IK in a plane chosen by a pole vector. Shoulder S, target T, bone lengths a (upper)
 * and b (lower). Writes the elbow into `outElbow` and the (possibly clamped) wrist into
 * `outWrist`. When T is out of reach the shoulder is conceptually pulled toward it: the wrist
 * stays exactly at T and the chain is laid straight back toward S (used for viewmodel arms whose
 * shoulders are off-screen, so hands always stay on their grips).
 * Returns the effective shoulder (same as S unless it had to move).
 */
export function solveTwoBone(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  a: number, b: number,
  px: number, py: number, pz: number,
  outElbow: { x: number; y: number; z: number },
  outShoulder: { x: number; y: number; z: number },
): void {
  let dx = tx - sx, dy = ty - sy, dz = tz - sz;
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) { dx = 0; dy = -1; dz = 0; d = 1e-6; }
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const reach = (a + b) * 0.999;
  const minReach = Math.abs(a - b) + 1e-4;
  let dd = d;
  if (d > reach) {
    // Move the shoulder toward the target so the hand stays on target.
    sx = tx - ux * reach; sy = ty - uy * reach; sz = tz - uz * reach;
    dd = reach;
  } else if (d < minReach) {
    sx = tx - ux * minReach; sy = ty - uy * minReach; sz = tz - uz * minReach;
    dd = minReach;
  }
  outShoulder.x = sx; outShoulder.y = sy; outShoulder.z = sz;
  // Distance from the shoulder along the axis to the elbow's projection, and the offset height.
  const along = (a * a - b * b + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, a * a - along * along));
  // Pole direction made perpendicular to the axis.
  const pd = px * ux + py * uy + pz * uz;
  let qx = px - ux * pd, qy = py - uy * pd, qz = pz - uz * pd;
  const ql = Math.hypot(qx, qy, qz);
  if (ql < 1e-6) {
    // Pole parallel to the axis: pick any perpendicular.
    qx = -uy; qy = ux; qz = 0;
    const l2 = Math.hypot(qx, qy, qz) || 1;
    qx /= l2; qy /= l2; qz /= l2;
  } else {
    qx /= ql; qy /= ql; qz /= ql;
  }
  outElbow.x = sx + ux * along + qx * h;
  outElbow.y = sy + uy * along + qy * h;
  outElbow.z = sz + uz * along + qz * h;
}
