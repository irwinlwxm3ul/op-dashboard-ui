// Multi-floor navigation inside buildings.
//
// The ground-level NavGrid covers terrain and every ground floor. Upper floors (and roofs reached
// by stairs) are separate per-building *levels*: small 0.5 m grids (stair landings and corridors
// are only ~1 m wide), one per slab height, rasterised like the ground grid with 0.25 m
// sub-samples: a sample is walkable when a slab of that level lies under it and nothing occupies
// the standing character's vertical span above it; a move between neighbouring cells is allowed
// when every sub-sample between the two centres is walkable. Stairwell holes have no slab, rails
// and walls are obstructions.
//
// Levels are connected by stair *runs* recovered from the building's step boxes (consecutive
// 'stairs' boxes on one base slab with rising tops). A run is a link from an entry point in front
// of its first step on the lower floor to an exit point just past its last step on the upper
// floor; walking straight along it is what the real character controller does on stairs. The run
// that starts on the ground floor links the levels to the ground grid through its first step (the
// ground grid already treats the lowest steps as walkable floor).
//
// Path planning across floors is hierarchical: a small Dijkstra over one building's levels and
// runs (a few hundred cells) produces the indoor part, the budgeted ground A* the rest.

import { STEP_HEIGHT } from '../constants';
import type { World, WorldBox } from '../types';
import type { NavGrid } from './nav';
import { DIR_DX, DIR_DZ, NF_BLOCKED, NF_NEAR } from './nav';
import { hyp } from './util';

/** Level index used for the ground floor (handled by the ground grid). */
export const GROUND = -1;

/** Level cell size (m) and sub-samples per cell side (0.25 m spacing). */
const CELL = 0.5;
const FINE = 2;
const CLEAR_LO = STEP_HEIGHT;
const CLEAR_HI = 1.75;
const BLOCK_INFLATE = 0.05;
const NEAR_INFLATE = 0.45;
const MIN_RASTER = CELL / FINE + 0.01;
/** Slab tops within this distance belong to the same level. */
const LEVEL_EPS = 0.08;
/** A stair run has at least this many step boxes (entrance treads have fewer and lie outside). */
const MIN_RUN_STEPS = 5;
/** Entry point distance in front of the first step / exit point past the last step (m). */
const ENTRY_BACK = 0.6;
const EXIT_AHEAD = 0.65;
/** A position counts as "on" a level when its feet are within this height above the slab. */
const ON_LEVEL_ABOVE = 2.6;
const ON_LEVEL_BELOW = 0.6;
const NEAR_PENALTY = 0.45;
const MAX_SEGMENT = 25;
const SMOOTH_CLEARANCE = 0.42;
const RELAX_RADIUS = 0.55;
/** Building index grid cell size (m). */
const BCELL = 32;

export interface StairRun {
  /** Level at the bottom (GROUND for the ground floor) and at the top. */
  bottomLevel: number;
  topLevel: number;
  /** Cell index within the bottom / top level grid (-1 for the ground grid). */
  bottomCell: number;
  topCell: number;
  /** Entry point on the lower floor, first step centre, last step centre, exit on the upper floor. */
  bx: number;
  bz: number;
  sx: number;
  sz: number;
  ex: number;
  ez: number;
  tx: number;
  tz: number;
  /** Walking length entry -> exit (m). */
  len: number;
}

export interface FloorLevel {
  /** Slab top height. */
  h: number;
  flags: Uint8Array;
  dirs: Uint8Array;
  /** Connected component per cell (-1 blocked). */
  comp: Int16Array;
  /** Per component: 1 when connected to the ground floor through stairs. */
  reach: Uint8Array;
}

/** Where a 3D position lies in a building's levels. */
export interface FloorLoc {
  building: number;
  level: number;
  cell: number;
}

// Rasterisation scratch (sized on demand, reused).
let fineFloor = new Float32Array(0);
let fineObs = new Uint8Array(0);
const boxBuf: WorldBox[] = [];
const tmpP = { x: 0, z: 0 };

/** Navigation data for one building's upper floors. */
export class BuildingNav {
  readonly bi: number;
  /** Level grid origin (world) and size in cells. */
  readonly ox: number;
  readonly oz: number;
  readonly W: number;
  readonly H: number;
  readonly levels: FloorLevel[] = [];
  readonly runs: StairRun[] = [];
  /** Ground-floor anchor of the stairs (first step of the run that starts on the ground floor). */
  groundX = 0;
  groundZ = 0;
  hasGround = false;
  private readonly grid: NavGrid;
  // Dijkstra scratch.
  private dist = new Float32Array(0);
  private prev = new Int32Array(0);
  private done = new Uint8Array(0);
  private heapN = new Int32Array(0);
  private heapF = new Float32Array(0);
  private heapSize = 0;
  private readonly seq: number[] = [];

  constructor(world: World, grid: NavGrid, bi: number) {
    this.bi = bi;
    this.grid = grid;
    const b = world.buildings[bi];
    this.ox = b.min.x - 1;
    this.oz = b.min.z - 1;
    this.W = Math.ceil((b.max.x - b.min.x + 2) / CELL);
    this.H = Math.ceil((b.max.z - b.min.z + 2) / CELL);
    this.build(world);
  }

  get cells(): number {
    return this.W * this.H;
  }

  /** Local cell index of a world position (-1 outside the grid). */
  cellAt(x: number, z: number): number {
    const i = Math.floor((x - this.ox) / CELL), j = Math.floor((z - this.oz) / CELL);
    return i < 0 || j < 0 || i >= this.W || j >= this.H ? -1 : j * this.W + i;
  }
  cellX(c: number): number {
    return this.ox + ((c % this.W) + 0.5) * CELL;
  }
  cellZ(c: number): number {
    return this.oz + (Math.floor(c / this.W) + 0.5) * CELL;
  }

  /** Is the cell walkable on that level? */
  free(level: number, c: number): boolean {
    return c >= 0 && (this.levels[level].flags[c] & NF_BLOCKED) === 0 && this.levels[level].dirs[c] !== 0;
  }

  /** Nearest walkable cell to (x, z) on a level within r cells (-1 if none). */
  nearestCell(level: number, x: number, z: number, r: number): number {
    const ci = Math.floor((x - this.ox) / CELL), cj = Math.floor((z - this.oz) / CELL);
    let best = -1, bestD = Infinity;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.W || j >= this.H) continue;
        const c = j * this.W + i;
        if (!this.free(level, c)) continue;
        const px = this.cellX(c) - x, pz = this.cellZ(c) - z;
        const d = px * px + pz * pz + (this.levels[level].flags[c] & NF_NEAR ? 0.3 : 0);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    return best;
  }

  /**
   * Locate a 3D position on this building's upper levels. Returns false for positions on (or near)
   * the ground floor and outside the grid.
   */
  locate(x: number, y: number, z: number, out: FloorLoc): boolean {
    if (this.levels.length === 0 || Number.isNaN(y)) return false;
    let lv = -1;
    for (let i = 0; i < this.levels.length; i++) {
      const h = this.levels[i].h;
      if (h <= y + ON_LEVEL_BELOW && y - h < ON_LEVEL_ABOVE) lv = i;
    }
    if (lv < 0) return false;
    let c = this.cellAt(x, z);
    if (c < 0 || !this.free(lv, c)) c = this.nearestCell(lv, x, z, 3);
    if (c < 0) return false;
    out.building = this.bi;
    out.level = lv;
    out.cell = c;
    return true;
  }

  /** Is a located position connected to the ground floor by stairs? */
  reachable(loc: FloorLoc): boolean {
    const L = this.levels[loc.level];
    const comp = L.comp[loc.cell];
    return comp >= 0 && L.reach[comp] === 1;
  }

  /**
   * Indoor route between two nodes (level/cell, or GROUND for the ground-floor stair entry).
   * Writes waypoints (x, z pairs) into out from index `at` (start position excluded; the final
   * point is (gx, gz) for a cell goal or the ground entry for GROUND). Returns the new point count
   * or -1 when unreachable / out of space.
   */
  route(
    fromLevel: number, fromCell: number, toLevel: number, toCell: number,
    sx: number, sz: number, gx: number, gz: number,
    out: Float32Array, at: number, maxPts: number,
  ): number {
    const N = this.cells, nL = this.levels.length;
    const G = nL * N;
    const start = fromLevel === GROUND ? G : fromLevel * N + fromCell;
    const goal = toLevel === GROUND ? G : toLevel * N + toCell;
    if (start === goal) {
      if (at >= maxPts) return -1;
      out[at * 2] = gx;
      out[at * 2 + 1] = gz;
      return at + 1;
    }
    if (!this.search(start, goal)) return -1;
    // Node sequence start -> goal.
    const seq = this.seq;
    seq.length = 0;
    for (let n = goal; n !== -1; n = this.prev[n]) seq.push(n);
    seq.reverse();
    let count = at;
    const push = (x: number, z: number): boolean => {
      if (count >= maxPts) return false;
      out[count * 2] = x;
      out[count * 2 + 1] = z;
      count++;
      return true;
    };
    let ax = fromLevel === GROUND ? this.groundX : sx;
    let az = fromLevel === GROUND ? this.groundZ : sz;
    let i = 0;
    while (i < seq.length) {
      const node = seq[i];
      const lv = node === G ? GROUND : Math.floor(node / N);
      let j = i;
      if (node !== G) {
        while (j + 1 < seq.length && seq[j + 1] !== G && Math.floor(seq[j + 1] / N) === lv) j++;
        const lastOfPath = j === seq.length - 1;
        let run: StairRun | null = null;
        let up = false;
        if (!lastOfPath) {
          run = this.linkFrom(seq[j], seq[j + 1]);
          if (!run) return -1;
          up = run.bottomLevel === lv;
        }
        // Same-level stretch i..j: smoothed walk from the anchor to the goal / stair entry.
        const termX = lastOfPath ? gx : up ? run!.bx : run!.tx;
        const termZ = lastOfPath ? gz : up ? run!.bz : run!.tz;
        if (!this.smoothStretch(lv, i, j, ax, az, termX, termZ, lastOfPath, push)) return -1;
        if (lastOfPath) break;
      } else if (j === seq.length - 1) {
        break;
      }
      // Stair link seq[j] -> seq[j + 1].
      const a = seq[j], b = seq[j + 1];
      const run = this.linkFrom(a, b);
      if (!run) return -1;
      const up = a === G || run.bottomLevel === Math.floor(a / N);
      // Coming from the ground grid the walker already stands on the first step.
      if (a === G ? !(push(run.ex, run.ez) && push(run.tx, run.tz)) : !this.pushRun(run, up, push)) return -1;
      ax = up ? run.tx : run.bx;
      az = up ? run.tz : run.bz;
      i = j + 1;
      if (b === G) break;
    }
    return count;
  }

  /** The stair run linking two Dijkstra nodes. */
  private linkFrom(a: number, b: number): StairRun | null {
    const N = this.cells, G = this.levels.length * N;
    const la = a === G ? GROUND : Math.floor(a / N), lb = b === G ? GROUND : Math.floor(b / N);
    return this.linkRun(la, a === G ? -1 : a - la * N, lb, b === G ? -1 : b - lb * N);
  }

  /** The stair run linking (la, ca) and (lb, cb) in either direction (GROUND uses cell -1). */
  private linkRun(la: number, ca: number, lb: number, cb: number): StairRun | null {
    for (const r of this.runs) {
      const bottomA = r.bottomLevel === la && (la === GROUND || r.bottomCell === ca);
      const topB = r.topLevel === lb && r.topCell === cb;
      if (bottomA && topB) return r;
      const topA = r.topLevel === la && r.topCell === ca;
      const bottomB = r.bottomLevel === lb && (lb === GROUND || r.bottomCell === cb);
      if (topA && bottomB) return r;
    }
    return null;
  }

  private pushRun(r: StairRun, up: boolean, push: (x: number, z: number) => boolean): boolean {
    if (up) return push(r.bx, r.bz) && push(r.sx, r.sz) && push(r.ex, r.ez) && push(r.tx, r.tz);
    return push(r.tx, r.tz) && push(r.ex, r.ez) && push(r.sx, r.sz) && push(r.bx, r.bz);
  }

  /**
   * Greedy string pulling over seq[i..j] on one level from anchor (ax, az) toward the terminal
   * point (the goal, or the stair entry / exit the stretch ends at). Emits intermediate waypoints
   * and, when `pushTerm`, the terminal point itself. Returns false when out of space.
   */
  private smoothStretch(
    lv: number, i: number, j: number, ax: number, az: number, termX: number, termZ: number, pushTerm: boolean,
    push: (x: number, z: number) => boolean,
  ): boolean {
    const N = this.cells;
    const seq = this.seq;
    const h = this.levels[lv].h;
    let anchorCell = seq[i] - lv * N;
    for (let k = i + 1; k <= j + 1; k++) {
      const isEnd = k > j;
      const px = isEnd ? termX : this.cellX(seq[k] - lv * N);
      const pz = isEnd ? termZ : this.cellZ(seq[k] - lv * N);
      if (hyp(px - ax, pz - az) <= MAX_SEGMENT && this.lineOfWalk(lv, ax, az, px, pz) &&
          this.grid.clearSegment(ax, az, px, pz, SMOOTH_CLEARANCE, h)) {
        continue;
      }
      let wc = seq[k - 1] - lv * N;
      if (wc === anchorCell) {
        if (isEnd) break;
        wc = seq[k] - lv * N;
      }
      tmpP.x = this.cellX(wc);
      tmpP.z = this.cellZ(wc);
      if (this.levels[lv].flags[wc] & NF_NEAR) this.relax(lv, tmpP);
      if (!push(tmpP.x, tmpP.z)) return false;
      ax = tmpP.x;
      az = tmpP.z;
      anchorCell = wc;
    }
    return pushTerm ? push(termX, termZ) : true;
  }

  /** Grid DDA on a level: every crossed cell boundary must be an allowed move. */
  lineOfWalk(lv: number, ax: number, az: number, bx: number, bz: number): boolean {
    const L = this.levels[lv];
    const u0 = (ax - this.ox) / CELL, v0 = (az - this.oz) / CELL;
    const u1 = (bx - this.ox) / CELL, v1 = (bz - this.oz) / CELL;
    let cx = Math.floor(u0), cz = Math.floor(v0);
    const ex = Math.floor(u1), ez = Math.floor(v1);
    const W = this.W, H = this.H;
    const inside = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < W && j < H;
    if (!inside(cx, cz) || L.flags[cz * W + cx] & NF_BLOCKED) return false;
    if (cx === ex && cz === ez) return true;
    const du = u1 - u0, dv = v1 - v0;
    const sx = du > 0 ? 1 : du < 0 ? -1 : 0;
    const sz = dv > 0 ? 1 : dv < 0 ? -1 : 0;
    const tdx = sx !== 0 ? Math.abs(1 / du) : Infinity;
    const tdz = sz !== 0 ? Math.abs(1 / dv) : Infinity;
    let tmx = sx > 0 ? (cx + 1 - u0) * tdx : sx < 0 ? (u0 - cx) * tdx : Infinity;
    let tmz = sz > 0 ? (cz + 1 - v0) * tdz : sz < 0 ? (v0 - cz) * tdz : Infinity;
    let guard = Math.abs(ex - cx) + Math.abs(ez - cz) + 2;
    while (guard-- > 0) {
      const m = L.dirs[cz * W + cx];
      let dir: number;
      if (Math.abs(tmx - tmz) < 1e-9) {
        dir = sx > 0 ? (sz > 0 ? 1 : 7) : sz > 0 ? 3 : 5;
        cx += sx;
        cz += sz;
        tmx += tdx;
        tmz += tdz;
      } else if (tmx < tmz) {
        dir = sx > 0 ? 0 : 4;
        cx += sx;
        tmx += tdx;
      } else {
        dir = sz > 0 ? 2 : 6;
        cz += sz;
        tmz += tdz;
      }
      if (!(m & (1 << dir)) || !inside(cx, cz)) return false;
      if (cx === ex && cz === ez) return true;
      if (L.flags[cz * W + cx] & NF_NEAR) return false;
    }
    return true;
  }

  /** Push a waypoint away from walls / rails of its level (doorways end up centred). */
  private relax(lv: number, p: { x: number; z: number }): void {
    const h = this.levels[lv].h;
    const lo = h + CLEAR_LO, hi = h + CLEAR_HI;
    const R = RELAX_RADIUS + 0.2;
    boxBuf.length = 0;
    const boxes = this.grid.world.queryBoxes(p.x - R, p.z - R, p.x + R, p.z + R, boxBuf);
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
        px += (dx / d) * (RELAX_RADIUS - d);
        pz += (dz / d) * (RELAX_RADIUS - d);
      }
      if (px === 0 && pz === 0) break;
      x += px * 0.5;
      z += pz * 0.5;
    }
    const mx = x - p.x, mz = z - p.z;
    const m = hyp(mx, mz);
    if (m < 1e-4) return;
    const s = m > 0.6 ? 0.6 / m : 1;
    const nx = p.x + mx * s, nz = p.z + mz * s;
    if (this.lineOfWalk(lv, p.x, p.z, nx, nz)) {
      p.x = nx;
      p.z = nz;
    }
  }

  // -------------------------------------------------------------------------
  // Dijkstra over level cells + the ground entry node
  // -------------------------------------------------------------------------

  private search(start: number, goal: number): boolean {
    const N = this.cells, nL = this.levels.length;
    const total = nL * N + 1;
    const G = nL * N;
    if (this.dist.length < total) {
      this.dist = new Float32Array(total);
      this.prev = new Int32Array(total);
      this.done = new Uint8Array(total);
      this.heapN = new Int32Array(total * 8 + 16);
      this.heapF = new Float32Array(total * 8 + 16);
    }
    this.dist.fill(Infinity, 0, total);
    this.done.fill(0, 0, total);
    this.prev[start] = -1;
    this.dist[start] = 0;
    this.heapSize = 0;
    this.push(start, 0);
    const W = this.W, H = this.H;
    while (this.heapSize > 0) {
      const node = this.heapN[0];
      this.pop();
      if (this.done[node]) continue;
      this.done[node] = 1;
      if (node === goal) return true;
      const d0 = this.dist[node];
      if (node === G) {
        for (const r of this.runs) {
          if (r.bottomLevel === GROUND && r.topCell >= 0) this.relaxEdge(node, r.topLevel * N + r.topCell, d0 + r.len + 1);
        }
        continue;
      }
      const lv = Math.floor(node / N), c = node - lv * N;
      const L = this.levels[lv];
      const m = L.dirs[c];
      const pen = L.flags[c] & NF_NEAR ? NEAR_PENALTY : 0;
      const ci = c % W, cj = Math.floor(c / W);
      for (let k = 0; k < 8; k++) {
        if (!(m & (1 << k))) continue;
        const ni = ci + DIR_DX[k], nj = cj + DIR_DZ[k];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        this.relaxEdge(node, lv * N + nj * W + ni, d0 + (k & 1 ? Math.SQRT2 * CELL : CELL) + pen * CELL);
      }
      for (const r of this.runs) {
        if (r.bottomLevel === lv && r.bottomCell === c && r.topCell >= 0) this.relaxEdge(node, r.topLevel * N + r.topCell, d0 + r.len + 1);
        if (r.topLevel === lv && r.topCell === c) {
          if (r.bottomLevel === GROUND) this.relaxEdge(node, G, d0 + r.len + 1);
          else if (r.bottomCell >= 0) this.relaxEdge(node, r.bottomLevel * N + r.bottomCell, d0 + r.len + 1);
        }
      }
    }
    return false;
  }

  private relaxEdge(from: number, to: number, d: number): void {
    if (this.done[to] || d >= this.dist[to]) return;
    this.dist[to] = d;
    this.prev[to] = from;
    this.push(to, d);
  }

  private push(node: number, f: number): void {
    if (this.heapSize >= this.heapN.length) return;
    let i = this.heapSize++;
    const hn = this.heapN, hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hn[i] = hn[p];
      hf[i] = hf[p];
      i = p;
    }
    hn[i] = node;
    hf[i] = f;
  }

  private pop(): void {
    const hn = this.heapN, hf = this.heapF;
    const n = --this.heapSize;
    if (n <= 0) return;
    const node = hn[n], f = hf[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && hf[c + 1] < hf[c]) c++;
      if (hf[c] >= f) break;
      hn[i] = hn[c];
      hf[i] = hf[c];
      i = c;
    }
    hn[i] = node;
    hf[i] = f;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private build(world: World): void {
    const bd = world.buildings[this.bi];
    // Ground-floor slab top (lowest 'floor' box of the building).
    let groundY = Infinity;
    for (const id of bd.boxIds) {
      const b = world.boxes[id];
      if (b.kind === 'floor' && b.max.y < groundY) groundY = b.max.y;
    }
    if (!Number.isFinite(groundY)) return;

    // Stair runs: interior step boxes grouped by their base slab.
    const groups = new Map<number, WorldBox[]>();
    for (const id of bd.boxIds) {
      const b = world.boxes[id];
      if (b.kind !== 'stairs') continue;
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      if (cx <= bd.min.x + 0.2 || cx >= bd.max.x - 0.2 || cz <= bd.min.z + 0.2 || cz >= bd.max.z - 0.2) continue;
      const key = Math.round(b.min.y * 100);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(b);
    }
    interface RawRun { base: number; top: number; first: WorldBox; last: WorldBox; dx: number; dz: number; }
    const raw: RawRun[] = [];
    for (const g of groups.values()) {
      if (g.length < MIN_RUN_STEPS) continue;
      g.sort((a, b) => a.max.y - b.max.y);
      const first = g[0], last = g[g.length - 1];
      const fx = (first.min.x + first.max.x) / 2, fz = (first.min.z + first.max.z) / 2;
      const lx = (last.min.x + last.max.x) / 2, lz = (last.min.z + last.max.z) / 2;
      let dx = lx - fx, dz = lz - fz;
      const l = hyp(dx, dz);
      if (l < 1) continue;
      dx /= l;
      dz /= l;
      const rise = (last.max.y - first.max.y) / (g.length - 1);
      raw.push({ base: first.min.y, top: last.max.y + rise, first, last, dx, dz });
    }
    if (raw.length === 0) return;

    // Levels: every slab height a run starts or ends on (above the ground floor).
    const heights: number[] = [];
    const addH = (h: number): void => {
      if (h < groundY + 1) return;
      for (const e of heights) if (Math.abs(e - h) < LEVEL_EPS) return;
      heights.push(h);
    };
    for (const r of raw) {
      addH(r.base);
      addH(r.top);
    }
    heights.sort((a, b) => a - b);
    // Snap level heights to the actual slab tops.
    for (let i = 0; i < heights.length; i++) {
      let best = heights[i], bestD = 0.25;
      for (const id of bd.boxIds) {
        const b = world.boxes[id];
        if ((b.kind === 'floor' || b.kind === 'roof') && Math.abs(b.max.y - heights[i]) < bestD) {
          bestD = Math.abs(b.max.y - heights[i]);
          best = b.max.y;
        }
      }
      heights[i] = best;
    }
    for (const h of heights) this.levels.push(this.rasterLevel(world, h));

    const levelOf = (h: number): number => {
      if (Math.abs(h - groundY) < 0.2) return GROUND;
      for (let i = 0; i < this.levels.length; i++) if (Math.abs(this.levels[i].h - h) < 0.2) return i;
      return -2;
    };
    for (const r of raw) {
      const bottomLevel = levelOf(r.base), topLevel = levelOf(r.top);
      if (bottomLevel === -2 || topLevel < 0) continue;
      const sx = (r.first.min.x + r.first.max.x) / 2, sz = (r.first.min.z + r.first.max.z) / 2;
      const ex = (r.last.min.x + r.last.max.x) / 2, ez = (r.last.min.z + r.last.max.z) / 2;
      const halfRun = Math.abs(r.dx) > 0.5 ? (r.first.max.x - r.first.min.x) / 2 : (r.first.max.z - r.first.min.z) / 2;
      const bx = sx - r.dx * (halfRun + ENTRY_BACK), bz = sz - r.dz * (halfRun + ENTRY_BACK);
      const tx = ex + r.dx * (halfRun + EXIT_AHEAD), tz = ez + r.dz * (halfRun + EXIT_AHEAD);
      const run: StairRun = {
        bottomLevel, topLevel, bottomCell: -1, topCell: -1, bx, bz, sx, sz, ex, ez, tx, tz,
        len: hyp(tx - bx, tz - bz),
      };
      if (bottomLevel !== GROUND) {
        const c = this.cellAt(bx, bz);
        run.bottomCell = c >= 0 && this.free(bottomLevel, c) ? c : this.nearestCell(bottomLevel, bx, bz, 1);
        if (run.bottomCell < 0) continue;
      } else {
        this.groundX = sx;
        this.groundZ = sz;
        this.hasGround = true;
      }
      const c = this.cellAt(tx, tz);
      run.topCell = c >= 0 && this.free(topLevel, c) ? c : this.nearestCell(topLevel, tx, tz, 1);
      if (run.topCell < 0) continue;
      this.runs.push(run);
    }
    this.computeComponents();
  }

  /** Level grid for the slab height h. */
  private rasterLevel(world: World, h: number): FloorLevel {
    const W = this.W, H = this.H, FW = W * FINE, FH = H * FINE;
    const SP = CELL / FINE; // sub-sample spacing; sample i sits at origin + (i + 0.5) * SP
    if (fineFloor.length < FW * FH) {
      fineFloor = new Float32Array(FW * FH);
      fineObs = new Uint8Array(FW * FH);
    }
    fineFloor.fill(NaN, 0, FW * FH);
    fineObs.fill(0, 0, FW * FH);
    const wx0 = this.ox, wz0 = this.oz;
    // Sample index range covering [a, b] (sample positions wx0 + (i + 0.5) * SP).
    const lo = (a: number, o: number): number => Math.max(0, Math.ceil((a - o) / SP - 0.5));
    const hiI = (b: number, o: number, n: number): number => Math.min(n - 1, Math.floor((b - o) / SP - 0.5));
    boxBuf.length = 0;
    const boxes = world.queryBoxes(wx0 - 1, wz0 - 1, wx0 + W * CELL + 1, wz0 + H * CELL + 1, boxBuf);
    // Slabs of this level.
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (Math.abs(b.max.y - h) > LEVEL_EPS || b.max.y - b.min.y > 1.0) continue;
      const fi0 = lo(b.min.x, wx0), fi1 = hiI(b.max.x, wx0, FW);
      const fj0 = lo(b.min.z, wz0), fj1 = hiI(b.max.z, wz0, FH);
      for (let fj = fj0; fj <= fj1; fj++) for (let fi = fi0; fi <= fi1; fi++) fineFloor[fj * FW + fi] = h;
    }
    // Obstructions in the standing span above it.
    const yLo = h + CLEAR_LO, yHi = h + CLEAR_HI;
    const flags = new Uint8Array(W * H);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.min.y >= yHi || b.max.y <= yLo) continue;
      const ix = Math.max(BLOCK_INFLATE, (MIN_RASTER - (b.max.x - b.min.x)) / 2);
      const iz = Math.max(BLOCK_INFLATE, (MIN_RASTER - (b.max.z - b.min.z)) / 2);
      const fi0 = lo(b.min.x - ix, wx0), fi1 = hiI(b.max.x + ix, wx0, FW);
      const fj0 = lo(b.min.z - iz, wz0), fj1 = hiI(b.max.z + iz, wz0, FH);
      for (let fj = fj0; fj <= fj1; fj++) for (let fi = fi0; fi <= fi1; fi++) fineObs[fj * FW + fi] = 1;
      // NEAR: cell centres within NEAR_INFLATE of the box.
      const ci0 = Math.max(0, Math.floor((b.min.x - NEAR_INFLATE - wx0) / CELL)), ci1 = Math.min(W - 1, Math.floor((b.max.x + NEAR_INFLATE - wx0) / CELL));
      const cj0 = Math.max(0, Math.floor((b.min.z - NEAR_INFLATE - wz0) / CELL)), cj1 = Math.min(H - 1, Math.floor((b.max.z + NEAR_INFLATE - wz0) / CELL));
      for (let cj = cj0; cj <= cj1; cj++) {
        const cz = wz0 + (cj + 0.5) * CELL;
        if (cz < b.min.z - NEAR_INFLATE || cz > b.max.z + NEAR_INFLATE) continue;
        for (let ci = ci0; ci <= ci1; ci++) {
          const cx = wx0 + (ci + 0.5) * CELL;
          if (cx >= b.min.x - NEAR_INFLATE && cx <= b.max.x + NEAR_INFLATE) flags[cj * W + ci] |= NF_NEAR;
        }
      }
    }
    const ok = (o: number): boolean => !Number.isNaN(fineFloor[o]) && fineObs[o] === 0;
    // A cell is walkable when its 2 x 2 central sub-samples are; slab edges (holes) next to it
    // make it NEAR (paths keep away from drops).
    const cellOk = (ci: number, cj: number): boolean => {
      const o = cj * FINE * FW + ci * FINE;
      return ok(o) && ok(o + 1) && ok(o + FW) && ok(o + FW + 1);
    };
    for (let cj = 0; cj < H; cj++) {
      for (let ci = 0; ci < W; ci++) {
        if (!cellOk(ci, cj)) {
          flags[cj * W + ci] |= NF_BLOCKED;
          continue;
        }
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = ci + di, nj = cj + dj;
            if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
            const o = nj * FINE * FW + ni * FINE;
            if (Number.isNaN(fineFloor[o]) || Number.isNaN(fineFloor[o + FW + 1])) flags[cj * W + ci] |= NF_NEAR;
          }
        }
      }
    }
    // Moves between neighbouring walkable cells: both cells' samples cover the strip between the
    // centres, so the move is open when both cells are walkable.
    const openE = new Uint8Array(W * H), openS = new Uint8Array(W * H);
    for (let cj = 0; cj < H; cj++) {
      for (let ci = 0; ci < W; ci++) {
        const k = cj * W + ci;
        if (flags[k] & NF_BLOCKED) continue;
        if (ci < W - 1 && !(flags[k + 1] & NF_BLOCKED)) openE[k] = 1;
        if (cj < H - 1 && !(flags[k + W] & NF_BLOCKED)) openS[k] = 1;
      }
    }
    const dirs = new Uint8Array(W * H);
    for (let cj = 0; cj < H; cj++) {
      for (let ci = 0; ci < W; ci++) {
        const k = cj * W + ci;
        if (flags[k] & NF_BLOCKED) continue;
        const oE = ci < W - 1 && openE[k] === 1;
        const oW = ci > 0 && openE[k - 1] === 1;
        const oS = cj < H - 1 && openS[k] === 1;
        const oN = cj > 0 && openS[k - W] === 1;
        let m = 0;
        if (oE) m |= 1;
        if (oS) m |= 1 << 2;
        if (oW) m |= 1 << 4;
        if (oN) m |= 1 << 6;
        if (oE && oS && openS[k + 1] && openE[k + W]) m |= 1 << 1;
        if (oW && oS && openS[k - 1] && openE[k + W - 1]) m |= 1 << 3;
        if (oW && oN && openS[k - W - 1] && openE[k - W - 1]) m |= 1 << 5;
        if (oE && oN && openS[k - W + 1] && openE[k - W]) m |= 1 << 7;
        dirs[k] = m;
      }
    }
    return { h, flags, dirs, comp: new Int16Array(W * H).fill(-1), reach: new Uint8Array(0) };
  }

  /** Flood-fill components per level and mark those connected to the ground by stairs. */
  private computeComponents(): void {
    const W = this.W, H = this.H, N = W * H;
    const stack: number[] = [];
    const counts: number[] = [];
    for (const L of this.levels) {
      let next = 0;
      for (let c = 0; c < N; c++) {
        if (L.comp[c] >= 0 || L.dirs[c] === 0) continue;
        L.comp[c] = next;
        stack.length = 0;
        stack.push(c);
        while (stack.length) {
          const k = stack.pop() as number;
          const m = L.dirs[k];
          const ci = k % W, cj = Math.floor(k / W);
          for (let d = 0; d < 8; d++) {
            if (!(m & (1 << d))) continue;
            const ni = ci + DIR_DX[d], nj = cj + DIR_DZ[d];
            if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
            const nk = nj * W + ni;
            if (L.comp[nk] >= 0) continue;
            L.comp[nk] = next;
            stack.push(nk);
          }
        }
        next++;
      }
      counts.push(next);
      L.reach = new Uint8Array(Math.max(1, next));
    }
    // Propagate reachability from the ground through the runs (fixed point, few runs).
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of this.runs) {
        const topC = this.levels[r.topLevel].comp[r.topCell];
        if (topC < 0) continue;
        const bottomReach = r.bottomLevel === GROUND ? true : (() => {
          const bc = this.levels[r.bottomLevel].comp[r.bottomCell];
          return bc >= 0 && this.levels[r.bottomLevel].reach[bc] === 1;
        })();
        const topReach = this.levels[r.topLevel].reach[topC] === 1;
        if (bottomReach && !topReach) {
          this.levels[r.topLevel].reach[topC] = 1;
          changed = true;
        } else if (topReach && r.bottomLevel !== GROUND) {
          const bc = this.levels[r.bottomLevel].comp[r.bottomCell];
          if (bc >= 0 && this.levels[r.bottomLevel].reach[bc] !== 1) {
            this.levels[r.bottomLevel].reach[bc] = 1;
            changed = true;
          }
        }
      }
    }
  }
}

/** Lazily built BuildingNavs for one world plus a building lookup grid. */
export class FloorNav {
  readonly world: World;
  readonly grid: NavGrid;
  private readonly navs: (BuildingNav | null | undefined)[];
  private readonly cellsPerSide: number;
  private readonly head: Int32Array;
  private readonly next: Int32Array;
  private readonly items: Int32Array;
  /** Building navs that may still be built this tick by non-forcing lookups. */
  buildBudget = 1;
  built = 0;

  constructor(world: World, grid: NavGrid) {
    this.world = world;
    this.grid = grid;
    const nb = world.buildings.length;
    this.navs = new Array<BuildingNav | null | undefined>(nb).fill(undefined);
    // Building index grid: each building is listed in every cell its footprint touches.
    const n = Math.max(1, Math.ceil(world.size / BCELL));
    this.cellsPerSide = n;
    this.head = new Int32Array(n * n).fill(-1);
    const nexts: number[] = [], items: number[] = [];
    for (let bi = 0; bi < nb; bi++) {
      const b = world.buildings[bi];
      const x0 = this.bcell(b.min.x), x1 = this.bcell(b.max.x), z0 = this.bcell(b.min.z), z1 = this.bcell(b.max.z);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cz * n + cx;
          items.push(bi);
          nexts.push(this.head[c]);
          this.head[c] = items.length - 1;
        }
      }
    }
    this.next = Int32Array.from(nexts);
    this.items = Int32Array.from(items);
  }

  private bcell(v: number): number {
    return Math.min(this.cellsPerSide - 1, Math.max(0, Math.floor((v + this.world.half) / BCELL)));
  }

  /** Building whose footprint contains (x, z), or -1. */
  buildingAt(x: number, z: number): number {
    const c = this.bcell(z) * this.cellsPerSide + this.bcell(x);
    for (let k = this.head[c]; k >= 0; k = this.next[k]) {
      const bi = this.items[k];
      const b = this.world.buildings[bi];
      if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) return bi;
    }
    return -1;
  }

  /**
   * Nav for building bi: null when it has no stairs. Without `force`, construction respects the
   * per-tick build budget and undefined is returned while pending.
   */
  get(bi: number, force: boolean): BuildingNav | null | undefined {
    const cur = this.navs[bi];
    if (cur !== undefined) return cur;
    if (!force && this.buildBudget <= 0) return undefined;
    this.buildBudget--;
    const nav = new BuildingNav(this.world, this.grid, bi);
    const res = nav.levels.length > 0 && nav.runs.length > 0 ? nav : null;
    this.navs[bi] = res;
    this.built++;
    return res;
  }

  /**
   * Locate a 3D position on some building's upper level. Returns the BuildingNav (with `out`
   * filled) or null for ground-floor / outdoor positions and buildings without stairs.
   */
  locate(x: number, y: number, z: number, out: FloorLoc, force: boolean): BuildingNav | null | undefined {
    if (Number.isNaN(y)) return null;
    const bi = this.buildingAt(x, z);
    if (bi < 0) return null;
    // Cheap reject: feet on (or just above) the ground floor.
    if (y - this.world.heightAt(x, z) < 1.8) return null;
    const nav = this.get(bi, force);
    if (!nav) return nav;
    return nav.locate(x, y, z, out) ? nav : null;
  }
}

const floorNavs = new WeakMap<World, FloorNav>();
/** Shared FloorNav per world. */
export function floorNavFor(world: World, grid: NavGrid): FloorNav {
  let f = floorNavs.get(world);
  if (!f) {
    f = new FloorNav(world, grid);
    floorNavs.set(world, f);
  }
  return f;
}
