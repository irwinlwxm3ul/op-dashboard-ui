// Loot tables: what a world loot spawn contains, weighted by the spawn's tier
// (0 = village, 1 = town, 2 = military). Deterministic for a given Rng state.

import type { Rng } from '../rng';
import type { AmmoId, ConsumableId, GearId, ItemId, WeaponId } from '../types';
import { AMMO, WEAPONS, WEAPON_IDS, gearIdFor } from './defs';

export interface LootRoll {
  item: ItemId;
  count: number;
  /** Rounds in the magazine for weapons. */
  mag?: number;
}

type Tier = 0 | 1 | 2;

/** Chance that a spawn holds a weapon (plus its ammo). */
const WEAPON_CHANCE: readonly number[] = [0.32, 0.38, 0.45];
/** Chance of one extra stack next to a weapon. */
const EXTRA_WITH_WEAPON: readonly number[] = [0.35, 0.45, 0.55];
/** Weights for 1 / 2 / 3 stacks on a spawn without a weapon. */
const STACKS_WEIGHTS: readonly (readonly number[])[] = [[0.55, 0.35, 0.1], [0.42, 0.4, 0.18], [0.3, 0.45, 0.25]];
const STACK_COUNTS = [1, 2, 3] as const;

/** Per-tier multiplier on WeaponDef.lootWeight: marksman rifles are rare except at military sites. */
const WEAPON_TIER_MUL: Record<WeaponId, readonly number[]> = {
  pistol: [1.5, 1, 0.4],
  smg: [1.2, 1, 0.8],
  ar: [0.8, 1, 1.3],
  shotgun: [1.2, 1, 0.7],
  dmr: [0.4, 1, 3],
  sniper: [0.3, 1, 4],
};
const WEAPON_WEIGHTS: number[][] = [0, 1, 2].map((t) =>
  WEAPON_IDS.map((id) => WEAPONS[id].lootWeight * WEAPON_TIER_MUL[id][t]),
);

type Cat = 'ammo' | 'consumable' | 'gear' | 'frag' | 'fuel';
const CATS: readonly Cat[] = ['ammo', 'consumable', 'gear', 'frag', 'fuel'];
const CAT_WEIGHTS: readonly (readonly number[])[] = [
  [0.32, 0.32, 0.25, 0.06, 0.05],
  [0.3, 0.3, 0.28, 0.08, 0.04],
  [0.3, 0.25, 0.33, 0.1, 0.02],
];

const AMMO_ORDER: readonly AmmoId[] = ['ammo_9mm', 'ammo_556', 'ammo_762', 'ammo_12g', 'ammo_300'];
/** Weights in AMMO_ORDER per tier: rifle calibres become more common at higher tiers. */
const AMMO_WEIGHTS: readonly (readonly number[])[] = [
  [0.36, 0.26, 0.12, 0.2, 0.06],
  [0.3, 0.3, 0.15, 0.16, 0.09],
  [0.18, 0.32, 0.22, 0.1, 0.18],
];

const HEALS: readonly ConsumableId[] = ['bandage', 'firstaid', 'medkit', 'energy'];
const HEAL_WEIGHTS: readonly (readonly number[])[] = [
  [0.45, 0.25, 0.05, 0.25],
  [0.4, 0.27, 0.08, 0.25],
  [0.3, 0.3, 0.14, 0.26],
];

const GEAR_KINDS = ['vest', 'helmet', 'pack'] as const;
const GEAR_KIND_WEIGHTS = [0.36, 0.36, 0.28] as const;
const GEAR_LEVELS = [1, 2, 3] as const;
const GEAR_LEVEL_WEIGHTS: readonly (readonly number[])[] = [
  [0.65, 0.3, 0.05],
  [0.45, 0.42, 0.13],
  [0.2, 0.5, 0.3],
];

/** Attempts to find an item not already on the spawn before giving up on an extra stack. */
const DISTINCT_ATTEMPTS = 4;

/** Roll one non-weapon stack (not yet added). */
function rollStack(rng: Rng, t: Tier): LootRoll {
  switch (rng.weighted(CATS, CAT_WEIGHTS[t])) {
    case 'ammo': {
      const id = rng.weighted(AMMO_ORDER, AMMO_WEIGHTS[t]);
      return { item: id, count: AMMO[id].stack };
    }
    case 'consumable': {
      const id = rng.weighted(HEALS, HEAL_WEIGHTS[t]);
      return { item: id, count: id === 'bandage' ? rng.int(3, 5) : 1 };
    }
    case 'gear': {
      const kind = rng.weighted(GEAR_KINDS, GEAR_KIND_WEIGHTS);
      const level = rng.weighted(GEAR_LEVELS, GEAR_LEVEL_WEIGHTS[t]);
      return { item: gearIdFor(kind, level) as GearId, count: 1 };
    }
    case 'frag':
      return { item: 'frag', count: rng.chance(0.25) ? 2 : 1 };
    case 'fuel':
      return { item: 'fuel', count: 1 };
  }
}

/** Add one extra stack whose item is not on the spawn yet (skipped if none is found). */
function addDistinctStack(rng: Rng, t: Tier, out: LootRoll[]): void {
  for (let attempt = 0; attempt < DISTINCT_ATTEMPTS; attempt++) {
    const s = rollStack(rng, t);
    if (!out.some((o) => o.item === s.item)) {
      out.push(s);
      return;
    }
  }
}

/**
 * Contents of one loot spawn: 1-3 item stacks. Weapons come with a matching ammo stack worth one
 * or two magazines and a partially filled magazine (0..magSize). Higher tiers hold more level 2-3
 * gear, DMRs and sniper rifles.
 */
export function rollLoot(rng: Rng, tier: Tier): LootRoll[] {
  const t: Tier = tier === 2 ? 2 : tier === 1 ? 1 : 0;
  const out: LootRoll[] = [];
  let extra: number;
  if (rng.chance(WEAPON_CHANCE[t])) {
    const id = rng.weighted(WEAPON_IDS, WEAPON_WEIGHTS[t]);
    const w = WEAPONS[id];
    out.push({ item: id, count: 1, mag: rng.int(0, w.magSize) });
    out.push({ item: w.ammo, count: w.magSize * rng.int(1, 2) });
    extra = rng.chance(EXTRA_WITH_WEAPON[t]) ? 1 : 0;
  } else {
    extra = rng.weighted(STACK_COUNTS, STACKS_WEIGHTS[t]);
  }
  for (let i = 0; i < extra; i++) addDistinctStack(rng, t, out);
  return out;
}
