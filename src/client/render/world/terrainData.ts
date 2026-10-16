// Pure terrain data preparation (no three.js objects): smooth vertex normals, per-vertex surface
// colours/weights from World.surface, and chunk mesh arrays (3 LODs + skirts). The full-resolution
// triangulation matches the physics heightfield exactly (diagonal from (i+1, j) to (i, j+1)).

import type { SurfaceMaterial } from '../../../shared/types';
import { fbm2, valueNoise2 } from '../../../shared/rng';
import { hexToLinear } from './geoBuilder';

export interface HeightFieldData {
  res: number;
  cell: number;
  half: number;
  heights: Float32Array;
  waterLevel: number;
}

export interface TerrainShading {
  /** 3 floats per heightmap vertex: smooth unit normal. */
  normals: Float32Array;
  /** 3 floats per vertex: linear albedo. */
  colors: Float32Array;
  /** 2 floats per vertex: grass weight, rock weight (drive the shader detail noise). */
  surf: Float32Array;
}

export interface ChunkArrays {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  surf: Float32Array;
  indices: Uint16Array | Uint32Array;
  minY: number;
  maxY: number;
}

/** sRGB palette for terrain surfaces. */
const PALETTE = {
  grassLush: 0x5c7f33,
  grassDry: 0x8a9244,
  grassDark: 0x4d6b2c,
  dirt: 0x84704f,
  rock: 0x7f7b73,
  rockDark: 0x6a665f,
  sand: 0xcbb98b,
  wetSand: 0xa3946d,
  road: 0x6b665e,
  concrete: 0x8e8b85,
  wood: 0x7a6650,
  metal: 0x6c7074,
  seabed: 0x84795a,
  snow: 0xedf1f4,
} as const;

type Rgb = [number, number, number];
function lin(hex: number): Rgb {
  const out: Rgb = [0, 0, 0];
  hexToLinear(hex, out);
  return out;
}
const C = {
  grassLush: lin(PALETTE.grassLush),
  grassDry: lin(PALETTE.grassDry),
  grassDark: lin(PALETTE.grassDark),
  dirt: lin(PALETTE.dirt),
  rock: lin(PALETTE.rock),
  rockDark: lin(PALETTE.rockDark),
  sand: lin(PALETTE.sand),
  wetSand: lin(PALETTE.wetSand),
  road: lin(PALETTE.road),
  concrete: lin(PALETTE.concrete),
  wood: lin(PALETTE.wood),
  metal: lin(PALETTE.metal),
  seabed: lin(PALETTE.seabed),
  snow: lin(PALETTE.snow),
};

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Smooth per-vertex normals from central differences of the heightmap. */
export function computeTerrainNormals(f: HeightFieldData): Float32Array {
  const { res, cell, heights } = f;
  const out = new Float32Array(res * res * 3);
  const last = res - 1;
  for (let j = 0; j < res; j++) {
    const jm = j > 0 ? j - 1 : 0, jp = j < last ? j + 1 : last;
    for (let i = 0; i < res; i++) {
      const im = i > 0 ? i - 1 : 0, ip = i < last ? i + 1 : last;
      const dx = (heights[j * res + ip] - heights[j * res + im]) / ((ip - im) * cell);
      const dz = (heights[jp * res + i] - heights[jm * res + i]) / ((jp - jm) * cell);
      const l = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      const o = (j * res + i) * 3;
      out[o] = -dx * l;
      out[o + 1] = l;
      out[o + 2] = -dz * l;
    }
  }
  return out;
}

/**
 * Per-vertex terrain albedo + detail weights. `surfaceOf(k)` returns the surface material of
 * heightmap vertex k. Grass varies between lush and dry with large-scale noise, steep slopes blend
 * to rock, concave spots darken slightly (cheap cavity occlusion), underwater ground darkens with
 * depth. The result is softened with a small blur so 4 m cells do not read as hard tiles.
 */
export function computeTerrainShading(
  f: HeightFieldData,
  normals: Float32Array,
  surfaceOf: (k: number) => SurfaceMaterial,
  seed: number,
): TerrainShading {
  const { res, cell, half, heights, waterLevel } = f;
  const n = res * res;
  const raw = new Float32Array(n * 3);
  const rawSurf = new Float32Array(n * 2);
  const last = res - 1;
  const ns = (seed ^ 0x5eed) >>> 0;

  for (let j = 0; j < res; j++) {
    const z = -half + j * cell;
    for (let i = 0; i < res; i++) {
      const x = -half + i * cell;
      const k = j * res + i;
      const h = heights[k];
      const ny = normals[k * 3 + 1];
      const mat = surfaceOf(k);
      let r = 0, g = 0, b = 0;
      let grassW = 0, rockW = 0;
      const set = (c: Rgb): void => { r = c[0]; g = c[1]; b = c[2]; };
      const mixIn = (c: Rgb, t: number): void => {
        r += (c[0] - r) * t; g += (c[1] - g) * t; b += (c[2] - b) * t;
      };

      switch (mat) {
        case 'grass': {
          // Large meadows drift between lush and dry; mid-scale patches add darker clumps.
          const macro = fbm2(ns, x / 230, z / 230, 3) * 0.5 + 0.5;
          const patch = valueNoise2(ns + 7, x / 38, z / 38) * 0.5 + 0.5;
          set(C.grassLush);
          mixIn(C.grassDry, smooth(0.45, 0.85, macro) * 0.85);
          mixIn(C.grassDark, smooth(0.55, 0.9, patch) * 0.45);
          grassW = 1;
          break;
        }
        case 'dirt': {
          set(C.dirt);
          mixIn(C.grassDry, (valueNoise2(ns + 3, x / 14, z / 14) * 0.5 + 0.5) * 0.25);
          break;
        }
        case 'rock':
          set(C.rock);
          mixIn(C.rockDark, valueNoise2(ns + 11, x / 22, z / 22) * 0.5 + 0.5);
          rockW = 1;
          break;
        case 'sand':
          set(C.sand);
          mixIn(C.wetSand, smooth(waterLevel + 1.4, waterLevel + 0.2, h));
          break;
        case 'road':
          set(C.road);
          break;
        case 'concrete':
          set(C.concrete);
          break;
        case 'wood':
          set(C.wood);
          break;
        case 'metal':
          set(C.metal);
          break;
        case 'snow':
          set(C.snow);
          break;
        case 'water':
        default:
          set(C.seabed);
          break;
      }

      // Steep slopes expose rock (not on built surfaces).
      if (mat === 'grass' || mat === 'dirt' || mat === 'sand' || mat === 'snow') {
        const steep = smooth(0.84, 0.66, ny);
        if (steep > 0) {
          mixIn(C.rock, steep);
          rockW = Math.max(rockW, steep);
          grassW *= 1 - steep;
        }
      }

      // Cavity: concave spots (valleys, ditches) slightly darker, ridges slightly lighter.
      let sum = 0, cnt = 0;
      for (let dj = -2; dj <= 2; dj += 2) {
        const jj = Math.min(last, Math.max(0, j + dj));
        for (let di = -2; di <= 2; di += 2) {
          if (di === 0 && dj === 0) continue;
          const ii = Math.min(last, Math.max(0, i + di));
          sum += heights[jj * res + ii];
          cnt++;
        }
      }
      const cav = h - sum / cnt;
      const ao = Math.min(1.05, Math.max(0.78, 1 + cav * 0.05));
      r *= ao; g *= ao; b *= ao;

      // Underwater: darker and greener with depth (the water shader adds the rest).
      if (h < waterLevel) {
        const d = Math.min(1, (waterLevel - h) / 9);
        const k2 = 1 - d * 0.45;
        r *= k2 * 0.95; g *= k2; b *= k2 * 0.97;
        grassW = 0;
      }

      raw[k * 3] = r;
      raw[k * 3 + 1] = g;
      raw[k * 3 + 2] = b;
      rawSurf[k * 2] = grassW;
      rawSurf[k * 2 + 1] = rockW;
    }
  }

  // 3x3 weighted blur (1 2 1 / 2 4 2 / 1 2 1) for soft material transitions.
  const colors = new Float32Array(n * 3);
  const surf = new Float32Array(n * 2);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      let r = 0, g = 0, b = 0, s0 = 0, s1 = 0, wsum = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj > last) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii > last) continue;
          const w = (dj === 0 ? 2 : 1) * (di === 0 ? 2 : 1);
          const kk = jj * res + ii;
          r += raw[kk * 3] * w;
          g += raw[kk * 3 + 1] * w;
          b += raw[kk * 3 + 2] * w;
          s0 += rawSurf[kk * 2] * w;
          s1 += rawSurf[kk * 2 + 1] * w;
          wsum += w;
        }
      }
      const k = j * res + i;
      colors[k * 3] = r / wsum;
      colors[k * 3 + 1] = g / wsum;
      colors[k * 3 + 2] = b / wsum;
      surf[k * 2] = s0 / wsum;
      surf[k * 2 + 1] = s1 / wsum;
    }
  }
  return { normals, colors, surf };
}

/** Vertex indices i0..i1 with the given step, always including the end vertex. */
function lattice(i0: number, i1: number, step: number, out: number[]): number[] {
  out.length = 0;
  for (let i = i0; i < i1; i += step) out.push(i);
  out.push(i1);
  return out;
}

/**
 * Builds one terrain chunk covering vertex columns [i0, i1] and rows [j0, j1] at a vertex step
 * (1 = full, 2 = half, 4 = quarter resolution) with downward skirts on all four edges.
 * Colours/weights of coarse LODs are box-averaged so thin features fade instead of aliasing.
 */
export function buildChunkArrays(
  f: HeightFieldData,
  shade: TerrainShading,
  i0: number, i1: number, j0: number, j1: number,
  step: number,
  skirtDepth: number,
): ChunkArrays {
  const { res, cell, half, heights } = f;
  const xs = lattice(i0, i1, step, []);
  const zs = lattice(j0, j1, step, []);
  const nx = xs.length, nz = zs.length;
  const gridVerts = nx * nz;
  const edgeVerts = 2 * (nx + nz);
  const vcount = gridVerts + edgeVerts;
  const positions = new Float32Array(vcount * 3);
  const normals = new Float32Array(vcount * 3);
  const colors = new Float32Array(vcount * 3);
  const surf = new Float32Array(vcount * 2);
  const radius = step > 1 ? step >> 1 : 0;
  const last = res - 1;
  let minY = Infinity, maxY = -Infinity;

  const writeVertex = (v: number, i: number, j: number, yOffset: number): void => {
    const k = j * res + i;
    const y = heights[k] + yOffset;
    positions[v * 3] = -half + i * cell;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = -half + j * cell;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    normals[v * 3] = shade.normals[k * 3];
    normals[v * 3 + 1] = shade.normals[k * 3 + 1];
    normals[v * 3 + 2] = shade.normals[k * 3 + 2];
    if (radius === 0) {
      colors[v * 3] = shade.colors[k * 3];
      colors[v * 3 + 1] = shade.colors[k * 3 + 1];
      colors[v * 3 + 2] = shade.colors[k * 3 + 2];
      surf[v * 2] = shade.surf[k * 2];
      surf[v * 2 + 1] = shade.surf[k * 2 + 1];
      return;
    }
    let r = 0, g = 0, b = 0, s0 = 0, s1 = 0, c = 0;
    for (let jj = Math.max(0, j - radius); jj <= Math.min(last, j + radius); jj++) {
      for (let ii = Math.max(0, i - radius); ii <= Math.min(last, i + radius); ii++) {
        const kk = jj * res + ii;
        r += shade.colors[kk * 3];
        g += shade.colors[kk * 3 + 1];
        b += shade.colors[kk * 3 + 2];
        s0 += shade.surf[kk * 2];
        s1 += shade.surf[kk * 2 + 1];
        c++;
      }
    }
    colors[v * 3] = r / c;
    colors[v * 3 + 1] = g / c;
    colors[v * 3 + 2] = b / c;
    surf[v * 2] = s0 / c;
    surf[v * 2 + 1] = s1 / c;
  };

  for (let b = 0; b < nz; b++) for (let a = 0; a < nx; a++) writeVertex(b * nx + a, xs[a], zs[b], 0);

  const quadCount = (nx - 1) * (nz - 1);
  const edgeQuads = 2 * (nx - 1) + 2 * (nz - 1);
  const icount = (quadCount + edgeQuads) * 6;
  const indices = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
  let ii = 0;
  // Grid: triangles (a, c, b) and (b, c, d) -> diagonal b-c like the physics heightfield.
  for (let bz = 0; bz < nz - 1; bz++) {
    for (let ax = 0; ax < nx - 1; ax++) {
      const a = bz * nx + ax, b = a + 1, c = a + nx, d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  // Skirts: each edge gets a copy of its vertices pushed down; quads face outward.
  let v = gridVerts;
  const skirt = (gridIdx: number[], outX: number, outZ: number): void => {
    const start = v;
    for (const gi of gridIdx) {
      const gx = Math.round((positions[gi * 3] + half) / cell);
      const gz = Math.round((positions[gi * 3 + 2] + half) / cell);
      writeVertex(v, gx, gz, -skirtDepth);
      // Reuse the top vertex's averaged colour/normal so the skirt blends in.
      colors[v * 3] = colors[gi * 3];
      colors[v * 3 + 1] = colors[gi * 3 + 1];
      colors[v * 3 + 2] = colors[gi * 3 + 2];
      surf[v * 2] = surf[gi * 2];
      surf[v * 2 + 1] = surf[gi * 2 + 1];
      v++;
    }
    for (let e = 0; e < gridIdx.length - 1; e++) {
      const p0 = gridIdx[e], p1 = gridIdx[e + 1];
      const q0 = start + e, q1 = start + e + 1;
      // Face normal of (p0, q0, p1) is proportional to (-ez, 0, ex) for edge direction e.
      const ex = positions[p1 * 3] - positions[p0 * 3];
      const ez = positions[p1 * 3 + 2] - positions[p0 * 3 + 2];
      const facesOut = -ez * outX + ex * outZ > 0;
      if (facesOut) {
        indices[ii++] = p0; indices[ii++] = q0; indices[ii++] = p1;
        indices[ii++] = p1; indices[ii++] = q0; indices[ii++] = q1;
      } else {
        indices[ii++] = p0; indices[ii++] = p1; indices[ii++] = q0;
        indices[ii++] = p1; indices[ii++] = q1; indices[ii++] = q0;
      }
    }
  };
  const north: number[] = [], south: number[] = [], west: number[] = [], east: number[] = [];
  for (let a = 0; a < nx; a++) {
    north.push(a);
    south.push((nz - 1) * nx + a);
  }
  for (let b = 0; b < nz; b++) {
    west.push(b * nx);
    east.push(b * nx + nx - 1);
  }
  skirt(north, 0, -1);
  skirt(south, 0, 1);
  skirt(west, -1, 0);
  skirt(east, 1, 0);

  return { positions, normals, colors, surf, indices, minY, maxY };
}

/** Chunk grid layout: 8x8 chunks over the heightmap cells. */
export const TERRAIN_CHUNKS = 8;

export function chunkCellRange(res: number, chunks: number, c: number): [number, number] {
  const cells = res - 1;
  const per = Math.ceil(cells / chunks);
  const a = Math.min(cells, c * per);
  const b = Math.min(cells, (c + 1) * per);
  return [a, b];
}
