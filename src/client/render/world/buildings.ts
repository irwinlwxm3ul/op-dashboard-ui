// Buildings & props from World.boxes:
//  * one merged vertex-coloured mesh per building (full detail, casts/receives shadows) within the
//    quality's detail distance;
//  * beyond it a single global "exterior shell" mesh (facade/roof boxes + dark interior cores so
//    windows read dark) in which each building is shown/hidden through a tiny visibility texture —
//    one draw call for every distant building, near-identical silhouette so the swap does not pop;
//  * free-standing props (building === -1) merged per 128 m spatial chunk;
//  * training target plates get a canvas ring texture on their faces.

import * as THREE from 'three';
import type { BuildingDef, World, WorldBox } from '../../../shared/types';
import {
  boxBaseColor, buildingFaceShade, emitBox, materialRM, visibleFaces, type Aabb, type BuildingContext, type FaceStyle,
} from './boxGeometry';
import { GeoBuilder, linearRgb } from './geoBuilder';
import { distanceToAabb, selectBand } from './lod';
import { NOISE_GLSL, patchShader } from './shaders';

const PROP_CHUNK = 128;
const LOD_HYSTERESIS = 15;
const SHELL_TEX_WIDTH = 256;
const INTERIOR_CORE = linearRgb(0x1f1d1b);
const SHELL_SKIP_KINDS = new Set(['stairs', 'misc', 'rack', 'crate', 'target']);

interface BuildingEntry {
  index: number;
  mesh: THREE.Mesh | null;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  band: number;
}

/** Building/prop material: per-vertex roughness/metalness + subtle world-space weathering. */
function createBoxMaterial(shell: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: shell ? 'dz-building-shell' : 'dz-building',
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
  const shellVis: { value: THREE.Texture | null } = { value: null };
  mat.userData.shellVis = shellVis;
  mat.onBeforeCompile = (shader) => {
    let vs = shader.vertexShader;
    let head = 'attribute vec2 rm;\nvarying vec2 vDzRM;\nvarying vec3 vDzWorld;\n';
    if (shell) head += 'attribute float bld;\nuniform sampler2D uShellVis;\n';
    vs = patchShader(vs, 'begin_vertex', '#include <begin_vertex>\nvDzRM = rm;\nvDzWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    if (shell) {
      vs = patchShader(
        vs,
        'project_vertex',
        `#include <project_vertex>
{
  int bi = int(bld + 0.5);
  float vis = texelFetch(uShellVis, ivec2(bi % ${SHELL_TEX_WIDTH}, bi / ${SHELL_TEX_WIDTH}), 0).r;
  if (vis < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
      );
      shader.uniforms.uShellVis = shellVis;
    }
    shader.vertexShader = head + vs;
    let fs = shader.fragmentShader;
    fs = patchShader(fs, 'roughnessmap_fragment', 'float roughnessFactor = vDzRM.x;');
    fs = patchShader(fs, 'metalnessmap_fragment', 'float metalnessFactor = vDzRM.y;');
    fs = patchShader(
      fs,
      'color_fragment',
      /* glsl */ `#include <color_fragment>
{
  float camDist = length(vDzWorld - cameraPosition);
  float fade = 1.0 - smoothstep(40.0, 220.0, camDist);
  float grime = dzNoise(vec2(vDzWorld.x + vDzWorld.z, vDzWorld.y * 0.35) * 1.3);
  float blotch = dzNoise(vDzWorld.xz * 0.9 + vDzWorld.y * 0.6);
  diffuseColor.rgb *= 1.0 + ((grime - 0.5) * 0.12 + (blotch - 0.5) * 0.08) * fade;
}`,
    );
    shader.fragmentShader = 'varying vec2 vDzRM;\nvarying vec3 vDzWorld;\n' + NOISE_GLSL + fs;
  };
  mat.customProgramCacheKey = () => (shell ? 'dz-building-shell-v1' : 'dz-building-v1');
  return mat;
}

/** Canvas texture for target plates: cream board, black scoring rings, red centre, head zone. */
function createTargetTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const w = 128, h = 384;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ddd6c2';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#3a3a38';
  g.lineWidth = 4;
  g.strokeRect(2, 2, w - 4, h - 4);
  // Head zone (top 22 % of the plate counts as head in the simulation).
  const headH = h * 0.22;
  g.fillStyle = '#c9c0a8';
  g.fillRect(4, 4, w - 8, headH - 4);
  g.strokeStyle = '#b23a2a';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(w / 2, headH / 2 + 2, headH * 0.32, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(4, headH);
  g.lineTo(w - 4, headH);
  g.strokeStyle = '#3a3a38';
  g.lineWidth = 2;
  g.stroke();
  // Body rings.
  const cy = headH + (h - headH) * 0.42;
  const rings = [56, 44, 32, 20];
  for (let i = 0; i < rings.length; i++) {
    g.beginPath();
    g.arc(w / 2, cy, rings[i], 0, Math.PI * 2);
    g.fillStyle = i % 2 === 0 ? '#2b2b29' : '#ddd6c2';
    g.fill();
  }
  g.beginPath();
  g.arc(w / 2, cy, 9, 0, Math.PI * 2);
  g.fillStyle = '#c0362a';
  g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class BuildingRenderer {
  readonly group = new THREE.Group();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly shellMaterial: THREE.MeshStandardMaterial;
  private readonly targetMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly targetTexture: THREE.CanvasTexture | null;
  private readonly entries: BuildingEntry[] = [];
  private readonly shell: THREE.Mesh | null = null;
  private readonly shellData: Uint8Array;
  private readonly shellTex: THREE.DataTexture;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly shadowCasters: THREE.Mesh[] = [];
  private readonly edges = [220];
  private shellDirty = true;

  constructor(world: World) {
    this.group.name = 'buildings';
    this.material = createBoxMaterial(false);
    this.shellMaterial = createBoxMaterial(true);
    this.targetTexture = world.kind === 'training' ? createTargetTexture() : null;
    if (this.targetTexture) {
      this.targetMaterial = new THREE.MeshStandardMaterial({ name: 'dz-target', map: this.targetTexture, roughness: 0.9 });
    }

    const rows = Math.max(1, Math.ceil(world.buildings.length / SHELL_TEX_WIDTH));
    this.shellData = new Uint8Array(SHELL_TEX_WIDTH * rows);
    this.shellTex = new THREE.DataTexture(this.shellData, SHELL_TEX_WIDTH, rows, THREE.RedFormat, THREE.UnsignedByteType);
    this.shellTex.minFilter = THREE.NearestFilter;
    this.shellTex.magFilter = THREE.NearestFilter;
    this.shellTex.generateMipmaps = false;
    this.shellTex.needsUpdate = true;
    (this.shellMaterial.userData.shellVis as { value: THREE.Texture | null }).value = this.shellTex;

    const heightAt = world.heightAt;
    const boxes = world.boxes;
    const owned = new Uint8Array(boxes.length);
    const shellBuilder = new GeoBuilder().addAttribute('rm', 2).addAttribute('bld', 1);
    const shade: number[] = [1, 1, 1, 1, 1, 1];

    world.buildings.forEach((bd, index) => {
      const list: WorldBox[] = [];
      for (const id of bd.boxIds) {
        const b = boxes[id];
        if (!b) continue;
        list.push(b);
        owned[id] = 1;
      }
      if (list.length === 0) return;
      const ctx = this.buildingContext(bd, list);
      const full = new GeoBuilder().addAttribute('rm', 2);
      for (const b of list) {
        if (b.kind === 'target') continue;
        const mask = visibleFaces(b, list, heightAt);
        if (!mask) continue;
        const style: FaceStyle = {
          color: boxBaseColor(b),
          rm: materialRM(b.material),
          faceShade: buildingFaceShade(b, ctx, shade),
          bottomShade: 0.84,
          ribbed: b.kind === 'container',
        };
        emitBox(full, b, mask, style);
        if (this.inShell(b, ctx)) {
          style.bld = index;
          emitBox(shellBuilder, b, mask, style);
        }
      }
      this.emitInteriorCores(shellBuilder, bd, list, index);
      let mesh: THREE.Mesh | null = null;
      if (!full.isEmpty) {
        const geo = full.build();
        this.geometries.push(geo);
        mesh = new THREE.Mesh(geo, this.material);
        mesh.name = `building-${bd.id}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        this.group.add(mesh);
        this.shadowCasters.push(mesh);
      }
      this.entries.push({
        index,
        mesh,
        minX: bd.min.x,
        minY: bd.min.y,
        minZ: bd.min.z,
        maxX: bd.max.x,
        maxY: bd.max.y,
        maxZ: bd.max.z,
        band: -1,
      });
    });

    if (!shellBuilder.isEmpty) {
      const geo = shellBuilder.build();
      this.geometries.push(geo);
      const shell = new THREE.Mesh(geo, this.shellMaterial);
      shell.name = 'building-shells';
      shell.frustumCulled = false;
      shell.matrixAutoUpdate = false;
      shell.castShadow = false;
      shell.receiveShadow = false;
      this.group.add(shell);
      this.shell = shell;
    }

    this.buildProps(world, owned);
  }

  private buildingContext(bd: BuildingDef, list: readonly WorldBox[]): BuildingContext {
    let minX = bd.min.x, minY = bd.min.y, minZ = bd.min.z, maxX = bd.max.x, maxY = bd.max.y, maxZ = bd.max.z;
    for (const b of list) {
      minX = Math.min(minX, b.min.x); minY = Math.min(minY, b.min.y); minZ = Math.min(minZ, b.min.z);
      maxX = Math.max(maxX, b.max.x); maxY = Math.max(maxY, b.max.y); maxZ = Math.max(maxZ, b.max.z);
    }
    let interiorTop = -Infinity;
    for (const b of list) if (b.kind === 'roof') interiorTop = Math.max(interiorTop, b.min.y);
    if (!Number.isFinite(interiorTop)) interiorTop = maxY;
    return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ }, interiorTop };
  }

  /** Exterior shell membership: facade / roof boxes large enough to matter at distance. */
  private inShell(b: WorldBox, ctx: BuildingContext): boolean {
    if (SHELL_SKIP_KINDS.has(b.kind)) return false;
    const dx = b.max.x - b.min.x, dy = b.max.y - b.min.y, dz = b.max.z - b.min.z;
    if (Math.max(dx * dy, dz * dy, dx * dz) < 1.0) return false;
    if (b.kind === 'roof' || b.max.y >= ctx.max.y - 0.6) return true;
    const m = 0.6;
    return (
      b.min.x <= ctx.min.x + m || b.max.x >= ctx.max.x - m ||
      b.min.z <= ctx.min.z + m || b.max.z >= ctx.max.z - m
    );
  }

  /** Dark boxes filling each storey (floor slab with a ceiling above) so windows of shells read dark. */
  private emitInteriorCores(out: GeoBuilder, bd: BuildingDef, list: readonly WorldBox[], index: number): void {
    const style: FaceStyle = {
      color: INTERIOR_CORE,
      rm: [1, 0],
      faceShade: [1, 1, 1, 1, 1, 1],
      bottomShade: 1,
      ribbed: false,
      bld: index,
    };
    const inset = 0.32;
    for (const f of list) {
      if (f.kind !== 'floor') continue;
      const fx = f.max.x - f.min.x, fz = f.max.z - f.min.z;
      if (fx * fz < 4 || fx < 1.2 || fz < 1.2) continue;
      let ceil = Infinity;
      for (const c of list) {
        if (c === f || (c.kind !== 'floor' && c.kind !== 'roof')) continue;
        if (c.min.y <= f.max.y + 1.0) continue;
        if (c.max.x <= f.min.x || c.min.x >= f.max.x || c.max.z <= f.min.z || c.min.z >= f.max.z) continue;
        ceil = Math.min(ceil, c.min.y);
      }
      if (!Number.isFinite(ceil) || ceil > bd.max.y + 0.01) continue;
      const core: Aabb = {
        min: { x: f.min.x + inset, y: f.max.y, z: f.min.z + inset },
        max: { x: f.max.x - inset, y: ceil, z: f.max.z - inset },
      };
      // Only the four sides: top/bottom are never visible from outside.
      emitBox(out, core, 0b110011, style);
    }
  }

  private buildProps(world: World, owned: Uint8Array): void {
    const half = world.half;
    const nChunks = Math.max(1, Math.ceil(world.size / PROP_CHUNK));
    const buckets = new Map<number, WorldBox[]>();
    const targets: WorldBox[] = [];
    for (const b of world.boxes) {
      if (owned[b.id] && b.building >= 0) continue;
      if (b.kind === 'target' && this.targetMaterial && isTargetPlate(b)) {
        targets.push(b);
        continue;
      }
      const cx = Math.min(nChunks - 1, Math.max(0, Math.floor(((b.min.x + b.max.x) / 2 + half) / PROP_CHUNK)));
      const cz = Math.min(nChunks - 1, Math.max(0, Math.floor(((b.min.z + b.max.z) / 2 + half) / PROP_CHUNK)));
      const key = cz * nChunks + cx;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(b);
    }
    const shade: number[] = [1, 1, 1, 1, 1, 1];
    for (const [key, list] of buckets) {
      const gb = new GeoBuilder().addAttribute('rm', 2);
      for (const b of list) {
        const mask = visibleFaces(b, list, world.heightAt);
        if (!mask) continue;
        emitBox(gb, b, mask, {
          color: boxBaseColor(b),
          rm: materialRM(b.material),
          faceShade: shade,
          bottomShade: 0.86,
          ribbed: b.kind === 'container',
        });
      }
      if (gb.isEmpty) continue;
      const geo = gb.build();
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = `props-${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    if (targets.length && this.targetMaterial) this.buildTargets(world, targets);
  }

  /** Target plates: ring texture on both broad faces, plain colour elsewhere (merged into one mesh). */
  private buildTargets(world: World, plates: readonly WorldBox[]): void {
    const textured = new GeoBuilder().addAttribute('uv', 2);
    const plain = new GeoBuilder().addAttribute('rm', 2);
    const firing = world.training?.firingLine ?? null;
    for (const b of plates) {
      const color = boxBaseColor(b);
      const dx = b.max.x - b.min.x, dz = b.max.z - b.min.z;
      const facesX = dx < dz; // thin along X -> broad faces are +-X
      const broad = facesX ? [0, 1] : [4, 5];
      const mask = 0b111111 & ~((1 << broad[0]) | (1 << broad[1]));
      emitBox(plain, b, mask, { color, rm: [0.9, 0], faceShade: [1, 1, 1, 1, 1, 1], bottomShade: 1, ribbed: false });
      for (const f of broad) {
        const sign = f === 0 || f === 4 ? 1 : -1;
        const nx = facesX ? sign : 0, nz = facesX ? 0 : sign;
        const x = facesX ? (sign > 0 ? b.max.x : b.min.x) : 0;
        const z = facesX ? 0 : sign > 0 ? b.max.z : b.min.z;
        // Corners bottom-left, bottom-right, top-right, top-left as seen from outside the face.
        const lx0 = facesX ? x : sign > 0 ? b.min.x : b.max.x;
        const lx1 = facesX ? x : sign > 0 ? b.max.x : b.min.x;
        const lz0 = facesX ? (sign > 0 ? b.max.z : b.min.z) : z;
        const lz1 = facesX ? (sign > 0 ? b.min.z : b.max.z) : z;
        // Darken the face pointing away from the firing line slightly (back of the plate).
        let k = 1;
        if (firing) {
          const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
          const toFire = (firing.x - cx) * nx + (firing.z - cz) * nz;
          if (toFire < 0) k = 0.8;
        }
        const v = [
          textured.vertex(lx0, b.min.y, lz0, nx, 0, nz, k, k, k),
          textured.vertex(lx1, b.min.y, lz1, nx, 0, nz, k, k, k),
          textured.vertex(lx1, b.max.y, lz1, nx, 0, nz, k, k, k),
          textured.vertex(lx0, b.max.y, lz0, nx, 0, nz, k, k, k),
        ];
        // uv per vertex (pushed in the same order as the vertices above).
        textured.extra('uv', 0, 0);
        textured.extra('uv', 1, 0);
        textured.extra('uv', 1, 1);
        textured.extra('uv', 0, 1);
        textured.quad(v[0], v[1], v[2], v[3]);
      }
    }
    if (!textured.isEmpty && this.targetMaterial) {
      this.targetMaterial.vertexColors = true;
      const geo = textured.build();
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.targetMaterial);
      mesh.name = 'target-faces';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    if (!plain.isEmpty) {
      const geo = plain.build();
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = 'target-plates';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
  }

  setDetailDistance(d: number): void {
    this.edges[0] = d;
  }

  setAnisotropy(a: number): void {
    if (this.targetTexture && this.targetTexture.anisotropy !== a) {
      this.targetTexture.anisotropy = a;
      this.targetTexture.needsUpdate = true;
    }
  }

  /** Full mesh vs shell per building (cheap; call a few times per second or on zoom changes). */
  update(cx: number, cy: number, cz: number, lodScale: number): void {
    let shells = 0;
    for (const e of this.entries) {
      const d = distanceToAabb(cx, cy, cz, e.minX, e.minY, e.minZ, e.maxX, e.maxY, e.maxZ) * lodScale;
      const band = selectBand(d, e.band, this.edges, LOD_HYSTERESIS);
      if (band !== 0) shells++;
      if (band === e.band) continue;
      e.band = band;
      if (e.mesh) e.mesh.visible = band === 0;
      this.shellData[e.index] = band === 0 ? 0 : 255;
      this.shellDirty = true;
    }
    if (this.shellDirty) {
      this.shellDirty = false;
      this.shellTex.needsUpdate = true;
    }
    if (this.shell) this.shell.visible = shells > 0;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
    this.shellMaterial.dispose();
    this.shellTex.dispose();
    this.targetMaterial?.dispose();
    this.targetTexture?.dispose();
    this.group.removeFromParent();
  }
}

/** Target plates are thin boards; their posts (if also tagged 'target') are thin in both axes. */
function isTargetPlate(b: WorldBox): boolean {
  const dx = b.max.x - b.min.x, dz = b.max.z - b.min.z, dy = b.max.y - b.min.y;
  const wide = Math.max(dx, dz), thin = Math.min(dx, dz);
  return wide >= 0.3 && dy >= 0.5 && wide / Math.max(thin, 0.01) >= 2.5;
}
