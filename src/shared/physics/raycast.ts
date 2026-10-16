// Ray casts against the static world: terrain (heightmap), water surface, bullet-blocking boxes,
// tree trunks and rocks.
//
// A per-world acceleration structure (built lazily, cached in a WeakMap keyed by the World object)
// buckets every collider into a uniform XZ grid stored as flat CSR arrays, together with the
// maximum terrain height of each cell. A ray walks the grid cells it crosses in order (2D DDA) and,
// per cell, tests the cell's colliders (each at most once per ray via stamps) and marches the
// heightmap only where the ray can actually be below the terrain. Because cells are visited front
// to back the walk stops as soon as the best hit lies before the end of the current cell.
// Nothing in the hot path allocates.

import type { RayHit, RockDef, TreeDef, Vec3, World, WorldBox } from '../types';
import { TREE_TRUNK_FRAC } from './tuning';

// ---------------------------------------------------------------------------
// Acceleration grid
// ---------------------------------------------------------------------------

/** Grid cell size (m). */
const CELL = 8;
/** Safety margin added to per-cell terrain maxima (m). */
const TERRAIN_MARGIN = 0.1;
/** Bisection steps when refining a terrain crossing (2 m bracket -> < 1 mm). */
const TERRAIN_REFINE = 12;
/** A ray that starts this close inside a surface and leaves through it is not blocked by it. */
const INSIDE_SKIN = 0.02;
/** Origins this far below the terrain still count as "on" it. */
const UNDERGROUND_TOLERANCE = 0.02;
/** Trunks extend this far below their base point so sloped ground never leaves a gap. */
const TRUNK_SINK = 1;
/** Longest ray considered (m); longer requests are clamped (the map is ~1 km across). */
const MAX_RAY = 10000;

interface RayGrid {
  half: number;
  n: number;
  inv: number;
  boxStart: Int32Array;
  boxItems: Int32Array;
  treeStart: Int32Array;
  treeItems: Int32Array;
  rockStart: Int32Array;
  rockItems: Int32Array;
  boxStamp: Uint32Array;
  treeStamp: Uint32Array;
  rockStamp: Uint32Array;
  /** Max terrain height per cell (+ margin). */
  cellMaxH: Float32Array;
  boxCount: number;
  treeCount: number;
  rockCount: number;
  heights: Float32Array;
}

const grids = new WeakMap<World, RayGrid>();
let rayStamp = 0;

function cellRange(v: number, half: number, inv: number, n: number): number {
  const i = Math.floor((v + half) * inv);
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** Bucket items into CSR arrays given their XZ bounds. */
function bucket(
  count: number,
  n: number,
  half: number,
  inv: number,
  include: (i: number) => boolean,
  bounds: (i: number, o: Float64Array) => void,
): { start: Int32Array; items: Int32Array } {
  const cells = n * n;
  const counts = new Int32Array(cells + 1);
  const b = new Float64Array(4);
  const ranges = new Int32Array(count * 4);
  const ok = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (!include(i)) continue;
    bounds(i, b);
    if (!(b[0] <= b[2]) || !(b[1] <= b[3])) continue; // NaN or inverted
    ok[i] = 1;
    const x0 = cellRange(b[0], half, inv, n), z0 = cellRange(b[1], half, inv, n);
    const x1 = cellRange(b[2], half, inv, n), z1 = cellRange(b[3], half, inv, n);
    ranges[i * 4] = x0; ranges[i * 4 + 1] = z0; ranges[i * 4 + 2] = x1; ranges[i * 4 + 3] = z1;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * n + x + 1]++;
  }
  for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
  const items = new Int32Array(counts[cells]);
  const fill = counts.slice(0, cells);
  for (let i = 0; i < count; i++) {
    if (!ok[i]) continue;
    const x0 = ranges[i * 4], z0 = ranges[i * 4 + 1], x1 = ranges[i * 4 + 2], z1 = ranges[i * 4 + 3];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) items[fill[z * n + x]++] = i;
  }
  return { start: counts, items };
}

function buildGrid(world: World): RayGrid {
  const half = world.half;
  const n = Math.max(1, Math.ceil((2 * half) / CELL));
  const inv = n / (2 * half);
  const boxes = world.boxes, trees = world.trees, rocks = world.rocks;
  const bx = bucket(boxes.length, n, half, inv, (i) => boxes[i].blocksBullets, (i, o) => {
    const b = boxes[i];
    o[0] = b.min.x; o[1] = b.min.z; o[2] = b.max.x; o[3] = b.max.z;
  });
  const tr = bucket(trees.length, n, half, inv, (i) => trees[i].r > 0 && trees[i].h > 0, (i, o) => {
    const t = trees[i];
    o[0] = t.x - t.r; o[1] = t.z - t.r; o[2] = t.x + t.r; o[3] = t.z + t.r;
  });
  const rk = bucket(rocks.length, n, half, inv, (i) => rocks[i].r > 0 && rocks[i].h > 0, (i, o) => {
    const k = rocks[i];
    o[0] = k.x - k.r; o[1] = k.z - k.r; o[2] = k.x + k.r; o[3] = k.z + k.r;
  });

  // Per-cell terrain maxima from the heightmap vertices covering the cell (plus a one-vertex
  // border so any local interpolation scheme stays bounded).
  const cellMaxH = new Float32Array(n * n);
  const vres = world.res, hc = world.cell, hs = world.heights;
  const validHeights = vres > 1 && hc > 0 && hs.length >= vres * vres;
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      let m = -Infinity;
      if (validHeights) {
        const x0 = -half + cx * CELL, z0 = -half + cz * CELL;
        const i0 = Math.max(0, Math.floor((x0 + half) / hc) - 1);
        const i1 = Math.min(vres - 1, Math.ceil((x0 + CELL + half) / hc) + 1);
        const j0 = Math.max(0, Math.floor((z0 + half) / hc) - 1);
        const j1 = Math.min(vres - 1, Math.ceil((z0 + CELL + half) / hc) + 1);
        for (let j = j0; j <= j1; j++) {
          const row = j * vres;
          for (let i = i0; i <= i1; i++) if (hs[row + i] > m) m = hs[row + i];
        }
      } else {
        m = Infinity; // unknown terrain: always march
      }
      cellMaxH[cz * n + cx] = m + TERRAIN_MARGIN;
    }
  }

  return {
    half, n, inv,
    boxStart: bx.start, boxItems: bx.items,
    treeStart: tr.start, treeItems: tr.items,
    rockStart: rk.start, rockItems: rk.items,
    boxStamp: new Uint32Array(boxes.length),
    treeStamp: new Uint32Array(trees.length),
    rockStamp: new Uint32Array(rocks.length),
    cellMaxH,
    boxCount: boxes.length, treeCount: trees.length, rockCount: rocks.length,
    heights: hs,
  };
}

function gridFor(world: World): RayGrid {
  let g = grids.get(world);
  if (
    !g || g.boxCount !== world.boxes.length || g.treeCount !== world.trees.length ||
    g.rockCount !== world.rocks.length || g.heights !== world.heights || g.half !== world.half
  ) {
    g = buildGrid(world);
    grids.set(world, g);
  }
  return g;
}

/** Build (or rebuild) the ray acceleration grid now, e.g. right after world generation, so the
 *  first shot of a match does not pay for it. Optional: casts build it lazily. */
export function prepareRaycastWorld(world: World): void {
  gridFor(world);
}

function nextStamp(g: RayGrid): number {
  rayStamp = (rayStamp + 1) >>> 0;
  if (rayStamp === 0) {
    // Wrapped around: clear every stamp array we know of (this one; others rebuild lazily).
    g.boxStamp.fill(0);
    g.treeStamp.fill(0);
    g.rockStamp.fill(0);
    rayStamp = 1;
  }
  return rayStamp;
}

// ---------------------------------------------------------------------------
// Primitive tests (ray state in module scratch to avoid argument shuffling)
// ---------------------------------------------------------------------------

let ox = 0, oy = 0, oz = 0, dx = 0, dy = 0, dz = 0;
/** Normal written by the primitive tests. */
let hnx = 0, hny = 0, hnz = 0;

function rayBox(b: WorldBox, maxT: number): number {
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 0;
  if (dx !== 0) {
    const inv = 1 / dx;
    let t1 = (b.min.x - ox) * inv, t2 = (b.max.x - ox) * inv, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
    if (t2 < tmax) tmax = t2;
  } else if (ox < b.min.x || ox > b.max.x) return -1;
  if (dy !== 0) {
    const inv = 1 / dy;
    let t1 = (b.min.y - oy) * inv, t2 = (b.max.y - oy) * inv, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
    if (t2 < tmax) tmax = t2;
  } else if (oy < b.min.y || oy > b.max.y) return -1;
  if (dz !== 0) {
    const inv = 1 / dz;
    let t1 = (b.min.z - oz) * inv, t2 = (b.max.z - oz) * inv, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
    if (t2 < tmax) tmax = t2;
  } else if (oz < b.min.z || oz > b.max.z) return -1;
  if (tmax < tmin || tmax < 0 || tmin > maxT) return -1;
  if (tmin >= 0) {
    hnx = axis === 0 ? sign : 0;
    hny = axis === 1 ? sign : 0;
    hnz = axis === 2 ? sign : 0;
    return tmin;
  }
  // Origin inside (or on the surface of) the box. Leaving through the face it starts on is free;
  // anything else is blocked immediately.
  if (tmax <= INSIDE_SKIN) return -1;
  hnx = -dx; hny = -dy; hnz = -dz;
  return 0;
}

function rayTrunk(t: TreeDef, maxT: number): number {
  const top = t.y + t.h * TREE_TRUNK_FRAC, bottom = t.y - TRUNK_SINK, r = t.r;
  const px = ox - t.x, pz = oz - t.z;
  const a = dx * dx + dz * dz;
  const b = px * dx + pz * dz;
  const c = px * px + pz * pz - r * r;
  if (c <= 0) {
    // Origin within the trunk's footprint: only a hit through the top cap is possible.
    if (oy > top && dy < 0) {
      const tc = (top - oy) / dy;
      if (tc > maxT) return -1;
      const qx = px + dx * tc, qz = pz + dz * tc;
      if (qx * qx + qz * qz <= r * r) { hnx = 0; hny = 1; hnz = 0; return tc; }
    }
    return -1;
  }
  if (a < 1e-12 || b >= 0) return -1;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const tn = (-b - sq) / a;
  if (tn > maxT) return -1;
  const y = oy + dy * tn;
  if (y >= bottom && y <= top) {
    hnx = (px + dx * tn) / r; hny = 0; hnz = (pz + dz * tn) / r;
    return tn;
  }
  if (y > top && dy < 0) {
    const tc = (top - oy) / dy, tf = (-b + sq) / a;
    if (tc >= tn && tc <= tf && tc <= maxT) { hnx = 0; hny = 1; hnz = 0; return tc; }
  }
  return -1;
}

/** Rock as an ellipsoid centred on its base point with radii (r, h, r): the visible dome. */
function rayRock(k: RockDef, maxT: number): number {
  const ir = 1 / k.r, ih = 1 / k.h;
  const px = (ox - k.x) * ir, py = (oy - k.y) * ih, pz = (oz - k.z) * ir;
  const qx = dx * ir, qy = dy * ih, qz = dz * ir;
  const c = px * px + py * py + pz * pz - 1;
  if (c <= 0) return -1; // origin inside the rock: ignore it (cannot happen for players)
  const b = px * qx + py * qy + pz * qz;
  if (b >= 0) return -1;
  const a = qx * qx + qy * qy + qz * qz;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t > maxT) return -1;
  // Gradient of the implicit ellipsoid at the hit point.
  const gx = (px + qx * t) * ir, gy = (py + qy * t) * ih, gz = (pz + qz * t) * ir;
  const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  hnx = gx / gl; hny = gy / gl; hnz = gz / gl;
  return t;
}

// ---------------------------------------------------------------------------
// Core cast
// ---------------------------------------------------------------------------

const KIND_NONE = 0, KIND_TERRAIN = 1, KIND_WATER = 2, KIND_BOX = 3, KIND_TREE = 4, KIND_ROCK = 5;

/** Result of the last `cast` (module scratch). */
const res = { t: 0, kind: KIND_NONE, index: -1, nx: 0, ny: 1, nz: 0 };

/**
 * Cast the normalised ray (ox..dz scratch) up to maxDist. With `anyHit` the walk stops at the first
 * blocker found (not necessarily the nearest) and terrain crossings are not refined.
 * Returns true on a hit (details in `res`).
 */
function cast(world: World, maxDist: number, includeWater: boolean, anyHit: boolean): boolean {
  const g = gridFor(world);
  let best = maxDist;
  let kind = KIND_NONE, index = -1, nx = 0, ny = 1, nz = 0;

  // Water surface: only when crossing it from above, over water.
  if (includeWater && dy < -1e-9 && oy > world.waterLevel) {
    const tw = (world.waterLevel - oy) / dy;
    if (tw <= best) {
      const wx = ox + dx * tw, wz = oz + dz * tw;
      if (wx >= -g.half && wx <= g.half && wz >= -g.half && wz <= g.half && world.heightAt(wx, wz) < world.waterLevel) {
        best = tw; kind = KIND_WATER; nx = 0; ny = 1; nz = 0;
        if (anyHit) { res.t = tw; res.kind = kind; res.index = -1; res.nx = 0; res.ny = 1; res.nz = 0; return true; }
      }
    }
  }

  // Clip the ray to the map square in XZ.
  const half = g.half;
  let t0 = 0, t1 = best;
  if (Math.abs(dx) < 1e-12) {
    if (ox < -half || ox > half) t1 = -1;
  } else {
    let ta = (-half - ox) / dx, tb = (half - ox) / dx;
    if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < -half || oz > half) t1 = -1;
  } else {
    let ta = (-half - oz) / dz, tb = (half - oz) / dz;
    if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }

  if (t0 <= t1) {
    const n = g.n, inv = g.inv, cs = (2 * half) / n;
    const stamp = nextStamp(g);
    const boxes = world.boxes, trees = world.trees, rocks = world.rocks;
    const bStart = g.boxStart, bItems = g.boxItems, bStamp = g.boxStamp;
    const tStart = g.treeStart, tItems = g.treeItems, tStamp = g.treeStamp;
    const rStart = g.rockStart, rItems = g.rockItems, rStamp = g.rockStamp;
    const step = world.cell > 0 ? world.cell * 0.5 : 1;

    let ix = cellRange(ox + dx * t0, half, inv, n);
    let iz = cellRange(oz + dz * t0, half, inv, n);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    let tMaxX = Math.abs(dx) < 1e-12 ? Infinity : ((ix + (dx > 0 ? 1 : 0)) * cs - half - ox) / dx;
    let tMaxZ = Math.abs(dz) < 1e-12 ? Infinity : ((iz + (dz > 0 ? 1 : 0)) * cs - half - oz) / dz;
    const tDX = Math.abs(dx) < 1e-12 ? Infinity : cs / Math.abs(dx);
    const tDZ = Math.abs(dz) < 1e-12 ? Infinity : cs / Math.abs(dz);
    let tA = t0;
    // Terrain march state: f = ray height above terrain at the last sample.
    let prevT = -1, prevF = 0;

    for (;;) {
      let tB = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tB > t1) tB = t1;
      const cell = iz * n + ix;

      // --- colliders in this cell ---
      for (let k = bStart[cell], e = bStart[cell + 1]; k < e; k++) {
        const i = bItems[k];
        if (bStamp[i] === stamp) continue;
        bStamp[i] = stamp;
        const t = rayBox(boxes[i], best);
        if (t >= 0 && t < best) {
          best = t; kind = KIND_BOX; index = i; nx = hnx; ny = hny; nz = hnz;
          if (anyHit) break;
        }
      }
      if (anyHit && kind !== KIND_NONE) break;
      for (let k = tStart[cell], e = tStart[cell + 1]; k < e; k++) {
        const i = tItems[k];
        if (tStamp[i] === stamp) continue;
        tStamp[i] = stamp;
        const t = rayTrunk(trees[i], best);
        if (t >= 0 && t < best) {
          best = t; kind = KIND_TREE; index = i; nx = hnx; ny = hny; nz = hnz;
          if (anyHit) break;
        }
      }
      if (anyHit && kind !== KIND_NONE) break;
      for (let k = rStart[cell], e = rStart[cell + 1]; k < e; k++) {
        const i = rItems[k];
        if (rStamp[i] === stamp) continue;
        rStamp[i] = stamp;
        const t = rayRock(rocks[i], best);
        if (t >= 0 && t < best) {
          best = t; kind = KIND_ROCK; index = i; nx = hnx; ny = hny; nz = hnz;
          if (anyHit) break;
        }
      }
      if (anyHit && kind !== KIND_NONE) break;

      // --- terrain inside this cell's ray interval ---
      // Only the part of the interval where the ray is at or below the cell's terrain maximum
      // needs sampling.
      let ts = tA, te = tB < best ? tB : best;
      const cm = g.cellMaxH[cell];
      if (dy > 0) {
        const tc = (cm - oy) / dy;
        if (tc < te) te = tc;
      } else if (dy < 0) {
        const tc = (cm - oy) / dy;
        if (tc > ts) ts = tc;
      } else if (oy > cm) {
        te = -1;
      }
      if (te >= ts) {
        let t = ts;
        if (prevT !== t) {
          // (Re)start sampling.
          let f = oy + dy * t - world.heightAt(ox + dx * t, oz + dz * t);
          if (f < 0) {
            if (t > 0 || f < -UNDERGROUND_TOLERANCE) {
              // Starts below the terrain (origin underground or entering the map through it).
              best = t; kind = KIND_TERRAIN; index = -1;
              break;
            }
            f = 0;
          }
          prevT = t; prevF = f;
        }
        let hitT = -1;
        while (t < te) {
          let t2 = t + step;
          if (t2 > te) t2 = te;
          const f2 = oy + dy * t2 - world.heightAt(ox + dx * t2, oz + dz * t2);
          if (f2 < 0 && prevF >= 0) {
            if (anyHit) { hitT = t2; break; }
            let lo = t, hi = t2;
            for (let it = 0; it < TERRAIN_REFINE; it++) {
              const mid = (lo + hi) * 0.5;
              const fm = oy + dy * mid - world.heightAt(ox + dx * mid, oz + dz * mid);
              if (fm < 0) hi = mid; else lo = mid;
            }
            hitT = hi;
            break;
          }
          t = t2; prevT = t2; prevF = f2;
        }
        if (hitT >= 0 && hitT <= best) {
          best = hitT; kind = KIND_TERRAIN; index = -1;
          if (anyHit) break;
        }
      } else {
        // Ray above this cell's terrain: the next cell restarts sampling.
        prevT = -1;
      }

      if (kind !== KIND_NONE && best <= tB) break;
      if (tB >= t1) break;
      if (tMaxX < tMaxZ) {
        ix += sx; tA = tMaxX; tMaxX += tDX;
        if (ix < 0 || ix >= n) break;
      } else {
        iz += sz; tA = tMaxZ; tMaxZ += tDZ;
        if (iz < 0 || iz >= n) break;
      }
    }
  }

  if (kind === KIND_NONE) return false;
  if (kind === KIND_TERRAIN) {
    // Terrain normal is evaluated by the caller only when it needs the full hit record.
    nx = 0; ny = 1; nz = 0;
  }
  res.t = best; res.kind = kind; res.index = index; res.nx = nx; res.ny = ny; res.nz = nz;
  return true;
}

function setRay(origin: Vec3, dir: Vec3): boolean {
  const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (!(l > 1e-9) || !Number.isFinite(l)) return false;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) return false;
  ox = origin.x; oy = origin.y; oz = origin.z;
  dx = dir.x / l; dy = dir.y / l; dz = dir.z / l;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Nearest hit along a ray among terrain, the water surface (crossed from above), bullet-blocking
 * boxes, tree trunks and rocks, up to maxDist. `dir` should be normalised (it is normalised
 * internally if not; distances are along the normalised direction). Fills and returns `out` when
 * given, otherwise a new RayHit; null on a miss. `id` is the box id for box hits (undefined
 * otherwise).
 */
export function raycastWorld(world: World, origin: Vec3, dir: Vec3, maxDist: number, out?: RayHit): RayHit | null {
  if (!(maxDist > 0) || !setRay(origin, dir)) return null;
  if (!cast(world, maxDist < MAX_RAY ? maxDist : MAX_RAY, true, false)) return null;
  const t = res.t;
  const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
  const hit: RayHit = out ?? {
    dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, kind: 'terrain', material: 'grass',
  };
  hit.dist = t;
  if (!hit.point) hit.point = { x: 0, y: 0, z: 0 };
  if (!hit.normal) hit.normal = { x: 0, y: 1, z: 0 };
  hit.point.x = px; hit.point.y = py; hit.point.z = pz;
  hit.id = undefined;
  hit.part = undefined;
  switch (res.kind) {
    case KIND_TERRAIN:
      world.normalAt(px, pz, hit.normal);
      hit.kind = 'terrain';
      hit.material = world.surfaceAt(px, pz);
      break;
    case KIND_WATER:
      hit.normal.x = 0; hit.normal.y = 1; hit.normal.z = 0;
      hit.kind = 'water';
      hit.material = 'water';
      break;
    case KIND_BOX: {
      const b = world.boxes[res.index];
      hit.normal.x = res.nx; hit.normal.y = res.ny; hit.normal.z = res.nz;
      hit.kind = 'box';
      hit.material = b.material;
      hit.id = b.id;
      break;
    }
    case KIND_TREE:
      hit.normal.x = res.nx; hit.normal.y = res.ny; hit.normal.z = res.nz;
      hit.kind = 'tree';
      hit.material = 'wood';
      break;
    default:
      hit.normal.x = res.nx; hit.normal.y = res.ny; hit.normal.z = res.nz;
      hit.kind = 'rock';
      hit.material = 'rock';
      break;
  }
  return hit;
}

/** Shortened by this much at the far end so targets resting on a surface are still visible. */
const LOS_END_SLACK = 0.02;

/** True when nothing static (terrain, bullet-blocking boxes, trunks, rocks) lies between a and b.
 *  Water does not block line of sight. */
export function lineOfSight(world: World, a: Vec3, b: Vec3): boolean {
  const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!Number.isFinite(l)) return false;
  if (l <= LOS_END_SLACK) return true;
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return false;
  ox = a.x; oy = a.y; oz = a.z;
  dx = vx / l; dy = vy / l; dz = vz / l;
  return !cast(world, Math.min(l - LOS_END_SLACK, MAX_RAY), false, true);
}
