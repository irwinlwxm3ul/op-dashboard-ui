// Trees (clustered into forests by noise), rocks (favouring slopes, peaks and coasts) and bushes.

import type { TreeKind } from '../types';
import { fbm2, Rng } from '../rng';
import { M_APRON, M_BUILDING, M_NOVEG, M_PROP, M_ROAD, M_ROCK, M_TOWN, M_TREE, OccupancyMask } from './mask';
import type { GeneratedWorld } from './worldImpl';

export interface VegetationParams {
  trees: number;
  rocks: number;
  bushes: number;
  noiseSeed: number;
  /** Lowest terrain height for trees / bushes (keeps them off beaches and out of water). */
  minLandH: number;
  /** Additional exclusion (e.g. firing range corridor). */
  exclude?: (x: number, z: number) => boolean;
  /** Forest density bias added to the noise (higher = more uniform cover). */
  forestBias?: number;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const TREE_BLOCK = M_ROAD | M_BUILDING | M_APRON | M_PROP | M_TOWN | M_TREE | M_ROCK | M_NOVEG;
const ROCK_BLOCK = M_ROAD | M_BUILDING | M_APRON | M_PROP | M_TOWN | M_TREE | M_ROCK | M_NOVEG;
const BUSH_BLOCK = M_ROAD | M_BUILDING | M_APRON | M_PROP | M_ROCK | M_NOVEG;

/** Forest density field in [0, 1]. */
export function forestDensity(seed: number, x: number, z: number, bias = 0): number {
  const n = fbm2(seed, x / 170 + 3.7, z / 170 - 8.1, 4) + bias;
  return smooth(-0.02, 0.28, n);
}

export function placeVegetation(world: GeneratedWorld, mask: OccupancyMask, rng: Rng, p: VegetationParams): void {
  const hf = world.hf;
  const lim = world.half - 6;
  const bias = p.forestBias ?? 0;

  // ---- Trees -----------------------------------------------------------------------------------
  for (let attempts = 0, max = p.trees * 80; world.trees.length < p.trees && attempts < max; attempts++) {
    const x = r2(rng.range(-lim, lim)), z = r2(rng.range(-lim, lim));
    const dens = 0.025 + 0.975 * forestDensity(p.noiseSeed, x, z, bias);
    if (rng.next() > dens) continue;
    if (mask.get(x, z) & TREE_BLOCK) continue;
    const h = hf.heightAt(x, z);
    if (h < p.minLandH || hf.flatness(x, z) < 0.74) continue;
    if (p.exclude && p.exclude(x, z)) continue;
    const alt = h > 45 ? 1 : h > 25 ? 0.5 : 0;
    const roll = rng.next();
    let kind: TreeKind;
    if (roll < 0.04 + alt * 0.04) kind = 'dead';
    else if (roll < 0.35 + alt * 0.45) kind = 'pine';
    else if (roll < 0.7 + alt * 0.2) kind = 'oak';
    else kind = 'birch';
    const height = kind === 'pine' ? rng.range(9, 16) : kind === 'dead' ? rng.range(6, 10) : kind === 'birch' ? rng.range(7, 13) : rng.range(7, 14);
    const r = Math.min(0.5, Math.max(0.2, 0.2 + (height - 6) * 0.025 + rng.range(-0.03, 0.05)));
    const base = Math.min(hf.heightAt(x - r, z), hf.heightAt(x + r, z), hf.heightAt(x, z - r), hf.heightAt(x, z + r), h);
    world.trees.push({ x, y: r3(base - 0.05), z, kind, scale: r3(height / 10), r: r3(r), h: r2(height), rot: r3(rng.range(0, Math.PI * 2)) });
    mask.markCircle(x, z, 1.6, M_TREE);
  }

  // ---- Rocks -----------------------------------------------------------------------------------
  for (let attempts = 0, max = p.rocks * 120; world.rocks.length < p.rocks && attempts < max; attempts++) {
    const x = r2(rng.range(-lim, lim)), z = r2(rng.range(-lim, lim));
    const h = hf.heightAt(x, z);
    if (h < 0.4) continue;
    if (p.exclude && p.exclude(x, z)) continue;
    const steep = 1 - hf.flatness(x, z);
    const chance = 0.1 + steep * 2.5 + (h > 35 ? 0.3 : 0) + (h < 3 ? 0.12 : 0);
    if (rng.next() > chance) continue;
    const large = rng.chance(0.14);
    const r = large ? rng.range(2.0, 4.2) : rng.range(0.35, 1.5);
    const rh = large ? rng.range(1.6, 3.4) : r * rng.range(0.55, 1.0);
    if (mask.anyCircle(x, z, r + 0.8, ROCK_BLOCK)) continue;
    const range = hf.rangeIn(x - r, z - r, x + r, z + r);
    world.rocks.push({ x, y: r3(range.min - rh * 0.12), z, r: r3(r), h: r3(rh), rot: r3(rng.range(0, Math.PI * 2)), seed: rng.int(1, 0x7ffffffe) });
    mask.markCircle(x, z, r + 0.5, M_ROCK);
  }

  // ---- Bushes (no collision) -------------------------------------------------------------------
  for (let attempts = 0, max = p.bushes * 60; world.bushes.length < p.bushes && attempts < max; attempts++) {
    const x = r2(rng.range(-lim, lim)), z = r2(rng.range(-lim, lim));
    const dens = 0.2 + 0.8 * forestDensity(p.noiseSeed, x, z, bias + 0.15);
    if (rng.next() > dens) continue;
    if (mask.get(x, z) & BUSH_BLOCK) continue;
    const h = hf.heightAt(x, z);
    if (h < p.minLandH - 0.4 || hf.flatness(x, z) < 0.65) continue;
    if (p.exclude && p.exclude(x, z)) continue;
    world.bushes.push({ x, y: r3(h - 0.05), z, scale: r3(rng.range(0.6, 1.5)) });
  }
  world.reindexVegetation();
}
