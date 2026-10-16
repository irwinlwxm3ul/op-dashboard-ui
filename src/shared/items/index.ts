// Public API of the items module: item definitions, combat math, ballistics, inventory rules and
// loot tables. Other modules import only from here.

export {
  WEAPONS, AMMO, CONSUMABLES, THROWABLES, GEAR, ITEMS, ALL_ITEM_IDS,
  WEAPON_IDS, AMMO_IDS, CONSUMABLE_IDS, THROWABLE_IDS, GEAR_IDS,
  BASE_CAPACITY, ZERO_RANGE,
  itemCategory, isWeaponId, isAmmoId, isConsumableId, isThrowableId, isGearId, isItemId,
  gearIdFor, itemWeight,
} from './defs';

export {
  fireInterval, spreadCone, shotDirections, recoilForShot, recoverRecoil, recoilPattern, recoilMul,
  computeDamage, applyArmorDamage, falloffMul, partMultiplier, fragDamage,
  SPREAD_STANCE_MUL, MAX_SPREAD, RECOIL_JITTER_FRAC, UNARMED_RECOVERY,
} from './combat';
export type { SpreadContext, RecoilKick, DamageResult } from './combat';

export {
  stepBallistic, simulateTrajectory, zeroAngle, launchVelocity, sightZeroAngle, sightDrop, BALLISTIC_SUBSTEP,
} from './ballistics';

export {
  capacity, usedCapacity, roomFor, pickupItem, removeItem, applyConsumable, canUseConsumable,
  tickBoost, boostHealRate, boostSpeedMul, emptyInventory, BOOST_DECAY_PER_SEC,
} from './inventory';
export type { PickupResult } from './inventory';

export { rollLoot } from './loot';
export type { LootRoll } from './loot';
