// Water depth and swim-mode transitions shared by the character controller and drop movement.
// All functions expect `gatherNear` to have been called around the body this step.

import type { CharacterBody, World } from '../types';
import { supportHeight } from './colliders';
import type { MoveEvents } from './types';
import { SUPPORT_RADIUS, SWIM_ENTER_DEPTH, SWIM_SUBMERGE_DEPTH } from './tuning';

/** Height of whatever the body would stand on below feet height `y` (terrain, box tops, rocks). */
export function groundBelow(world: World, x: number, z: number, y: number): number {
  return supportHeight(world, x, z, y + 0.05, SUPPORT_RADIUS);
}

/** Water depth above the ground under a body whose feet are at `y` (negative = dry). */
export function waterDepthBelow(world: World, x: number, z: number, y: number): number {
  return world.waterLevel - groundBelow(world, x, z, y);
}

/** Whether a body with feet at `y` is deep enough in water to start swimming. */
export function shouldSwim(world: World, x: number, z: number, y: number): boolean {
  return y < world.waterLevel - SWIM_SUBMERGE_DEPTH && waterDepthBelow(world, x, z, y) > SWIM_ENTER_DEPTH;
}

/**
 * Switch a body into swim mode. Arriving from the air counts as a landing with landSpeed 0
 * (water absorbs the impact, so no fall damage); `enteredWater` is always reported.
 */
export function enterSwim(body: CharacterBody, out: MoveEvents, fromAir: boolean): void {
  body.mode = 'swim';
  body.stance = 'stand';
  body.onGround = false;
  body.airTime = 0;
  body.jumpBuffer = 0;
  body.fallSpeed = 0;
  // Vertical motion is taken over by the swim float controller (eases to swim height).
  body.vel.y = 0;
  out.enteredWater = true;
  if (fromAir) {
    out.landed = true;
    out.landSpeed = 0;
  }
}
