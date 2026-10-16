// Uniform spatial grid over the square map [-half, half]^2 stored in compressed-sparse-row form.
// Items are registered in every cell their XZ bounds overlap, so a query only visits the cells the
// query rectangle touches (O(cells touched)). Duplicate hits of multi-cell items are filtered with
// a per-item stamp, which keeps queries allocation free.

export class SpatialGrid {
  readonly half: number;
  readonly cellSize: number;
  /** Cells per side. */
  readonly n: number;
  /** Item bounds, 4 per item: minX, minZ, maxX, maxZ. */
  readonly bounds: Float64Array;
  readonly count: number;
  private readonly cellStart: Int32Array;
  private readonly items: Int32Array;
  private readonly stamps: Uint32Array;
  private stamp = 0;

  constructor(half: number, cellSize: number, bounds: Float64Array, count: number) {
    this.half = half;
    this.cellSize = cellSize;
    this.n = Math.max(1, Math.ceil((half * 2) / cellSize));
    this.bounds = bounds;
    this.count = count;
    const n = this.n;
    const nc = n * n;
    const start = new Int32Array(nc + 1);
    for (let i = 0; i < count; i++) {
      const cx0 = this.cellCoord(bounds[i * 4]), cz0 = this.cellCoord(bounds[i * 4 + 1]);
      const cx1 = this.cellCoord(bounds[i * 4 + 2]), cz1 = this.cellCoord(bounds[i * 4 + 3]);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) start[cz * n + cx + 1]++;
    }
    for (let c = 0; c < nc; c++) start[c + 1] += start[c];
    const items = new Int32Array(start[nc]);
    const cursor = start.slice(0, nc);
    for (let i = 0; i < count; i++) {
      const cx0 = this.cellCoord(bounds[i * 4]), cz0 = this.cellCoord(bounds[i * 4 + 1]);
      const cx1 = this.cellCoord(bounds[i * 4 + 2]), cz1 = this.cellCoord(bounds[i * 4 + 3]);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) items[cursor[cz * n + cx]++] = i;
    }
    this.cellStart = start;
    this.items = items;
    this.stamps = new Uint32Array(count);
  }

  /** Cell coordinate (clamped to the grid) of a world coordinate. */
  cellCoord(v: number): number {
    const c = Math.floor((v + this.half) / this.cellSize);
    return c < 0 ? 0 : c >= this.n ? this.n - 1 : c;
  }

  /**
   * Clears `out`, then appends every item of `src` whose XZ bounds overlap (inclusive) the query
   * rectangle. Each item appears at most once.
   */
  query<T>(minX: number, minZ: number, maxX: number, maxZ: number, src: readonly T[], out: T[]): T[] {
    out.length = 0;
    // Also rejects NaN input (all comparisons false).
    if (!(minX <= maxX && minZ <= maxZ) || this.count === 0) return out;
    const half = this.half;
    if (maxX < -half || maxZ < -half || minX > half || minZ > half) return out;
    if (++this.stamp === 0xffffffff) {
      this.stamps.fill(0);
      this.stamp = 1;
    }
    const s = this.stamp, stamps = this.stamps, b = this.bounds, items = this.items, start = this.cellStart, n = this.n;
    const cx0 = this.cellCoord(minX), cz0 = this.cellCoord(minZ);
    const cx1 = this.cellCoord(maxX), cz1 = this.cellCoord(maxZ);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * n + cx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const i = items[k];
          if (stamps[i] === s) continue;
          stamps[i] = s;
          const o = i * 4;
          if (b[o] <= maxX && b[o + 2] >= minX && b[o + 1] <= maxZ && b[o + 3] >= minZ) out.push(src[i]);
        }
      }
    }
    return out;
  }

  /** Index of the cell containing (x, z) (clamped). */
  cellAt(x: number, z: number): number {
    return this.cellCoord(z) * this.n + this.cellCoord(x);
  }
  cellBegin(cell: number): number {
    return this.cellStart[cell];
  }
  cellEnd(cell: number): number {
    return this.cellStart[cell + 1];
  }
  /** Item index stored at slot k (between cellBegin and cellEnd). */
  itemAt(k: number): number {
    return this.items[k];
  }
}
