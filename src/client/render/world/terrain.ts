// Terrain: 8x8 heightmap chunks with 3 LODs each (full / half / quarter resolution), skirts to hide
// LOD cracks, distance-based LOD selection with hysteresis (scaled by camera zoom), frustum culled
// per chunk by three.js. A sloping apron around the map edge runs the ground down into the sea so
// the island never ends in a visible cliff. Vertex colours from World.surface plus a world-space
// detail-noise material so close terrain is not flat-coloured.

import * as THREE from 'three';
import { distanceToAabb, selectBand } from './lod';
import { NOISE_GLSL, patchShader } from './shaders';
import {
  TERRAIN_CHUNKS, buildChunkArrays, chunkCellRange, type ChunkArrays, type HeightFieldData, type TerrainShading,
} from './terrainData';
import { linearRgb } from './geoBuilder';

const LOD_STEPS = [1, 2, 4] as const;
const LOD_HYSTERESIS = 20;
/** How far the apron reaches beyond the map edge (m). */
const APRON_REACH = 900;

interface TerrainChunk {
  meshes: THREE.Mesh[];
  lod: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'dz-terrain',
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute vec2 surf;\nvarying vec2 vDzSurf;\nvarying vec3 vDzWorld;\n' +
      patchShader(
        shader.vertexShader,
        'begin_vertex',
        '#include <begin_vertex>\nvDzSurf = surf;\nvDzWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader =
      'varying vec2 vDzSurf;\nvarying vec3 vDzWorld;\n' +
      NOISE_GLSL +
      patchShader(
        shader.fragmentShader,
        'color_fragment',
        /* glsl */ `#include <color_fragment>
{
  float camDist = length(vDzWorld - cameraPosition);
  float fineFade = 1.0 - smoothstep(20.0, 110.0, camDist);
  float midFade = 1.0 - smoothstep(80.0, 450.0, camDist);
  vec2 p = vDzWorld.xz;
  float nMacro = dzNoise(p * 0.031);
  float nMid = dzNoise(p * 0.27) * 0.6 + dzNoise(p * 0.63 + 3.1) * 0.4;
  float nFine = dzNoise(p * 2.3) * 0.55 + dzNoise(p * 5.3 + 1.7) * 0.45;
  float g = clamp(vDzSurf.x, 0.0, 1.0);
  float r = clamp(vDzSurf.y, 0.0, 1.0);
  float grassMod = 1.0 + (nMid - 0.5) * 0.34 * midFade + (nFine - 0.5) * 0.38 * fineFade;
  float strata = dzNoise(vec2((p.x + p.y) * 0.13, vDzWorld.y * 1.3));
  float rockMod = 1.0 + (strata - 0.5) * 0.4 * midFade + (nFine - 0.5) * 0.28 * fineFade;
  float baseMod = 1.0 + (nMid - 0.5) * 0.18 * midFade + (nFine - 0.5) * 0.22 * fineFade;
  float m = mix(mix(baseMod, grassMod, g), rockMod, r);
  diffuseColor.rgb *= m * (0.93 + 0.14 * nMacro);
  float dry = smoothstep(0.58, 0.82, dzNoise(p * 0.085 + 7.0)) * g;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.13, 1.05, 0.72), dry * 0.4);
}`,
      );
  };
  mat.customProgramCacheKey = () => 'dz-terrain-v1';
  return mat;
}

function toGeometry(a: ChunkArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(a.colors, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(a.surf, 2));
  g.setIndex(new THREE.BufferAttribute(a.indices, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export class TerrainRenderer {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly chunks: TerrainChunk[] = [];
  private readonly apron: THREE.Mesh;
  private readonly edges: [number, number] = [200, 430];

  constructor(field: HeightFieldData, shade: TerrainShading) {
    this.group.name = 'terrain';
    this.material = createTerrainMaterial();
    const { res, cell, half } = field;
    for (let cz = 0; cz < TERRAIN_CHUNKS; cz++) {
      const [j0, j1] = chunkCellRange(res, TERRAIN_CHUNKS, cz);
      if (j1 <= j0) continue;
      for (let cx = 0; cx < TERRAIN_CHUNKS; cx++) {
        const [i0, i1] = chunkCellRange(res, TERRAIN_CHUNKS, cx);
        if (i1 <= i0) continue;
        const chunk: TerrainChunk = {
          meshes: [],
          lod: -1,
          minX: -half + i0 * cell,
          maxX: -half + i1 * cell,
          minZ: -half + j0 * cell,
          maxZ: -half + j1 * cell,
          minY: Infinity,
          maxY: -Infinity,
        };
        for (let l = 0; l < LOD_STEPS.length; l++) {
          const step = LOD_STEPS[l];
          const arrays = buildChunkArrays(field, shade, i0, i1, j0, j1, step, 3 + step * cell * 1.5);
          if (l === 0) {
            chunk.minY = arrays.minY;
            chunk.maxY = arrays.maxY;
          }
          const mesh = new THREE.Mesh(toGeometry(arrays), this.material);
          mesh.name = `terrain-${cx}-${cz}-lod${l}`;
          mesh.receiveShadow = true;
          mesh.castShadow = false;
          mesh.visible = false;
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          this.group.add(mesh);
          chunk.meshes.push(mesh);
        }
        this.chunks.push(chunk);
      }
    }
    this.apron = this.buildApron(field, shade);
    this.group.add(this.apron);
  }

  /** Ring of ground around the map that slopes from the edge heights down under the sea. */
  private buildApron(field: HeightFieldData, shade: TerrainShading): THREE.Mesh {
    const { res, cell, half, heights, waterLevel } = field;
    const step = 4;
    const last = res - 1;
    const ring: number[] = []; // perimeter vertex indices k, counter-clockwise from above
    for (let i = 0; i < last; i += step) ring.push(i); // north edge (j = 0), west -> east
    for (let j = 0; j < last; j += step) ring.push(j * res + last); // east edge, north -> south
    for (let i = last; i > 0; i -= step) ring.push(last * res + i); // south edge, east -> west
    for (let j = last; j > 0; j -= step) ring.push(j * res); // west edge, south -> north
    const n = ring.length;
    const rows = 3;
    const pos = new Float32Array(n * rows * 3);
    const nrm = new Float32Array(n * rows * 3);
    const col = new Float32Array(n * rows * 3);
    const surf = new Float32Array(n * rows * 2);
    const seabed = linearRgb(0x6f6750);
    for (let e = 0; e < n; e++) {
      const k = ring[e];
      const i = k % res, j = Math.floor(k / res);
      const x = -half + i * cell, z = -half + j * cell;
      const h = heights[k];
      const len = Math.hypot(x, z) || 1;
      const dx = x / len, dz = z / len;
      const ys = [h - 0.05, Math.min(h - 3, waterLevel - 5), waterLevel - 45];
      const reach = [0, 40, APRON_REACH];
      for (let r = 0; r < rows; r++) {
        const v = r * n + e;
        pos[v * 3] = x + dx * reach[r];
        pos[v * 3 + 1] = ys[r];
        pos[v * 3 + 2] = z + dz * reach[r];
        nrm[v * 3 + 1] = 1;
        const c = r === 0 ? [shade.colors[k * 3], shade.colors[k * 3 + 1], shade.colors[k * 3 + 2]] : seabed;
        col[v * 3] = c[0];
        col[v * 3 + 1] = c[1];
        col[v * 3 + 2] = c[2];
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let e = 0; e < n; e++) {
        const a = r * n + e, b = r * n + ((e + 1) % n);
        const c = (r + 1) * n + e, d = (r + 1) * n + ((e + 1) % n);
        // Orient each quad so it faces up.
        const ax = pos[a * 3], az = pos[a * 3 + 2];
        const ux = pos[c * 3] - ax, uz = pos[c * 3 + 2] - az;
        const vx = pos[b * 3] - ax, vz = pos[b * 3 + 2] - az;
        const upY = uz * vx - ux * vz; // y of (c - a) x (b - a)
        if (upY > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = 'terrain-apron';
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  setLodDistances(d0: number, d1: number): void {
    this.edges[0] = d0;
    this.edges[1] = d1;
  }

  /** Select chunk LODs for the camera (lodScale < 1 when zoomed in). */
  update(cx: number, cy: number, cz: number, lodScale: number): void {
    for (const ch of this.chunks) {
      const d = distanceToAabb(cx, cy, cz, ch.minX, ch.minY, ch.minZ, ch.maxX, ch.maxY, ch.maxZ) * lodScale;
      const lod = selectBand(d, ch.lod, this.edges, LOD_HYSTERESIS);
      if (lod !== ch.lod) {
        if (ch.lod >= 0) ch.meshes[ch.lod].visible = false;
        ch.meshes[lod].visible = true;
        ch.lod = lod;
      }
    }
  }

  dispose(): void {
    for (const ch of this.chunks) for (const m of ch.meshes) m.geometry.dispose();
    this.apron.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
