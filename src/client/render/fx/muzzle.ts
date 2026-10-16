// Pure helpers shared by the FX renderer and the view rig: approximate third-person muzzle
// positions, segment-vs-capsule tests for predicted bullets, and the per-frame "local muzzle"
// hand-off from the view rig (which knows where the first-person gun is) to the FX renderer
// (which draws the local player's tracers).

import { EYE_HEIGHT, PLAYER_RADIUS, STANCE_HEIGHT } from '../../../shared/constants';
import type { MovementMode, Stance, Vec3, WeaponId } from '../../../shared/types';
import { PF } from '../../../shared/protocol';
import { WEAPON_MODELS } from '../../assets';

/** How far in front of the eye a pistol is held at arm's length (m). */
const PISTOL_HOLD = 0.42;

/**
 * Forward distance (m) from the shooter's shoulder / eye plane to the muzzle and the muzzle height
 * above the shoulder line, from the imported weapon models (WEAPON_MODELS, weapon frame: grip at
 * the origin, butt on the shoulder, barrel -Z). Pistols are held out at arm's length.
 */
export const BARREL_REACH: Record<WeaponId, number> = {} as Record<WeaponId, number>;
export const BARREL_RISE: Record<WeaponId, number> = {} as Record<WeaponId, number>;
for (const id of Object.keys(WEAPON_MODELS) as WeaponId[]) {
  const m = WEAPON_MODELS[id];
  BARREL_REACH[id] = (m.pistol ? PISTOL_HOLD : m.butt[2]) - m.muzzle[2];
  BARREL_RISE[id] = m.muzzle[1] - m.butt[1];
}

/** Approximate eye height above the feet for a third-person pose. */
export function poseEyeHeight(stance: Stance, mode: MovementMode, downed: boolean): number {
  if (mode === 'vehicle') return 1.1;
  if (mode === 'swim') return EYE_HEIGHT.stand;
  if (downed) return EYE_HEIGHT.prone;
  return EYE_HEIGHT[stance];
}

/**
 * Approximate world muzzle position of a third-person shooter from feet position, aim and pose.
 * The gun is held at the right shoulder (or centred when aiming down sights / prone).
 */
export function approxMuzzle(
  pos: Vec3, yaw: number, pitch: number, stance: Stance, mode: MovementMode, flags: number,
  weapon: WeaponId | null, out: Vec3,
): Vec3 {
  const ads = (flags & PF.ADS) !== 0;
  const lean = (flags & PF.LEAN_L) !== 0 ? -1 : (flags & PF.LEAN_R) !== 0 ? 1 : 0;
  const eye = poseEyeHeight(stance, mode, false);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // forward (aim) and right vectors
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, rz = -sy;
  const side = (ads ? 0.07 : stance === 'prone' ? 0.1 : 0.2) + lean * 0.33;
  const drop = ads ? 0.06 : stance === 'prone' ? 0.08 : 0.17;
  const reach = weapon ? BARREL_REACH[weapon] : 0.4;
  const rise = weapon ? BARREL_RISE[weapon] : 0;
  // Up vector of the aim frame (pitch tilts the barrel's height offset with it).
  const ux = sy * sp, uy = cp, uz = cy * sp;
  out.x = pos.x + rx * side + fx * reach + ux * rise;
  out.y = pos.y + eye - drop + fy * reach + uy * rise;
  out.z = pos.z + rz * side + fz * reach + uz * rise;
  return out;
}

/**
 * Segment (a -> a + d * len, d unit) vs vertical capsule around a player standing at `feet`
 * (body height from stance). Returns the distance along the segment of the first contact or -1.
 * Coarse (a single capsule) but matches what the player saw: used to stop predicted bullet
 * streaks at the target instead of letting them fly through.
 */
export function segmentHitsPlayer(
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number, len: number,
  feet: Vec3, stance: Stance, mode: MovementMode, downed: boolean,
): number {
  let h: number;
  if (mode === 'vehicle') h = 1.4;
  else if (downed || stance === 'prone') h = 0.55;
  else h = STANCE_HEIGHT[stance];
  const r = downed || stance === 'prone' ? 0.45 : PLAYER_RADIUS + 0.05;
  // Capsule axis from (feet + r) to (feet + h - r) along Y.
  const y0 = feet.y + Math.min(r, h * 0.5), y1 = feet.y + Math.max(h - r, h * 0.5);
  return segmentVerticalCapsule(ax, ay, az, dx, dy, dz, len, feet.x, y0, y1, feet.z, r);
}

/**
 * Exact-enough segment vs vertical capsule (axis x=cx, z=cz, y in [y0,y1], radius r).
 * Returns distance along the unit direction or -1.
 */
export function segmentVerticalCapsule(
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number, len: number,
  cx: number, y0: number, y1: number, cz: number, r: number,
): number {
  // Infinite cylinder part (XZ).
  const ox = ax - cx, oz = az - cz;
  const a = dx * dx + dz * dz;
  let best = -1;
  if (a > 1e-12) {
    const b = ox * dx + oz * dz;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      let t = (-b - s) / a;
      if (t < 0 && c < 0) t = 0; // starts inside the cylinder
      if (t >= 0 && t <= len) {
        const y = ay + dy * t;
        if (y >= y0 && y <= y1) best = t;
      }
    }
  }
  // End caps (spheres).
  const t0 = segmentSphere(ax, ay, az, dx, dy, dz, len, cx, y0, cz, r);
  if (t0 >= 0 && (best < 0 || t0 < best)) best = t0;
  const t1 = segmentSphere(ax, ay, az, dx, dy, dz, len, cx, y1, cz, r);
  if (t1 >= 0 && (best < 0 || t1 < best)) best = t1;
  return best;
}

/** Segment (unit direction, length len) vs sphere: first contact distance or -1. */
export function segmentSphere(
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number, len: number,
  cx: number, cy: number, cz: number, r: number,
): number {
  const px = ax - cx, py = ay - cy, pz = az - cz;
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0 && c < 0) t = 0;
  return t >= 0 && t <= len ? t : -1;
}

/**
 * Per-frame hand-off from the view rig to the FX renderer. The rig writes it every frame after
 * positioning the camera; the FX renderer reads it in its own update (which runs afterwards).
 */
export interface LocalMuzzleState {
  /** The first-person gun is on screen (rig handles flash + casings). */
  viewmodelVisible: boolean;
  /** World position that appears at the first-person muzzle on screen. */
  pos: Vec3;
  /** performance.now() of the last write (stale data is ignored). */
  stamp: number;
}

export const localMuzzle: LocalMuzzleState = {
  viewmodelVisible: false,
  pos: { x: 0, y: 0, z: 0 },
  stamp: -1,
};
