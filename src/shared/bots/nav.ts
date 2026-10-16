// Ground-level navigation grid for bots.
//
// The map is covered by 1 m cells grouped into 64 x 64 cell tiles that are generated lazily the
// first time something needs them. Each cell stores:
//   * its walkable floor height ("base"): the terrain, or the top of a low box the character can
//     stand on (foundations, floor slabs, low steps),
//   * flags: BLOCKED (something occupies the standing character's vertical span at the cell
//     centre, deep water, too steep, map edge), NEAR (an obstacle within ~0.5 m: used to keep
//     paths off walls and to keep smoothing honest), ON_BOX (base comes from a box), and edge
//     flags for the east/south neighbour moves crossing a thin obstacle (walls are 0.25 m thick,
//     much thinner than a cell, so a wall can sit between two free cell centres),
//   * a direction mask: which of the 8 neighbour moves are allowed (both cells free, no edge
//     obstacle, step height <= MAX_STEP_UP; diagonals only when the whole 2 x 2 block is open).
//
// Cell centres are tested against obstacles inflated by only 0.15 m: with 1 m cells this
// guarantees that every door gap >= 1.3 m wide keeps at least one free column of cells, while
// the edge flags guarantee that no move crosses a wall. Waypoints in NEAR cells are later
// "relaxed" away from walls (see relaxPoint) so bots walk through the middle of doorways.

import { STEP_HEIGHT } from '../constants';
import type { RockDef, TreeDef, Vec3, World, WorldBox } from '../types';

export const NAV_TILE = 64;
const TILE_SHIFT = 6;
const TILE_MASK = NAV_TILE - 1;
const TILE_CELLS = NAV_TILE * NAV_TILE;
const PADW = NAV_TILE + 2;

export const NF_BLOCKED = 1;
export const NF_EDGE_E = 2;
export const NF_EDGE_S = 4;
export const NF_NEAR = 8;
export const NF_ON_BOX = 16;
/** Returned by non-forcing lookups for cells whose tile has not been generated yet. */
export const NF_UNKNOWN = 128;

/** Neighbour directions: E, SE, S, SW, W, NW, N, NE (S = +Z). */
export const DIR_DX: readonly number[] = [1, 1, 0, -1, -1, -1, 0, 1];
export const DIR_DZ: readonly number[] = [0, 1, 1, 1, 0, -1, -1, -1];
export const DIR_E = 0, DIR_S = 2, DIR_W = 4, DIR_N = 6;

const BLOCK_INFLATE = 0.15;
const NEAR_INFLATE = 0.5;
/** Vertical span (above the floor) that must be free for a standing character to pass. */
const CLEAR_LO = STEP_HEIGHT;
const CLEAR_HI = 1.75;
/** Box tops at most this far above the terrain may become the walkable floor of a cell. */
const FLOOR_MAX_ABOVE_TERRAIN = 2.0;
/** Max floor height difference between neighbouring cells when a box floor is involved. */
export const MAX_STEP_UP = 0.5;
/** Minimum terrain normal Y that is comfortably walkable (MAX_SLOPE_DEG is 50 deg, keep margin). */
const MIN_WALK_NORMAL_Y = 0.68;
/** Water deeper than this (m) is treated as blocked (bots avoid swimming). */
const DEEP_WATER = 1.0;
const TREE_TRUNK_FRAC = 0.6;
/** Cells this close to the map border are blocked (physics clamps at half - 1). */
const EDGE_CELLS = 2;
/** World units of extra margin when querying colliders for a tile. */
const QUERY_MARGIN = 2;
/** Clearance used when relaxing waypoints away from walls. */
const RELAX_RADIUS = 0.55;

// ---------------------------------------------------------------------------
// Module scratch (generation is not re-entrant, JS is single threaded)
// ---------------------------------------------------------------------------

const padBase = new Float32Array(PADW * PADW);
const padTerr = new Float32Array(PADW * PADW);
const padFlags = new Uint8Array(PADW * PADW);
const boxBuf: WorldBox[] = [];
const boxSorted: WorldBox[] = [];
const treeBuf: TreeDef[] = [];
const rockBuf: RockDef[] = [];
const scratchN: Vec3 = { x: 0, y: 1, z: 0 };
const byTop = (a: WorldBox, b: WorldBox): number => a.max.y - b.max.y || a.id - b.id;

export class NavGrid {
  readonly world: World;
  readonly half: number;
  /** Cells per side. */
  readonly cells: number;
  /** Tiles per side. */
  readonly tiles: number;
  private readonly tFlags: (Uint8Array | null)[];
  private readonly tDirs: (Uint8Array | null)[];
  private readonly tBase: (Float32Array | null)[];
  /** Remaining tile generations allowed for non-forcing lookups (reset per tick by the owner). */
  genBudget = 2;
  /** Total generated tiles (stats / tests). */
  tilesGenerated = 0;

  constructor(world: World) {
    this.world = world;
    this.half = world.half;
    this.cells = Math.round(world.size);
    this.tiles = Math.ceil(this.cells / NAV_TILE);
    const n = this.tiles * this.tiles;
    this.tFlags = new Array<Uint8Array | null>(n).fill(null);
    this.tDirs = new Array<Uint8Array | null>(n).fill(null);
    this.tBase = new Array<Float32Array | null>(n).fill(null);
  }

  /** Global cell coordinate of a world X/Z (may be outside the grid). */
  cell(v: number): number {
    return Math.floor(v + this.half);
  }
  /** World coordinate of a cell centre. */
  center(c: number): number {
    return c + 0.5 - this.half;
  }
  inGrid(gx: number, gz: number): boolean {
    return gx >= 0 && gz >= 0 && gx < this.cells && gz < this.cells;
  }

  /** Make sure the tile holding cell (gx, gz) exists. Non-forcing calls respect genBudget. */
  ensureCell(gx: number, gz: number, force: boolean): boolean {
    if (!this.inGrid(gx, gz)) return true;
    const ti = (gz >> TILE_SHIFT) * this.tiles + (gx >> TILE_SHIFT);
    if (this.tFlags[ti]) return true;
    if (!force && this.genBudget <= 0) return false;
    this.genBudget--;
    this.generate(gx >> TILE_SHIFT, gz >> TILE_SHIFT);
    return true;
  }

  /** Cell flags; out-of-grid cells are BLOCKED; NF_UNKNOWN when not generated and not forced. */
  flags(gx: number, gz: number, force = true): number {
    if (!this.inGrid(gx, gz)) return NF_BLOCKED;
    const ti = (gz >> TILE_SHIFT) * this.tiles + (gx >> TILE_SHIFT);
    let f = this.tFlags[ti];
    if (!f) {
      if (!this.ensureCell(gx, gz, force)) return NF_UNKNOWN;
      f = this.tFlags[ti] as Uint8Array;
    }
    return f[((gz & TILE_MASK) << TILE_SHIFT) | (gx & TILE_MASK)];
  }

  /** Allowed-move mask (bit k = direction k of DIR_DX/DIR_DZ); -1 when unknown and not forced. */
  dirs(gx: number, gz: number, force = true): number {
    if (!this.inGrid(gx, gz)) return 0;
    const ti = (gz >> TILE_SHIFT) * this.tiles + (gx >> TILE_SHIFT);
    let d = this.tDirs[ti];
    if (!d) {
      if (!this.ensureCell(gx, gz, force)) return -1;
      d = this.tDirs[ti] as Uint8Array;
    }
    return d[((gz & TILE_MASK) << TILE_SHIFT) | (gx & TILE_MASK)];
  }

  /** Walkable floor height of a cell. */
  base(gx: number, gz: number): number {
    if (!this.inGrid(gx, gz)) return 0;
    const ti = (gz >> TILE_SHIFT) * this.tiles + (gx >> TILE_SHIFT);
    if (!this.tBase[ti]) this.ensureCell(gx, gz, true);
    return (this.tBase[ti] as Float32Array)[((gz & TILE_MASK) << TILE_SHIFT) | (gx & TILE_MASK)];
  }

  /** Flags of the cell under a world position. */
  flagsAt(x: number, z: number, force = true): number {
    return this.flags(this.cell(x), this.cell(z), force);
  }

  /** True when the cell under (x, z) is free (unknown tiles count as free when not forced). */
  freeAt(x: number, z: number, force = true): boolean {
    const f = this.flagsAt(x, z, force);
    return f === NF_UNKNOWN || (f & NF_BLOCKED) === 0;
  }

  /**
   * Can a character walk in a straight line from a to b (both world X/Z)? Traverses every cell the
   * segment touches (grid DDA) and requires each crossing to be an allowed move. With `strict`,
   * intermediate cells must not be NEAR obstacles (used for path smoothing so shortcuts keep their
   * distance from walls). `force` generates missing tiles; otherwise unknown tiles count as open.
   */
  lineOfWalk(ax: number, az: number, bx: number, bz: number, strict: boolean, force = true): boolean {
    const half = this.half;
    const u0 = ax + half, v0 = az + half, u1 = bx + half, v1 = bz + half;
    let cx = Math.floor(u0), cz = Math.floor(v0);
    const ex = Math.floor(u1), ez = Math.floor(v1);
    const f0 = this.flags(cx, cz, force);
    if (f0 !== NF_UNKNOWN && f0 & NF_BLOCKED) return false;
    if (cx === ex && cz === ez) return true;
    const du = u1 - u0, dv = v1 - v0;
    const sx = du > 0 ? 1 : du < 0 ? -1 : 0;
    const sz = dv > 0 ? 1 : dv < 0 ? -1 : 0;
    const tdx = sx !== 0 ? Math.abs(1 / du) : Infinity;
    const tdz = sz !== 0 ? Math.abs(1 / dv) : Infinity;
    let tmx = sx > 0 ? (cx + 1 - u0) * tdx : sx < 0 ? (u0 - cx) * tdx : Infinity;
    let tmz = sz > 0 ? (cz + 1 - v0) * tdz : sz < 0 ? (v0 - cz) * tdz : Infinity;
    const dirX = sx > 0 ? DIR_E : DIR_W;
    const dirZ = sz > 0 ? DIR_S : DIR_N;
    let guard = Math.abs(ex - cx) + Math.abs(ez - cz) + 2;
    while (guard-- > 0) {
      const m = this.dirs(cx, cz, force);
      let dir: number;
      if (Math.abs(tmx - tmz) < 1e-9) {
        // Exactly through a corner: require the diagonal (whole 2 x 2 block open).
        dir = sx > 0 ? (sz > 0 ? 1 : 7) : sz > 0 ? 3 : 5;
        if (m !== -1 && !(m & (1 << dir))) return false;
        cx += sx; cz += sz;
        tmx += tdx; tmz += tdz;
      } else if (tmx < tmz) {
        dir = dirX;
        if (m !== -1 && !(m & (1 << dir))) return false;
        cx += sx;
        tmx += tdx;
      } else {
        dir = dirZ;
        if (m !== -1 && !(m & (1 << dir))) return false;
        cz += sz;
        tmz += tdz;
      }
      const last = cx === ex && cz === ez;
      if (last) return true;
      if (strict) {
        const f = this.flags(cx, cz, force);
        if (f !== NF_UNKNOWN && f & NF_NEAR) return false;
      }
    }
    return true;
  }

  /**
   * Nearest free cell centre to (x, z) within `maxR` cells (ring search, preferring cells away
   * from walls within the same ring). Writes into out and returns true when found.
   */
  nearestFree(x: number, z: number, maxR: number, out: { x: number; z: number }): boolean {
    const gx = this.cell(x), gz = this.cell(z);
    for (let r = 0; r <= maxR; r++) {
      let best = -1, bestD = Infinity, bestNear = true;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const f = this.flags(gx + dx, gz + dz, true);
          if (f & NF_BLOCKED || this.dirs(gx + dx, gz + dz, true) === 0) continue;
          const near = (f & NF_NEAR) !== 0;
          const d = dx * dx + dz * dz;
          if ((bestNear && !near) || (near === bestNear && d < bestD)) {
            best = (dz + r) * (2 * r + 1) + (dx + r);
            bestD = d;
            bestNear = near;
          }
        }
      }
      if (best >= 0) {
        const w = 2 * r + 1;
        const dx = (best % w) - r, dz = Math.floor(best / w) - r;
        out.x = this.center(gx + dx);
        out.z = this.center(gz + dz);
        return true;
      }
    }
    return false;
  }

  /**
   * Push a waypoint away from nearby walls/trunks so it keeps ~RELAX_RADIUS clearance where the
   * space allows (doorways end up centred). Moves at most 0.6 m and never into a blocked cell.
   */
  relaxPoint(p: { x: number; z: number }): void {
    const gx = this.cell(p.x), gz = this.cell(p.z);
    const base = this.base(gx, gz);
    const lo = base + CLEAR_LO, hi = base + CLEAR_HI;
    const w = this.world;
    const R = RELAX_RADIUS + 0.2;
    boxBuf.length = 0;
    const boxes = w.queryBoxes(p.x - R, p.z - R, p.x + R, p.z + R, boxBuf);
    treeBuf.length = 0;
    const trees = w.queryTrees(p.x - 2, p.z - 2, p.x + 2, p.z + 2, treeBuf);
    let x = p.x, z = p.z;
    for (let iter = 0; iter < 4; iter++) {
      let px = 0, pz = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.min.y >= hi || b.max.y <= lo) continue;
        const qx = x < b.min.x ? b.min.x : x > b.max.x ? b.max.x : x;
        const qz = z < b.min.z ? b.min.z : z > b.max.z ? b.max.z : z;
        const dx = x - qx, dz = z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= RELAX_RADIUS * RELAX_RADIUS || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        const pen = RELAX_RADIUS - d;
        px += (dx / d) * pen;
        pz += (dz / d) * pen;
      }
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        if (t.y >= hi || t.y + t.h * TREE_TRUNK_FRAC <= lo) continue;
        const dx = x - t.x, dz = z - t.z;
        const R2 = t.r + RELAX_RADIUS;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R2 * R2 || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        px += (dx / d) * (R2 - d);
        pz += (dz / d) * (R2 - d);
      }
      if (px === 0 && pz === 0) break;
      x += px * 0.5;
      z += pz * 0.5;
    }
    const mx = x - p.x, mz = z - p.z;
    const m = Math.hypot(mx, mz);
    if (m < 1e-4) return;
    const s = m > 0.6 ? 0.6 / m : 1;
    const nx = p.x + mx * s, nz = p.z + mz * s;
    // Only accept when the moved point is still free and reachable in a straight line.
    if (this.lineOfWalk(p.x, p.z, nx, nz, false, true)) {
      p.x = nx;
      p.z = nz;
    }
  }

  // -------------------------------------------------------------------------
  // Tile generation
  // -------------------------------------------------------------------------

  private generate(tx: number, tz: number): void {
    const w = this.world, half = this.half, cells = this.cells;
    const gx0 = tx * NAV_TILE - 1, gz0 = tz * NAV_TILE - 1; // padded origin (global cells)
    const water = w.waterLevel;

    // 1. Terrain floor, map edge.
    for (let pj = 0; pj < PADW; pj++) {
      const gz = gz0 + pj;
      const z = gz + 0.5 - half;
      for (let pi = 0; pi < PADW; pi++) {
        const gx = gx0 + pi;
        const k = pj * PADW + pi;
        if (gx < EDGE_CELLS || gz < EDGE_CELLS || gx >= cells - EDGE_CELLS || gz >= cells - EDGE_CELLS) {
          padFlags[k] = NF_BLOCKED;
          padTerr[k] = padBase[k] = 0;
          continue;
        }
        const h = w.heightAt(gx + 0.5 - half, z);
        padTerr[k] = h;
        padBase[k] = h;
        padFlags[k] = 0;
      }
    }

    const wx0 = gx0 - half, wz0 = gz0 - half;
    const wx1 = wx0 + PADW, wz1 = wz0 + PADW;

    // 2. Low boxes become floors (ascending by top so stacked steps/slabs build up).
    boxBuf.length = 0;
    const found = w.queryBoxes(wx0 - QUERY_MARGIN, wz0 - QUERY_MARGIN, wx1 + QUERY_MARGIN, wz1 + QUERY_MARGIN, boxBuf);
    boxSorted.length = 0;
    for (let i = 0; i < found.length; i++) boxSorted.push(found[i]);
    boxSorted.sort(byTop);
    for (let i = 0; i < boxSorted.length; i++) {
      const b = boxSorted[i];
      const pi0 = Math.max(0, Math.ceil(b.min.x - wx0 - 0.5));
      const pi1 = Math.min(PADW - 1, Math.floor(b.max.x - wx0 - 0.5));
      const pj0 = Math.max(0, Math.ceil(b.min.z - wz0 - 0.5));
      const pj1 = Math.min(PADW - 1, Math.floor(b.max.z - wz0 - 0.5));
      for (let pj = pj0; pj <= pj1; pj++) {
        for (let pi = pi0; pi <= pi1; pi++) {
          const k = pj * PADW + pi;
          if (padFlags[k] & NF_BLOCKED) continue;
          const top = b.max.y;
          if (top > padBase[k] && top <= padTerr[k] + FLOOR_MAX_ABOVE_TERRAIN && b.min.y <= padBase[k] + MAX_STEP_UP) {
            padBase[k] = top;
            padFlags[k] |= NF_ON_BOX;
          }
        }
      }
    }

    // 3. Boxes: blocked cells, NEAR cells, blocked edges.
    for (let i = 0; i < boxSorted.length; i++) this.rasterBox(boxSorted[i], wx0, wz0);

    // 4. Tree trunks and rocks (vertical cylinders).
    treeBuf.length = 0;
    const trees = w.queryTrees(wx0 - QUERY_MARGIN, wz0 - QUERY_MARGIN, wx1 + QUERY_MARGIN, wz1 + QUERY_MARGIN, treeBuf);
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      this.rasterCylinder(t.x, t.z, t.r, t.y, t.y + t.h * TREE_TRUNK_FRAC, wx0, wz0);
    }
    rockBuf.length = 0;
    const rocks = w.queryRocks(wx0 - QUERY_MARGIN, wz0 - QUERY_MARGIN, wx1 + QUERY_MARGIN, wz1 + QUERY_MARGIN, rockBuf);
    for (let i = 0; i < rocks.length; i++) {
      const r = rocks[i];
      this.rasterCylinder(r.x, r.z, r.r, r.y - 1, r.y + r.h, wx0, wz0);
    }

    // 5. Deep water and steep terrain.
    for (let pj = 0; pj < PADW; pj++) {
      for (let pi = 0; pi < PADW; pi++) {
        const k = pj * PADW + pi;
        const f = padFlags[k];
        if (f & (NF_BLOCKED | NF_ON_BOX)) continue;
        if (padTerr[k] < water - DEEP_WATER) {
          padFlags[k] = f | NF_BLOCKED;
          continue;
        }
        const n = w.normalAt(wx0 + pi + 0.5, wz0 + pj + 0.5, scratchN);
        if (n.y < MIN_WALK_NORMAL_Y) padFlags[k] = f | NF_BLOCKED;
      }
    }

    // 6. Store inner cells + direction masks.
    const flags = new Uint8Array(TILE_CELLS);
    const dirs = new Uint8Array(TILE_CELLS);
    const base = new Float32Array(TILE_CELLS);
    for (let j = 0; j < NAV_TILE; j++) {
      for (let i = 0; i < NAV_TILE; i++) {
        const k = (j + 1) * PADW + (i + 1);
        const o = (j << TILE_SHIFT) | i;
        flags[o] = padFlags[k];
        base[o] = padBase[k];
        dirs[o] = padFlags[k] & NF_BLOCKED ? 0 : dirMask(k);
      }
    }
    const ti = tz * this.tiles + tx;
    this.tFlags[ti] = flags;
    this.tDirs[ti] = dirs;
    this.tBase[ti] = base;
    this.tilesGenerated++;
  }

  private rasterBox(b: WorldBox, wx0: number, wz0: number): void {
    const I = BLOCK_INFLATE, N = NEAR_INFLATE;
    const by0 = b.min.y, by1 = b.max.y;
    // Cells (NEAR range includes the BLOCK range).
    const pi0 = Math.max(0, Math.ceil(b.min.x - N - wx0 - 0.5));
    const pi1 = Math.min(PADW - 1, Math.floor(b.max.x + N - wx0 - 0.5));
    const pj0 = Math.max(0, Math.ceil(b.min.z - N - wz0 - 0.5));
    const pj1 = Math.min(PADW - 1, Math.floor(b.max.z + N - wz0 - 0.5));
    const bx0 = b.min.x - I, bx1 = b.max.x + I, bz0 = b.min.z - I, bz1 = b.max.z + I;
    for (let pj = pj0; pj <= pj1; pj++) {
      const cz = wz0 + pj + 0.5;
      for (let pi = pi0; pi <= pi1; pi++) {
        const k = pj * PADW + pi;
        const base = padBase[k];
        if (by0 >= base + CLEAR_HI || by1 <= base + CLEAR_LO) continue;
        let f = padFlags[k] | NF_NEAR;
        const cx = wx0 + pi + 0.5;
        if (cx >= bx0 && cx <= bx1 && cz >= bz0 && cz <= bz1) f |= NF_BLOCKED;
        padFlags[k] = f;
      }
    }
    // East edges: segment (cx, cz) -> (cx + 1, cz) for rows whose centre z is inside the inflated box.
    {
      const j0 = Math.max(0, Math.ceil(bz0 - wz0 - 0.5));
      const j1 = Math.min(PADW - 1, Math.floor(bz1 - wz0 - 0.5));
      const i0 = Math.max(0, Math.ceil(bx0 - wx0 - 1.5));
      const i1 = Math.min(PADW - 2, Math.floor(bx1 - wx0 - 0.5));
      for (let pj = j0; pj <= j1; pj++) {
        for (let pi = i0; pi <= i1; pi++) {
          const a = pj * PADW + pi;
          const ba = padBase[a], bb = padBase[a + 1];
          const lo = (ba < bb ? ba : bb) + CLEAR_LO, hi = (ba > bb ? ba : bb) + CLEAR_HI;
          if (by0 < hi && by1 > lo) padFlags[a] |= NF_EDGE_E;
        }
      }
    }
    // South edges: segment (cx, cz) -> (cx, cz + 1).
    {
      const i0 = Math.max(0, Math.ceil(bx0 - wx0 - 0.5));
      const i1 = Math.min(PADW - 1, Math.floor(bx1 - wx0 - 0.5));
      const j0 = Math.max(0, Math.ceil(bz0 - wz0 - 1.5));
      const j1 = Math.min(PADW - 2, Math.floor(bz1 - wz0 - 0.5));
      for (let pj = j0; pj <= j1; pj++) {
        for (let pi = i0; pi <= i1; pi++) {
          const a = pj * PADW + pi;
          const ba = padBase[a], bb = padBase[a + PADW];
          const lo = (ba < bb ? ba : bb) + CLEAR_LO, hi = (ba > bb ? ba : bb) + CLEAR_HI;
          if (by0 < hi && by1 > lo) padFlags[a] |= NF_EDGE_S;
        }
      }
    }
  }

  private rasterCylinder(x: number, z: number, r: number, y0: number, y1: number, wx0: number, wz0: number): void {
    const rb = r + BLOCK_INFLATE, rn = r + NEAR_INFLATE;
    const rb2 = rb * rb, rn2 = rn * rn;
    const pi0 = Math.max(0, Math.floor(x - rn - wx0 - 1));
    const pi1 = Math.min(PADW - 1, Math.ceil(x + rn - wx0));
    const pj0 = Math.max(0, Math.floor(z - rn - wz0 - 1));
    const pj1 = Math.min(PADW - 1, Math.ceil(z + rn - wz0));
    for (let pj = pj0; pj <= pj1; pj++) {
      const cz = wz0 + pj + 0.5;
      const dz = cz - z;
      for (let pi = pi0; pi <= pi1; pi++) {
        const k = pj * PADW + pi;
        const base = padBase[k];
        const cx = wx0 + pi + 0.5;
        const dx = cx - x;
        const d2 = dx * dx + dz * dz;
        if (d2 <= rn2 && y0 < base + CLEAR_HI && y1 > base + CLEAR_LO) {
          padFlags[k] |= d2 <= rb2 ? NF_BLOCKED | NF_NEAR : NF_NEAR;
        }
        // East edge (cx..cx+1, cz)
        if (pi < PADW - 1 && Math.abs(dz) <= rb) {
          const qx = x < cx ? cx : x > cx + 1 ? cx + 1 : x;
          const ex = qx - x;
          if (ex * ex + dz * dz <= rb2) {
            const ba = base, bb = padBase[k + 1];
            const lo = (ba < bb ? ba : bb) + CLEAR_LO, hi = (ba > bb ? ba : bb) + CLEAR_HI;
            if (y0 < hi && y1 > lo) padFlags[k] |= NF_EDGE_E;
          }
        }
        // South edge (cx, cz..cz+1)
        if (pj < PADW - 1 && Math.abs(dx) <= rb) {
          const qz = z < cz ? cz : z > cz + 1 ? cz + 1 : z;
          const ez = qz - z;
          if (dx * dx + ez * ez <= rb2) {
            const ba = base, bb = padBase[k + PADW];
            const lo = (ba < bb ? ba : bb) + CLEAR_LO, hi = (ba > bb ? ba : bb) + CLEAR_HI;
            if (y0 < hi && y1 > lo) padFlags[k] |= NF_EDGE_S;
          }
        }
      }
    }
  }
}

/** Orthogonal move between padded cells a -> b; `edgeCell`/`edgeBit` hold the thin-obstacle flag. */
function orthOpen(a: number, b: number, edgeCell: number, edgeBit: number): boolean {
  const fa = padFlags[a], fb = padFlags[b];
  if ((fa | fb) & NF_BLOCKED) return false;
  if (padFlags[edgeCell] & edgeBit) return false;
  if ((fa | fb) & NF_ON_BOX) {
    const d = padBase[a] - padBase[b];
    if (d > MAX_STEP_UP || d < -MAX_STEP_UP) return false;
  }
  return true;
}

/** Allowed-move mask for an inner padded cell k. */
function dirMask(k: number): number {
  const e = k + 1, wv = k - 1, s = k + PADW, n = k - PADW;
  const oE = orthOpen(k, e, k, NF_EDGE_E);
  const oW = orthOpen(k, wv, wv, NF_EDGE_E);
  const oS = orthOpen(k, s, k, NF_EDGE_S);
  const oN = orthOpen(k, n, n, NF_EDGE_S);
  let m = 0;
  if (oE) m |= 1 << 0;
  if (oS) m |= 1 << 2;
  if (oW) m |= 1 << 4;
  if (oN) m |= 1 << 6;
  // Diagonals: the whole 2x2 block must be open both ways round.
  if (oE && oS && orthOpen(e, s + 1, e, NF_EDGE_S) && orthOpen(s, s + 1, s, NF_EDGE_E)) m |= 1 << 1; // SE
  if (oW && oS && orthOpen(wv, s - 1, wv, NF_EDGE_S) && orthOpen(s, s - 1, s - 1, NF_EDGE_E)) m |= 1 << 3; // SW
  if (oW && oN && orthOpen(wv, n - 1, n - 1, NF_EDGE_S) && orthOpen(n, n - 1, n - 1, NF_EDGE_E)) m |= 1 << 5; // NW
  if (oE && oN && orthOpen(e, n + 1, n + 1, NF_EDGE_S) && orthOpen(n, n + 1, n, NF_EDGE_E)) m |= 1 << 7; // NE
  return m;
}

const grids = new WeakMap<World, NavGrid>();
/** Shared nav grid per world (tiles are reused by every driver on the same world). */
export function navGridFor(world: World): NavGrid {
  let g = grids.get(world);
  if (!g) {
    g = new NavGrid(world);
    grids.set(world, g);
  }
  return g;
}
