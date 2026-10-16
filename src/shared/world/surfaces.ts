// Terrain surface material table. `World.surface` stores per-vertex indices into SURFACE_LIST.

import type { SurfaceMaterial } from '../types';

export const SURFACE_LIST: SurfaceMaterial[] = [
  'grass', 'dirt', 'rock', 'sand', 'road', 'wood', 'concrete', 'metal', 'water', 'snow',
];

/** Index of each material in SURFACE_LIST. */
export const SURF: Readonly<Record<SurfaceMaterial, number>> = {
  grass: 0, dirt: 1, rock: 2, sand: 3, road: 4, wood: 5, concrete: 6, metal: 7, water: 8, snow: 9,
};
