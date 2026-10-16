// Free-standing cover props built from WorldBoxes: crate stacks, shipping containers (closed or
// open-ended and enterable), concrete jersey barriers, sandbag walls and fences.

import type { WorldBox } from '../types';
import { Rng } from '../rng';
import type { Rect } from './buildings';
import { Heightfield } from './heightfield';
import { M_APRON, M_BUILDING, M_NOVEG, M_PROP, M_ROAD, OccupancyMask } from './mask';
import { PAL } from './palette';
import { pushBox } from './worldImpl';

export interface PropCtx {
  boxes: WorldBox[];
  hf: Heightfield;
  mask: OccupancyMask;
  rng: Rng;
}

export type PropKind = 'crates' | 'container' | 'barrier' | 'sandbags' | 'fence';

export interface PropInfo {
  kind: PropKind;
  rect: Rect;
  /** Walkable interior (open containers) and its floor height. */
  interior?: Rect;
  floorY?: number;
  military: boolean;
}

const BLOCK = M_ROAD | M_BUILDING | M_APRON | M_PROP;

export const CONTAINER_L = 6.06;
export const CONTAINER_W = 2.44;
export const CONTAINER_H = 2.59;

function free(ctx: PropCtx, r: Rect, pad: number, bits = BLOCK): boolean {
  if (Math.abs(r.x0) > ctx.hf.half - 4 || Math.abs(r.x1) > ctx.hf.half - 4 || Math.abs(r.z0) > ctx.hf.half - 4 || Math.abs(r.z1) > ctx.hf.half - 4) return false;
  return !ctx.mask.anyRect(r.x0 - pad, r.z0 - pad, r.x1 + pad, r.z1 + pad, bits);
}

function reserve(ctx: PropCtx, r: Rect, pad: number): void {
  ctx.mask.markRect(r.x0 - pad, r.z0 - pad, r.x1 + pad, r.z1 + pad, M_PROP);
  ctx.mask.markRect(r.x0 - pad - 1.0, r.z0 - pad - 1.0, r.x1 + pad + 1.0, r.z1 + pad + 1.0, M_NOVEG);
}

/** Cluster of 1-3 crates (some stacked) centred at (x, z). */
export function placeCrates(ctx: PropCtx, x: number, z: number, military: boolean, check = true): PropInfo | null {
  const { rng, hf, boxes } = ctx;
  const s = Math.round(rng.range(1.0, 1.4) * 10) / 10;
  const n = rng.int(1, 3);
  const alongX = rng.chance(0.5);
  const lenA = n * s + (n - 1) * 0.05;
  const rect: Rect = alongX
    ? { x0: x - lenA / 2, z0: z - s / 2, x1: x + lenA / 2, z1: z + s / 2 }
    : { x0: x - s / 2, z0: z - lenA / 2, x1: x + s / 2, z1: z + lenA / 2 };
  if (check && !free(ctx, rect, 0.6)) return null;
  const range = hf.rangeIn(rect.x0, rect.z0, rect.x1, rect.z1);
  if (range.min < 0.4 || range.max - range.min > 1.0) return null;
  const col = military ? rng.pick(PAL.crateMilitary) : rng.pick(PAL.crate);
  for (let i = 0; i < n; i++) {
    const o = -lenA / 2 + i * (s + 0.05);
    const b: Rect = alongX
      ? { x0: x + o, z0: rect.z0, x1: x + o + s, z1: rect.z1 }
      : { x0: rect.x0, z0: z + o, x1: rect.x1, z1: z + o + s };
    const top = range.max + s;
    pushBox(boxes, b.x0, range.min - 0.15, b.z0, b.x1, top, b.z1, 'crate', 'wood', col, -1);
    if (rng.chance(0.35)) {
      const t = s * 0.8, ox = (s - t) / 2;
      pushBox(boxes, b.x0 + ox, top, b.z0 + ox, b.x0 + ox + t, top + t, b.z0 + ox + t, 'crate', 'wood', col, -1);
    }
  }
  reserve(ctx, rect, 0.6);
  return { kind: 'crates', rect, military };
}

/** Shipping container; open ones have one open end and can be entered. */
export function placeContainer(ctx: PropCtx, x: number, z: number, alongX: boolean, open: boolean, military: boolean, check = true): PropInfo | null {
  const { rng, hf, boxes } = ctx;
  const hl = CONTAINER_L / 2, hw = CONTAINER_W / 2;
  const rect: Rect = alongX ? { x0: x - hl, z0: z - hw, x1: x + hl, z1: z + hw } : { x0: x - hw, z0: z - hl, x1: x + hw, z1: z + hl };
  if (check && !free(ctx, rect, open ? 1.2 : 0.8)) return null;
  const range = hf.rangeIn(rect.x0, rect.z0, rect.x1, rect.z1);
  if (range.min < 0.4 || range.max - range.min > (open ? 0.3 : 0.9)) return null;
  const col = military ? rng.pick(PAL.military) : rng.pick(PAL.container);
  const base = range.min - 0.1;
  if (!open) {
    pushBox(boxes, rect.x0, base, rect.z0, rect.x1, range.max + CONTAINER_H, rect.z1, 'container', 'metal', col, -1);
    reserve(ctx, rect, 0.6);
    return { kind: 'container', rect, military };
  }
  const floorY = range.max + 0.15;
  const wt = 0.1, roofT = 0.1;
  const innerTop = floorY + CONTAINER_H - 0.25;
  // Which end is open: +1 = max end, -1 = min end.
  const end = rng.chance(0.5) ? 1 : -1;
  pushBox(boxes, rect.x0, base, rect.z0, rect.x1, floorY, rect.z1, 'container', 'metal', col, -1);
  pushBox(boxes, rect.x0, innerTop, rect.z0, rect.x1, innerTop + roofT, rect.z1, 'container', 'metal', col, -1);
  let interior: Rect;
  if (alongX) {
    pushBox(boxes, rect.x0, floorY, rect.z0, rect.x1, innerTop, rect.z0 + wt, 'container', 'metal', col, -1);
    pushBox(boxes, rect.x0, floorY, rect.z1 - wt, rect.x1, innerTop, rect.z1, 'container', 'metal', col, -1);
    if (end > 0) pushBox(boxes, rect.x0, floorY, rect.z0 + wt, rect.x0 + wt, innerTop, rect.z1 - wt, 'container', 'metal', col, -1);
    else pushBox(boxes, rect.x1 - wt, floorY, rect.z0 + wt, rect.x1, innerTop, rect.z1 - wt, 'container', 'metal', col, -1);
    interior = { x0: rect.x0 + (end > 0 ? wt : 0), z0: rect.z0 + wt, x1: rect.x1 - (end < 0 ? wt : 0), z1: rect.z1 - wt };
  } else {
    pushBox(boxes, rect.x0, floorY, rect.z0, rect.x0 + wt, innerTop, rect.z1, 'container', 'metal', col, -1);
    pushBox(boxes, rect.x1 - wt, floorY, rect.z0, rect.x1, innerTop, rect.z1, 'container', 'metal', col, -1);
    if (end > 0) pushBox(boxes, rect.x0 + wt, floorY, rect.z0, rect.x1 - wt, innerTop, rect.z0 + wt, 'container', 'metal', col, -1);
    else pushBox(boxes, rect.x0 + wt, floorY, rect.z1 - wt, rect.x1 - wt, innerTop, rect.z1, 'container', 'metal', col, -1);
    interior = { x0: rect.x0 + wt, z0: rect.z0 + (end > 0 ? wt : 0), x1: rect.x1 - wt, z1: rect.z1 - (end < 0 ? wt : 0) };
  }
  // Keep the open end clear.
  const apron: Rect = alongX
    ? (end > 0 ? { x0: rect.x1, z0: rect.z0, x1: rect.x1 + 2.5, z1: rect.z1 } : { x0: rect.x0 - 2.5, z0: rect.z0, x1: rect.x0, z1: rect.z1 })
    : (end > 0 ? { x0: rect.x0, z0: rect.z1, x1: rect.x1, z1: rect.z1 + 2.5 } : { x0: rect.x0, z0: rect.z0 - 2.5, x1: rect.x1, z1: rect.z0 });
  reserve(ctx, rect, 0.6);
  ctx.mask.markRect(apron.x0, apron.z0, apron.x1, apron.z1, M_APRON | M_NOVEG);
  return { kind: 'container', rect, interior, floorY, military };
}

/** Concrete jersey barrier (0.6 x 0.9 x 3 m). */
export function placeBarrier(ctx: PropCtx, x: number, z: number, alongX: boolean, check = true): PropInfo | null {
  const hl = 1.5, hw = 0.3;
  const rect: Rect = alongX ? { x0: x - hl, z0: z - hw, x1: x + hl, z1: z + hw } : { x0: x - hw, z0: z - hl, x1: x + hw, z1: z + hl };
  if (check && !free(ctx, rect, 0.6)) return null;
  const range = ctx.hf.rangeIn(rect.x0, rect.z0, rect.x1, rect.z1);
  if (range.min < 0.3) return null;
  pushBox(ctx.boxes, rect.x0, range.min - 0.15, rect.z0, rect.x1, range.max + 0.9, rect.z1, 'barrier', 'concrete', PAL.barrier, -1);
  reserve(ctx, rect, 0.5);
  return { kind: 'barrier', rect, military: false };
}

/** Straight sandbag wall of `len` m, 1.1 m high and 0.6 m thick. */
export function placeSandbags(ctx: PropCtx, x: number, z: number, len: number, alongX: boolean, check = true): PropInfo | null {
  const hl = len / 2, hw = 0.3;
  const rect: Rect = alongX ? { x0: x - hl, z0: z - hw, x1: x + hl, z1: z + hw } : { x0: x - hw, z0: z - hl, x1: x + hw, z1: z + hl };
  if (check && !free(ctx, rect, 0.7)) return null;
  const range = ctx.hf.rangeIn(rect.x0, rect.z0, rect.x1, rect.z1);
  if (range.min < 0.3 || range.max - range.min > 1.2) return null;
  pushBox(ctx.boxes, rect.x0, range.min - 0.1, rect.z0, rect.x1, range.max + 1.1, rect.z1, 'barrier', 'sand', PAL.sandbag, -1);
  reserve(ctx, rect, 0.6);
  return { kind: 'sandbags', rect, military: true };
}

/**
 * Axis-aligned fence run from (x0, z0) to (x1, z1) split into ~3 m panels; panels that would hit
 * roads, buildings, door aprons or other props are skipped (leaving gaps).
 * wooden: low 0.75 m bullet-blocking boards; otherwise 2.4 m see-through chain-link.
 */
export function placeFence(ctx: PropCtx, x0: number, z0: number, x1: number, z1: number, wooden: boolean, ignoreBits = 0): number {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const n = Math.max(1, Math.round(len / 3));
  const t = wooden ? 0.08 : 0.06;
  const h = wooden ? 0.75 : 2.4;
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n;
    const r: Rect = alongX
      ? { x0: Math.min(x0 + (x1 - x0) * a, x0 + (x1 - x0) * b), z0: z0 - t / 2, x1: Math.max(x0 + (x1 - x0) * a, x0 + (x1 - x0) * b), z1: z0 + t / 2 }
      : { x0: x0 - t / 2, z0: Math.min(z0 + (z1 - z0) * a, z0 + (z1 - z0) * b), x1: x0 + t / 2, z1: Math.max(z0 + (z1 - z0) * a, z0 + (z1 - z0) * b) };
    if (!free(ctx, r, 0.4, BLOCK & ~ignoreBits)) continue;
    const range = ctx.hf.rangeIn(r.x0, r.z0, r.x1, r.z1);
    if (range.min < 0.3) continue;
    pushBox(ctx.boxes, r.x0, range.min - 0.2, r.z0, r.x1, range.max + h, r.z1, 'fence', wooden ? 'wood' : 'metal', wooden ? PAL.fence : PAL.chainlink, -1, wooden);
    ctx.mask.markRect(r.x0 - 0.3, r.z0 - 0.3, r.x1 + 0.3, r.z1 + 0.3, M_PROP);
    ctx.mask.markRect(r.x0 - 1, r.z0 - 1, r.x1 + 1, r.z1 + 1, M_NOVEG);
    placed++;
  }
  return placed;
}
