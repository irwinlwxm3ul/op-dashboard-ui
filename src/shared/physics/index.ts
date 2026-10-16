// Public API of the physics module: character controller, drop movement, world raycasts,
// hitboxes and generic collision helpers. See ARCHITECTURE.md ("src/shared/physics").

export type { MoveIntent, MoveEvents, HitboxPose } from './types';
export { createMoveEvents, createMoveIntent, resetMoveEvents } from './types';
export { stepCharacter } from './character';
export { stepDrop } from './drop';
export { bodyHeight, eyePosition } from './body';
export { canStand, collideCircleXZ } from './colliders';
export type { CirclePush } from './colliders';
export { raycastWorld, lineOfSight } from './raycast';
export { buildHitboxes, raycastHitboxes, rayCapsule, hitboxCount, hitboxBounds } from './hitboxes';
export * as PhysicsTuning from './tuning';
