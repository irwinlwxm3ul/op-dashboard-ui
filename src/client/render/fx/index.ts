// FX renderer (render-view-fx module): tracers, ballistic bullet streaks, third-person muzzle
// flashes, impacts (per material) with decals, blood mist / armor sparks, explosions (fireball,
// smoke column, debris, shock ring, flash light, scorch), frags in flight, casings, landing dust,
// parachute puffs and water splashes. See fxRenderer.ts for the frame flow.

import type { CreateFxRenderer } from '../contracts';
import { createFx } from './fxRenderer';

export const createFxRenderer: CreateFxRenderer = (core, world, events) => createFx(core, world, events);

export { approxMuzzle, localMuzzle, segmentHitsPlayer, segmentVerticalCapsule } from './muzzle';
export { streakLength } from './bullets';
