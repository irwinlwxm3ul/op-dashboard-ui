// Instanced vegetation with distance bands: near (full low-poly), mid (simplified), far (cross-quad
// impostors from a canvas atlas), culled beyond. Items are bucketed by terrain chunk; band
// membership is recomputed a few times per second (whole chunks beyond the far band are skipped
// in one test), with hysteresis so objects on a boundary never flicker, and instance buffers are
// rewritten only when membership changed. Wind sway runs in the vertex shader. Trunks are scaled
// per instance to the physics trunk radius; rocks match the physics ellipsoid (r, h, r).

import * as THREE from 'three';
import type { TreeKind, World } from '../../../shared/types';
import { hashFloat } from '../../../shared/rng';
import type { VegetationProfile } from '../core/quality';
import { distanceToAabb, selectBand } from './lod';
import { patchShader, type WorldUniforms } from './shaders';
import {
  BUSH_IMPOSTOR_H, BUSH_IMPOSTOR_W, IMPOSTOR_CELL, IMPOSTOR_CELLS, IMPOSTOR_WIDTH, TREE_KINDS, UNIT_TRUNK_RADIUS,
  buildBushModels, buildImpostorQuad, buildRockModel, buildTreeModels, createImpostorAtlas,
} from './vegetationModels';

const GRID = 8;
const HYSTERESIS = 10;
const ROCK_VARIANTS = 4;
/** Hard cap on real distance (zoomed scopes shrink LOD distances, not draw distance). */
const MAX_REAL_DISTANCE = 1060;
const UPDATE_INTERVAL = 0.25;

interface Slot {
  mesh: THREE.InstancedMesh;
  cap: number;
  count: number;
  trunk: THREE.InstancedBufferAttribute | null;
  cell: THREE.InstancedBufferAttribute | null;
}

interface Layer {
  n: number;
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

const NO_BAND = 255;

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

/** Foliage material: wind sway (+ per-instance trunk radius for trees). */
function createFoliageMaterial(shared: WorldUniforms, trunkScale: boolean, depth: boolean): THREE.Material {
  const mat: THREE.Material = depth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  mat.name = `dz-foliage${trunkScale ? '-tree' : '-bush'}${depth ? '-depth' : ''}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    const head =
      'attribute float sway;\nuniform float uTime;\nuniform float uWind;\n' +
      (trunkScale ? 'attribute float trunk;\nattribute float aTrunk;\n' : '');
    shader.vertexShader =
      head +
      patchShader(
        shader.vertexShader,
        'begin_vertex',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 dzInst = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 dzInst = vec3(0.0);
#endif
${trunkScale ? 'transformed.xz *= mix(1.0, aTrunk, trunk);' : ''}
float dzPh = uTime * 1.6 + dzInst.x * 0.051 + dzInst.z * 0.073;
float dzS = sway * sway * uWind;
transformed.x += (sin(dzPh) + 0.45 * sin(dzPh * 2.3 + 1.7)) * dzS * 0.016;
transformed.z += (cos(dzPh * 0.83 + 0.4) + 0.35 * sin(dzPh * 3.1)) * dzS * 0.011;
transformed += normal * (sin(uTime * 5.5 + (position.x + position.z) * 37.0 + dzInst.x) * 0.004 * dzS);`,
      );
    if (!depth) {
      // Foliage transmits and scatters light: a constant wrap term keeps shaded canopies green
      // instead of near-black (cheap stand-in for translucency).
      shader.fragmentShader = patchShader(
        shader.fragmentShader,
        'lights_fragment_end',
        '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * 0.3;',
      );
    }
  };
  mat.customProgramCacheKey = () => `dz-foliage-${trunkScale ? 1 : 0}-${depth ? 1 : 0}-v2`;
  return mat;
}

function createImpostorMaterial(atlas: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'dz-impostor',
    map: atlas,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    alphaTest: 0.42,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float aCell;\n' +
      patchShader(
        shader.vertexShader,
        'uv_vertex',
        `#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv.x = (vMapUv.x + aCell) * ${(1 / IMPOSTOR_CELLS).toFixed(6)};\n#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'dz-impostor-v1';
  return mat;
}

export class VegetationRenderer {
  readonly group = new THREE.Group();
  private readonly layers: Layer[] = [];
  private readonly slots: Slot[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly atlas: THREE.CanvasTexture | null;
  private readonly impostorMaterial: THREE.MeshStandardMaterial;
  private readonly edges = [150, 450, 900];
  private density = 1;
  private readonly gridMin: number;
  private readonly gridCell: number;
  private timer = UPDATE_INTERVAL;
  private lastLodScale = 1;
  private forceUpdate = true;

  constructor(world: World, shared: WorldUniforms) {
    this.group.name = 'vegetation';
    this.gridMin = -world.half;
    this.gridCell = world.size / GRID;

    this.atlas = createImpostorAtlas();
    this.impostorMaterial = createImpostorMaterial(this.atlas);
    const treeMat = createFoliageMaterial(shared, true, false);
    const treeDepth = createFoliageMaterial(shared, true, true);
    const bushMat = createFoliageMaterial(shared, false, false);
    const bushDepth = createFoliageMaterial(shared, false, true);
    const rockMat = new THREE.MeshStandardMaterial({ name: 'dz-rock', vertexColors: true, roughness: 0.94, metalness: 0 });
    this.materials.push(this.impostorMaterial, treeMat, treeDepth, bushMat, bushDepth, rockMat);

    // ---- gather raw items per layer ----
    const treeItems = new Map<TreeKind, RawItem[]>();
    for (const k of TREE_KINDS) treeItems.set(k, []);
    world.trees.forEach((t, i) => {
      const kind: TreeKind = treeItems.has(t.kind) ? t.kind : 'oak';
      const h = t.h > 0.5 ? t.h : 10 * (t.scale > 0 ? t.scale : 1);
      const kx = 0.9 + hashFloat(i, 0x7e1) * 0.24;
      const sx = h * kx;
      const trunkR = t.r > 0 ? t.r : UNIT_TRUNK_RADIUS * h;
      const tint = 0.86 + hashFloat(i, 0x7e2) * 0.26;
      const hue = hashFloat(i, 0x7e3) - 0.5;
      treeItems.get(kind)!.push({
        x: t.x, y: t.y, z: t.z, h,
        mat: trs(t.x, t.y, t.z, t.rot, sx, h, sx),
        far: trs(t.x, t.y, t.z, t.rot, h * IMPOSTOR_WIDTH[kind] * kx, h, h * IMPOSTOR_WIDTH[kind] * kx),
        col: [tint * (1 + hue * 0.1), tint, tint * (1 - hue * 0.14)],
        trunk: Math.min(4, Math.max(0.3, trunkR / (UNIT_TRUNK_RADIUS * sx))),
      });
    });
    const bushItems: RawItem[] = world.bushes.map((b, i) => {
      const s = (b.scale > 0 ? b.scale : 1) * (0.9 + hashFloat(i, 0xb05) * 0.2);
      const rot = hashFloat(i, 0xb06) * Math.PI * 2;
      const tint = 0.85 + hashFloat(i, 0xb07) * 0.3;
      const hue = hashFloat(i, 0xb08) - 0.5;
      return {
        x: b.x, y: b.y, z: b.z, h: s,
        mat: trs(b.x, b.y, b.z, rot, s, s, s),
        far: trs(b.x, b.y, b.z, rot, BUSH_IMPOSTOR_W * s, BUSH_IMPOSTOR_H * s, BUSH_IMPOSTOR_W * s),
        col: [tint * (1 + hue * 0.12), tint, tint * (1 - hue * 0.16)],
        trunk: 1,
      };
    });
    const rockItems: RawItem[][] = [];
    for (let v = 0; v < ROCK_VARIANTS; v++) rockItems.push([]);
    world.rocks.forEach((r, i) => {
      const v = ((r.seed >>> 0) + i) % ROCK_VARIANTS;
      const tint = 0.84 + hashFloat(r.seed, 0x40c) * 0.26;
      const warm = hashFloat(r.seed, 0x40d) - 0.5;
      rockItems[v].push({
        x: r.x, y: r.y, z: r.z, h: r.h,
        mat: trs(r.x, r.y, r.z, r.rot, r.r, r.h, r.r),
        far: null,
        col: [tint * (1 + warm * 0.08), tint, tint * (1 - warm * 0.08)],
        trunk: 1,
      });
    });

    // ---- shared slots ----
    const farCap = world.trees.length + world.bushes.length;
    const farGeo = buildImpostorQuad();
    const farSlot = this.makeSlot('veg-far-impostors', farGeo, this.impostorMaterial, null, farCap, false, false, true);

    for (const kind of TREE_KINDS) {
      const items = treeItems.get(kind)!;
      if (items.length === 0) continue;
      const models = buildTreeModels(kind);
      const near = this.makeSlot(`tree-${kind}-near`, models.near, treeMat, treeDepth, items.length, true, true, false);
      const mid = this.makeSlot(`tree-${kind}-mid`, models.mid, treeMat, treeDepth, items.length, false, true, false);
      this.addLayer(items, [near, mid, farSlot], IMPOSTOR_CELL[kind]);
    }
    if (bushItems.length) {
      const models = buildBushModels();
      const near = this.makeSlot('bush-near', models.near, bushMat, bushDepth, bushItems.length, true, false, false);
      const mid = this.makeSlot('bush-mid', models.mid, bushMat, bushDepth, bushItems.length, false, false, false);
      this.addLayer(bushItems, [near, mid, farSlot], IMPOSTOR_CELL.bush, true);
    }
    const rockTotal = world.rocks.length;
    if (rockTotal) {
      const midGeo = buildRockModel(7, 0);
      const mid = this.makeSlot('rock-mid', midGeo, rockMat, null, rockTotal, false, false, false);
      for (let v = 0; v < ROCK_VARIANTS; v++) {
        if (rockItems[v].length === 0) continue;
        const near = this.makeSlot(`rock-near-${v}`, buildRockModel(v, 1), rockMat, null, rockItems[v].length, true, false, false);
        this.addLayer(rockItems[v], [near, mid, mid], 0, false, true);
      }
    }
  }

  private makeSlot(
    name: string, geo: THREE.BufferGeometry, mat: THREE.Material, depth: THREE.Material | null,
    cap: number, near: boolean, trunk: boolean, cell: boolean,
  ): Slot | null {
    if (cap <= 0) {
      geo.dispose();
      return null;
    }
    this.geometries.push(geo);
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = near;
    mesh.receiveShadow = near;
    if (depth) mesh.customDepthMaterial = depth;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    let trunkAttr: THREE.InstancedBufferAttribute | null = null;
    if (trunk) {
      trunkAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1);
      trunkAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aTrunk', trunkAttr);
    }
    let cellAttr: THREE.InstancedBufferAttribute | null = null;
    if (cell) {
      cellAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      cellAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aCell', cellAttr);
    }
    this.group.add(mesh);
    const slot: Slot = { mesh, cap, count: 0, trunk: trunkAttr, cell: cellAttr };
    this.slots.push(slot);
    return slot;
  }

  /** Sort items by terrain chunk and store them as typed arrays. */
  private addLayer(items: RawItem[], slots: [Slot | null, Slot | null, Slot | null], cell: number, densityCulled = false, smallCulled = false): void {
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
      // keepFar code: 1 = always kept in the far band; 128 + rank (0..99) = kept while rank < density * 100.
      const rank = Math.floor(hashFloat(Math.round(it.x * 10), Math.round(it.z * 10), 0x5eed) * 100);
      const small = smallCulled && it.h < 1.2;
      layer.keepFar[i] = densityCulled || small ? 128 + Math.min(99, rank) : 1;
      layer.chunkMinY[c] = Math.min(layer.chunkMinY[c], it.y - 1);
      layer.chunkMaxY[c] = Math.max(layer.chunkMaxY[c], it.y + it.h);
    });
    this.layers.push(layer);
  }

  setProfile(v: Readonly<VegetationProfile>): void {
    if (this.edges[0] !== v.near || this.edges[1] !== v.mid || this.edges[2] !== v.far || this.density !== v.density) {
      this.edges[0] = v.near;
      this.edges[1] = v.mid;
      this.edges[2] = v.far;
      this.density = v.density;
      this.forceUpdate = true;
    }
  }

  setShadows(on: boolean): void {
    for (const s of this.slots) {
      if (s.mesh.receiveShadow) s.mesh.castShadow = on;
    }
  }

  setAnisotropy(a: number, msaa: boolean): void {
    if (this.atlas && this.atlas.anisotropy !== a) {
      this.atlas.anisotropy = a;
      this.atlas.needsUpdate = true;
    }
    if (this.impostorMaterial.alphaToCoverage !== msaa) {
      this.impostorMaterial.alphaToCoverage = msaa;
      this.impostorMaterial.needsUpdate = true;
    }
  }

  private keptFar(code: number): boolean {
    if (code < 128) return true;
    return code - 128 < this.density * 100;
  }

  update(cx: number, cy: number, cz: number, lodScale: number, dt: number): void {
    this.timer += dt;
    const zoomJump = Math.abs(lodScale - this.lastLodScale) > 0.15 * Math.max(lodScale, this.lastLodScale);
    if (!this.forceUpdate && !zoomJump && this.timer < UPDATE_INTERVAL) return;
    this.timer = 0;
    this.lastLodScale = lodScale;
    const force = this.forceUpdate;
    this.forceUpdate = false;
    const edges = this.edges;
    const farLimit = edges[2] + HYSTERESIS;
    let changed = force;
    for (const L of this.layers) {
      const band = L.band;
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
            L.chunkCulled[c] = 1;
          }
          continue;
        }
        L.chunkCulled[c] = 0;
        for (let i = s; i < e; i++) {
          const dx = L.x[i] - cx, dy = L.y[i] - cy, dz = L.z[i] - cz;
          const real = Math.sqrt(dx * dx + dy * dy + dz * dz);
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
        const dst = slot.mesh.instanceMatrix.array as Float32Array;
        const src = b === 2 && L.farMats ? L.farMats : L.mats;
        const so = i * 16, d = k * 16;
        for (let j = 0; j < 16; j++) dst[d + j] = src[so + j];
        const col = slot.mesh.instanceColor!.array as Float32Array;
        col[k * 3] = L.cols[i * 3];
        col[k * 3 + 1] = L.cols[i * 3 + 1];
        col[k * 3 + 2] = L.cols[i * 3 + 2];
        if (slot.trunk) (slot.trunk.array as Float32Array)[k] = L.trunk ? L.trunk[i] : 1;
        if (slot.cell) (slot.cell.array as Float32Array)[k] = L.cell;
      }
    }
    for (const s of this.slots) {
      const m = s.mesh;
      m.count = s.count;
      m.visible = s.count > 0;
      if (s.count === 0) continue;
      markRange(m.instanceMatrix, s.count * 16);
      markRange(m.instanceColor!, s.count * 3);
      if (s.trunk) markRange(s.trunk, s.count);
      if (s.cell) markRange(s.cell, s.count);
    }
  }

  dispose(): void {
    for (const s of this.slots) s.mesh.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.atlas?.dispose();
    this.group.removeFromParent();
  }
}

function markRange(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}
