// Uniform spatial hashes on the XZ plane used for loot (incrementally maintained) and players
// (rebuilt once per tick). Both cover [-half, half] and clamp outside positions to the border cells.

import type { EntityId, LootItem, PlayerState } from '../types';

/** Bucketed grid for loot items: O(1) add, O(bucket) remove, queries touch only covered cells. */
export class LootGrid {
  readonly cell: number;
  readonly dim: number;
  private readonly half: number;
  private readonly buckets: LootItem[][];
  /** Cell index each item was inserted into (positions never change while on the ground). */
  private readonly cellOf = new Map<EntityId, number>();

  constructor(half: number, cell: number) {
    this.half = half;
    this.cell = cell;
    this.dim = Math.max(1, Math.ceil((half * 2) / cell));
    this.buckets = new Array(this.dim * this.dim);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  private cx(x: number): number {
    const c = Math.floor((x + this.half) / this.cell);
    return c < 0 ? 0 : c >= this.dim ? this.dim - 1 : c;
  }

  add(item: LootItem): void {
    const idx = this.cx(item.pos.z) * this.dim + this.cx(item.pos.x);
    this.buckets[idx].push(item);
    this.cellOf.set(item.id, idx);
  }

  remove(id: EntityId): void {
    const idx = this.cellOf.get(id);
    if (idx === undefined) return;
    this.cellOf.delete(id);
    const b = this.buckets[idx];
    for (let i = 0; i < b.length; i++) {
      if (b[i].id === id) {
        b[i] = b[b.length - 1];
        b.pop();
        return;
      }
    }
  }

  query(x: number, z: number, radius: number, out: LootItem[]): LootItem[] {
    out.length = 0;
    if (!(radius >= 0)) return out;
    const x0 = this.cx(x - radius), x1 = this.cx(x + radius);
    const z0 = this.cx(z - radius), z1 = this.cx(z + radius);
    const r2 = radius * radius;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.buckets[cz * this.dim + cx];
        for (let i = 0; i < b.length; i++) {
          const it = b[i];
          const dx = it.pos.x - x, dz = it.pos.z - z;
          if (dx * dx + dz * dz <= r2) out.push(it);
        }
      }
    }
    return out;
  }
}

/**
 * Player grid rebuilt from scratch every tick with intrusive linked lists in typed arrays (no
 * allocations after construction). Large-radius queries fall back to a linear scan when that is
 * cheaper than walking the cells.
 */
export class PlayerGrid {
  readonly cell: number;
  readonly dim: number;
  private readonly half: number;
  private readonly head: Int32Array;
  private next = new Int32Array(64);
  private list: PlayerState[] = [];

  constructor(half: number, cell: number) {
    this.half = half;
    this.cell = cell;
    this.dim = Math.max(1, Math.ceil((half * 2) / cell));
    this.head = new Int32Array(this.dim * this.dim).fill(-1);
  }

  private cx(x: number): number {
    const c = Math.floor((x + this.half) / this.cell);
    return c < 0 ? 0 : c >= this.dim ? this.dim - 1 : c;
  }

  rebuild(players: PlayerState[]): void {
    this.list = players;
    this.head.fill(-1);
    if (this.next.length < players.length) this.next = new Int32Array(Math.max(players.length, this.next.length * 2));
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const idx = this.cx(p.pos.z) * this.dim + this.cx(p.pos.x);
      this.next[i] = this.head[idx];
      this.head[idx] = i;
    }
  }

  query(x: number, z: number, radius: number, out: PlayerState[]): PlayerState[] {
    out.length = 0;
    if (!(radius >= 0)) return out;
    const r2 = radius * radius;
    const x0 = this.cx(x - radius), x1 = this.cx(x + radius);
    const z0 = this.cx(z - radius), z1 = this.cx(z + radius);
    const cells = (x1 - x0 + 1) * (z1 - z0 + 1);
    const list = this.list;
    if (cells >= list.length) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const dx = p.pos.x - x, dz = p.pos.z - z;
        if (dx * dx + dz * dz <= r2) out.push(p);
      }
      return out;
    }
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let i = this.head[cz * this.dim + cx]; i !== -1; i = this.next[i]) {
          const p = list[i];
          const dx = p.pos.x - x, dz = p.pos.z - z;
          if (dx * dx + dz * dz <= r2) out.push(p);
        }
      }
    }
    return out;
  }
}
