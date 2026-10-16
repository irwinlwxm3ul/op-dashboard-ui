// Procedural low-poly vegetation models (deterministic) and the far-impostor atlas.
//
// Trees are authored at unit height (y 0..1; instance scale = tree height). Trunk vertices carry
// `trunk = 1` so the shader can scale them to the collision radius (TreeDef.r) independently of
// the canopy, which keeps the visible trunk equal to the solid part used by physics (radius r up
// to 0.6 h). `sway` drives the wind animation (0 at the base, ~1 at the top of the canopy).
// Rocks are unit ellipsoids centred on the origin (instance scale (r, h, r)), matching the
// physics collision shape. Bushes are ~1.6 m wide clusters at scale 1.

import * as THREE from 'three';
import type { TreeKind } from '../../../shared/types';
import { Rng, hashFloat } from '../../../shared/rng';
import { GeoBuilder, linearRgb } from './geoBuilder';

/** Trunk radius at the base in unit model space (scaled to TreeDef.r per instance). */
export const UNIT_TRUNK_RADIUS = 0.03;

export const TREE_KINDS: readonly TreeKind[] = ['pine', 'oak', 'birch', 'dead'];

/** Impostor quad width relative to tree height. */
export const IMPOSTOR_WIDTH: Readonly<Record<TreeKind, number>> = { pine: 0.52, oak: 0.78, birch: 0.46, dead: 0.62 };
export const IMPOSTOR_CELL: Readonly<Record<TreeKind | 'bush', number>> = { pine: 0, oak: 1, birch: 2, dead: 3, bush: 4 };
export const IMPOSTOR_CELLS = 5;
/** Bush impostor size at scale 1 (m). */
export const BUSH_IMPOSTOR_W = 1.7;
export const BUSH_IMPOSTOR_H = 1.0;

const COLORS = {
  pineCanopy: 0x3e5d34,
  pineTrunk: 0x5b4636,
  oakCanopy: 0x56772f,
  oakTrunk: 0x4f3d2d,
  birchCanopy: 0x7d9c46,
  birchTrunk: 0xd9d5ca,
  birchMark: 0x2d2a26,
  deadWood: 0x6e6256,
  bush: 0x4b6b2d,
  rock: 0x8a867d,
} as const;

type Rgb = readonly [number, number, number];
type V3 = [number, number, number];

function scaled(c: Rgb, k: number): V3 {
  return [c[0] * k, c[1] * k, c[2] * k];
}

function newTreeBuilder(): GeoBuilder {
  return new GeoBuilder().addAttribute('sway', 1).addAttribute('trunk', 1);
}

const swayOf = (y: number): number => Math.min(1, Math.max(0, (y - 0.08) / 0.92));

function vtx(gb: GeoBuilder, p: V3, n: V3, c: V3, trunk: number, sway = swayOf(p[1])): number {
  const i = gb.vertex(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2]);
  gb.extra('sway', sway);
  gb.extra('trunk', trunk);
  return i;
}

/** Tapered open cylinder along +Y (trunk), `rings` segments high for colour banding. */
function addTrunk(
  gb: GeoBuilder, y0: number, y1: number, r0: number, r1: number, sides: number, rings: number,
  colorAt: (ring: number, side: number) => V3,
): void {
  const idx: number[][] = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const y = y0 + (y1 - y0) * t;
    const r = r0 + (r1 - r0) * t;
    const row: number[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      row.push(vtx(gb, [nx * r, y, nz * r], [nx, 0.15, nz], colorAt(k, s), 1));
    }
    idx.push(row);
  }
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      // Angle grows from +X toward +Z: (bottom s, top s, top s1) is outward facing.
      const a = idx[k][s], b = idx[k][s1], c = idx[k + 1][s1], d = idx[k + 1][s];
      gb.tri(a, d, c);
      gb.tri(a, c, b);
    }
  }
}

/** Branch: tapered prism from p0 to p1 (not trunk-scaled), closed with a tip vertex. */
function addBranch(gb: GeoBuilder, p0: V3, p1: V3, r0: number, sides: number, col: V3): void {
  const dir = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const len = dir.length();
  dir.normalize();
  const up = Math.abs(dir.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(dir, up).normalize();
  const w = new THREE.Vector3().crossVectors(u, dir).normalize();
  const base: number[] = [];
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    const ox = u.x * Math.cos(a) + w.x * Math.sin(a);
    const oy = u.y * Math.cos(a) + w.y * Math.sin(a);
    const oz = u.z * Math.cos(a) + w.z * Math.sin(a);
    base.push(vtx(gb, [p0[0] + ox * r0, p0[1] + oy * r0, p0[2] + oz * r0], [ox, oy, oz], col, 0));
  }
  const tip = vtx(gb, [p0[0] + dir.x * len, p0[1] + dir.y * len, p0[2] + dir.z * len], [dir.x, dir.y, dir.z], col, 0);
  // Determine winding from the first face so the prism faces outward.
  for (let s = 0; s < sides; s++) {
    const a = base[s], b = base[(s + 1) % sides];
    const pa = gb.pos.slice(a * 3, a * 3 + 3), pb = gb.pos.slice(b * 3, b * 3 + 3), pt = gb.pos.slice(tip * 3, tip * 3 + 3);
    const e1 = new THREE.Vector3(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    const e2 = new THREE.Vector3(pt[0] - pa[0], pt[1] - pa[1], pt[2] - pa[2]);
    const nrm = new THREE.Vector3().crossVectors(e1, e2);
    const mid = new THREE.Vector3((pa[0] + pb[0]) / 2 - p0[0], (pa[1] + pb[1]) / 2 - p0[1], (pa[2] + pb[2]) / 2 - p0[2]);
    if (nrm.dot(mid) >= 0) gb.tri(a, b, tip);
    else gb.tri(a, tip, b);
  }
}

/**
 * Layered cone (pine tier): drooping base ring, mid ring, apex, plus an underside fan.
 * Normals lean outward + up for soft foliage lighting.
 */
function addTier(
  gb: GeoBuilder, rng: Rng, yb: number, yt: number, r: number, sides: number, base: Rgb, withMid: boolean,
): void {
  const ringB: number[] = [];
  const ringM: number[] = [];
  const phase = rng.next() * Math.PI * 2;
  const ym = yb + (yt - yb) * 0.42;
  for (let s = 0; s < sides; s++) {
    const a = phase + (s / sides) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rr = r * (0.88 + rng.next() * 0.24);
    const droop = -rng.next() * 0.03;
    ringB.push(vtx(gb, [ca * rr, yb + droop, sa * rr], norm([ca * 0.85, 0.45, sa * 0.85]), scaled(base, 0.78), 0));
    if (withMid) {
      const rm = rr * 0.62;
      ringM.push(vtx(gb, [ca * rm, ym, sa * rm], norm([ca * 0.75, 0.66, sa * 0.75]), scaled(base, 0.98), 0));
    }
  }
  const apex = vtx(gb, [0, yt, 0], [0, 1, 0], scaled(base, 1.12), 0);
  const under = vtx(gb, [0, yb + (yt - yb) * 0.22, 0], [0, 1, 0], scaled(base, 0.5), 0);
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    if (withMid) {
      gb.tri(ringB[s], ringM[s], ringM[s1]);
      gb.tri(ringB[s], ringM[s1], ringB[s1]);
      gb.tri(ringM[s], apex, ringM[s1]);
    } else {
      gb.tri(ringB[s], apex, ringB[s1]);
    }
    // Underside (seen from below).
    gb.tri(ringB[s], ringB[s1], under);
  }
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const icoCache = new Map<number, Float32Array>();
function icoPositions(detail: number): Float32Array {
  let p = icoCache.get(detail);
  if (!p) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    p = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    icoCache.set(detail, p);
  }
  return p;
}

/** Deterministic per-position jitter so shared corners of the non-indexed icosphere stay welded. */
function jitter(seed: number, x: number, y: number, z: number): number {
  return hashFloat(seed, Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000)) - 0.5;
}

/** Foliage blob: displaced icosphere with soft normals, darker underneath. */
function addBlob(
  gb: GeoBuilder, seed: number, c: V3, radii: V3, detail: number, base: Rgb, canopyCenter: V3, rough = 0.22,
): void {
  const p = icoPositions(detail);
  const tint = 0.92 + hashFloat(seed, 77) * 0.16;
  const idx: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const ux = p[i], uy = p[i + 1], uz = p[i + 2];
    const k = 1 + jitter(seed, ux, uy, uz) * rough * 2;
    const x = c[0] + ux * radii[0] * k;
    const y = c[1] + uy * radii[1] * k;
    const z = c[2] + uz * radii[2] * k;
    const nb = norm([ux, uy, uz]);
    const nc = norm([x - canopyCenter[0], y - canopyCenter[1], z - canopyCenter[2]]);
    // Upward-biased normals: foliage scatters light, so undersides should not go black.
    const n = norm([nb[0] * 0.5 + nc[0] * 0.5, nb[1] * 0.5 + nc[1] * 0.5 + 0.45, nb[2] * 0.5 + nc[2] * 0.5]);
    const shade = (0.76 + 0.36 * (uy * 0.5 + 0.5)) * tint;
    idx.push(vtx(gb, [x, y, z], n, scaled(base, shade), 0));
  }
  for (let i = 0; i < idx.length; i += 3) gb.tri(idx[i], idx[i + 1], idx[i + 2]);
}

export interface TreeModelSet {
  near: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
}

export function buildTreeModels(kind: TreeKind): TreeModelSet {
  switch (kind) {
    case 'pine': return { near: pineNear(), mid: pineMid() };
    case 'oak': return { near: oakNear(), mid: oakMid() };
    case 'birch': return { near: birchNear(), mid: birchMid() };
    default: return { near: deadNear(), mid: deadMid() };
  }
}

const LIN = {
  pineCanopy: linearRgb(COLORS.pineCanopy),
  pineTrunk: linearRgb(COLORS.pineTrunk),
  oakCanopy: linearRgb(COLORS.oakCanopy),
  oakTrunk: linearRgb(COLORS.oakTrunk),
  birchCanopy: linearRgb(COLORS.birchCanopy),
  birchTrunk: linearRgb(COLORS.birchTrunk),
  birchMark: linearRgb(COLORS.birchMark),
  deadWood: linearRgb(COLORS.deadWood),
  bush: linearRgb(COLORS.bush),
  rock: linearRgb(COLORS.rock),
};

function pineNear(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  const rng = new Rng(0x9157);
  addTrunk(gb, -0.06, 0.92, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.3, 6, 2, () => scaled(LIN.pineTrunk, 1));
  const tiers = 5;
  for (let k = 0; k < tiers; k++) {
    const yb = 0.2 + k * 0.15;
    const yt = k === tiers - 1 ? 1.0 : yb + 0.27;
    const r = 0.24 - k * 0.042;
    addTier(gb, rng, yb, yt, r, 10, LIN.pineCanopy, true);
  }
  return gb.build();
}

function pineMid(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  const rng = new Rng(0x9158);
  addTrunk(gb, -0.06, 0.6, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.6, 4, 1, () => scaled(LIN.pineTrunk, 1));
  addTier(gb, rng, 0.2, 0.74, 0.24, 7, LIN.pineCanopy, false);
  addTier(gb, rng, 0.55, 1.0, 0.15, 7, LIN.pineCanopy, false);
  return gb.build();
}

const OAK_BLOBS: { c: V3; r: V3 }[] = [
  { c: [0, 0.68, 0], r: [0.27, 0.23, 0.27] },
  { c: [0.17, 0.6, 0.07], r: [0.2, 0.17, 0.2] },
  { c: [-0.15, 0.62, -0.08], r: [0.21, 0.18, 0.21] },
  { c: [0.03, 0.84, -0.04], r: [0.19, 0.15, 0.19] },
];

function oakNear(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  addTrunk(gb, -0.06, 0.62, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.62, 7, 2, () => scaled(LIN.oakTrunk, 1));
  addBranch(gb, [0, 0.4, 0], [0.17, 0.6, 0.07], 0.018, 5, scaled(LIN.oakTrunk, 0.95));
  addBranch(gb, [0, 0.44, 0], [-0.15, 0.63, -0.08], 0.017, 5, scaled(LIN.oakTrunk, 0.95));
  const cc: V3 = [0, 0.66, 0];
  OAK_BLOBS.forEach((b, i) => addBlob(gb, 0x0a40 + i, b.c, b.r, 1, LIN.oakCanopy, cc));
  return gb.build();
}

function oakMid(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  addTrunk(gb, -0.06, 0.6, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.65, 4, 1, () => scaled(LIN.oakTrunk, 1));
  const cc: V3 = [0, 0.66, 0];
  addBlob(gb, 0x0a50, [0, 0.67, 0], [0.34, 0.25, 0.34], 0, LIN.oakCanopy, cc, 0.1);
  addBlob(gb, 0x0a51, [0.02, 0.84, -0.03], [0.2, 0.15, 0.2], 0, LIN.oakCanopy, cc, 0.1);
  return gb.build();
}

function birchNear(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  const rings = 7;
  addTrunk(gb, -0.06, 0.88, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.4, 6, rings, (ring, side) =>
    hashFloat(0xb1c4, ring, side) < 0.28 ? scaled(LIN.birchMark, 1) : scaled(LIN.birchTrunk, 1),
  );
  const cc: V3 = [0, 0.74, 0];
  addBlob(gb, 0xb100, [0, 0.6, 0], [0.16, 0.21, 0.16], 1, LIN.birchCanopy, cc);
  addBlob(gb, 0xb101, [0.05, 0.77, 0.03], [0.14, 0.19, 0.14], 1, LIN.birchCanopy, cc);
  addBlob(gb, 0xb102, [-0.03, 0.9, -0.02], [0.1, 0.11, 0.1], 1, LIN.birchCanopy, cc);
  return gb.build();
}

function birchMid(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  addTrunk(gb, -0.06, 0.6, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.6, 4, 1, () => scaled(LIN.birchTrunk, 0.95));
  const cc: V3 = [0, 0.74, 0];
  addBlob(gb, 0xb110, [0, 0.66, 0], [0.18, 0.26, 0.18], 0, LIN.birchCanopy, cc, 0.1);
  addBlob(gb, 0xb111, [0, 0.88, 0], [0.11, 0.12, 0.11], 0, LIN.birchCanopy, cc, 0.1);
  return gb.build();
}

function deadNear(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  const wood = scaled(LIN.deadWood, 1);
  addTrunk(gb, -0.06, 0.9, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.3, 6, 2, () => wood);
  const rng = new Rng(0xdead);
  for (let i = 0; i < 6; i++) {
    const y = 0.38 + i * 0.08;
    const a = rng.next() * Math.PI * 2;
    const len = 0.18 + rng.next() * 0.14 - i * 0.012;
    const end: V3 = [Math.cos(a) * len, y + 0.1 + rng.next() * 0.12, Math.sin(a) * len];
    addBranch(gb, [0, y, 0], end, 0.012, 5, scaled(LIN.deadWood, 0.95));
    if (i < 4) {
      const b = a + (rng.next() - 0.5) * 1.6;
      const mid: V3 = [end[0] * 0.6, y + (end[1] - y) * 0.6, end[2] * 0.6];
      const twig: V3 = [mid[0] + Math.cos(b) * 0.09, mid[1] + 0.1, mid[2] + Math.sin(b) * 0.09];
      addBranch(gb, mid, twig, 0.007, 4, scaled(LIN.deadWood, 0.9));
    }
  }
  return gb.build();
}

function deadMid(): THREE.BufferGeometry {
  const gb = newTreeBuilder();
  const wood = scaled(LIN.deadWood, 1);
  addTrunk(gb, -0.06, 0.85, UNIT_TRUNK_RADIUS, UNIT_TRUNK_RADIUS * 0.35, 4, 1, () => wood);
  addBranch(gb, [0, 0.45, 0], [0.2, 0.65, 0.05], 0.014, 4, wood);
  addBranch(gb, [0, 0.55, 0], [-0.16, 0.74, -0.1], 0.013, 4, wood);
  addBranch(gb, [0, 0.62, 0], [0.04, 0.82, 0.18], 0.012, 4, wood);
  return gb.build();
}

/** Bush models: sway is amplified (bushes are short, the shader works in model units). */
export function buildBushModels(): { near: THREE.BufferGeometry; mid: THREE.BufferGeometry } {
  const near = new GeoBuilder().addAttribute('sway', 1).addAttribute('trunk', 1);
  const cc: V3 = [0, 0.35, 0];
  addBlob(near, 0xb5a0, [0, 0.45, 0], [0.56, 0.42, 0.56], 1, LIN.bush, cc);
  addBlob(near, 0xb5a1, [0.36, 0.33, 0.16], [0.4, 0.32, 0.4], 1, LIN.bush, cc);
  addBlob(near, 0xb5a2, [-0.32, 0.35, -0.2], [0.42, 0.33, 0.42], 1, LIN.bush, cc);
  const mid = new GeoBuilder().addAttribute('sway', 1).addAttribute('trunk', 1);
  addBlob(mid, 0xb5b0, [0, 0.42, 0], [0.78, 0.5, 0.74], 0, LIN.bush, cc, 0.12);
  const amplify = (g: GeoBuilder): THREE.BufferGeometry => {
    const geo = g.build();
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const sway = geo.getAttribute('sway') as THREE.BufferAttribute;
    for (let i = 0; i < sway.count; i++) sway.setX(i, Math.max(0, pos.getY(i)) * 2.2);
    return geo;
  };
  return { near: amplify(near), mid: amplify(mid) };
}

/**
 * Rock: unit ellipsoid centred at the origin (radius 1), lightly displaced and flat shaded. The
 * part below y = -0.35 is squashed (always underground). Instance scale (r, h, r) gives the
 * physics dome: visible from the base up to h, width 2r.
 */
export function buildRockModel(variant: number, detail: number): THREE.BufferGeometry {
  const p = icoPositions(detail);
  const seed = 0x70c0 + variant * 31;
  const amp = detail > 0 ? 0.1 : 0.06;
  const tris = p.length / 9;
  const gb = new GeoBuilder();
  const base = LIN.rock;
  const mossy = variant % 2 === 1;
  const warm = 0.94 + (variant % 3) * 0.04;
  const pts: V3[] = [];
  for (let t = 0; t < tris; t++) {
    pts.length = 0;
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * 3;
      const ux = p[o], uy = p[o + 1], uz = p[o + 2];
      // Low-frequency lumps (two scales) keep the outline within ~10 % of the collision ellipsoid.
      const d = 1 + jitter(seed, ux, uy, uz) * amp * 2 + Math.sin(ux * 3.1 + seed) * Math.cos(uz * 2.7 - seed) * amp * 0.6;
      let x = ux * d, y = uy * d, z = uz * d;
      // Slight top flattening, squash the buried bottom.
      if (y > 0.75) y = 0.75 + (y - 0.75) * 0.6;
      if (y < -0.35) y = -0.35 + (y + 0.35) * 0.25;
      // Variant skew so instances are not mirror images.
      x += y * 0.06 * ((variant & 1) ? 1 : -1);
      z += y * 0.05 * ((variant & 2) ? 1 : -1);
      pts.push([x, y, z]);
    }
    const [a, b, c] = pts;
    const e1 = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const e2 = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
    const cy = (a[1] + b[1] + c[1]) / 3;
    const shade = (0.82 + 0.2 * Math.max(0, n.y) + (hashFloat(seed, t) - 0.5) * 0.12) * warm;
    let col: V3 = scaled(base, shade);
    if (mossy && n.y > 0.55 && cy > 0.2) {
      col = [col[0] * 0.78, col[1] * 0.95, col[2] * 0.62];
    }
    for (const q of pts) gb.vertex(q[0], q[1], q[2], n.x, n.y, n.z, col[0], col[1], col[2]);
    const i0 = gb.vertexCount - 3;
    gb.tri(i0, i0 + 1, i0 + 2);
  }
  return gb.build();
}

/** Two crossed quads, each doubled (front + back) so both sides light like canopy (normals lean up). */
export function buildImpostorQuad(): THREE.BufferGeometry {
  const gb = new GeoBuilder().addAttribute('uv', 2);
  const planes: [number, number][] = [[1, 0], [0, 1]]; // quad plane direction (x, z)
  for (const [ax, az] of planes) {
    for (const side of [1, -1]) {
      // Face normal is perpendicular to the plane direction.
      const fnx = -az * side, fnz = ax * side;
      const n = norm([fnx * 0.35, 1, fnz * 0.35]);
      const corners: [number, number, number, number][] = [
        [-0.5, 0, 0, 0], [0.5, 0, 1, 0], [0.5, 1, 1, 1], [-0.5, 1, 0, 1],
      ];
      const ids = corners.map(([s, y, u, v]) => {
        const i = gb.vertex(ax * s, y, az * s, n[0], n[1], n[2], 1, 1, 1);
        gb.extra('uv', u, v);
        return i;
      });
      // (c0, c1, c2) faces along (-az, 0, ax); flip the quad for the other side.
      if (-az * fnx + ax * fnz > 0) gb.quad(ids[0], ids[1], ids[2], ids[3]);
      else gb.quad(ids[1], ids[0], ids[3], ids[2]);
    }
  }
  return gb.build();
}

// ---------------------------------------------------------------------------------------------
// Impostor atlas (canvas): pine, oak, birch, dead, bush; 128 x 256 per cell, base at the bottom.
// ---------------------------------------------------------------------------------------------

const CELL_W = 128;
const CELL_H = 256;
const PAD = 4;

function css(hex: number, k = 1): string {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return `rgb(${r},${g},${b})`;
}

export function createImpostorAtlas(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = CELL_W * IMPOSTOR_CELLS;
  cv.height = CELL_H;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, cv.width, cv.height);
  const rng = new Rng(0x1a7a5);
  const W = CELL_W - PAD * 2, H = CELL_H - PAD * 2;
  // Cell-local helpers: x in [-0.5, 0.5] of quad width, y in [0, 1] of height (canvas y flipped).
  const at = (cell: number, x: number, y: number): [number, number] => [cell * CELL_W + PAD + (x + 0.5) * W, PAD + (1 - y) * H];

  const blob = (cell: number, x: number, y: number, rx: number, ry: number, hex: number, light: number): void => {
    const [cx, cy] = at(cell, x, y);
    const grad = g.createRadialGradient(cx - rx * W * 0.3, cy - ry * H * 0.35, 1, cx, cy, Math.max(rx * W, ry * H));
    grad.addColorStop(0, css(hex, light * 1.15));
    grad.addColorStop(1, css(hex, light * 0.72));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(cx, cy, rx * W, ry * H, 0, 0, Math.PI * 2);
    g.fill();
  };
  const trunk = (cell: number, x0: number, x1: number, y0: number, y1: number, hex: number, w0: number, w1: number): void => {
    const [ax, ay] = at(cell, x0, y0);
    const [bx, by] = at(cell, x1, y1);
    g.fillStyle = css(hex);
    g.beginPath();
    g.moveTo(ax - w0 * W, ay);
    g.lineTo(bx - w1 * W, by);
    g.lineTo(bx + w1 * W, by);
    g.lineTo(ax + w0 * W, ay);
    g.closePath();
    g.fill();
  };

  // Pine: stacked jagged triangles (widths relative to quad width 0.52 h -> radius 0.24 h = 0.46).
  {
    const c = IMPOSTOR_CELL.pine;
    trunk(c, 0, 0, 0, 0.5, COLORS.pineTrunk, 0.04, 0.02);
    for (let k = 0; k < 5; k++) {
      const yb = 0.2 + k * 0.15, yt = k === 4 ? 1.0 : yb + 0.27;
      const r = (0.24 - k * 0.042) / IMPOSTOR_WIDTH.pine;
      const [lx, ly] = at(c, -r, yb);
      const [rx2] = at(c, r, yb);
      const [tx, ty] = at(c, 0, yt);
      const grad = g.createLinearGradient(0, ty, 0, ly);
      grad.addColorStop(0, css(COLORS.pineCanopy, 1.15));
      grad.addColorStop(1, css(COLORS.pineCanopy, 0.7));
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(tx, ty);
      const teeth = 7;
      for (let i = 0; i <= teeth; i++) {
        const px = rx2 + (lx - rx2) * (i / teeth);
        const py = ly + (i % 2 === 0 ? 0 : -H * 0.025) + rng.next() * H * 0.01;
        g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
    }
  }
  // Oak: trunk + overlapping canopy blobs.
  {
    const c = IMPOSTOR_CELL.oak;
    const s = 1 / IMPOSTOR_WIDTH.oak;
    trunk(c, 0, 0, 0, 0.62, COLORS.oakTrunk, 0.045, 0.028);
    for (const b of OAK_BLOBS) blob(c, b.c[0] * s, b.c[1], b.r[0] * s, b.r[1], COLORS.oakCanopy, 0.95);
    for (let i = 0; i < 14; i++) {
      const a = rng.next() * Math.PI * 2, d = rng.next() * 0.25;
      blob(c, Math.cos(a) * d * s * 0.9, 0.68 + Math.sin(a) * d * 0.7, 0.07 * s, 0.06, COLORS.oakCanopy, 0.85 + rng.next() * 0.35);
    }
  }
  // Birch: white trunk with marks + narrow light canopy.
  {
    const c = IMPOSTOR_CELL.birch;
    const s = 1 / IMPOSTOR_WIDTH.birch;
    trunk(c, 0, 0, 0, 0.88, COLORS.birchTrunk, 0.035, 0.015);
    g.fillStyle = css(COLORS.birchMark);
    for (let i = 0; i < 8; i++) {
      const [mx, my] = at(c, (rng.next() - 0.5) * 0.04, 0.05 + rng.next() * 0.45);
      g.fillRect(mx - 2, my, 4, 2);
    }
    blob(c, 0, 0.6, 0.16 * s, 0.21, COLORS.birchCanopy, 0.95);
    blob(c, 0.05 * s, 0.77, 0.14 * s, 0.19, COLORS.birchCanopy, 1.0);
    blob(c, -0.03 * s, 0.9, 0.1 * s, 0.11, COLORS.birchCanopy, 1.05);
  }
  // Dead: grey trunk and branches.
  {
    const c = IMPOSTOR_CELL.dead;
    trunk(c, 0, 0, 0, 0.9, COLORS.deadWood, 0.05, 0.012);
    g.strokeStyle = css(COLORS.deadWood, 0.95);
    g.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const y = 0.38 + i * 0.075;
      const dir = i % 2 === 0 ? 1 : -1;
      const len = 0.25 + rng.next() * 0.2;
      const [ax, ay] = at(c, 0, y);
      const [bx, by] = at(c, dir * len, y + 0.12 + rng.next() * 0.1);
      g.lineWidth = 3 - i * 0.25;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
    }
  }
  // Bush: wide low clump filling the cell.
  {
    const c = IMPOSTOR_CELL.bush;
    blob(c, 0, 0.42, 0.34, 0.4, COLORS.bush, 0.9);
    blob(c, 0.2, 0.33, 0.25, 0.32, COLORS.bush, 0.85);
    blob(c, -0.19, 0.35, 0.26, 0.33, COLORS.bush, 0.95);
    for (let i = 0; i < 10; i++) {
      blob(c, (rng.next() - 0.5) * 0.6, 0.3 + rng.next() * 0.4, 0.08, 0.1, COLORS.bush, 0.8 + rng.next() * 0.4);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
