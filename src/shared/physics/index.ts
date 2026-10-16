// Public API of the physics module: character controller, drop movement, world raycasts,
// hitboxes and generic collision helpers. See ARCHITECTURE.md ("src/shared/physics").
//
// Everything here is deterministic, allocation-light and free of DOM / Node / three.js so it runs
// identically on the server, in the local-match worker and in client prediction.

export type { MoveIntent, MoveEvents, HitboxPose } from './types';
export { createMoveEvents, createMoveIntent, resetMoveEvents } from './types';

// Character controller (ground / swim) and drop (freefall / parachute).
export { stepCharacter } from './character';
export { stepDrop } from './drop';
export { bodyHeight, eyePosition } from './body';
export { canStand, collideCircleXZ } from './colliders';
export type { CirclePush } from './colliders';

// World ray casts.
export { raycastWorld, lineOfSight, prepareRaycastWorld } from './raycast';

// Hitboxes.
export { buildHitboxes, raycastHitboxes, rayCapsule, hitboxCount, hitboxBounds } from './hitboxes';

// Tuning values (read-only) for consumers that want to mirror controller behaviour
// (camera smoothing, prediction error thresholds, bot movement planning).
export * as PhysicsTuning from './tuning';
