// Road network helpers: terrain-aware A* routing, polyline smoothing, height profiles, terrain
// flattening under roads and rasterisation into the occupancy mask.

import type { RoadSegment, Vec2 } from '../types';
import { Heightfield, smooth01 } from './heightfield';
import { M_ROAD, OccupancyMask } from './mask';

export interface Road {
  pts: Vec2[];
  /** Road surface height at each point. */
  h: number[];
  width: number;
}

const segScratch = { d: 0, t: 0 };

/** Distance from P to segment AB (and the clamped projection parameter t). */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number, out = segScratch): typeof segScratch {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  out.d = Math.sqrt(qx * qx + qz * qz);
  out.t = t;
  return out;
}

/** Distance from P to the nearest road centreline (Infinity if no roads). */
export function distToRoads(roads: readonly Road[], px: number, pz: number): number {
  let best = Infinity;
  for (const r of roads) {
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const d = distToSegment(px, pz, a.x, a.z, b.x, b.z).d - r.width / 2;
      if (d < best) best = d;
    }
  }
  return best;
}

/** Minimal binary min-heap of node ids keyed by a Float64 score (ties broken by id). */
class NodeHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.ids[a] < this.ids[b]);
  }
  private swap(a: number, b: number): void {
    const ti = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = ti;
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
  }
  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop() as number, lastKey = this.keys.pop() as number;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* on a coarse lattice (spacing `step`) from A to B. `penalty(x, z, h)` returns an extra cost
 * multiplier >= 0 for a node, or Infinity for impassable nodes. Grade is penalised quadratically.
 * Returns world points from exactly A to exactly B, or null if unreachable.
 */
export function routeRoad(
  hf: Heightfield, ax: number, az: number, bx: number, bz: number, step: number,
  penalty: (x: number, z: number, h: number) => number,
): Vec2[] | null {
  const half = hf.half;
  const n = Math.floor(hf.size / step) + 1;
  const N = n * n;
  const nodeH = new Float64Array(N);
  const pen = new Float64Array(N);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + i * step, z = -half + j * step, h = hf.heightAt(x, z);
      nodeH[j * n + i] = h;
      pen[j * n + i] = penalty(x, z, h);
    }
  }
  const idx = (x: number, z: number): number => {
    const i = Math.min(n - 1, Math.max(0, Math.round((x + half) / step)));
    const j = Math.min(n - 1, Math.max(0, Math.round((z + half) / step)));
    return j * n + i;
  };
  const start = idx(ax, az), goal = idx(bx, bz);
  pen[start] = Math.min(pen[start], 0);
  pen[goal] = Math.min(pen[goal], 0);
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const gx = goal % n, gz = Math.floor(goal / n);
  const heap = new NodeHeap();
  g[start] = 0;
  heap.push(start, 0);
  const DI = [1, -1, 0, 0, 1, 1, -1, -1];
  const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    const ci = cur % n, cj = Math.floor(cur / n);
    for (let k = 0; k < 8; k++) {
      const ni = ci + DI[k], nj = cj + DJ[k];
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nb = nj * n + ni;
      if (closed[nb] || pen[nb] === Infinity) continue;
      const len = k < 4 ? step : step * Math.SQRT2;
      const grade = Math.abs(nodeH[nb] - nodeH[cur]) / len;
      const c = len * (1 + 0.5 * (pen[cur] + pen[nb]) + 40 * grade * grade);
      const ng = g[cur] + c;
      if (ng < g[nb]) {
        g[nb] = ng;
        came[nb] = cur;
        const hx = (ni - gx) * step, hz = (nj - gz) * step;
        heap.push(nb, ng + Math.sqrt(hx * hx + hz * hz));
      }
    }
  }
  if (!closed[goal]) return null;
  const nodes: number[] = [];
  for (let c = goal; c !== -1; c = came[c]) nodes.push(c);
  nodes.reverse();
  const pts: Vec2[] = [{ x: ax, z: az }];
  for (let k = 1; k < nodes.length - 1; k++) {
    pts.push({ x: -half + (nodes[k] % n) * step, z: -half + Math.floor(nodes[k] / n) * step });
  }
  pts.push({ x: bx, z: bz });
  return pts;
}

/** Chaikin corner cutting (endpoints preserved). */
export function chaikin(pts: Vec2[], iterations: number): Vec2[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur;
    const next: Vec2[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = cur[i], b = cur[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/** Resample a polyline to roughly uniform spacing (endpoints preserved). */
export function resample(pts: Vec2[], spacing: number): Vec2[] {
  const n = pts.length;
  if (n < 2) return pts.map((p) => ({ x: p.x, z: p.z }));
  const cum = [0];
  for (let i = 0; i + 1 < n; i++) cum.push(cum[i] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z));
  const total = cum[n - 1];
  const count = Math.max(1, Math.round(total / spacing));
  const stepLen = total / count;
  const out: Vec2[] = [{ x: pts[0].x, z: pts[0].z }];
  let seg = 0;
  for (let k = 1; k < count; k++) {
    const target = stepLen * k;
    while (seg < n - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 1e-9 ? Math.min(1, Math.max(0, (target - cum[seg]) / segLen)) : 0;
    const a = pts[seg], b = pts[seg + 1];
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  out.push({ x: pts[n - 1].x, z: pts[n - 1].z });
  return out;
}

/** Terrain-following height profile, smoothed along the road and kept above the sea. */
export function roadProfile(hf: Heightfield, pts: Vec2[], minH: number): number[] {
  let h = pts.map((p) => Math.max(minH, hf.heightAt(p.x, p.z)));
  for (let pass = 0; pass < 6; pass++) {
    const nh = h.slice();
    for (let i = 1; i + 1 < h.length; i++) nh[i] = h[i - 1] * 0.25 + h[i] * 0.5 + h[i + 1] * 0.25;
    h = nh;
  }
  return h.map((v) => Math.max(minH, v));
}

/**
 * Blend terrain toward road profiles: flat within width/2 + 1 m, smooth shoulder out to
 * width/2 + 9 m. Returns a per-vertex flag (1 = vertex lies on the road surface).
 */
export function flattenRoads(hf: Heightfield, roads: readonly Road[]): Uint8Array {
  const res = hf.res, cell = hf.cell, half = hf.half;
  const N = res * res;
  const wgt = new Float32Array(N);
  const tgt = new Float32Array(N);
  const dist = new Float32Array(N).fill(Infinity);
  const onRoad = new Uint8Array(N);
  const s = { d: 0, t: 0 };
  for (const r of roads) {
    const inner = r.width / 2 + 1, outer = r.width / 2 + 9, surf = r.width / 2 + 0.6;
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const a = r.pts[k], b = r.pts[k + 1];
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - outer + half) / cell));
      const i1 = Math.min(res - 1, Math.ceil((Math.max(a.x, b.x) + outer + half) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - outer + half) / cell));
      const j1 = Math.min(res - 1, Math.ceil((Math.max(a.z, b.z) + outer + half) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = -half + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = -half + i * cell;
          distToSegment(x, z, a.x, a.z, b.x, b.z, s);
          if (s.d >= outer) continue;
          const v = j * res + i;
          const w = s.d <= inner ? 1 : 1 - smooth01((s.d - inner) / (outer - inner));
          if (s.d < surf) onRoad[v] = 1;
          if (w > wgt[v] || (w === wgt[v] && s.d < dist[v])) {
            wgt[v] = w;
            dist[v] = s.d;
            tgt[v] = r.h[k] + (r.h[k + 1] - r.h[k]) * s.t;
          }
        }
      }
    }
  }
  for (let v = 0; v < N; v++) if (wgt[v] > 0) hf.h[v] += (tgt[v] - hf.h[v]) * wgt[v];
  return onRoad;
}

/** Mark road surface + 1 m shoulder in the mask. */
export function rasterizeRoads(mask: OccupancyMask, roads: readonly Road[]): void {
  const s = { d: 0, t: 0 };
  for (const r of roads) {
    const lim = r.width / 2 + 1;
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const a = r.pts[k], b = r.pts[k + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) - lim), x1 = Math.ceil(Math.max(a.x, b.x) + lim);
      const z0 = Math.floor(Math.min(a.z, b.z) - lim), z1 = Math.ceil(Math.max(a.z, b.z) + lim);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          // Test the cell centre against the widened road.
          if (distToSegment(x + 0.5, z + 0.5, a.x, a.z, b.x, b.z, s).d < lim + 0.71) mask.markRect(x + 0.5, z + 0.5, x + 0.5, z + 0.5, M_ROAD);
        }
      }
    }
  }
}

/** Flatten roads into contract segments. */
export function roadSegments(roads: readonly Road[]): RoadSegment[] {
  const out: RoadSegment[] = [];
  for (const r of roads) {
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const a = r.pts[k], b = r.pts[k + 1];
      out.push({
        a: { x: Math.round(a.x * 100) / 100, z: Math.round(a.z * 100) / 100 },
        b: { x: Math.round(b.x * 100) / 100, z: Math.round(b.z * 100) / 100 },
        width: r.width,
      });
    }
  }
  return out;
}
