// Grass tufts around the camera (high/ultra): one InstancedMesh fed by a toroidal ring buffer of
// 8 m patches. When the camera crosses a patch boundary only the patches that scrolled out are
// regenerated (deterministic placement, a bounded number per frame). Tufts appear only on grass
// surfaces (not on roads, sand, rock, water or under props), fade/shrink out toward the radius in
// the vertex shader so the edge never pops, and sway in the wind.

import * as THREE from 'three';
import type { RoadSegment, World, WorldBox } from '../../../shared/types';
import { hashFloat } from '../../../shared/rng';
import type { GrassProfile } from '../core/quality';
import { GeoBuilder, linearRgb } from './geoBuilder';
import { patchShader, type WorldUniforms } from './shaders';
import type { TerrainShading } from './terrainData';

const PATCH = 8;
const MAX_TUFTS_PER_PATCH = 256;
const PATCHES_PER_FRAME = 10;

function buildTuft(): THREE.BufferGeometry {
  const gb = new GeoBuilder().addAttribute('sway', 1);
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2 + 0.4;
    const ox = Math.cos(a) * 0.07, oz = Math.sin(a) * 0.07;
    // Blade plane faces across its lean direction.
    const lean = 0.22 + b * 0.05;
    const lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    const px = -Math.sin(a), pz = Math.cos(a);
    const w0 = 0.055, w1 = 0.032;
    const h = 1 - b * 0.12;
    const v = (x: number, y: number, z: number, k: number, s: number): number => {
      const i = gb.vertex(x, y, z, 0, 1, 0, k, k, k * 0.92);
      gb.extra('sway', s);
      return i;
    };
    const b0 = v(ox - px * w0, 0, oz - pz * w0, 0.5, 0);
    const b1 = v(ox + px * w0, 0, oz + pz * w0, 0.5, 0);
    const m0 = v(ox + lx * 0.35 - px * w1, h * 0.5, oz + lz * 0.35 - pz * w1, 0.85, 0.5);
    const m1 = v(ox + lx * 0.35 + px * w1, h * 0.5, oz + lz * 0.35 + pz * w1, 0.85, 0.5);
    const tip = v(ox + lx, h, oz + lz, 1.12, 1);
    gb.tri(b0, b1, m1);
    gb.tri(b0, m1, m0);
    gb.tri(m0, m1, tip);
  }
  return gb.build();
}

/** Wind sway, distance fade toward the radius and up-normals on both faces for a grass material. */
export function patchGrassMaterial(mat: THREE.Material, shared: WorldUniforms, fade: { value: THREE.Vector2 }, key: string): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.uniforms.uGrassFade = fade;
    shader.vertexShader =
      'attribute float sway;\nuniform float uTime;\nuniform float uWind;\nuniform vec2 uGrassFade;\n' +
      patchShader(
        shader.vertexShader,
        'begin_vertex',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 dzInst = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 dzInst = vec3(0.0);
#endif
float dzD = distance(dzInst.xz, cameraPosition.xz);
transformed *= 1.0 - smoothstep(uGrassFade.x, uGrassFade.y, dzD);
float dzPh = uTime * 2.1 + dzInst.x * 0.37 + dzInst.z * 0.29;
float dzS = sway * sway * uWind;
transformed.x += (sin(dzPh) * 0.7 + sin(dzPh * 2.7 + 0.8) * 0.3) * dzS * 0.11;
transformed.z += (cos(dzPh * 0.9 + 1.1) * 0.6 + sin(dzPh * 3.3) * 0.25) * dzS * 0.08;`,
      );
    // Blades / cards are drawn double-sided: keep the authored (up-leaning) normal on both faces.
    shader.fragmentShader = patchShader(shader.fragmentShader, 'normal_fragment_begin', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  mat.customProgramCacheKey = () => `dz-grass-${key}-v2`;
}

/** One kind of tuft drawn by its own InstancedMesh. */
export interface GrassVariant {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Instance height range (m). */
  scaleMin: number;
  scaleMax: number;
  /** Instance colour: 'terrain' = terrain albedo (vertex-coloured tufts), 'relative' = tint
   *  relative to lush grass (textured tufts). */
  tint: 'terrain' | 'relative';
}

export interface GrassModelSet {
  variants: GrassVariant[];
  /** Multiplier on the profile's tufts per square meter (big textured clumps need fewer). */
  densityScale: number;
  dispose(): void;
}

const LUSH = linearRgb(0x5c7f33);

/** Built-in blade tufts (fallback / while loading). */
export function proceduralGrassSet(shared: WorldUniforms, fade: { value: THREE.Vector2 }): GrassModelSet {
  const geometry = buildTuft();
  const material = new THREE.MeshLambertMaterial({ name: 'dz-grass', vertexColors: true, side: THREE.DoubleSide });
  patchGrassMaterial(material, shared, fade, 'procedural');
  return {
    variants: [{ geometry, material, scaleMin: 0.3, scaleMax: 0.62, tint: 'terrain' }],
    densityScale: 1,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

interface GrassMesh {
  mesh: THREE.InstancedMesh;
  variant: GrassVariant;
}

export class GrassRenderer {
  readonly group = new THREE.Group();
  readonly fade = { value: new THREE.Vector2(30, 45) };
  private readonly world: World;
  private readonly shading: TerrainShading;
  private set: GrassModelSet;
  private meshes: GrassMesh[] = [];
  private n = 0;
  private tufts = 0;
  private slotPx = new Int32Array(0);
  private slotPz = new Int32Array(0);
  private profile: Readonly<GrassProfile> = { enabled: false, radius: 0, density: 0 };
  private readonly boxScratch: WorldBox[] = [];
  private readonly roadScratch: RoadSegment[] = [];
  private readonly nScratch = { x: 0, y: 1, z: 0 };

  constructor(world: World, shading: TerrainShading, shared: WorldUniforms) {
    this.world = world;
    this.shading = shading;
    this.group.name = 'grass';
    this.set = proceduralGrassSet(shared, this.fade);
  }

  /** Swap the tuft models (e.g. once the glTF grass loaded). The previous set is disposed. */
  setModels(set: GrassModelSet): void {
    const old = this.set;
    this.set = set;
    const p = this.profile;
    this.release();
    this.profile = { enabled: false, radius: 0, density: 0 };
    this.configure(p);
    old.dispose();
  }

  /** (Re)allocate for a quality profile; disabled profiles free the instance buffers. */
  configure(p: Readonly<GrassProfile>): void {
    const enabled = p.enabled && p.radius > 0 && p.density > 0;
    if (!enabled) {
      this.release();
      this.profile = p;
      return;
    }
    if (p.radius === this.profile.radius && p.density === this.profile.density && this.meshes.length) return;
    this.release();
    this.profile = p;
    const nv = this.set.variants.length;
    this.n = 2 * Math.ceil(p.radius / PATCH) + 1;
    const total = Math.min(MAX_TUFTS_PER_PATCH, Math.ceil(PATCH * PATCH * p.density * this.set.densityScale));
    this.tufts = Math.max(1, Math.ceil(total / nv));
    const cap = this.n * this.n * this.tufts;
    this.meshes = this.set.variants.map((variant, vi) => {
      const mesh = new THREE.InstancedMesh(variant.geometry, variant.material, cap);
      mesh.name = nv > 1 ? `grass-tufts-${vi}` : 'grass-tufts';
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Start with collapsed (zero-scale) instances until their patch is generated.
      const m0 = mesh.instanceMatrix.array as Float32Array;
      m0.fill(0);
      for (let o = 0; o < m0.length; o += 16) {
        m0[o + 13] = -10000;
        m0[o + 15] = 1;
      }
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return { mesh, variant };
    });
    this.slotPx = new Int32Array(this.n * this.n).fill(0x7fffffff);
    this.slotPz = new Int32Array(this.n * this.n).fill(0x7fffffff);
    this.fade.value.set(p.radius * 0.68, p.radius);
  }

  private release(): void {
    for (const g of this.meshes) {
      this.group.remove(g.mesh);
      g.mesh.dispose();
    }
    this.meshes = [];
  }

  update(cx: number, cz: number): void {
    if (this.meshes.length === 0) return;
    const n = this.n, k = (n - 1) >> 1;
    const cpx = Math.floor(cx / PATCH), cpz = Math.floor(cz / PATCH);
    let budget = PATCHES_PER_FRAME;
    let dirtyMin = Infinity, dirtyMax = -Infinity;
    // Visit rings from the centre outward so the nearest missing patches fill first.
    for (let ring = 0; ring <= k && budget > 0; ring++) {
      for (let dz = -ring; dz <= ring && budget > 0; dz++) {
        for (let dx = -ring; dx <= ring && budget > 0; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const px = cpx + dx, pz = cpz + dz;
          const sx = ((px % n) + n) % n, sz = ((pz % n) + n) % n;
          const slot = sz * n + sx;
          if (this.slotPx[slot] === px && this.slotPz[slot] === pz) continue;
          this.fillPatch(slot, px, pz);
          this.slotPx[slot] = px;
          this.slotPz[slot] = pz;
          budget--;
          dirtyMin = Math.min(dirtyMin, slot);
          dirtyMax = Math.max(dirtyMax, slot);
        }
      }
    }
    if (dirtyMax >= 0) {
      const t = this.tufts;
      const start = dirtyMin * t, count = (dirtyMax - dirtyMin + 1) * t;
      for (const { mesh } of this.meshes) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(start * 16, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(start * 3, count * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    }
  }

  private fillPatch(slot: number, px: number, pz: number): void {
    const w = this.world;
    const x0 = px * PATCH, z0 = pz * PATCH;
    const boxes = w.queryBoxes(x0, z0, x0 + PATCH, z0 + PATCH, this.boxScratch);
    const roads = this.roadScratch;
    roads.length = 0;
    for (const r of w.roads) {
      const m = r.width / 2 + 0.5;
      if (Math.max(r.a.x, r.b.x) + m < x0 || Math.min(r.a.x, r.b.x) - m > x0 + PATCH) continue;
      if (Math.max(r.a.z, r.b.z) + m < z0 || Math.min(r.a.z, r.b.z) - m > z0 + PATCH) continue;
      roads.push(r);
    }
    const { res, cell, half } = w;
    const base = slot * this.tufts;
    for (let vi = 0; vi < this.meshes.length; vi++) {
      const { mesh, variant } = this.meshes[vi];
      const mats = mesh.instanceMatrix.array as Float32Array;
      const cols = mesh.instanceColor!.array as Float32Array;
      const salt = vi * 7919;
      for (let t = 0; t < this.tufts; t++) {
        const o = (base + t) * 16;
        const x = x0 + hashFloat(px, pz, t + salt, 1) * PATCH;
        const z = z0 + hashFloat(px, pz, t + salt, 2) * PATCH;
        if (!this.accept(x, z, boxes, roads)) {
          // Degenerate (zero scale) instance at the patch: costs nothing to rasterise.
          for (let j = 0; j < 16; j++) mats[o + j] = 0;
          mats[o + 12] = x0;
          mats[o + 14] = z0;
          mats[o + 15] = 1;
          continue;
        }
        const y = w.heightAt(x, z) - 0.03;
        const s = variant.scaleMin + hashFloat(px, pz, t + salt, 3) * (variant.scaleMax - variant.scaleMin);
        const rot = hashFloat(px, pz, t + salt, 4) * Math.PI * 2;
        const c = Math.cos(rot) * s * 0.95, sn = Math.sin(rot) * s * 0.95;
        mats[o] = c; mats[o + 1] = 0; mats[o + 2] = -sn; mats[o + 3] = 0;
        mats[o + 4] = 0; mats[o + 5] = s; mats[o + 6] = 0; mats[o + 7] = 0;
        mats[o + 8] = sn; mats[o + 9] = 0; mats[o + 10] = c; mats[o + 11] = 0;
        mats[o + 12] = x; mats[o + 13] = y; mats[o + 14] = z; mats[o + 15] = 1;
        const i = Math.min(res - 1, Math.max(0, Math.round((x + half) / cell)));
        const j = Math.min(res - 1, Math.max(0, Math.round((z + half) / cell)));
        const kk = (j * res + i) * 3;
        const v = 0.82 + hashFloat(px, pz, t + salt, 5) * 0.36;
        const co = (base + t) * 3;
        const tr = this.shading.colors[kk], tg = this.shading.colors[kk + 1], tb = this.shading.colors[kk + 2];
        if (variant.tint === 'terrain') {
          cols[co] = tr * v * 1.05;
          cols[co + 1] = tg * v * 1.08;
          cols[co + 2] = tb * v * 0.95;
        } else {
          // Follow the meadow's lush/dry variation relative to the base grass colour.
          cols[co] = Math.min(1.4, Math.max(0.6, tr / LUSH[0])) * v;
          cols[co + 1] = Math.min(1.4, Math.max(0.6, tg / LUSH[1])) * v;
          cols[co + 2] = Math.min(1.4, Math.max(0.6, tb / LUSH[2])) * v;
        }
      }
    }
  }
  private accept(x: number, z: number, boxes: readonly WorldBox[], roads: readonly RoadSegment[]): boolean {
    const w = this.world;
    if (!w.inBounds(x, z)) return false;
    if (w.surfaceAt(x, z) !== 'grass') return false;
    const { res, cell, half } = w;
    const i = Math.min(res - 1, Math.max(0, Math.round((x + half) / cell)));
    const j = Math.min(res - 1, Math.max(0, Math.round((z + half) / cell)));
    if (this.shading.surf[(j * res + i) * 2] < 0.55) return false;
    if (w.normalAt(x, z, this.nScratch).y < 0.82) return false;
    for (const b of boxes) {
      if (x >= b.min.x - 0.1 && x <= b.max.x + 0.1 && z >= b.min.z - 0.1 && z <= b.max.z + 0.1) return false;
    }
    for (const r of roads) {
      const dx = r.b.x - r.a.x, dz = r.b.z - r.a.z;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - r.a.x) * dx + (z - r.a.z) * dz) / l2)) : 0;
      const ex = r.a.x + dx * t - x, ez = r.a.z + dz * t - z;
      const m = r.width / 2 + 0.4;
      if (ex * ex + ez * ez < m * m) return false;
    }
    return true;
  }

  dispose(): void {
    this.release();
    this.set.dispose();
    this.group.removeFromParent();
  }
}
