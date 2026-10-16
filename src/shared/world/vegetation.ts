// Trees (clustered into forests by noise), rocks (favouring slopes, peaks and coasts) and bushes.

import type { TreeKind } from '../types';
import { Rng } from '../rng';
import { Noise2 } from './noise';
import { M_APRON, M_BUILDING, M_NOVEG, M_PROP, M_ROAD, M_ROCK, M_TOWN, M_TREE, OccupancyMask } from './mask';
import type { GeneratedWorld } from './worldImpl';

export interface VegetationParams {
  trees: number;
  rocks: number;
  bushes: number;
  noiseSeed: number;
  /** Lowest terrain height for trees / bushes (keeps them off beaches and out of water). */
  minLandH: number;
  /** Candidates are drawn from [-extent, extent]^2 (defaults to the whole map). */
  extent?: number;
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

/** Forest noise sampled on an 8 m lattice and bilinearly interpolated (cheap per-candidate lookups). */
export class ForestField {
  private readonly n: number;
  private readonly half: number;
  private readonly step = 8;
  private readonly v: Float32Array;

  constructor(seed: number, size: number) {
    const noise = new Noise2(seed);
    this.half = size / 2;
    this.n = Math.ceil(size / this.step) + 1;
    this.v = new Float32Array(this.n * this.n);
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const x = -this.half + i * this.step, z = -this.half + j * this.step;
        this.v[j * this.n + i] = noise.fbm(x / 170 + 3.7, z / 170 - 8.1, 4);
      }
    }
  }

  raw(x: number, z: number): number {
    const n = this.n;
    let fx = (x + this.half) / this.step, fz = (z + this.half) / this.step;
    fx = Math.min(n - 1.001, Math.max(0, fx));
    fz = Math.min(n - 1.001, Math.max(0, fz));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const v = this.v, k = j * n + i;
    const a = v[k] + (v[k + 1] - v[k]) * tx, b = v[k + n] + (v[k + n + 1] - v[k + n]) * tx;
    return a + (b - a) * tz;
  }

  /** Forest density in [0, 1]. */
  density(x: number, z: number, bias = 0): number {
    return smooth(-0.02, 0.28, this.raw(x, z) + bias);
  }
}

export function placeVegetation(world: GeneratedWorld, mask: OccupancyMask, rng: Rng, p: VegetationParams): void {
  const hf = world.hf;
  const lim = Math.min(world.half - 6, p.extent ?? Infinity);
  const bias = p.forestBias ?? 0;
  const forest = new ForestField(p.noiseSeed, world.size);

  // ---- Trees -----------------------------------------------------------------------------------
  for (let attempts = 0, max = p.trees * 80; world.trees.length < p.trees && attempts < max; attempts++) {
    const x = r2(rng.range(-lim, lim)), z = r2(rng.range(-lim, lim));
    const dens = 0.025 + 0.975 * forest.density(x, z, bias);
    const roll = rng.next();
    if (mask.get(x, z) & TREE_BLOCK || roll > dens) continue;
    const h = hf.heightAt(x, z);
    if (h < p.minLandH || hf.flatness(x, z) < 0.74) continue;
    if (p.exclude && p.exclude(x, z)) continue;
    const alt = h > 45 ? 1 : h > 25 ? 0.5 : 0;
    const kr = rng.next();
    let kind: TreeKind;
    if (kr < 0.04 + alt * 0.04) kind = 'dead';
    else if (kr < 0.35 + alt * 0.45) kind = 'pine';
    else if (kr < 0.7 + alt * 0.2) kind = 'oak';
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
    world.rocks.push({ x, y: r3(range.min - 0.05), z, r: r3(r), h: r3(rh), rot: r3(rng.range(0, Math.PI * 2)), seed: rng.int(1, 0x7ffffffe) });
    mask.markCircle(x, z, r + 0.5, M_ROCK);
  }

  // ---- Bushes (no collision) -------------------------------------------------------------------
  for (let attempts = 0, max = p.bushes * 60; world.bushes.length < p.bushes && attempts < max; attempts++) {
    const x = r2(rng.range(-lim, lim)), z = r2(rng.range(-lim, lim));
    const dens = 0.2 + 0.8 * forest.density(x, z, bias + 0.15);
    const roll = rng.next();
    if (mask.get(x, z) & BUSH_BLOCK || roll > dens) continue;
    const h = hf.heightAt(x, z);
    if (h < p.minLandH - 0.4 || hf.flatness(x, z) < 0.65) continue;
    if (p.exclude && p.exclude(x, z)) continue;
    world.bushes.push({ x, y: r3(h - 0.05), z, scale: r3(rng.range(0.6, 1.5)) });
  }
  world.reindexVegetation();
}
