// Small allocation-light vector helpers on plain objects so state stays JSON/structured-clone friendly.
// Conventions (match three.js): Y up. yaw = rotation about +Y; yaw 0 faces -Z; positive yaw turns left
// (counter-clockwise seen from above). pitch > 0 looks up.
//   forward(yaw)        = (-sin(yaw), 0, -cos(yaw))
//   right(yaw)          = ( cos(yaw), 0, -sin(yaw))
//   dir(yaw, pitch)     = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))

import type { Vec3 } from './types';

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const set = (o: Vec3, x: number, y: number, z: number): Vec3 => {
  o.x = x; o.y = y; o.z = z; return o;
};
export const copy = (o: Vec3, a: Vec3): Vec3 => {
  o.x = a.x; o.y = a.y; o.z = a.z; return o;
};
export const add = (a: Vec3, b: Vec3, o: Vec3 = v3()): Vec3 => set(o, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3, o: Vec3 = v3()): Vec3 => set(o, a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number, o: Vec3 = v3()): Vec3 => set(o, a.x * s, a.y * s, a.z * s);
export const addScaled = (a: Vec3, b: Vec3, s: number, o: Vec3 = v3()): Vec3 =>
  set(o, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3, o: Vec3 = v3()): Vec3 =>
  set(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const lenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const len = (a: Vec3): number => Math.sqrt(lenSq(a));
export const lenXZ = (a: Vec3): number => Math.hypot(a.x, a.z);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const distXZ = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);
export const normalize = (a: Vec3, o: Vec3 = v3()): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l, o) : set(o, 0, 0, 0);
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: Vec3, b: Vec3, t: number, o: Vec3 = v3()): Vec3 =>
  set(o, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const saturate = (x: number): number => clamp(x, 0, 1);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;
/** Wrap angle to (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
/** Shortest signed difference b - a in (-PI, PI]. */
export const angleDiff = (a: number, b: number): number => wrapAngle(b - a);
export const lerpAngle = (a: number, b: number, t: number): number => a + angleDiff(a, b) * t;
/** Frame-rate independent exponential smoothing factor. */
export const damp = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);

export const forward = (yaw: number, o: Vec3 = v3()): Vec3 => set(o, -Math.sin(yaw), 0, -Math.cos(yaw));
export const right = (yaw: number, o: Vec3 = v3()): Vec3 => set(o, Math.cos(yaw), 0, -Math.sin(yaw));
export const dirFromAngles = (yaw: number, pitch: number, o: Vec3 = v3()): Vec3 => {
  const cp = Math.cos(pitch);
  return set(o, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
};
/** Inverse of dirFromAngles. */
export const anglesFromDir = (d: Vec3): { yaw: number; pitch: number } => ({
  yaw: Math.atan2(-d.x, -d.z),
  pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)),
});
/** Yaw that faces from a to b on the XZ plane. */
export const yawTo = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.atan2(-(b.x - a.x), -(b.z - a.z));

export const round2 = (x: number): number => Math.round(x * 100) / 100;
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
export const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Ray vs sphere: returns distance along normalized dir or -1. */
export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number, maxDist: number): number {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  return t >= 0 && t <= maxDist ? t : -1;
}

/** Ray vs AABB (slab). Returns entry distance (0 if inside) or -1; writes face normal into n if given. */
export function rayAABB(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxDist: number, n?: Vec3): number {
  let tmin = 0, tmax = maxDist, axis = -1, sign = 0;
  const oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z], mn = [min.x, min.y, min.z], mx = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(da[i]) < 1e-12) {
      if (oa[i] < mn[i] || oa[i] > mx[i]) return -1;
    } else {
      const inv = 1 / da[i];
      let t1 = (mn[i] - oa[i]) * inv, t2 = (mx[i] - oa[i]) * inv;
      let s = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  if (n) {
    set(n, 0, 0, 0);
    if (axis === 0) n.x = sign; else if (axis === 1) n.y = sign; else if (axis === 2) n.z = sign;
  }
  return tmin;
}
