// Budgeted A* over the bot nav grid.
//
// One search runs at a time inside a fixed 256 x 256 cell window (allocated once). Requests are
// queued; each tick the driver hands the planner a node-expansion budget, so a long search simply
// continues on the next tick and the per-tick cost stays bounded no matter how many bots repath.
// Finished paths are string-pulled with grid line-of-walk checks, waypoints next to walls are
// relaxed toward the middle of doorways, and results are cached by (goal cell, coarse start) so
// squadmates heading for the same spot reuse one search.

import { NavGrid, NF_BLOCKED, NF_NEAR, DIR_DX, DIR_DZ } from './nav';

export const PATH_IDLE = 0;
export const PATH_QUEUED = 1;
export const PATH_RUNNING = 2;
export const PATH_DONE = 3;
export const PATH_FAILED = 4;

/** Max waypoints stored per path. */
export const MAX_PATH_POINTS = 96;
/** Destinations farther than this are clamped (callers plan long trips in legs). */
export const MAX_PLAN_DIST = 110;

const WIN = 256;
const WIN_SHIFT = 8;
const WIN_CELLS = WIN * WIN;
const HEAP_CAP = WIN_CELLS * 2;
/** Expansion cap per search (beyond this the best partial path is returned). */
const MAX_EXPANSIONS = 24000;
/** Weighted A*: slightly greedy for speed, paths stay near optimal. */
const HEURISTIC_W = 1.15;
const NEAR_PENALTY = 0.45;
const SQRT2 = Math.SQRT2;
const STEP_COST: readonly number[] = [1, SQRT2, 1, SQRT2, 1, SQRT2, 1, SQRT2];
/** Max straight segment length produced by smoothing (bounds smoothing cost). */
const MAX_SEGMENT = 40;
const CACHE_SIZE = 128;
const CACHE_TTL_TICKS = 30 * 30;

export interface PathRequest {
  status: number;
  sx: number;
  sz: number;
  gx: number;
  gz: number;
  /** Waypoints as x,z pairs (start position excluded, final point = destination). */
  pts: Float32Array;
  count: number;
  /** True when the destination could not be reached and the path ends as close as possible. */
  partial: boolean;
}

export function newPathRequest(): PathRequest {
  return { status: PATH_IDLE, sx: 0, sz: 0, gx: 0, gz: 0, pts: new Float32Array(MAX_PATH_POINTS * 2), count: 0, partial: false };
}

interface CacheEntry {
  pts: Float32Array;
  count: number;
  partial: boolean;
  tick: number;
}

const tmpP = { x: 0, z: 0 };

export class PathPlanner {
  readonly grid: NavGrid;
  private readonly queue: PathRequest[] = [];
  private active: PathRequest | null = null;
  // Search window state.
  private readonly g = new Float32Array(WIN_CELLS);
  private readonly parent = new Int32Array(WIN_CELLS);
  private readonly visit = new Uint32Array(WIN_CELLS);
  private readonly closed = new Uint32Array(WIN_CELLS);
  private readonly heapNode = new Int32Array(HEAP_CAP);
  private readonly heapF = new Float32Array(HEAP_CAP);
  private heapSize = 0;
  private sid = 0;
  private wx0 = 0;
  private wz0 = 0;
  private startNode = 0;
  private goalNode = 0;
  private goalLX = 0;
  private goalLZ = 0;
  private startX = 0;
  private startZ = 0;
  private goalX = 0;
  private goalZ = 0;
  private bestNode = 0;
  private bestH = Infinity;
  private startH = 0;
  private expansions = 0;
  private cacheKey = 0;
  private readonly cellBuf = new Int32Array(WIN_CELLS);
  private readonly cache = new Map<number, CacheEntry>();
  private tick = 0;
  /** Stats for tests/telemetry. */
  searches = 0;
  cacheHits = 0;

  constructor(grid: NavGrid) {
    this.grid = grid;
  }

  /** (Re)queue a request for a path from (sx, sz) to (gx, gz). */
  request(req: PathRequest, sx: number, sz: number, gx: number, gz: number): void {
    this.cancel(req);
    req.sx = sx;
    req.sz = sz;
    req.gx = gx;
    req.gz = gz;
    req.count = 0;
    req.partial = false;
    req.status = PATH_QUEUED;
    this.queue.push(req);
  }

  /** Drop a pending/running request (its status becomes idle). */
  cancel(req: PathRequest): void {
    if (this.active === req) this.active = null;
    const i = this.queue.indexOf(req);
    if (i >= 0) this.queue.splice(i, 1);
    if (req.status === PATH_QUEUED || req.status === PATH_RUNNING) req.status = PATH_IDLE;
  }

  pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /** Spend up to `budget` node expansions on queued searches. */
  step(budget: number): void {
    this.tick++;
    let guard = 64;
    while (budget > 0 && guard-- > 0) {
      if (!this.active) {
        const next = this.queue.shift();
        if (!next) return;
        budget -= 20;
        if (!this.begin(next)) continue;
      }
      const used = this.run(budget);
      if (used < 0) return; // waiting for tile generation budget
      budget -= used;
    }
  }

  /**
   * Synchronous path search (tests / tools): runs to completion ignoring tick budgets.
   * Returns the request status (PATH_DONE or PATH_FAILED).
   */
  findPathNow(req: PathRequest, sx: number, sz: number, gx: number, gz: number): number {
    this.cancel(req);
    req.sx = sx;
    req.sz = sz;
    req.gx = gx;
    req.gz = gz;
    req.count = 0;
    req.partial = false;
    const saved = this.active;
    this.active = null;
    if (this.begin(req)) {
      const genSaved = this.grid.genBudget;
      while (this.active === req) {
        this.grid.genBudget = 1 << 20;
        this.run(1 << 20);
      }
      this.grid.genBudget = genSaved;
    }
    this.active = saved;
    return req.status;
  }

  // -------------------------------------------------------------------------

  private begin(req: PathRequest): boolean {
    const grid = this.grid;
    req.status = PATH_RUNNING;
    // Start: nearest free cell if standing in a blocked one (e.g. hugging a wall).
    let sx = req.sx, sz = req.sz;
    const sf = grid.flagsAt(sx, sz);
    if (sf & NF_BLOCKED || grid.dirs(grid.cell(sx), grid.cell(sz)) === 0) {
      if (!grid.nearestFree(sx, sz, 4, tmpP)) return this.fail(req);
      sx = tmpP.x;
      sz = tmpP.z;
    }
    // Goal: clamp very long trips, then nearest free cell.
    let gx = req.gx, gz = req.gz;
    const dx = gx - sx, dz = gz - sz;
    const d = Math.hypot(dx, dz);
    if (d > MAX_PLAN_DIST) {
      gx = sx + (dx / d) * MAX_PLAN_DIST;
      gz = sz + (dz / d) * MAX_PLAN_DIST;
      req.partial = true;
    }
    const gf = grid.flagsAt(gx, gz);
    if (gf & NF_BLOCKED || grid.dirs(grid.cell(gx), grid.cell(gz)) === 0) {
      if (!grid.nearestFree(gx, gz, 8, tmpP)) return this.fail(req);
      gx = tmpP.x;
      gz = tmpP.z;
    }
    const sgx = grid.cell(sx), sgz = grid.cell(sz), ggx = grid.cell(gx), ggz = grid.cell(gz);
    this.startX = sx;
    this.startZ = sz;
    this.goalX = gx;
    this.goalZ = gz;
    // Cache lookup (goal cell + 4 m start bucket).
    this.cacheKey = (ggz * grid.cells + ggx) * 65536 + ((sgz >> 2) & 255) * 256 + ((sgx >> 2) & 255);
    const hit = this.cache.get(this.cacheKey);
    if (hit && this.tick - hit.tick < CACHE_TTL_TICKS && hit.count > 0 &&
        grid.lineOfWalk(req.sx, req.sz, hit.pts[0], hit.pts[1], false, true)) {
      req.pts.set(hit.pts.subarray(0, hit.count * 2));
      req.count = hit.count;
      req.partial = req.partial || hit.partial;
      req.status = PATH_DONE;
      this.cacheHits++;
      return false;
    }
    if (sgx === ggx && sgz === ggz) {
      req.pts[0] = gx;
      req.pts[1] = gz;
      req.count = 1;
      req.status = PATH_DONE;
      return false;
    }
    // Window centred between start and goal.
    this.wx0 = ((sgx + ggx) >> 1) - (WIN >> 1);
    this.wz0 = ((sgz + ggz) >> 1) - (WIN >> 1);
    const slx = sgx - this.wx0, slz = sgz - this.wz0;
    this.goalLX = ggx - this.wx0;
    this.goalLZ = ggz - this.wz0;
    this.sid = (this.sid + 1) >>> 0 || 1;
    this.heapSize = 0;
    this.expansions = 0;
    this.startNode = (slz << WIN_SHIFT) | slx;
    this.goalNode = (this.goalLZ << WIN_SHIFT) | this.goalLX;
    this.g[this.startNode] = 0;
    this.parent[this.startNode] = -1;
    this.visit[this.startNode] = this.sid;
    this.startH = this.octile(slx, slz);
    this.bestH = this.startH;
    this.bestNode = this.startNode;
    this.push(this.startNode, this.startH * HEURISTIC_W);
    this.active = req;
    this.searches++;
    return true;
  }

  private fail(req: PathRequest): boolean {
    req.status = PATH_FAILED;
    req.count = 0;
    if (this.active === req) this.active = null;
    return false;
  }

  private octile(lx: number, lz: number): number {
    const dx = Math.abs(lx - this.goalLX), dz = Math.abs(lz - this.goalLZ);
    return dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx;
  }

  /** Returns expansions used, or -1 when waiting for tile generation. */
  private run(budget: number): number {
    const req = this.active as PathRequest;
    const grid = this.grid;
    const sid = this.sid;
    let used = 0;
    while (used < budget) {
      if (this.heapSize === 0 || this.expansions >= MAX_EXPANSIONS) {
        this.finish(req, false);
        return used;
      }
      const node = this.heapNode[0];
      if (this.closed[node] === sid) {
        this.pop();
        continue;
      }
      const lx = node & (WIN - 1), lz = node >> WIN_SHIFT;
      const cgx = this.wx0 + lx, cgz = this.wz0 + lz;
      const m = grid.dirs(cgx, cgz, false);
      if (m === -1) return used > 0 ? used : -1;
      this.pop();
      this.closed[node] = sid;
      used++;
      this.expansions++;
      if (node === this.goalNode) {
        this.finish(req, true);
        return used;
      }
      const h = this.octile(lx, lz);
      if (h < this.bestH) {
        this.bestH = h;
        this.bestNode = node;
      }
      if (m === 0) continue;
      const pen = grid.flags(cgx, cgz, false) & NF_NEAR ? NEAR_PENALTY : 0;
      const g0 = this.g[node];
      for (let k = 0; k < 8; k++) {
        if (!(m & (1 << k))) continue;
        const nx = lx + DIR_DX[k], nz = lz + DIR_DZ[k];
        if (nx < 0 || nz < 0 || nx >= WIN || nz >= WIN) continue;
        const ni = (nz << WIN_SHIFT) | nx;
        if (this.closed[ni] === sid) continue;
        const ng = g0 + STEP_COST[k] + pen;
        if (this.visit[ni] !== sid || ng < this.g[ni]) {
          this.visit[ni] = sid;
          this.g[ni] = ng;
          this.parent[ni] = node;
          if (!this.push(ni, ng + this.octile(nx, nz) * HEURISTIC_W)) {
            this.finish(req, false);
            return used;
          }
        }
      }
    }
    return used;
  }

  private finish(req: PathRequest, reached: boolean): void {
    this.active = null;
    let end = this.goalNode;
    if (!reached) {
      // Partial path toward the closest point reached, if it is meaningfully closer.
      if (this.bestH > this.startH - 4) {
        req.status = PATH_FAILED;
        req.count = 0;
        return;
      }
      end = this.bestNode;
      req.partial = true;
    }
    // Collect cells start -> end.
    let n = 0;
    for (let c = end; c !== -1 && n < WIN_CELLS; c = this.parent[c]) this.cellBuf[n++] = c;
    // Reverse in place.
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const t = this.cellBuf[i];
      this.cellBuf[i] = this.cellBuf[j];
      this.cellBuf[j] = t;
    }
    const grid = this.grid;
    const out = req.pts;
    let count = 0;
    let ax = this.startX, az = this.startZ;
    const endX = reached ? this.goalX : this.cx(this.cellBuf[n - 1]);
    const endZ = reached ? this.goalZ : this.cz(this.cellBuf[n - 1]);
    let anchorCell = this.cellBuf[0];
    for (let k = 1; k < n && count < MAX_PATH_POINTS - 1; k++) {
      const last = k === n - 1;
      const px = last ? endX : this.cx(this.cellBuf[k]);
      const pz = last ? endZ : this.cz(this.cellBuf[k]);
      const seg = Math.hypot(px - ax, pz - az);
      if (seg <= MAX_SEGMENT && grid.lineOfWalk(ax, az, px, pz, true, true)) continue;
      // Emit the previous cell as a waypoint. If that is the anchor itself (the anchor sits off the
      // cell centre after relaxing), emit this cell instead: the A* step between them is valid.
      let wc = this.cellBuf[k - 1];
      if (wc === anchorCell) {
        if (last) break;
        wc = this.cellBuf[k];
      }
      tmpP.x = this.cx(wc);
      tmpP.z = this.cz(wc);
      if (grid.flagsAt(tmpP.x, tmpP.z) & NF_NEAR) grid.relaxPoint(tmpP);
      out[count * 2] = tmpP.x;
      out[count * 2 + 1] = tmpP.z;
      count++;
      ax = tmpP.x;
      az = tmpP.z;
      anchorCell = wc;
    }
    out[count * 2] = endX;
    out[count * 2 + 1] = endZ;
    count++;
    req.count = count;
    req.status = PATH_DONE;
    // Cache.
    if (this.cache.size >= CACHE_SIZE) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(this.cacheKey, { pts: out.slice(0, count * 2), count, partial: req.partial, tick: this.tick });
  }

  private cx(node: number): number {
    return this.grid.center(this.wx0 + (node & (WIN - 1)));
  }
  private cz(node: number): number {
    return this.grid.center(this.wz0 + (node >> WIN_SHIFT));
  }

  // Binary min-heap on f.
  private push(node: number, f: number): boolean {
    if (this.heapSize >= HEAP_CAP) return false;
    let i = this.heapSize++;
    const hn = this.heapNode, hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hn[i] = hn[p];
      hf[i] = hf[p];
      i = p;
    }
    hn[i] = node;
    hf[i] = f;
    return true;
  }

  private pop(): void {
    const hn = this.heapNode, hf = this.heapF;
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
}
