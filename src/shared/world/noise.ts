// Fast seeded 2D value noise for world generation (permutation-table lattice instead of hashing
// every corner). Deterministic: the tables come from the seeded Rng; evaluation is plain arithmetic.

import { Rng } from '../rng';

export class Noise2 {
  private readonly perm = new Uint16Array(512);
  private readonly vals = new Float64Array(256);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p: number[] = [];
    for (let i = 0; i < 256; i++) {
      p.push(i);
      this.vals[i] = rng.next() * 2 - 1;
    }
    rng.shuffle(p);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Smooth value noise in [-1, 1]. */
  value(x: number, y: number): number {
    const xf = Math.floor(x), yf = Math.floor(y);
    const xi = xf & 255, yi = yf & 255;
    const tx = x - xf, ty = y - yf;
    const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
    const perm = this.perm, vals = this.vals;
    const p0 = perm[xi], p1 = perm[xi + 1];
    const a = vals[perm[p0 + yi]], b = vals[perm[p1 + yi]];
    const c = vals[perm[p0 + yi + 1]], d = vals[perm[p1 + yi + 1]];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** Fractal sum, normalised to roughly [-1, 1]. Octaves are offset to decorrelate them. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.value(x * freq + i * 37.17, y * freq - i * 19.73);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
