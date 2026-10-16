// Deterministic random helpers. Everything that must match between client and server
// (world generation, weapon spread, recoil jitter) must use these, never Math.random().

/** 32-bit integer hash of up to 4 integers (xxhash-like avalanche). */
export function hash32(a: number, b = 0, c = 0, d = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= Math.imul(b | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13), 0x165667b1);
  h ^= Math.imul(c | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca77);
  h ^= Math.imul(d | 0, 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash to float in [0,1). */
export const hashFloat = (a: number, b = 0, c = 0, d = 0): number => hash32(a, b, c, d) / 4294967296;

/** Seeded PRNG (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x12345678;
  }
  /** float in [0,1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Weighted pick: weights need not sum to 1. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
  /** Approximately normal(0,1). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

/** Smooth 2D value noise in [-1,1], seeded. */
export function valueNoise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hashFloat(seed, xi, yi), b = hashFloat(seed, xi + 1, yi);
  const c = hashFloat(seed, xi, yi + 1), d = hashFloat(seed, xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

/** Fractal Brownian motion of value noise. */
export function fbm2(seed: number, x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(seed + i * 1013, x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
