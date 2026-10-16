// Instanced vegetation with distance bands: near (full model), mid (LOD1 / simplified), far
// (cross-quad impostors from an atlas), culled beyond. Items are bucketed by terrain chunk; band
// membership is recomputed a few times per second (whole chunks beyond the far band are skipped
// in one test), with hysteresis so objects on a boundary never flicker, and instance buffers are
// rewritten only when membership changed. Each species variant has one slot per band; a slot is
// one InstancedMesh per model part (e.g. bark + leaves) sharing the same instance buffers.
// Models come from a VegetationModelSet (procedural fallback or the glTF assets); trunks are
// scaled per instance to the physics trunk radius; rocks match the physics shape (r, h, r).

import * as THREE from 'three';
import type { TreeKind, World } from '../../../shared/types';
import { hash32, hashFloat } from '../../../shared/rng';
import type { VegetationProfile } from '../core/quality';
import { distanceToAabb, selectBand } from './lod';
import { IMPOSTOR_CELL, TREE_KINDS, buildImpostorQuad } from './vegetationModels';
import type { BandModel, SpeciesGroup, SpeciesVariant, VegetationModelSet } from './vegetationSets';

const GRID = 8;
const HYSTERESIS = 10;
/** Hard cap on real distance (zoomed scopes shrink LOD distances, not draw distance). */
const MAX_REAL_DISTANCE = 1060;
const UPDATE_INTERVAL = 0.25;
const NO_BAND = 255;
const ONE: readonly [number, number, number] = [1, 1, 1];
/** Rocks lower than this (m) cannot hide a prone player and are not drawn in the far band. */
const TINY_ROCK = 0.3;
const GROUPS: readonly SpeciesGroup[] = ['tree', 'bush', 'rock'];
/** Distance histogram for the instance budgets: 2 m buckets up to MAX_REAL_DISTANCE. */
const BUCKET = 2;
const BUCKETS = Math.ceil(MAX_REAL_DISTANCE / BUCKET) + 1;

interface Slot {
  meshes: THREE.InstancedMesh[];
  /** Mesh owning the shared instance buffers. */
  lead: THREE.InstancedMesh;
  cap: number;
  count: number;
  /** Casts shadows while shadows are enabled (near band). */
  shadowCaster: boolean;
  trunk: THREE.InstancedBufferAttribute | null;
  cell: THREE.InstancedBufferAttribute | null;
}

interface Layer {
  n: number;
  /** Species group index into GROUPS (own band edges and instance budget). */
  group: number;
  /** Real distance of each item at the last update (scratch). */
  dist: Float32Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  mats: Float32Array;
  farMats: Float32Array | null;
  cols: Float32Array;
  trunk: Float32Array | null;
  keepFar: Uint8Array;
  band: Uint8Array;
  cell: number;
  slots: [Slot | null, Slot | null, Slot | null];
  chunkStart: Int32Array;
  chunkMinY: Float32Array;
  chunkMaxY: Float32Array;
  chunkCulled: Uint8Array;
}

interface RawItem {
  x: number;
  y: number;
  z: number;
  /** Object height (for chunk bounds). */
  h: number;
  mat: number[];
  far: number[] | null;
  col: [number, number, number];
  trunk: number;
}

/** Column-major T * Ry(rot) * S into out[o..o+15]. */
function writeTRS(out: number[] | Float32Array, o: number, x: number, y: number, z: number, rot: number, sx: number, sy: number, sz: number): void {
  const c = Math.cos(rot), s = Math.sin(rot);
  out[o] = c * sx; out[o + 1] = 0; out[o + 2] = -s * sx; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = sy; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = s * sz; out[o + 9] = 0; out[o + 10] = c * sz; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

function trs(x: number, y: number, z: number, rot: number, sx: number, sy: number, sz: number): number[] {
  const m = new Array<number>(16);
  writeTRS(m, 0, x, y, z, rot, sx, sy, sz);
  return m;
}

/** Variant index for item `i` among `n` variants (deterministic). */
function pickVariant(i: number, salt: number, n: number): number {
  return n <= 1 ? 0 : hash32(i, salt) % n;
}

export class VegetationRenderer {
  readonly group = new THREE.Group();
  readonly set: VegetationModelSet;
  private readonly layers: Layer[] = [];
  private readonly slots: Slot[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly instDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  /** Profile-derived band edges per group (near, mid, far), before budgets. */
  private readonly baseEdges = new Float64Array(9);
  /** Effective (budget-limited, smoothed) edges per group, as selectBand edge arrays. */
  private readonly edges: number[][] = [[150, 450, 900], [150, 450, 900], [150, 450, 900]];
  private readonly budgets = new Float64Array(6);
  private readonly hist = new Uint32Array(3 * BUCKETS);
  private readonly profile: { near: number; mid: number; far: number; budgetScale: number } = { near: 0, mid: 0, far: 0, budgetScale: 0 };
  private shadows = true;
  private bushShadows = false;
  private readonly bushSlots = new Set<Slot>();
  private readonly gridMin: number;
  private readonly gridCell: number;
  private timer = UPDATE_INTERVAL;
  private lastLodScale = 1;
  private forceUpdate = true;

  /**
   * `profile` fixes the variant counts (a profile with other counts needs a new renderer);
   * distances / budgets can change later through setProfile().
   */
  constructor(world: World, set: VegetationModelSet, profile: Readonly<VegetationProfile>) {
    this.group.name = 'vegetation';
    this.set = set;
    this.gridMin = -world.half;
    this.gridCell = world.size / GRID;
    this.applyProfile(profile);
    this.bushShadows = profile.bushShadows;

    // ---- trees: one layer per (kind, variant) ----
    const treeVariants = Math.max(1, profile.treeVariants);
    const treeItems = new Map<TreeKind, RawItem[][]>();
    for (const k of TREE_KINDS) {
      const nv = Math.min(treeVariants, set.trees[k].length);
      treeItems.set(k, Array.from({ length: nv }, () => []));
    }
    world.trees.forEach((t, i) => {
      const kind: TreeKind = treeItems.has(t.kind) ? t.kind : 'oak';
      const lists = treeItems.get(kind)!;
      const vi = pickVariant(i, 0x7ee, lists.length);
      const variant = set.trees[kind][vi];
      const h = t.h > 0.5 ? t.h : 10 * (t.scale > 0 ? t.scale : 1);
      const kx = 0.9 + hashFloat(i, 0x7e1) * 0.24;
      const sx = h * kx;
      const trunkR = t.r > 0 ? t.r : variant.trunkRadius * h;
      const tint = 0.88 + hashFloat(i, 0x7e2) * 0.22;
      const hue = hashFloat(i, 0x7e3) - 0.5;
      const fw = h * set.impostorWidth[kind] * kx;
      lists[vi].push({
        x: t.x, y: t.y, z: t.z, h,
        mat: trs(t.x, t.y, t.z, t.rot, sx, h, sx),
        far: trs(t.x, t.y, t.z, t.rot, fw, h, fw),
        col: [tint * (1 + hue * 0.08), tint, tint * (1 - hue * 0.12)],
        trunk: Math.min(4, Math.max(0.3, trunkR / (variant.trunkRadius * sx))),
      });
    });

    // ---- bushes ----
    const nb = Math.max(1, Math.min(profile.bushVariants, set.bushes.length));
    const bushItems: RawItem[][] = Array.from({ length: nb }, () => []);
    const bi = set.bushImpostor;
    world.bushes.forEach((b, i) => {
      const s = (b.scale > 0 ? b.scale : 1) * (0.9 + hashFloat(i, 0xb05) * 0.2);
      const rot = hashFloat(i, 0xb06) * Math.PI * 2;
      const vi = pickVariant(i, 0xb09, nb);
      const vt = set.bushes[vi].tint ?? ONE;
      const tint = 0.88 + hashFloat(i, 0xb07) * 0.24;
      const hue = hashFloat(i, 0xb08) - 0.5;
      bushItems[vi].push({
        x: b.x, y: b.y, z: b.z, h: s,
        mat: trs(b.x, b.y, b.z, rot, s, s, s),
        far: trs(b.x, b.y, b.z, rot, bi.w * s, bi.h * s, bi.w * s),
        col: [tint * (1 + hue * 0.1) * vt[0], tint * vt[1], tint * (1 - hue * 0.14) * vt[2]],
        trunk: 1,
      });
    });

    // ---- rocks: unit shape base 0 / top 1 / radius 1 -> scale (r, h, r) ----
    const nr = Math.max(1, Math.min(profile.rockVariants, set.rocks.length));
    const rockItems: RawItem[][] = Array.from({ length: nr }, () => []);
    world.rocks.forEach((r, i) => {
      const tint = 0.9 + hashFloat(r.seed, 0x40c) * 0.18;
      const warm = hashFloat(r.seed, 0x40d) - 0.5;
      rockItems[((r.seed >>> 0) + i) % nr].push({
        x: r.x, y: r.y, z: r.z, h: r.h,
        mat: trs(r.x, r.y, r.z, r.rot, r.r, r.h, r.r),
        far: null,
        col: [tint * (1 + warm * 0.06), tint, tint * (1 - warm * 0.06)],
        trunk: 1,
      });
    });

    // ---- slots ----
    const farCap = world.trees.length + world.bushes.length;
    const farGeo = buildImpostorQuad();
    this.geometries.push(farGeo);
    const farSlot = farCap > 0
      ? this.makeSlot('veg-far-impostors', { parts: [{ geometry: farGeo, material: set.impostorMaterial, depth: null, castShadow: false }] }, farCap, false, false, true)
      : null;

    for (const kind of TREE_KINDS) {
      treeItems.get(kind)!.forEach((items, vi) => {
        if (items.length === 0) return;
        const v: SpeciesVariant = set.trees[kind][vi];
        const near = this.makeSlot(`tree-${kind}-${vi}-near`, v.near, items.length, true, true, false);
        const mid = this.makeSlot(`tree-${kind}-${vi}-mid`, v.mid, items.length, false, true, false);
        this.addLayer('tree', items, [near, mid, farSlot], IMPOSTOR_CELL[kind]);
      });
    }
    bushItems.forEach((items, vi) => {
      if (items.length === 0) return;
      const v = set.bushes[vi];
      const near = this.makeSlot(`bush-${vi}-near`, v.near, items.length, true, false, false);
      const mid = this.makeSlot(`bush-${vi}-mid`, v.mid, items.length, false, false, false);
      if (near) this.bushSlots.add(near);
      this.addLayer('bush', items, [near, mid, farSlot], IMPOSTOR_CELL.bush);
    });
    // Far rocks: one cheap shared model (rocks are cover and are drawn to the far edge).
    const rockFar = set.rockFar && world.rocks.length
      ? this.makeSlot('rock-far', set.rockFar, world.rocks.length, false, false, false)
      : null;
    rockItems.forEach((items, vi) => {
      if (items.length === 0) return;
      const v = set.rocks[vi];
      const near = this.makeSlot(`rock-${vi}-near`, v.near, items.length, true, false, false);
      const mid = this.makeSlot(`rock-${vi}-mid`, v.mid, items.length, false, false, false);
      this.addLayer('rock', items, [near, mid, rockFar ?? mid], 0, true);
    });
    this.applyShadowFlags();
  }

  private makeSlot(name: string, band: BandModel, cap: number, near: boolean, trunk: boolean, cell: boolean): Slot | null {
    if (cap <= 0 || band.parts.length === 0) return null;
    const meshes: THREE.InstancedMesh[] = [];
    let lead: THREE.InstancedMesh | null = null;
    let trunkAttr: THREE.InstancedBufferAttribute | null = null;
    let cellAttr: THREE.InstancedBufferAttribute | null = null;
    if (trunk) {
      trunkAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1);
      trunkAttr.setUsage(THREE.DynamicDrawUsage);
    }
    if (cell) {
      cellAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      cellAttr.setUsage(THREE.DynamicDrawUsage);
    }
    band.parts.forEach((part, pi) => {
      // Slot-private geometry view (attributes shared by reference) so per-slot instanced
      // attributes never leak into another slot using the same model.
      const geo = new THREE.BufferGeometry();
      for (const [n, a] of Object.entries(part.geometry.attributes)) geo.setAttribute(n, a);
      if (part.geometry.index) geo.setIndex(part.geometry.index);
      geo.boundingSphere = part.geometry.boundingSphere?.clone() ?? null;
      if (trunkAttr) geo.setAttribute('aTrunk', trunkAttr);
      if (cellAttr) geo.setAttribute('aCell', cellAttr);
      this.geometries.push(geo);
      const mesh = new THREE.InstancedMesh(geo, part.material, cap);
      mesh.name = band.parts.length > 1 ? `${name}-${pi}` : name;
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = near && part.castShadow;
      mesh.receiveShadow = near;
      mesh.userData.castable = near && part.castShadow;
      // Own depth material for every caster (three's shared default is also used by skinned /
      // batched objects, which makes it re-resolve programs every frame).
      mesh.customDepthMaterial = part.depth ?? this.instDepth;
      if (lead) {
        mesh.instanceMatrix = lead.instanceMatrix;
        mesh.instanceColor = lead.instanceColor;
      } else {
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        lead = mesh;
      }
      meshes.push(mesh);
      this.group.add(mesh);
    });
    if (!lead) return null;
    const slot: Slot = { meshes, lead, cap, count: 0, shadowCaster: near, trunk: trunkAttr, cell: cellAttr };
    this.slots.push(slot);
    return slot;
  }

  /** Sort items by terrain chunk and store them as typed arrays. */
  private addLayer(group: SpeciesGroup, items: RawItem[], slots: [Slot | null, Slot | null, Slot | null], cell: number, tinyCulled = false): void {
    const n = items.length;
    const chunks = GRID * GRID;
    const chunkOf = (it: RawItem): number => {
      const cx = Math.min(GRID - 1, Math.max(0, Math.floor((it.x - this.gridMin) / this.gridCell)));
      const cz = Math.min(GRID - 1, Math.max(0, Math.floor((it.z - this.gridMin) / this.gridCell)));
      return cz * GRID + cx;
    };
    const counts = new Int32Array(chunks + 1);
    const ci = items.map(chunkOf);
    for (const c of ci) counts[c + 1]++;
    for (let c = 0; c < chunks; c++) counts[c + 1] += counts[c];
    const chunkStart = Int32Array.from(counts);
    const fill = Int32Array.from(counts);
    const layer: Layer = {
      n,
      group: GROUPS.indexOf(group),
      dist: new Float32Array(n),
      x: new Float32Array(n),
      y: new Float32Array(n),
      z: new Float32Array(n),
      mats: new Float32Array(n * 16),
      farMats: items[0]?.far ? new Float32Array(n * 16) : null,
      cols: new Float32Array(n * 3),
      trunk: slots[0]?.trunk ? new Float32Array(n) : null,
      keepFar: new Uint8Array(n),
      band: new Uint8Array(n).fill(NO_BAND),
      cell,
      slots,
      chunkStart,
      chunkMinY: new Float32Array(chunks).fill(Infinity),
      chunkMaxY: new Float32Array(chunks).fill(-Infinity),
      chunkCulled: new Uint8Array(chunks),
    };
    items.forEach((it, k) => {
      const c = ci[k];
      const i = fill[c]++;
      layer.x[i] = it.x;
      layer.y[i] = it.y;
      layer.z[i] = it.z;
      layer.mats.set(it.mat, i * 16);
      if (layer.farMats && it.far) layer.farMats.set(it.far, i * 16);
      layer.cols[i * 3] = it.col[0];
      layer.cols[i * 3 + 1] = it.col[1];
      layer.cols[i * 3 + 2] = it.col[2];
      if (layer.trunk) layer.trunk[i] = it.trunk;
      // keepFar: 0 = never in the far band (pebbles too small to hide even a prone player),
      // 1 = drawn to the far edge. Cover is never density-thinned.
      layer.keepFar[i] = tinyCulled && it.h < TINY_ROCK ? 0 : 1;
      layer.chunkMinY[c] = Math.min(layer.chunkMinY[c], it.y - 1);
      layer.chunkMaxY[c] = Math.max(layer.chunkMaxY[c], it.y + it.h);
    });
    this.layers.push(layer);
  }

  private applyProfile(v: Readonly<VegetationProfile>): boolean {
    const p = this.profile;
    if (p.near === v.near && p.mid === v.mid && p.far === v.far && p.budgetScale === v.budgetScale) return false;
    p.near = v.near;
    p.mid = v.mid;
    p.far = v.far;
    p.budgetScale = v.budgetScale;
    GROUPS.forEach((g, gi) => {
      const sc = this.set.bandScale[g];
      const near = v.near * sc[0];
      const mid = Math.max(near + 1, v.mid * sc[1]);
      this.baseEdges[gi * 3] = near;
      this.baseEdges[gi * 3 + 1] = mid;
      this.baseEdges[gi * 3 + 2] = Math.max(mid + 1, v.far);
      const e = this.edges[gi];
      e[0] = near;
      e[1] = mid;
      e[2] = this.baseEdges[gi * 3 + 2];
      const b = this.set.budget[g];
      this.budgets[gi * 2] = b[0] * v.budgetScale;
      this.budgets[gi * 2 + 1] = b[1] * v.budgetScale;
    });
    return true;
  }

  /** Scaled distance at which the group's cumulative instance count reaches `count`. */
  private distanceAtCount(g: number, count: number): number {
    const h = this.hist;
    let acc = 0;
    for (let b = 0; b < BUCKETS; b++) {
      acc += h[g * BUCKETS + b];
      if (acc >= count) return b * BUCKET;
    }
    return Infinity;
  }

  /** Distances / budgets (variant counts are fixed per renderer, see constructor). */
  setProfile(v: Readonly<VegetationProfile>): void {
    if (this.applyProfile(v)) this.forceUpdate = true;
    if (this.bushShadows !== v.bushShadows) {
      this.bushShadows = v.bushShadows;
      this.applyShadowFlags();
    }
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.applyShadowFlags();
  }

  private applyShadowFlags(): void {
    for (const s of this.slots) {
      const allow = this.shadows && s.shadowCaster && (!this.bushSlots.has(s) || this.bushShadows);
      for (const m of s.meshes) m.castShadow = allow && m.userData.castable === true;
    }
  }

  private keptFar(code: number): boolean {
    return code !== 0;
  }

  update(cx: number, cy: number, cz: number, lodScale: number, dt: number): void {
    this.timer += dt;
    const zoomJump = Math.abs(lodScale - this.lastLodScale) > 0.15 * Math.max(lodScale, this.lastLodScale);
    if (!this.forceUpdate && !zoomJump && this.timer < UPDATE_INTERVAL) return;
    this.timer = 0;
    this.lastLodScale = lodScale;
    const force = this.forceUpdate;
    this.forceUpdate = false;
    let changed = force;

    // Pass 1: chunk culling, item distances and per-group distance histograms.
    this.hist.fill(0);
    for (const L of this.layers) {
      const band = L.band;
      const gi = L.group;
      const farLimit = this.baseEdges[gi * 3 + 2] + HYSTERESIS;
      for (let c = 0; c < GRID * GRID; c++) {
        const s = L.chunkStart[c], e = L.chunkStart[c + 1];
        if (s === e) continue;
        const x0 = this.gridMin + (c % GRID) * this.gridCell, z0 = this.gridMin + Math.floor(c / GRID) * this.gridCell;
        // Pad by 12 m: impostor/canopy extents around item origins.
        const dmin = distanceToAabb(cx, cy, cz, x0 - 12, L.chunkMinY[c], z0 - 12, x0 + this.gridCell + 12, L.chunkMaxY[c], z0 + this.gridCell + 12);
        if (dmin * lodScale > farLimit || dmin > MAX_REAL_DISTANCE) {
          if (!L.chunkCulled[c] || force) {
            for (let i = s; i < e; i++) {
              if (band[i] !== 3) {
                band[i] = 3;
                changed = true;
              }
            }
          }
          L.chunkCulled[c] = 1;
          continue;
        }
        L.chunkCulled[c] = 0;
        for (let i = s; i < e; i++) {
          const dx = L.x[i] - cx, dy = L.y[i] - cy, dz = L.z[i] - cz;
          const real = Math.sqrt(dx * dx + dy * dy + dz * dz);
          L.dist[i] = real;
          const b = Math.floor((real * lodScale) / BUCKET);
          if (b < BUCKETS) this.hist[gi * BUCKETS + b]++;
        }
      }
    }

    // Budgets: the nearest N instances of a group keep the near model, the next M the mid model.
    for (let gi = 0; gi < GROUPS.length; gi++) {
      const nb = this.budgets[gi * 2], mb = this.budgets[gi * 2 + 1];
      const nearT = Math.min(this.baseEdges[gi * 3], this.distanceAtCount(gi, nb));
      const midT = Math.max(nearT + 1, Math.min(this.baseEdges[gi * 3 + 1], this.distanceAtCount(gi, nb + mb)));
      const e = this.edges[gi];
      // Smooth threshold moves (they shift as the camera walks through dense areas).
      e[0] = force ? nearT : e[0] + (nearT - e[0]) * 0.5;
      e[1] = force ? midT : e[1] + (midT - e[1]) * 0.5;
      e[2] = this.baseEdges[gi * 3 + 2];
    }

    // Pass 2: band membership with hysteresis.
    for (const L of this.layers) {
      const band = L.band;
      const edges = this.edges[L.group];
      for (let c = 0; c < GRID * GRID; c++) {
        if (L.chunkCulled[c]) continue;
        const s = L.chunkStart[c], e = L.chunkStart[c + 1];
        for (let i = s; i < e; i++) {
          const real = L.dist[i];
          const cur = band[i] === NO_BAND ? -1 : band[i];
          let nb = selectBand(real * lodScale, cur, edges, HYSTERESIS);
          if (real > MAX_REAL_DISTANCE) nb = 3;
          if (nb === 2 && !this.keptFar(L.keepFar[i])) nb = 3;
          if (nb !== band[i]) {
            band[i] = nb;
            changed = true;
          }
        }
      }
    }
    if (changed) this.rebuild();
  }

  /** Rewrite instance buffers from band membership (only called when membership changed). */
  private rebuild(): void {
    for (const s of this.slots) s.count = 0;
    for (const L of this.layers) {
      for (let i = 0; i < L.n; i++) {
        const b = L.band[i];
        if (b > 2) continue;
        const slot = L.slots[b];
        if (!slot || slot.count >= slot.cap) continue;
        const k = slot.count++;
        const dst = slot.lead.instanceMatrix.array as Float32Array;
        const src = b === 2 && L.farMats ? L.farMats : L.mats;
        const so = i * 16, d = k * 16;
        for (let j = 0; j < 16; j++) dst[d + j] = src[so + j];
        const col = slot.lead.instanceColor!.array as Float32Array;
        col[k * 3] = L.cols[i * 3];
        col[k * 3 + 1] = L.cols[i * 3 + 1];
        col[k * 3 + 2] = L.cols[i * 3 + 2];
        if (slot.trunk) (slot.trunk.array as Float32Array)[k] = L.trunk ? L.trunk[i] : 1;
        if (slot.cell) (slot.cell.array as Float32Array)[k] = L.cell;
      }
    }
    for (const s of this.slots) {
      for (const m of s.meshes) {
        m.count = s.count;
        m.visible = s.count > 0;
      }
      if (s.count === 0) continue;
      markRange(s.lead.instanceMatrix, s.count * 16);
      markRange(s.lead.instanceColor!, s.count * 3);
      if (s.trunk) markRange(s.trunk, s.count);
      if (s.cell) markRange(s.cell, s.count);
    }
  }

  /** Disposes this renderer's meshes and buffers (the model set belongs to the caller). */
  dispose(): void {
    for (const s of this.slots) s.lead.dispose();
    for (const g of this.geometries) g.dispose();
    this.instDepth.dispose();
    this.group.removeFromParent();
  }
}

function markRange(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}

/** Anisotropy / alpha-to-coverage of a model set's textures and alpha-tested materials. */
export function applySetQuality(set: VegetationModelSet, anisotropy: number, msaa: boolean): void {
  for (const t of set.textures) {
    if (t.anisotropy !== anisotropy) {
      t.anisotropy = anisotropy;
      t.needsUpdate = true;
    }
  }
  for (const m of set.alphaTested) {
    if (m.alphaToCoverage !== msaa) {
      m.alphaToCoverage = msaa;
      m.needsUpdate = true;
    }
  }
}
