// Static, world-derived lookup data for bots, built once per world and shared by every driver:
// building centres and interior walk targets, buildings per town, and a bush grid for
// concealment tests (bushes do not block bullets or movement, but a human cannot see a
// crouching player inside one).

import type { World } from '../types';
import type { NavGrid } from './nav';
import { NF_BLOCKED } from './nav';

const BUSH_CELL = 16;
/** Bush footprint radius / height per unit of BushDef.scale. */
export const BUSH_RADIUS = 1.0;
export const BUSH_HEIGHT = 1.15;

export interface MapInfo {
  /** Building centre XZ pairs. */
  bCenter: Float32Array;
  /** Building footprint half extents XZ pairs. */
  bHalf: Float32Array;
  /** Interior walk target per building (XZ pairs); NaN = not computed, Infinity = none. */
  bInterior: Float32Array;
  /** Building indices per town index (towns[i]). */
  townBuildings: number[][];
  /** Bush spatial hash. */
  bushCells: number;
  bushHead: Int32Array;
  bushNext: Int32Array;
}

const infos = new WeakMap<World, MapInfo>();

export function mapInfoFor(world: World): MapInfo {
  let info = infos.get(world);
  if (info) return info;
  const nb = world.buildings.length;
  const bCenter = new Float32Array(nb * 2);
  const bHalf = new Float32Array(nb * 2);
  const bInterior = new Float32Array(nb * 2).fill(NaN);
  for (let i = 0; i < nb; i++) {
    const b = world.buildings[i];
    bCenter[i * 2] = (b.min.x + b.max.x) / 2;
    bCenter[i * 2 + 1] = (b.min.z + b.max.z) / 2;
    bHalf[i * 2] = (b.max.x - b.min.x) / 2;
    bHalf[i * 2 + 1] = (b.max.z - b.min.z) / 2;
  }
  const townBuildings: number[][] = world.towns.map(() => []);
  for (let i = 0; i < nb; i++) {
    const t = world.buildings[i].town;
    const ti = world.towns.findIndex((tw) => tw.id === t);
    if (ti >= 0) townBuildings[ti].push(i);
  }
  const bushCells = Math.max(1, Math.ceil(world.size / BUSH_CELL));
  const bushHead = new Int32Array(bushCells * bushCells).fill(-1);
  const bushNext = new Int32Array(world.bushes.length).fill(-1);
  for (let i = 0; i < world.bushes.length; i++) {
    const b = world.bushes[i];
    const cx = Math.min(bushCells - 1, Math.max(0, Math.floor((b.x + world.half) / BUSH_CELL)));
    const cz = Math.min(bushCells - 1, Math.max(0, Math.floor((b.z + world.half) / BUSH_CELL)));
    const c = cz * bushCells + cx;
    bushNext[i] = bushHead[c];
    bushHead[c] = i;
  }
  info = { bCenter, bHalf, bInterior, townBuildings, bushCells, bushHead, bushNext };
  infos.set(world, info);
  return info;
}

/**
 * Height of the bush top covering (x, z) at ground level `y` (0 when no bush covers the point).
 * Used for concealment: a target inside a bush whose top is above its head height is hidden
 * from distant viewers.
 */
export function bushCoverHeight(world: World, info: MapInfo, x: number, z: number): number {
  const n = info.bushCells;
  const cx = Math.floor((x + world.half) / BUSH_CELL), cz = Math.floor((z + world.half) / BUSH_CELL);
  let best = 0;
  for (let dz = -1; dz <= 1; dz++) {
    const zz = cz + dz;
    if (zz < 0 || zz >= n) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= n) continue;
      for (let i = info.bushHead[zz * n + xx]; i >= 0; i = info.bushNext[i]) {
        const b = world.bushes[i];
        const r = BUSH_RADIUS * b.scale;
        const ddx = x - b.x, ddz = z - b.z;
        if (ddx * ddx + ddz * ddz <= r * r) {
          const h = BUSH_HEIGHT * b.scale;
          if (h > best) best = h;
        }
      }
    }
  }
  return best;
}

const tmp = { x: 0, z: 0 };

/**
 * A free ground-floor nav cell inside building `bi` (lazily computed and cached). Returns false
 * when the building has no reachable-looking interior cell.
 */
export function buildingInterior(world: World, info: MapInfo, grid: NavGrid, bi: number, out: { x: number; z: number }): boolean {
  let x = info.bInterior[bi * 2];
  if (Number.isNaN(x)) {
    const b = world.buildings[bi];
    const cx = info.bCenter[bi * 2], cz = info.bCenter[bi * 2 + 1];
    let found = false;
    if (grid.nearestFree(cx, cz, 6, tmp)) {
      // Must be inside the footprint and not blocked.
      if (tmp.x > b.min.x + 0.5 && tmp.x < b.max.x - 0.5 && tmp.z > b.min.z + 0.5 && tmp.z < b.max.z - 0.5 &&
          !(grid.flagsAt(tmp.x, tmp.z) & NF_BLOCKED)) {
        found = true;
      }
    }
    info.bInterior[bi * 2] = found ? tmp.x : Infinity;
    info.bInterior[bi * 2 + 1] = found ? tmp.z : Infinity;
    x = info.bInterior[bi * 2];
  }
  if (!Number.isFinite(x)) return false;
  out.x = x;
  out.z = info.bInterior[bi * 2 + 1];
  return true;
}
