// Level-of-detail selection with hysteresis plus the dithered crossfade bookkeeping used by every
// character LOD. Pure functions on small mutable records (no scene access, no allocations).

import { LOD_HYSTERESIS, LOD_MID, LOD_NEAR, PLAYER_RENDER_DISTANCE } from '../../../shared/constants';
import type { Quality } from '../../game/types';

export const LOD_NEAR_IDX = 0;
export const LOD_MID_IDX = 1;
export const LOD_FAR_IDX = 2;
export const LOD_HIDDEN_IDX = 3;
/** 0 near (articulated), 1 mid (instanced parts), 2 far (silhouette impostor), 3 hidden. */
export type LodLevel = 0 | 1 | 2 | 3;

export interface LodThresholds {
  /** Outer edge of the near band (m). */
  near: number;
  /** Outer edge of the mid band (m). */
  mid: number;
  /** Render distance (m): beyond this the entity is hidden. */
  far: number;
  /** Half width of the hysteresis band around each edge (m). */
  hysteresis: number;
}

/** LOD band edges per quality preset (medium matches the PLAN.md budget exactly). */
export function lodThresholds(q: Quality): LodThresholds {
  switch (q) {
    case 'low':
      return { near: LOD_NEAR * 0.7, mid: LOD_MID * 0.8, far: PLAYER_RENDER_DISTANCE, hysteresis: LOD_HYSTERESIS };
    case 'high':
      return { near: LOD_NEAR * 1.3, mid: LOD_MID * 1.15, far: PLAYER_RENDER_DISTANCE, hysteresis: LOD_HYSTERESIS };
    case 'ultra':
      return { near: LOD_NEAR * 1.6, mid: LOD_MID * 1.3, far: PLAYER_RENDER_DISTANCE, hysteresis: LOD_HYSTERESIS };
    default:
      return { near: LOD_NEAR, mid: LOD_MID, far: PLAYER_RENDER_DISTANCE, hysteresis: LOD_HYSTERESIS };
  }
}

function edge(level: number, th: LodThresholds): number {
  return level === 0 ? th.near : level === 1 ? th.mid : th.far;
}

/**
 * Next LOD for an entity currently at `prev` that is `dist` metres away. Moving outward requires
 * crossing edge + hysteresis, moving inward edge - hysteresis, so an entity sitting on a band edge
 * never flickers. Handles jumps across several bands (teleports, spectator switches).
 */
export function selectLod(prev: LodLevel, dist: number, th: LodThresholds): LodLevel {
  let lod: number = prev;
  while (lod < LOD_HIDDEN_IDX && dist > edge(lod, th) + th.hysteresis) lod++;
  while (lod > LOD_NEAR_IDX && dist < edge(lod - 1, th) - th.hysteresis) lod--;
  return lod as LodLevel;
}

/** LOD for an entity seen for the first time (no hysteresis history). */
export function initialLod(dist: number, th: LodThresholds): LodLevel {
  if (dist <= th.near) return 0;
  if (dist <= th.mid) return 1;
  if (dist <= th.far) return 2;
  return 3;
}

/**
 * Distance used for LOD selection: scoped / zoomed views magnify distant players, so the distance
 * is scaled by the ratio of the current to the reference field of view (tan of half angles).
 */
export function effectiveLodDistance(dist: number, fovDeg: number, refFovDeg: number): number {
  const k = Math.tan((fovDeg * Math.PI) / 360) / Math.tan((refFovDeg * Math.PI) / 360);
  return dist * Math.min(1.25, Math.max(0.08, k));
}

/**
 * Uniform scale that keeps an object of `heightM` at least `minPx` pixels tall on screen.
 * `focalPx` = (viewport height / 2) / tan(vfov / 2).
 */
export function minScreenScale(heightM: number, dist: number, focalPx: number, minPx: number): number {
  if (dist <= 0 || focalPx <= 0) return 1;
  const px = (heightM * focalPx) / dist;
  return px >= minPx ? 1 : minPx / Math.max(1e-6, px);
}

// ---------------------------------------------------------------------------
// Crossfade (screen-door dither) state
// ---------------------------------------------------------------------------

/**
 * Crossfade between two LODs. `t` runs 0..1 from `prev` to `cur`. Each drawn representation gets a
 * signed dither code (see `fadeCode`): positive codes keep pixels whose noise < code, negative codes
 * keep pixels whose noise >= 1 + code. The outgoing and incoming LODs therefore cover exactly
 * complementary pixel sets and the swap never darkens or double-draws.
 */
export interface LodFade {
  cur: LodLevel;
  prev: LodLevel;
  t: number;
}

export function createLodFade(initial: LodLevel): LodFade {
  return { cur: initial, prev: initial, t: 1 };
}

/** Request `target` and advance the fade by dt (duration in seconds). */
export function stepLodFade(f: LodFade, target: LodLevel, dt: number, duration: number): void {
  if (target !== f.cur) {
    if (f.t < 1 && target === f.prev) {
      // Switching back mid-fade: reverse the running fade instead of restarting it.
      f.prev = f.cur;
      f.cur = target;
      f.t = 1 - f.t;
    } else {
      // A new switch while a fade is still running keeps whichever representation is mostly
      // visible as the outgoing one, so nothing visibly jumps.
      if (f.t >= 0.5) f.prev = f.cur;
      f.cur = target;
      f.t = 0;
    }
  }
  if (f.t < 1) f.t = Math.min(1, f.t + dt / Math.max(1e-3, duration));
}

/**
 * Signed dither code for drawing `lod` this frame (0 = do not draw). `visibility` (0..1) scales the
 * code (e.g. the death fade-out) while keeping incoming/outgoing pixel sets disjoint.
 */
export function fadeCode(f: LodFade, lod: LodLevel, visibility: number): number {
  if (lod === LOD_HIDDEN_IDX || visibility <= 0) return 0;
  if (lod === f.cur) {
    if (f.t >= 1 || f.prev === f.cur || f.prev === LOD_HIDDEN_IDX) return f.t >= 1 ? visibility : f.t * visibility;
    return -f.t * visibility;
  }
  if (lod === f.prev && f.t < 1) return (1 - f.t) * visibility;
  return 0;
}
