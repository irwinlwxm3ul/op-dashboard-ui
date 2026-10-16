// Loot evaluation: how much a bot wants a given ground item, based only on its own inventory.

import { GEAR, WEAPONS, isAmmoId, isConsumableId, isGearId, isThrowableId, isWeaponId, roomFor } from '../items';
import type { ItemId, LootItem, PlayerState, WeaponId } from '../types';
import { WEAPON_TIER, wantedReserve } from './aim';

/** Weapon slot (0/1) the bot would replace to take a better primary, or -1. */
export function worstPrimarySlot(p: PlayerState): -1 | 0 | 1 {
  const a = p.weapons[0], b = p.weapons[1];
  if (!a || !b) return -1;
  return WEAPON_TIER[a.id] <= WEAPON_TIER[b.id] ? 0 : 1;
}

function holdsWeaponForAmmo(p: PlayerState, ammo: ItemId): WeaponId | null {
  for (let s = 0; s < 3; s++) {
    const w = p.weapons[s];
    if (w && WEAPONS[w.id].ammo === ammo) return w.id;
  }
  return null;
}

/** Desirability of an item in [0, 1] (0 = ignore). */
export function lootUtility(p: PlayerState, it: LootItem): number {
  const id = it.item;
  if (isWeaponId(id)) {
    const def = WEAPONS[id];
    const tier = WEAPON_TIER[id];
    const hasAmmo = (p.ammo[def.ammo] || 0) > 0 || (it.mag ?? 0) > 0;
    const ammoMul = hasAmmo ? 1 : 0.6;
    if (def.slot === 'pistol') {
      if (p.weapons[2]) return 0;
      return (p.weapons[0] || p.weapons[1] ? 0.22 : 0.7) * ammoMul;
    }
    const a = p.weapons[0], b = p.weapons[1];
    if (!a && !b) return 1 * ammoMul;
    if ((a && a.id === id) || (b && b.id === id)) return 0;
    if (!a || !b) return (0.55 + 0.35 * tier) * ammoMul;
    const worst = Math.min(WEAPON_TIER[a.id], WEAPON_TIER[b.id]);
    return tier > worst + 0.1 ? Math.min(0.8, (tier - worst) * 2.2) * ammoMul : 0;
  }
  if (isGearId(id)) {
    const g = GEAR[id];
    const cur = p.armor[g.kind];
    if (g.level <= cur || roomFor(p, id) <= 0) return 0;
    if (g.kind === 'pack') return 0.4 + 0.12 * (g.level - cur);
    return 0.62 + 0.13 * (g.level - cur);
  }
  if (roomFor(p, id) <= 0) return 0;
  if (isAmmoId(id)) {
    const w = holdsWeaponForAmmo(p, id);
    if (!w) return 0.03;
    const want = wantedReserve(WEAPONS[w]);
    const have = p.ammo[id] || 0;
    if (have >= want * 2) return 0;
    return have >= want ? 0.08 : 0.4 + 0.5 * (1 - have / want);
  }
  if (isConsumableId(id)) {
    const c = p.items[id] || 0;
    switch (id) {
      case 'bandage': return c >= 10 ? 0 : 0.25 * (1 - c / 10) + (p.health < 75 ? 0.15 : 0);
      case 'firstaid': return c >= 3 ? 0 : 0.45 * (1 - c / 3) + (p.health < 60 ? 0.2 : 0);
      case 'medkit': return c >= 1 ? 0.04 : 0.5;
      case 'energy': return c >= 4 ? 0 : 0.28 * (1 - c / 4);
      default: return 0;
    }
  }
  if (isThrowableId(id)) {
    const c = p.items[id] || 0;
    return c >= 3 ? 0 : 0.3 * (1 - c / 3);
  }
  return 0;
}

/** True when the bot has nothing important left to find (stops building exploration). */
export function wellEquipped(p: PlayerState): boolean {
  const hasPrimary = !!(p.weapons[0] || p.weapons[1]);
  return hasPrimary && p.armor.vest >= 2 && p.armor.helmet >= 2 && (p.items.firstaid || 0) + (p.items.medkit || 0) >= 2;
}
