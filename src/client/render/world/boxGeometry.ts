// Pure box -> merged geometry helpers for buildings and props: face tables, hidden-face culling,
// per-face shading rules (interior darkening, dark window/door reveals, contact darkening, ribbed
// containers) and material roughness/metalness. Output goes into a GeoBuilder.

import type { BoxKind, SurfaceMaterial, Vec3, WorldBox } from '../../../shared/types';
import { hash32 } from '../../../shared/rng';
import type { GeoBuilder } from './geoBuilder';
import { hexToLinear } from './geoBuilder';

/** Face order: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** Corner selectors (0 = min, 1 = max) per face, counter-clockwise seen from outside. For vertical
 *  faces corners 0,1 are the bottom edge and 2,3 the top edge (3 above 0). */
const FACE_CORNERS: readonly (readonly (readonly [number, number, number])[])[] = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Roughness / metalness per box material. */
export function materialRM(m: SurfaceMaterial): [number, number] {
  switch (m) {
    case 'metal': return [0.5, 0.15];
    case 'wood': return [0.86, 0];
    case 'concrete': return [0.93, 0];
    case 'rock': return [0.92, 0];
    case 'snow': return [0.6, 0];
    case 'water': return [0.25, 0];
    case 'road': return [0.9, 0];
    default: return [0.92, 0];
  }
}

const EPS = 0.002;

/** True if face `f` of box `a` is fully covered from outside by box `b`. */
function faceCoveredBy(a: Aabb, f: number, b: Aabb): boolean {
  const d = 0.02;
  // Region just outside the face.
  let x0 = a.min.x, x1 = a.max.x, y0 = a.min.y, y1 = a.max.y, z0 = a.min.z, z1 = a.max.z;
  switch (f) {
    case 0: x0 = a.max.x; x1 = a.max.x + d; break;
    case 1: x1 = a.min.x; x0 = a.min.x - d; break;
    case 2: y0 = a.max.y; y1 = a.max.y + d; break;
    case 3: y1 = a.min.y; y0 = a.min.y - d; break;
    case 4: z0 = a.max.z; z1 = a.max.z + d; break;
    default: z1 = a.min.z; z0 = a.min.z - d; break;
  }
  return (
    b.min.x <= x0 + EPS && b.max.x >= x1 - EPS &&
    b.min.y <= y0 + EPS && b.max.y >= y1 - EPS &&
    b.min.z <= z0 + EPS && b.max.z >= z1 - EPS
  );
}

/**
 * Bitmask of visible faces of `box` (bit f set = draw face f): faces covered by a neighbour box,
 * faces fully underground and the bottom face of boxes resting on/in the terrain are culled.
 */
export function visibleFaces(box: Aabb, neighbours: readonly Aabb[], heightAt: (x: number, z: number) => number): number {
  let mask = 0b111111;
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const groundC = heightAt(cx, cz);
  if (box.min.y <= groundC + 0.05) mask &= ~(1 << 3);
  for (let f = 0; f < 6; f++) {
    if (!(mask & (1 << f))) continue;
    if (f !== 2 && f !== 3) {
      // Vertical face completely below the terrain along its bottom edge?
      let ax: number, az: number, bx: number, bz: number;
      if (f === 0 || f === 1) {
        ax = bx = f === 0 ? box.max.x : box.min.x;
        az = box.min.z; bz = box.max.z;
      } else {
        az = bz = f === 4 ? box.max.z : box.min.z;
        ax = box.min.x; bx = box.max.x;
      }
      const g = Math.min(heightAt(ax, az), heightAt(bx, bz), heightAt((ax + bx) / 2, (az + bz) / 2));
      if (box.max.y < g - 0.05) {
        mask &= ~(1 << f);
        continue;
      }
    }
    for (const n of neighbours) {
      if (n === box) continue;
      if (faceCoveredBy(box, f, n)) {
        mask &= ~(1 << f);
        break;
      }
    }
  }
  return mask;
}

export interface FaceStyle {
  /** Linear base colour. */
  color: readonly [number, number, number];
  rm: readonly [number, number];
  /** Per-face brightness multipliers (length 6). */
  faceShade: readonly number[];
  /** Multiplier for the bottom edge of vertical faces (contact darkening). */
  bottomShade: number;
  /** Ribbed corrugation stripes on vertical faces (containers). */
  ribbed: boolean;
  /** Optional value for the `bld` attribute (exterior shell). */
  bld?: number;
}

const _rgb: [number, number, number] = [0, 0, 0];

/** Emits the visible faces of an AABB into `out` (builder must declare `rm` and optionally `bld`). */
export function emitBox(out: GeoBuilder, box: Aabb, mask: number, style: FaceStyle): void {
  const mn = box.min, mx = box.max;
  for (let f = 0; f < 6; f++) {
    if (!(mask & (1 << f))) continue;
    const n = FACE_NORMALS[f];
    const corners = FACE_CORNERS[f];
    const shade = style.faceShade[f];
    const vertical = f !== 2 && f !== 3;
    const cr = style.color[0] * shade, cg = style.color[1] * shade, cb = style.color[2] * shade;
    const px = (c: readonly [number, number, number]): number => (c[0] ? mx.x : mn.x);
    const py = (c: readonly [number, number, number]): number => (c[1] ? mx.y : mn.y);
    const pz = (c: readonly [number, number, number]): number => (c[2] ? mx.z : mn.z);
    const emitV = (x: number, y: number, z: number, k: number): number => {
      const i = out.vertex(x, y, z, n[0], n[1], n[2], cr * k, cg * k, cb * k);
      out.extra('rm', style.rm[0], style.rm[1]);
      if (style.bld !== undefined) out.extra('bld', style.bld);
      return i;
    };
    if (!vertical) {
      const a = emitV(px(corners[0]), py(corners[0]), pz(corners[0]), 1);
      const b = emitV(px(corners[1]), py(corners[1]), pz(corners[1]), 1);
      const c = emitV(px(corners[2]), py(corners[2]), pz(corners[2]), 1);
      const d = emitV(px(corners[3]), py(corners[3]), pz(corners[3]), 1);
      out.quad(a, b, c, d);
      continue;
    }
    const height = mx.y - mn.y;
    const bottomK = height > 0.5 ? style.bottomShade : 1;
    const x0 = px(corners[0]), z0 = pz(corners[0]);
    const x1 = px(corners[1]), z1 = pz(corners[1]);
    const yb = mn.y, yt = mx.y;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const strips = style.ribbed && len > 0.8 ? Math.max(2, Math.round(len / 0.3)) : 1;
    for (let s = 0; s < strips; s++) {
      const t0 = s / strips, t1 = (s + 1) / strips;
      const k = strips > 1 && s % 2 === 1 ? 0.82 : 1;
      const sx0 = x0 + (x1 - x0) * t0, sz0 = z0 + (z1 - z0) * t0;
      const sx1 = x0 + (x1 - x0) * t1, sz1 = z0 + (z1 - z0) * t1;
      const a = emitV(sx0, yb, sz0, k * bottomK);
      const b = emitV(sx1, yb, sz1, k * bottomK);
      const c = emitV(sx1, yt, sz1, k);
      const d = emitV(sx0, yt, sz0, k);
      out.quad(a, b, c, d);
    }
  }
}

/** Small deterministic brightness jitter per box so repeated pieces do not look identical. */
export function boxJitter(id: number): number {
  return 0.95 + (hash32(id, 0x6b0c) / 4294967296) * 0.1;
}

/** Linear colour of a box after kind-specific tone tweaks. */
export function boxBaseColor(box: WorldBox): [number, number, number] {
  hexToLinear(box.color, _rgb);
  let k = boxJitter(box.id);
  const kind: BoxKind = box.kind;
  if (kind === 'roof') k *= 0.93;
  else if (kind === 'window_frame' || kind === 'door_frame') k *= 0.55;
  else if (kind === 'stairs') k *= 0.92;
  return [_rgb[0] * k, _rgb[1] * k, _rgb[2] * k];
}

export interface BuildingContext {
  /** Building footprint / volume. */
  min: Vec3;
  max: Vec3;
  /** Underside of the roof: points below it inside the footprint count as indoors. */
  interiorTop: number;
}

/**
 * Per-face multipliers for a building box: faces looking into the building interior are darker
 * (fake indoor occlusion), thin wall ends inside the facade (window/door reveals) get a dark frame.
 */
export function buildingFaceShade(box: WorldBox, ctx: BuildingContext, out: number[]): number[] {
  const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
  const dx = box.max.x - box.min.x, dz = box.max.z - box.min.z;
  const thinWall = box.kind === 'wall' && Math.min(dx, dz) <= 0.45;
  const longX = dx >= dz;
  for (let f = 0; f < 6; f++) {
    const n = FACE_NORMALS[f];
    const fx = n[0] !== 0 ? (n[0] > 0 ? box.max.x : box.min.x) : cx;
    const fy = n[1] !== 0 ? (n[1] > 0 ? box.max.y : box.min.y) : cy;
    const fz = n[2] !== 0 ? (n[2] > 0 ? box.max.z : box.min.z) : cz;
    const px = fx + n[0] * 0.3, py = fy + n[1] * 0.3, pz = fz + n[2] * 0.3;
    const inside =
      px > ctx.min.x + 0.05 && px < ctx.max.x - 0.05 &&
      pz > ctx.min.z + 0.05 && pz < ctx.max.z - 0.05 &&
      py < ctx.interiorTop && py > ctx.min.y;
    let k = 1;
    if (inside) k = f === 2 ? 0.86 : f === 3 ? 0.74 : 0.8;
    if (thinWall && f !== 2 && f !== 3) {
      const alongLong = longX ? n[0] !== 0 : n[2] !== 0;
      if (alongLong) {
        const onBoundary = longX
          ? Math.abs(fx - ctx.min.x) < 0.06 || Math.abs(fx - ctx.max.x) < 0.06
          : Math.abs(fz - ctx.min.z) < 0.06 || Math.abs(fz - ctx.max.z) < 0.06;
        if (!onBoundary) k *= 0.62;
      }
    }
    out[f] = k;
  }
  return out;
}
