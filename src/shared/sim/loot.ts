// Ground loot: initial seeded spawn, spatial hash (16 m cells) kept in sync on add/remove, and the
// add/remove delta drained by the MatchRunner for snapshots.

import { rollLoot } from '../items';
import type { Rng } from '../rng';
import type { EntityId, ItemId, LootItem, Vec3, World } from '../types';
import { LootGrid } from './grid';
import { LOOT_CELL, LOOT_FILL } from './tuning';

export class LootManager {
  readonly items = new Map<EntityId, LootItem>();
  private readonly grid: LootGrid;
  private added: LootItem[] = [];
  private removed: EntityId[] = [];
  /** Ids added since the last drain (so add+remove inside one window cancel out). */
  private readonly pendingAdd = new Set<EntityId>();

  constructor(world: World) {
    this.grid = new LootGrid(world.half, LOOT_CELL);
  }

  add(id: EntityId, item: ItemId, count: number, pos: Vec3, mag?: number): LootItem {
    const it: LootItem = { id, item, count, pos: { x: pos.x, y: pos.y, z: pos.z } };
    if (mag !== undefined) it.mag = mag;
    this.items.set(id, it);
    this.grid.add(it);
    this.added.push(it);
    this.pendingAdd.add(id);
    return it;
  }

  remove(id: EntityId): LootItem | null {
    const it = this.items.get(id);
    if (!it) return null;
    this.items.delete(id);
    this.grid.remove(id);
    if (this.pendingAdd.has(id)) {
      this.pendingAdd.delete(id);
      const i = this.added.indexOf(it);
      if (i >= 0) this.added.splice(i, 1);
    } else {
      this.removed.push(id);
    }
    return it;
  }

  near(x: number, z: number, radius: number, out: LootItem[]): LootItem[] {
    return this.grid.query(x, z, radius, out);
  }

  drainDelta(): { added: LootItem[]; removed: EntityId[] } {
    const d = { added: this.added, removed: this.removed };
    this.added = [];
    this.removed = [];
    this.pendingAdd.clear();
    return d;
  }

  /** Discard the pending delta (initial spawn is delivered through MatchInit instead). */
  clearDelta(): void {
    this.added = [];
    this.removed = [];
    this.pendingAdd.clear();
  }

  /**
   * Initial spawn: about LOOT_FILL of the world's loot spawns get a tier-based roll; stacks of
   * one spawn are laid out on a small ring so they do not overlap.
   */
  spawnInitial(world: World, rng: Rng, nextId: () => EntityId): void {
    const spawns = world.lootSpawns;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[i];
      if (!rng.chance(LOOT_FILL)) continue;
      const roll = rollLoot(rng, s.tier);
      const n = roll.length;
      const rot = rng.next() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const r = roll[k];
        const a = rot + (k / Math.max(1, n)) * Math.PI * 2;
        const off = n > 1 ? 0.35 : 0;
        const pos = { x: s.pos.x + Math.cos(a) * off, y: s.pos.y, z: s.pos.z + Math.sin(a) * off };
        this.add(nextId(), r.item, r.count, pos, r.mag);
      }
    }
  }
}
