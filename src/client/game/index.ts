// Client game state: ClientGame (netcode heart), settings store, input controller and the
// prediction helpers shared with tests. Types live in ./types (fixed contract).

export { ClientGame, SNAP_DISTANCE } from './ClientGame';
export type { ClientGameOptions } from './ClientGame';
export { settings, LocalSettingsStore, DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, sanitizeSettings } from './settings';
export type { StorageLike } from './settings';
export { DEFAULT_KEYBINDS, KEY_ACTIONS, isKeyAction } from './keybinds';
export { InputController, LOOK_RAD_PER_PX, PITCH_LIMIT } from './input';
export type { InputContext } from './input';
export { EventBus } from './events';
export { ClockSync, RenderClock, PING_INTERVAL_MS } from './clock';
export { SampleRing, SmoothOffset, interpolatePlayer, interpolateVehicle, interpolateProjectile, makeBracket } from './interpolation';
export type { Bracket } from './interpolation';
export { resolveInteraction, interactionAction, firstFreeSeat, PROMPT_RANGE } from './interaction';
export type { InteractionEnv, InteractionSelf } from './interaction';
export { LootIndex } from './lootIndex';
export {
  predictTick, buildMoveIntent, movementSpeedMul, activeWeapon, canShootFrom, currentSpread, vehicleControls,
  createPredictRt, copyPredictRt, createTickEvents, createPredictedPlayer, applySelfState, vehicleFromNet,
  applyNetVehicle, planePositionAt, planeTraveledAt,
} from './predict';
export type { PredictEnv, PredictRt, TickEvents } from './predict';
export type * from './types';
