// Inventory rules (mutating PlayerState): capacity, pickup / replace, removal, consumable effects
// and boost. Weapons occupy slots and gear occupies equipment slots; neither uses capacity.
//
// Gear durability travels in the `mag` field of dropped / picked up vest and helmet stacks, so a
// damaged vest stays damaged when it is dropped and picked up again (absent = full durability).

import { MAX_BOOST, MAX_HEALTH } from '../constants';
import type {
  AmmoId, ConsumableId, GearId, ItemId, PlayerState, ThrowableId, WeaponInstance,
} from '../types';
import {
  AMMO, AMMO_IDS, BASE_CAPACITY, CONSUMABLE_IDS, CONSUMABLES, GEAR, THROWABLE_IDS, THROWABLES, WEAPONS,
  gearIdFor, isAmmoId, isConsumableId, isGearId, isWeaponId,
} from './defs';

/** Floating point slack for capacity comparisons (weights such as 0.4 are not exact in binary). */
const CAP_EPS = 1e-6;

const VEST_CAPACITY = [0, GEAR.vest1.capacity, GEAR.vest2.capacity, GEAR.vest3.capacity];
const PACK_CAPACITY = [0, GEAR.pack1.capacity, GEAR.pack2.capacity, GEAR.pack3.capacity];
const STACK_IDS: (ConsumableId | ThrowableId)[] = [...CONSUMABLE_IDS, ...THROWABLE_IDS];

export interface PickupResult {
  /** Units taken from the offered stack (weapons / gear: 0 or 1). */
  taken: number;
  /** Items the player let go of (replaced weapon with its magazine, replaced gear). */
  dropped: { item: ItemId; count: number; mag?: number }[];
}

// ============================================================================
// Capacity
// ============================================================================

function capacityWith(vest: number, pack: number): number {
  return BASE_CAPACITY + VEST_CAPACITY[vest] + PACK_CAPACITY[pack];
}

/** Total carrying capacity: base + vest + backpack. */
export function capacity(p: PlayerState): number {
  return capacityWith(p.armor.vest, p.armor.pack);
}

/** Capacity used by ammo, consumables and throwables. */
export function usedCapacity(p: PlayerState): number {
  let used = 0;
  for (let i = 0; i < AMMO_IDS.length; i++) {
    const id = AMMO_IDS[i];
    used += (p.ammo[id] || 0) * AMMO[id].weight;
  }
  for (let i = 0; i < STACK_IDS.length; i++) {
    const id = STACK_IDS[i];
    const n = p.items[id] || 0;
    if (n > 0) used += n * (isConsumableId(id) ? CONSUMABLES[id].weight : THROWABLES[id as ThrowableId].weight);
  }
  return used;
}

function stackWeight(id: AmmoId | ConsumableId | ThrowableId): number {
  if (isAmmoId(id)) return AMMO[id].weight;
  if (isConsumableId(id)) return CONSUMABLES[id].weight;
  return THROWABLES[id].weight;
}

/** Whether swapping / removing the pack keeps the current load within capacity. */
function packChangeFits(p: PlayerState, newPack: number): boolean {
  return usedCapacity(p) <= capacityWith(p.armor.vest, newPack) + CAP_EPS;
}

/**
 * How many units of `item` the player can take now. Weapons: always 1 (empty slot or swap).
 * Gear: 1 if it would be equipped (empty slot or a different level; a smaller backpack only if the
 * load still fits), else 0. Stackables: limited by the remaining capacity.
 */
export function roomFor(p: PlayerState, item: ItemId): number {
  if (isWeaponId(item)) return 1;
  if (isGearId(item)) {
    const g = GEAR[item];
    const cur = p.armor[g.kind];
    if (cur === g.level) return 0;
    if (g.kind === 'pack' && cur !== 0 && !packChangeFits(p, g.level)) return 0;
    return 1;
  }
  const w = stackWeight(item);
  const free = capacity(p) - usedCapacity(p);
  if (w <= 0) return free >= 0 ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(free / w + CAP_EPS));
}

// ============================================================================
// Pickup / removal
// ============================================================================

/** Reset per-weapon handling state when the weapon in the active slot is replaced or removed. */
function resetActiveHandling(p: PlayerState): void {
  p.reloadTimer = 0;
  p.reloadTotal = 0;
  p.sprayCount = 0;
  p.bloom = 0;
}

/**
 * Pick up `count` units of `item`.
 * * Weapons: primaries fill slot A then B, the pistol fills the pistol slot. When full the ACTIVE
 *   primary slot (slot A if the active slot is not a primary) / the pistol slot is replaced and
 *   the old weapon is returned in `dropped` with its magazine. `mag` = rounds loaded (default 0).
 *   Replacing the weapon in hand cancels its reload and starts the new weapon's draw.
 * * Gear: equipped when the slot is empty or holds a different level; replaced gear is dropped
 *   (vest/helmet with remaining durability in `mag`). `mag` on a vest/helmet = its durability.
 * * Ammo / consumables / throwables: takes what fits in the remaining capacity.
 */
export function pickupItem(p: PlayerState, item: ItemId, count: number, mag?: number): PickupResult {
  const res: PickupResult = { taken: 0, dropped: [] };
  const n = Math.floor(count);
  if (!(n > 0)) return res;

  if (isWeaponId(item)) {
    const def = WEAPONS[item];
    const loaded = Math.max(0, Math.min(def.magSize, Math.floor(mag ?? 0) || 0));
    const inst: WeaponInstance = { id: item, mag: loaded };
    let slot: 0 | 1 | 2;
    if (def.slot === 'pistol') slot = 2;
    else if (!p.weapons[0]) slot = 0;
    else if (!p.weapons[1]) slot = 1;
    else slot = p.activeSlot === 0 || p.activeSlot === 1 ? p.activeSlot : 0;
    const old = p.weapons[slot];
    if (old) res.dropped.push({ item: old.id, count: 1, mag: old.mag });
    p.weapons[slot] = inst;
    if (old && p.activeSlot === slot) {
      resetActiveHandling(p);
      p.drawTimer = def.drawTime;
    }
    res.taken = 1;
    return res;
  }

  if (isGearId(item)) {
    const g = GEAR[item];
    const cur = p.armor[g.kind];
    if (cur === g.level) return res;
    if (g.kind === 'pack') {
      if (cur !== 0 && !packChangeFits(p, g.level)) return res;
      if (cur !== 0) res.dropped.push({ item: gearIdFor('pack', cur) as GearId, count: 1 });
      p.armor.pack = g.level;
    } else {
      const hp = mag !== undefined && mag > 0 ? Math.min(g.durability, mag) : g.durability;
      if (g.kind === 'vest') {
        if (cur !== 0) res.dropped.push({ item: gearIdFor('vest', cur) as GearId, count: 1, mag: p.armor.vestHp });
        p.armor.vest = g.level;
        p.armor.vestHp = hp;
      } else {
        if (cur !== 0) res.dropped.push({ item: gearIdFor('helmet', cur) as GearId, count: 1, mag: p.armor.helmetHp });
        p.armor.helmet = g.level;
        p.armor.helmetHp = hp;
      }
    }
    res.taken = 1;
    return res;
  }

  const take = Math.min(n, roomFor(p, item));
  if (take <= 0) return res;
  if (isAmmoId(item)) p.ammo[item] = (p.ammo[item] || 0) + take;
  else p.items[item] = (p.items[item] || 0) + take;
  res.taken = take;
  return res;
}

/**
 * Remove up to `count` units; returns how many were removed. Weapons: removes one instance (the
 * one in hand first, which leaves the player unarmed). Gear: unequips it (a backpack only if the
 * load still fits without it).
 */
export function removeItem(p: PlayerState, item: ItemId, count: number): number {
  const n = Math.floor(count);
  if (!(n > 0)) return 0;

  if (isWeaponId(item)) {
    const active = p.activeSlot;
    let slot = -1;
    if (active !== -1 && p.weapons[active]?.id === item) slot = active;
    else slot = p.weapons.findIndex((w) => w !== null && w.id === item);
    if (slot < 0) return 0;
    p.weapons[slot] = null;
    if (p.activeSlot === slot) {
      resetActiveHandling(p);
      p.drawTimer = 0;
      p.activeSlot = -1;
    }
    return 1;
  }

  if (isGearId(item)) {
    const g = GEAR[item];
    if (p.armor[g.kind] !== g.level) return 0;
    if (g.kind === 'pack') {
      if (!packChangeFits(p, 0)) return 0;
      p.armor.pack = 0;
    } else if (g.kind === 'vest') {
      p.armor.vest = 0;
      p.armor.vestHp = 0;
    } else {
      p.armor.helmet = 0;
      p.armor.helmetHp = 0;
    }
    return 1;
  }

  if (isAmmoId(item)) {
    const have = p.ammo[item] || 0;
    const r = Math.min(have, n);
    p.ammo[item] = have - r;
    return r;
  }
  const have = p.items[item] || 0;
  const r = Math.min(have, n);
  p.items[item] = have - r;
  return r;
}

// ============================================================================
// Consumables & boost
// ============================================================================

/** Boost lost per second (~1 point every 2.5 s). */
export const BOOST_DECAY_PER_SEC = 1 / 2.5;

/** Health regenerated per second by boost. */
export function boostHealRate(boost: number): number {
  return boost >= 60 ? 1.0 : boost >= 20 ? 0.6 : boost > 0 ? 0.3 : 0;
}

/** Movement speed multiplier from boost. */
export function boostSpeedMul(boost: number): number {
  return boost >= 60 ? 1.04 : 1;
}

/**
 * Whether using the item now would have an effect (bandage / first aid only below their cap,
 * medkit below full health, energy below max boost). Fuel always returns true when carried: its
 * vehicle requirement is checked by the simulation.
 */
export function canUseConsumable(p: PlayerState, item: ConsumableId): boolean {
  if ((p.items[item] || 0) <= 0 || p.life !== 'alive') return false;
  const d = CONSUMABLES[item];
  if (item === 'fuel') return true;
  if (d.heal > 0 && p.health < d.healCap) return true;
  return d.boost > 0 && p.boost < MAX_BOOST;
}

/** Apply a consumable's heal / boost (fuel is handled by the simulation and ignored here). */
export function applyConsumable(p: PlayerState, item: ConsumableId): void {
  if (item === 'fuel' || p.life !== 'alive') return;
  const d = CONSUMABLES[item];
  if (d.heal > 0 && p.health < d.healCap) p.health = Math.min(d.healCap, p.health + d.heal);
  if (d.boost > 0) p.boost = Math.min(MAX_BOOST, p.boost + d.boost);
}

/** Boost heal-over-time (alive only, never above max health) and decay. */
export function tickBoost(p: PlayerState, dt: number): void {
  if (!(dt > 0) || !(p.boost > 0)) return;
  if (p.life === 'alive' && p.health > 0 && p.health < MAX_HEALTH) {
    p.health = Math.min(MAX_HEALTH, p.health + boostHealRate(p.boost) * dt);
  }
  p.boost = Math.max(0, p.boost - BOOST_DECAY_PER_SEC * dt);
}

/** Fresh zeroed ammo / item counters for a new player. */
export function emptyInventory(): { ammo: Record<AmmoId, number>; items: Record<ConsumableId | ThrowableId, number> } {
  const ammo = {} as Record<AmmoId, number>;
  for (const id of AMMO_IDS) ammo[id] = 0;
  const items = {} as Record<ConsumableId | ThrowableId, number>;
  for (const id of CONSUMABLE_IDS) items[id] = 0;
  for (const id of THROWABLE_IDS) items[id] = 0;
  return { ammo, items };
}
