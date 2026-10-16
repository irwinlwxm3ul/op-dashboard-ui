// World generation public API. Worlds are deterministic functions of (seed, kind) and are cached
// per module instance, so the simulation, bots and renderers share one instance.

import type { MapKind, World } from '../types';
import { generateIsland } from './island';
import { generateTraining } from './training';

export { SURFACE_LIST } from './surfaces';

/** Bump when generation output changes so stale caches are never mixed with new worlds. */
const GEN_VERSION = 1;
/** Small LRU bound: a long-running server sees many seeds. */
const CACHE_LIMIT = 6;
const cache = new Map<string, World>();

export function worldCacheKey(seed: number, kind: MapKind): string {
  return `${kind}:${seed >>> 0}:v${GEN_VERSION}`;
}

/** Build a world without touching the cache (used by tests and tools). */
export function generateWorldUncached(seed: number, kind: MapKind): World {
  const s = seed >>> 0;
  return kind === 'training' ? generateTraining(s) : generateIsland(s);
}

export function generateWorld(seed: number, kind: MapKind): World {
  const key = worldCacheKey(seed, kind);
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const world = generateWorldUncached(seed, kind);
  cache.set(key, world);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return world;
}

/** Drop all cached worlds. */
export function clearWorldCache(): void {
  cache.clear();
}
