// Uniform XZ grid over ground loot so interaction prompts / inventory "nearby" lists query only a
// few cells instead of scanning ~1 800 items every tick.

import type { LootItem } from '../../shared/types';

const CELL = 8;
const OFFSET = 4096;
const SPAN = 8192;

function cellKey(ix: number, iz: number): number {
  return (ix + OFFSET) * SPAN + (iz + OFFSET);
}

export class LootIndex {
  private readonly cells = new Map<number, LootItem[]>();
  private n = 0;

  get size(): number {
    return this.n;
  }

  add(l: LootItem): void {
    const k = cellKey(Math.floor(l.pos.x / CELL), Math.floor(l.pos.z / CELL));
    let c = this.cells.get(k);
    if (!c) {
      c = [];
      this.cells.set(k, c);
    }
    c.push(l);
    this.n++;
  }

  /** Remove by id from the cell of `l.pos` (the position it was added with). */
  remove(l: LootItem): boolean {
    const k = cellKey(Math.floor(l.pos.x / CELL), Math.floor(l.pos.z / CELL));
    const c = this.cells.get(k);
    if (!c) return false;
    for (let i = 0; i < c.length; i++) {
      if (c[i].id === l.id) {
        c[i] = c[c.length - 1];
        c.pop();
        if (c.length === 0) this.cells.delete(k);
        this.n--;
        return true;
      }
    }
    return false;
  }

  /** Items within `radius` (XZ) of (x, z), written into `out` (cleared first). */
  query(x: number, z: number, radius: number, out: LootItem[]): LootItem[] {
    out.length = 0;
    const r2 = radius * radius;
    const x0 = Math.floor((x - radius) / CELL), x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL), z1 = Math.floor((z + radius) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const c = this.cells.get(cellKey(ix, iz));
        if (!c) continue;
        for (let i = 0; i < c.length; i++) {
          const l = c[i];
          const dx = l.pos.x - x, dz = l.pos.z - z;
          if (dx * dx + dz * dz <= r2) out.push(l);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.n = 0;
  }
}
