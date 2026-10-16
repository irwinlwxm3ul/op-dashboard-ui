import { TERRAIN_RES, TRAINING_MAP_SIZE } from '../constants';
import { Heightfield } from './heightfield';
import { GeneratedWorld } from './worldImpl';

export function generateTraining(seed: number): GeneratedWorld {
  const hf = new Heightfield(TRAINING_MAP_SIZE, TERRAIN_RES);
  hf.h.fill(3);
  const w = new GeneratedWorld(seed, 'training', hf);
  w.training = { spawn: { x: 0, y: 3, z: 300 }, spawnYaw: 0, racks: [], targets: [], firingLine: { x: 0, y: 3, z: 300 } };
  w.reindexBoxes();
  w.reindexVegetation();
  return w;
}
