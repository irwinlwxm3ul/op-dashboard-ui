// Item definitions: weapons, ammo, consumables, throwables and gear.
//
// All tuning lives here so the simulation, bots, client prediction, feel and FX read one source
// of truth. Units: meters, seconds, radians (spread / recoil / kick angles), m/s for velocities.

import type {
  AmmoDef, AmmoId, ConsumableDef, ConsumableId, GearDef, GearId, ItemCategory, ItemDef, ItemId,
  ThrowableDef, ThrowableId, WeaponDef, WeaponId,
} from '../types';

/** Inventory capacity without vest or backpack. */
export const BASE_CAPACITY = 50;
/** Range (m) the sights of ballistic weapons are zeroed at. */
export const ZERO_RANGE = 100;

// ============================================================================
// Weapons
// ============================================================================
//
// Design notes
// * Spread values are cone half angles. ADS spread of rifles is near pinpoint; hip fire is the
//   SMG's strength. Moving / airborne penalties are added on top (see combat.ts spreadCone).
// * Bloom: each shot adds `bloomPerShot`, the sim decays it at `bloomRecovery` rad/s. Per-shot
//   values exceed the decay over one fire interval so sustained fire blooms toward `bloomMax`
//   within ~6-12 shots, and a released trigger clears it in ~0.3-0.5 s.
// * Recoil is server authoritative (combat.ts recoilForShot): vertical climbs with spray index
//   and plateaus, horizontal follows a learnable per-weapon drift. `kick` is purely cosmetic.
// * Hitscan weapons have drag 0 / gravityScale 0 so a tracer advanced with stepBallistic stays on
//   the straight hitscan line; their muzzleVelocity only sets tracer speed.
// * Shotgun reloads shell by shell (`reloadPerShell`); its reloadTime / reloadEmptyTime are the
//   full-tube durations (5 shells, empty adds a pump rack) used for UI progress estimates.

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol',
    category: 'weapon',
    slot: 'pistol',
    ammo: 'ammo_9mm',
    magSize: 15,
    fireMode: 'semi',
    rpm: 400,
    damage: 35,
    pellets: 1,
    headMul: 2.0,
    limbMul: 0.9,
    falloffStart: 20,
    falloffEnd: 75,
    falloffMinMul: 0.5,
    hitscan: true,
    muzzleVelocity: 360,
    drag: 0,
    gravityScale: 0,
    range: 250,
    spreadHip: 0.02,
    spreadAds: 0.006,
    spreadMove: 0.018,
    spreadAir: 0.07,
    pelletSpread: 0,
    bloomPerShot: 0.012,
    bloomMax: 0.02,
    bloomRecovery: 0.057,
    recoil: {
      vertical: 0.014,
      verticalGrowth: 0.15,
      verticalMaxMul: 1.6,
      horizontal: 0.004,
      firstShotMul: 1.0,
      recovery: 0.35,
      adsMul: 0.8,
      crouchMul: 0.85,
      proneMul: 0.7,
    },
    kick: { camPitch: 0.012, camYaw: 0.004, camRoll: 0.01, vmBack: 0.045, vmUp: 0.02, vmRot: 0.09, shake: 0.06 },
    reloadTime: 1.6,
    reloadEmptyTime: 2.05,
    drawTime: 0.4,
    adsTime: 0.15,
    adsZoom: 0.82,
    scope: 'iron',
    moveSpeedMul: 1.0,
    sound: 'pistol',
    loudness: 250,
    lootWeight: 1.0,
  },
  smg: {
    id: 'smg',
    category: 'weapon',
    slot: 'primary',
    ammo: 'ammo_9mm',
    magSize: 30,
    fireMode: 'auto',
    rpm: 750,
    damage: 33,
    pellets: 1,
    headMul: 2.0,
    limbMul: 0.9,
    falloffStart: 15,
    falloffEnd: 60,
    falloffMinMul: 0.55,
    hitscan: true,
    muzzleVelocity: 400,
    drag: 0,
    gravityScale: 0,
    range: 300,
    spreadHip: 0.016,
    spreadAds: 0.007,
    spreadMove: 0.011,
    spreadAir: 0.06,
    pelletSpread: 0,
    bloomPerShot: 0.0055,
    bloomMax: 0.018,
    bloomRecovery: 0.05,
    recoil: {
      vertical: 0.0048,
      verticalGrowth: 0.05,
      verticalMaxMul: 1.6,
      horizontal: 0.0035,
      firstShotMul: 0.6,
      recovery: 0.35,
      adsMul: 0.85,
      crouchMul: 0.85,
      proneMul: 0.7,
    },
    kick: { camPitch: 0.005, camYaw: 0.003, camRoll: 0.006, vmBack: 0.022, vmUp: 0.008, vmRot: 0.035, shake: 0.035 },
    reloadTime: 2.1,
    reloadEmptyTime: 2.7,
    drawTime: 0.55,
    adsTime: 0.18,
    adsZoom: 0.8,
    scope: 'iron',
    moveSpeedMul: 0.98,
    sound: 'smg',
    loudness: 300,
    lootWeight: 0.9,
  },
  ar: {
    id: 'ar',
    category: 'weapon',
    slot: 'primary',
    ammo: 'ammo_556',
    magSize: 30,
    fireMode: 'auto',
    rpm: 690,
    damage: 41,
    pellets: 1,
    headMul: 2.2,
    limbMul: 0.9,
    falloffStart: 60,
    falloffEnd: 250,
    falloffMinMul: 0.7,
    hitscan: true,
    muzzleVelocity: 880,
    drag: 0,
    gravityScale: 0,
    range: 600,
    spreadHip: 0.03,
    spreadAds: 0.0035,
    spreadMove: 0.025,
    spreadAir: 0.1,
    pelletSpread: 0,
    bloomPerShot: 0.0048,
    bloomMax: 0.016,
    bloomRecovery: 0.04,
    recoil: {
      vertical: 0.0058,
      verticalGrowth: 0.055,
      verticalMaxMul: 1.75,
      horizontal: 0.003,
      firstShotMul: 0.7,
      recovery: 0.3,
      adsMul: 0.8,
      crouchMul: 0.82,
      proneMul: 0.65,
    },
    kick: { camPitch: 0.008, camYaw: 0.004, camRoll: 0.008, vmBack: 0.032, vmUp: 0.012, vmRot: 0.05, shake: 0.05 },
    reloadTime: 2.3,
    reloadEmptyTime: 3.0,
    drawTime: 0.7,
    adsTime: 0.22,
    adsZoom: 0.8,
    scope: 'reddot',
    moveSpeedMul: 0.94,
    sound: 'rifle',
    loudness: 450,
    lootWeight: 0.8,
  },
  shotgun: {
    id: 'shotgun',
    category: 'weapon',
    slot: 'primary',
    ammo: 'ammo_12g',
    magSize: 5,
    fireMode: 'pump',
    rpm: 70,
    damage: 24,
    pellets: 9,
    headMul: 2.0,
    limbMul: 0.9,
    falloffStart: 8,
    falloffEnd: 35,
    falloffMinMul: 0.3,
    hitscan: true,
    muzzleVelocity: 400,
    drag: 0,
    gravityScale: 0,
    range: 120,
    spreadHip: 0.02,
    spreadAds: 0.012,
    spreadMove: 0.015,
    spreadAir: 0.06,
    pelletSpread: 0.048,
    bloomPerShot: 0.01,
    bloomMax: 0.01,
    bloomRecovery: 0.03,
    recoil: {
      vertical: 0.045,
      verticalGrowth: 0,
      verticalMaxMul: 1,
      horizontal: 0.008,
      firstShotMul: 1.0,
      recovery: 0.4,
      adsMul: 0.9,
      crouchMul: 0.85,
      proneMul: 0.75,
    },
    kick: { camPitch: 0.035, camYaw: 0.008, camRoll: 0.02, vmBack: 0.09, vmUp: 0.04, vmRot: 0.16, shake: 0.22 },
    reloadTime: 2.75,
    reloadEmptyTime: 3.3,
    reloadPerShell: 0.55,
    drawTime: 0.75,
    adsTime: 0.25,
    adsZoom: 0.8,
    scope: 'iron',
    moveSpeedMul: 0.93,
    sound: 'shotgun',
    loudness: 350,
    lootWeight: 0.7,
  },
  dmr: {
    id: 'dmr',
    category: 'weapon',
    slot: 'primary',
    ammo: 'ammo_762',
    magSize: 10,
    fireMode: 'semi',
    rpm: 300,
    damage: 52,
    pellets: 1,
    headMul: 2.3,
    limbMul: 0.9,
    falloffStart: 150,
    falloffEnd: 800,
    falloffMinMul: 0.8,
    hitscan: false,
    muzzleVelocity: 850,
    drag: 0.15,
    gravityScale: 1,
    range: 1000,
    spreadHip: 0.04,
    spreadAds: 0.0012,
    spreadMove: 0.04,
    spreadAir: 0.12,
    pelletSpread: 0,
    bloomPerShot: 0.015,
    bloomMax: 0.02,
    bloomRecovery: 0.05,
    recoil: {
      vertical: 0.022,
      verticalGrowth: 0.12,
      verticalMaxMul: 1.5,
      horizontal: 0.006,
      firstShotMul: 1.0,
      recovery: 0.28,
      adsMul: 0.75,
      crouchMul: 0.85,
      proneMul: 0.6,
    },
    kick: { camPitch: 0.02, camYaw: 0.006, camRoll: 0.014, vmBack: 0.06, vmUp: 0.025, vmRot: 0.1, shake: 0.12 },
    reloadTime: 2.6,
    reloadEmptyTime: 3.4,
    drawTime: 0.8,
    adsTime: 0.3,
    adsZoom: 0.25,
    scope: 'x4',
    moveSpeedMul: 0.9,
    sound: 'dmr',
    loudness: 600,
    lootWeight: 0.25,
  },
  sniper: {
    id: 'sniper',
    category: 'weapon',
    slot: 'primary',
    ammo: 'ammo_300',
    magSize: 5,
    fireMode: 'bolt',
    rpm: 40,
    damage: 80,
    pellets: 1,
    headMul: 2.5,
    limbMul: 0.9,
    falloffStart: 300,
    falloffEnd: 1000,
    falloffMinMul: 0.8,
    hitscan: false,
    muzzleVelocity: 760,
    drag: 0.12,
    gravityScale: 1,
    range: 1000,
    spreadHip: 0.06,
    spreadAds: 0.0003,
    spreadMove: 0.06,
    spreadAir: 0.15,
    pelletSpread: 0,
    bloomPerShot: 0.01,
    bloomMax: 0.01,
    bloomRecovery: 0.02,
    recoil: {
      vertical: 0.04,
      verticalGrowth: 0,
      verticalMaxMul: 1,
      horizontal: 0.006,
      firstShotMul: 1.0,
      recovery: 0.3,
      adsMul: 0.8,
      crouchMul: 0.85,
      proneMul: 0.6,
    },
    kick: { camPitch: 0.05, camYaw: 0.01, camRoll: 0.025, vmBack: 0.11, vmUp: 0.045, vmRot: 0.2, shake: 0.3 },
    reloadTime: 2.9,
    reloadEmptyTime: 3.8,
    drawTime: 0.9,
    adsTime: 0.35,
    adsZoom: 0.125,
    scope: 'x8',
    moveSpeedMul: 0.86,
    sound: 'sniper',
    loudness: 800,
    lootWeight: 0.12,
  },
};

// ============================================================================
// Ammo, consumables, throwables, gear
// ============================================================================

/** `stack` = rounds in one loot pile; `weight` = capacity per round. */
export const AMMO: Record<AmmoId, AmmoDef> = {
  ammo_9mm: { id: 'ammo_9mm', category: 'ammo', stack: 30, weight: 0.25 },
  ammo_556: { id: 'ammo_556', category: 'ammo', stack: 30, weight: 0.4 },
  ammo_762: { id: 'ammo_762', category: 'ammo', stack: 20, weight: 0.5 },
  ammo_12g: { id: 'ammo_12g', category: 'ammo', stack: 10, weight: 1.0 },
  ammo_300: { id: 'ammo_300', category: 'ammo', stack: 10, weight: 0.8 },
};

/**
 * Healing items restore `heal` health but never above `healCap` (first aid therefore "sets to 75").
 * Fuel's effect (refuelling a vehicle) is handled by the simulation.
 */
export const CONSUMABLES: Record<ConsumableId, ConsumableDef> = {
  bandage: { id: 'bandage', category: 'consumable', useTime: 4, heal: 10, healCap: 75, boost: 0, moveMul: 0.8, weight: 2, stack: 5 },
  firstaid: { id: 'firstaid', category: 'consumable', useTime: 6, heal: 75, healCap: 75, boost: 0, moveMul: 0.6, weight: 10, stack: 1 },
  medkit: { id: 'medkit', category: 'consumable', useTime: 8, heal: 100, healCap: 100, boost: 0, moveMul: 0.4, weight: 20, stack: 1 },
  energy: { id: 'energy', category: 'consumable', useTime: 4, heal: 0, healCap: 0, boost: 40, moveMul: 0.8, weight: 4, stack: 1 },
  fuel: { id: 'fuel', category: 'consumable', useTime: 5, heal: 0, healCap: 0, boost: 0, moveMul: 0.4, weight: 20, stack: 1 },
};

export const THROWABLES: Record<ThrowableId, ThrowableDef> = {
  frag: { id: 'frag', category: 'throwable', fuse: 4, damage: 120, radius: 7, throwSpeed: 18, weight: 12 },
};

export const GEAR: Record<GearId, GearDef> = {
  vest1: { id: 'vest1', category: 'gear', kind: 'vest', level: 1, reduction: 0.3, durability: 200, capacity: 50 },
  vest2: { id: 'vest2', category: 'gear', kind: 'vest', level: 2, reduction: 0.4, durability: 220, capacity: 50 },
  vest3: { id: 'vest3', category: 'gear', kind: 'vest', level: 3, reduction: 0.55, durability: 250, capacity: 50 },
  helmet1: { id: 'helmet1', category: 'gear', kind: 'helmet', level: 1, reduction: 0.3, durability: 80, capacity: 0 },
  helmet2: { id: 'helmet2', category: 'gear', kind: 'helmet', level: 2, reduction: 0.4, durability: 150, capacity: 0 },
  helmet3: { id: 'helmet3', category: 'gear', kind: 'helmet', level: 3, reduction: 0.55, durability: 230, capacity: 0 },
  pack1: { id: 'pack1', category: 'gear', kind: 'pack', level: 1, reduction: 0, durability: 0, capacity: 100 },
  pack2: { id: 'pack2', category: 'gear', kind: 'pack', level: 2, reduction: 0, durability: 0, capacity: 150 },
  pack3: { id: 'pack3', category: 'gear', kind: 'pack', level: 3, reduction: 0, durability: 0, capacity: 200 },
};

// ============================================================================
// Registries & type guards
// ============================================================================

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];
export const AMMO_IDS = Object.keys(AMMO) as AmmoId[];
export const CONSUMABLE_IDS = Object.keys(CONSUMABLES) as ConsumableId[];
export const THROWABLE_IDS = Object.keys(THROWABLES) as ThrowableId[];
export const GEAR_IDS = Object.keys(GEAR) as GearId[];

export const ITEMS: Record<ItemId, ItemDef> = {
  ...WEAPONS,
  ...AMMO,
  ...CONSUMABLES,
  ...THROWABLES,
  ...GEAR,
};

export const ALL_ITEM_IDS: ItemId[] = [
  ...WEAPON_IDS, ...AMMO_IDS, ...CONSUMABLE_IDS, ...THROWABLE_IDS, ...GEAR_IDS,
];

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isWeaponId(id: string): id is WeaponId { return has(WEAPONS, id); }
export function isAmmoId(id: string): id is AmmoId { return has(AMMO, id); }
export function isConsumableId(id: string): id is ConsumableId { return has(CONSUMABLES, id); }
export function isThrowableId(id: string): id is ThrowableId { return has(THROWABLES, id); }
export function isGearId(id: string): id is GearId { return has(GEAR, id); }
export function isItemId(id: string): id is ItemId { return has(ITEMS, id); }

export function itemCategory(id: ItemId): ItemCategory {
  return ITEMS[id].category;
}

/** Gear id for a kind/level pair (level 0 = none). */
export function gearIdFor(kind: 'vest' | 'helmet' | 'pack', level: 0 | 1 | 2 | 3): GearId | null {
  return level === 0 ? null : (`${kind}${level}` as GearId);
}

/** Capacity used by one unit of an item. Weapons and gear do not use capacity. */
export function itemWeight(id: ItemId): number {
  const d = ITEMS[id];
  switch (d.category) {
    case 'ammo':
    case 'consumable':
    case 'throwable':
      return d.weight;
    default:
      return 0;
  }
}
