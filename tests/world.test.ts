import { describe, expect, it } from 'vitest';
import { MAP_SIZE, TERRAIN_RES, TRAINING_MAP_SIZE, WATER_LEVEL } from '../src/shared/constants';
import type { BuildingDef, ItemId, RockDef, SurfaceMaterial, TreeDef, Vec3, World, WorldBox } from '../src/shared/types';
import { Rng } from '../src/shared/rng';
import {
  SURFACE_LIST, clearWorldCache, generateWorld, generateWorldUncached, worldCacheKey,
} from '../src/shared/world';

const SEED = 20241;
const island = (): World => generateWorld(SEED, 'island');
const training = (): World => generateWorld(SEED, 'training');

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** FNV-1a over numbers (rounded to 1e-4) for content hashing. */
function hashWorld(w: World): string {
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    const q = Math.round(v * 1e4) | 0;
    for (let k = 0; k < 4; k++) {
      h ^= (q >>> (k * 8)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  };
  for (let i = 0; i < w.heights.length; i++) mix(w.heights[i]);
  for (let i = 0; i < w.surface.length; i++) mix(w.surface[i]);
  for (const b of w.boxes) { mix(b.min.x); mix(b.min.y); mix(b.min.z); mix(b.max.x); mix(b.max.y); mix(b.max.z); mix(b.color); mix(b.building); }
  for (const t of w.trees) { mix(t.x); mix(t.y); mix(t.z); mix(t.r); mix(t.h); }
  for (const r of w.rocks) { mix(r.x); mix(r.y); mix(r.z); mix(r.r); mix(r.h); mix(r.seed); }
  for (const b of w.bushes) { mix(b.x); mix(b.z); mix(b.scale); }
  for (const l of w.lootSpawns) { mix(l.pos.x); mix(l.pos.y); mix(l.pos.z); mix(l.tier); }
  for (const v of w.vehicleSpawns) { mix(v.pos.x); mix(v.pos.z); mix(v.yaw); }
  for (const r of w.roads) { mix(r.a.x); mix(r.a.z); mix(r.b.x); mix(r.b.z); mix(r.width); }
  const names = w.towns.map((t) => `${t.name}@${t.x},${t.z}`).join('|') + w.buildings.map((b) => b.style).join(',');
  for (let i = 0; i < names.length; i++) mix(names.charCodeAt(i));
  return (h >>> 0).toString(16);
}

function strictlyInside(b: WorldBox, p: Vec3, eps = 1e-6): boolean {
  return p.x > b.min.x + eps && p.x < b.max.x - eps && p.y > b.min.y + eps && p.y < b.max.y - eps && p.z > b.min.z + eps && p.z < b.max.z - eps;
}

function circleHitsRect(x: number, z: number, r: number, b: WorldBox): boolean {
  const cx = Math.min(Math.max(x, b.min.x), b.max.x), cz = Math.min(Math.max(z, b.min.z), b.max.z);
  return (cx - x) ** 2 + (cz - z) ** 2 < r * r;
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

function buildingBoxes(w: World, b: BuildingDef): WorldBox[] {
  return b.boxIds.map((id) => w.boxes[id]);
}

/** Ground-floor walking height: lowest 'floor' slab top of the building. */
function groundFloorY(w: World, b: BuildingDef): number {
  return Math.min(...buildingBoxes(w, b).filter((x) => x.kind === 'floor').map((x) => x.max.y));
}

/** Is there a clear 1.3 m wide, 2.2 m tall opening through an exterior wall at ground floor? */
function hasDoorGap(w: World, b: BuildingDef): boolean {
  const y0 = groundFloorY(w, b) + 0.05, y1 = groundFloorY(w, b) + 2.15;
  const near = w.queryBoxes(b.min.x - 2, b.min.z - 2, b.max.x + 2, b.max.z + 2, []).slice();
  const clear = (x0: number, z0: number, x1: number, z1: number): boolean =>
    !near.some((o) => o.min.x < x1 && o.max.x > x0 && o.min.z < z1 && o.max.z > z0 && o.min.y < y1 && o.max.y > y0);
  const W = 1.3;
  for (let x = b.min.x; x + W <= b.max.x; x += 0.05) {
    if (clear(x, b.min.z - 0.4, x + W, b.min.z + 0.6)) return true;
    if (clear(x, b.max.z - 0.6, x + W, b.max.z + 0.4)) return true;
  }
  for (let z = b.min.z; z + W <= b.max.z; z += 0.05) {
    if (clear(b.min.x - 0.4, z, b.min.x + 0.6, z + W)) return true;
    if (clear(b.max.x - 0.6, z, b.max.x + 0.4, z + W)) return true;
  }
  return false;
}

/**
 * Character navigation flood fill around one building, emulating the controller: a 0.35 m radius,
 * 1.8 m tall cylinder that is blocked by boxes rising more than 0.45 m above its feet, steps up
 * onto the highest box top within 0.45 m under a 0.28 m support disc and needs head room when
 * stepping up. Returns floor-slab standing spots of the building that cannot be reached from the
 * terrain outside.
 */
function unreachableFloorSpots(w: World, b: BuildingDef): { unreachable: number; total: number } {
  const R = 0.35, H = 1.8, STEP = 0.45, SUP = 0.28, RES = 0.2, margin = 3;
  const x0 = b.min.x - margin, z0 = b.min.z - margin;
  const nx = Math.ceil((b.max.x + margin - x0) / RES), nz = Math.ceil((b.max.z + margin - z0) / RES);
  const all = w.queryBoxes(x0 - 1, z0 - 1, b.max.x + margin + 1, b.max.z + margin + 1, []).slice();
  const cx = (i: number): number => x0 + (i + 0.5) * RES, cz = (j: number): number => z0 + (j + 0.5) * RES;
  const cells: WorldBox[][] = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) cells.push(all.filter((o) => circleHitsRect(cx(i), cz(j), R + 0.01, o)));
  const support = (c: number, ref: number): number => {
    const i = c % nx, j = (c - i) / nx;
    let h = w.heightAt(cx(i), cz(j));
    for (const o of cells[c]) if (o.max.y > h && o.max.y <= ref && circleHitsRect(cx(i), cz(j), SUP, o)) h = o.max.y;
    return h;
  };
  const seen = new Map<number, Set<number>>();
  const stack: [number, number][] = [];
  const visit = (c: number, y: number): void => {
    const k = Math.round(y * 100);
    let s = seen.get(c);
    if (!s) seen.set(c, (s = new Set()));
    if (!s.has(k)) { s.add(k); stack.push([c, y]); }
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (i > 1 && j > 1 && i < nx - 2 && j < nz - 2) continue;
    visit(j * nx + i, w.heightAt(cx(i), cz(j)));
  }
  while (stack.length) {
    const [c, y] = stack.pop() as [number, number];
    const i = c % nx, j = (c - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const nc = nj * nx + ni;
      if (cells[nc].some((o) => o.max.y > y + STEP && o.min.y < y + H && circleHitsRect(cx(ni), cz(nj), R, o))) continue;
      const sup = support(nc, y + STEP);
      if (sup > y && cells[nc].some((o) => o.min.y < sup + H && o.max.y > y + H && circleHitsRect(cx(ni), cz(nj), R - 0.02, o))) continue;
      visit(nc, sup);
    }
  }
  let total = 0, unreachable = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i, x = cx(i), z = cz(j);
    for (const f of cells[c]) {
      if (f.building !== b.id || f.kind !== 'floor' || x < f.min.x || x > f.max.x || z < f.min.z || z > f.max.z) continue;
      const top = f.max.y;
      if (cells[c].some((o) => o.max.y > top + 0.02 && o.min.y < top + H && circleHitsRect(x, z, R, o))) continue;
      if (support(c, top + 0.01) !== top) continue;
      total++;
      if (!seen.get(c)?.has(Math.round(top * 100))) unreachable++;
    }
  }
  return { unreachable, total };
}

// ---------------------------------------------------------------------------------------------
// API, determinism, performance
// ---------------------------------------------------------------------------------------------

describe('world API', () => {
  it('exposes the surface table and cache keys', () => {
    const mats: SurfaceMaterial[] = ['grass', 'dirt', 'rock', 'sand', 'road', 'wood', 'concrete', 'metal', 'water', 'snow'];
    for (const m of mats) expect(SURFACE_LIST).toContain(m);
    expect(new Set(SURFACE_LIST).size).toBe(SURFACE_LIST.length);
    expect(worldCacheKey(5, 'island')).not.toBe(worldCacheKey(5, 'training'));
    expect(worldCacheKey(5, 'island')).not.toBe(worldCacheKey(6, 'island'));
    expect(worldCacheKey(5, 'island')).toBe(worldCacheKey(5, 'island'));
  });

  it('caches worlds per (seed, kind)', () => {
    const a = island();
    expect(generateWorld(SEED, 'island')).toBe(a);
    expect(generateWorld(SEED, 'training')).not.toBe(a);
    clearWorldCache();
    const b = generateWorld(SEED, 'island');
    expect(b).not.toBe(a);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });

  it('describes the heightmap per the contract', () => {
    const w = island();
    expect(w.kind).toBe('island');
    expect(w.size).toBe(MAP_SIZE);
    expect(w.half).toBe(MAP_SIZE / 2);
    expect(w.res).toBe(TERRAIN_RES);
    expect(w.cell).toBeCloseTo(MAP_SIZE / (TERRAIN_RES - 1));
    expect(w.heights.length).toBe(w.res * w.res);
    expect(w.surface.length).toBe(w.res * w.res);
    expect(w.waterLevel).toBe(WATER_LEVEL);
    // heightAt reproduces the vertices (row-major z rows, x columns) and interpolates between.
    for (const [i, j] of [[10, 20], [128, 128], [200, 37]]) {
      expect(w.heightAt(-w.half + i * w.cell, -w.half + j * w.cell)).toBeCloseTo(w.heights[j * w.res + i], 4);
    }
    const n = w.normalAt(12.3, -45.6);
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
    expect(n.y).toBeGreaterThan(0);
    expect(w.inBounds(0, 0)).toBe(true);
    expect(w.inBounds(w.half + 1, 0)).toBe(false);
  });
});

describe('determinism and performance', () => {
  it('produces identical worlds for the same seed and different ones for other seeds', () => {
    const a = generateWorldUncached(777, 'island');
    const b = generateWorldUncached(777, 'island');
    const c = generateWorldUncached(778, 'island');
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(a.boxes.length).toBe(b.boxes.length);
    expect(hashWorld(c)).not.toBe(hashWorld(a));
    const t1 = generateWorldUncached(3, 'training'), t2 = generateWorldUncached(3, 'training');
    expect(hashWorld(t1)).toBe(hashWorld(t2));
  });

  it('generates the island quickly', () => {
    generateWorldUncached(91, 'island'); // warm up the JIT like a long-running server
    const t0 = performance.now();
    generateWorldUncached(92, 'island');
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------------------------
// Island content
// ---------------------------------------------------------------------------------------------

describe('island', () => {
  it('has content within the expected ranges', () => {
    const w = island();
    expect(w.towns.length).toBeGreaterThanOrEqual(8);
    expect(w.towns.length).toBeLessThanOrEqual(12);
    expect(w.towns.filter((t) => t.tier === 2).length).toBe(1);
    expect(new Set(w.towns.map((t) => t.name)).size).toBe(w.towns.length);
    for (const t of w.towns) expect(t.name.length).toBeGreaterThan(2);
    expect(w.buildings.length).toBeGreaterThanOrEqual(90);
    expect(w.buildings.length).toBeLessThanOrEqual(135);
    expect(w.trees.length).toBeGreaterThanOrEqual(3500);
    expect(w.trees.length).toBeLessThanOrEqual(4500);
    expect(w.rocks.length).toBeGreaterThanOrEqual(1000);
    expect(w.rocks.length).toBeLessThanOrEqual(1400);
    expect(w.bushes.length).toBeGreaterThanOrEqual(2200);
    expect(w.bushes.length).toBeLessThanOrEqual(2800);
    expect(w.lootSpawns.length).toBeGreaterThanOrEqual(1600);
    expect(w.lootSpawns.length).toBeLessThanOrEqual(2100);
    expect(w.lootSpawns.filter((l) => l.indoor).length / w.lootSpawns.length).toBeGreaterThan(0.7);
    expect(w.vehicleSpawns.length).toBeGreaterThanOrEqual(18);
    expect(w.vehicleSpawns.length).toBeLessThanOrEqual(24);
    for (const type of ['buggy', 'uaz', 'bike'] as const) expect(w.vehicleSpawns.some((v) => v.type === type)).toBe(true);
    expect(w.roads.length).toBeGreaterThan(20);
    for (const r of w.roads) {
      expect(r.width).toBeGreaterThanOrEqual(6);
      expect(r.width).toBeLessThanOrEqual(8);
    }
    const styles = new Set(w.buildings.map((b) => b.style));
    for (const s of ['house', 'barn', 'apartment', 'warehouse', 'shed', 'tower', 'bunker', 'shop'] as const) expect(styles.has(s)).toBe(true);
    expect(w.training).toBeNull();
    // Box ids are their indices and building box lists point back to their building.
    w.boxes.forEach((b, i) => expect(b.id).toBe(i));
    for (const b of w.buildings) {
      expect(b.boxIds.length).toBeGreaterThan(10);
      for (const id of b.boxIds) expect(w.boxes[id].building).toBe(b.id);
      expect(b.town).toBeGreaterThanOrEqual(0);
      expect(b.town).toBeLessThan(w.towns.length);
    }
    const kinds = new Set(w.boxes.map((b) => b.kind));
    for (const k of ['wall', 'floor', 'roof', 'stairs', 'crate', 'container', 'fence', 'barrier'] as const) expect(kinds.has(k)).toBe(true);
    for (const b of w.boxes) {
      expect(b.max.x).toBeGreaterThan(b.min.x);
      expect(b.max.y).toBeGreaterThan(b.min.y);
      expect(b.max.z).toBeGreaterThan(b.min.z);
    }
  });

  it('is an island: land in the middle, coast 380-490 m out, sea floor down to about -12 m', () => {
    const w = island();
    let min = Infinity, max = -Infinity;
    for (const h of w.heights) { min = Math.min(min, h); max = Math.max(max, h); }
    expect(min).toBeGreaterThanOrEqual(-12.5);
    expect(min).toBeLessThan(-8);
    expect(max).toBeGreaterThan(55);
    expect(max).toBeLessThan(105);
    for (let k = 0; k < 24; k++) {
      const dx = Math.cos((k / 24) * Math.PI * 2), dz = Math.sin((k / 24) * Math.PI * 2);
      let coast = -1;
      for (let r = 0; r < 520; r += 2) {
        if (w.heightAt(dx * r, dz * r) < w.waterLevel) { coast = r; break; }
      }
      expect(coast).toBeGreaterThan(340);
      expect(coast).toBeLessThan(500);
      expect(w.heightAt(dx * 505, dz * 505)).toBeLessThan(w.waterLevel);
    }
    const counts = new Map<SurfaceMaterial, number>();
    for (const s of w.surface) counts.set(SURFACE_LIST[s], (counts.get(SURFACE_LIST[s]) ?? 0) + 1);
    for (const m of ['grass', 'dirt', 'rock', 'sand', 'road'] as const) expect(counts.get(m) ?? 0).toBeGreaterThan(50);
    // Beaches: sand right above the waterline along the coast.
    expect(w.surfaceAt(0, 0)).not.toBe('water');
    expect(w.surfaceAt(w.half - 1, w.half - 1)).toBe('water');
  });

  it('flattens terrain under roads and marks them as road surface', () => {
    const w = island();
    let onRoad = 0;
    for (const r of w.roads) {
      const mx = (r.a.x + r.b.x) / 2, mz = (r.a.z + r.b.z) / 2;
      if (w.surfaceAt(mx, mz) === 'road') onRoad++;
      // Across the road the surface is nearly level.
      const len = Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z) || 1;
      const px = -(r.b.z - r.a.z) / len, pz = (r.b.x - r.a.x) / len;
      const h1 = w.heightAt(mx + px * 2, mz + pz * 2), h2 = w.heightAt(mx - px * 2, mz - pz * 2);
      expect(Math.abs(h1 - h2)).toBeLessThan(1.2);
    }
    expect(onRoad / w.roads.length).toBeGreaterThan(0.8);
  });

  it('keeps buildings, trees and loot out of the water', () => {
    const w = island();
    for (const b of w.buildings) {
      expect(b.min.y).toBeGreaterThan(w.waterLevel);
      for (const [x, z] of [[b.min.x, b.min.z], [b.max.x, b.max.z], [b.min.x, b.max.z], [b.max.x, b.min.z]]) {
        expect(w.heightAt(x, z)).toBeGreaterThan(w.waterLevel);
      }
    }
    for (const t of w.trees) {
      expect(w.heightAt(t.x, t.z)).toBeGreaterThan(w.waterLevel + 0.5);
      expect(t.y).toBeGreaterThan(w.waterLevel);
    }
    for (const l of w.lootSpawns) expect(l.pos.y).toBeGreaterThan(w.waterLevel);
  });

  it('places vegetation per the rules (sizes, not in towns, roads or buildings)', () => {
    const w = island();
    for (const t of w.trees) {
      expect(t.r).toBeGreaterThanOrEqual(0.2);
      expect(t.r).toBeLessThanOrEqual(0.5);
      expect(t.h).toBeGreaterThanOrEqual(6);
      expect(t.h).toBeLessThanOrEqual(16);
      expect(['pine', 'oak', 'birch', 'dead']).toContain(t.kind);
      for (const town of w.towns) expect(Math.hypot(t.x - town.x, t.z - town.z)).toBeGreaterThan(town.r);
      for (const b of w.buildings) {
        const inside = t.x > b.min.x - 1.5 - t.r && t.x < b.max.x + 1.5 + t.r && t.z > b.min.z - 1.5 - t.r && t.z < b.max.z + 1.5 + t.r;
        expect(inside).toBe(false);
      }
    }
    for (const t of w.trees.filter((_, i) => i % 4 === 0)) {
      for (const r of w.roads) expect(segDist(t.x, t.z, r.a.x, r.a.z, r.b.x, r.b.z)).toBeGreaterThan(r.width / 2);
    }
    expect(w.rocks.some((r) => r.r >= 2)).toBe(true);
    for (const r of w.rocks) {
      expect(r.h).toBeGreaterThan(0);
      expect(r.y).toBeLessThanOrEqual(w.heightAt(r.x, r.z) + 0.01);
    }
  });

  it('puts loot on box tops or terrain, never inside boxes', () => {
    const w = island();
    const near: WorldBox[] = [];
    for (const l of w.lootSpawns) {
      w.queryBoxes(l.pos.x - 0.01, l.pos.z - 0.01, l.pos.x + 0.01, l.pos.z + 0.01, near);
      for (const b of near) expect(strictlyInside(b, l.pos)).toBe(false);
      const surface = w.groundAt(l.pos.x, l.pos.z, l.pos.y);
      expect(Math.abs(surface - (l.pos.y - 0.05))).toBeLessThan(0.011);
      expect([0, 1, 2]).toContain(l.tier);
    }
    // Indoor loot sits on building floors, spread over the upper floors too.
    const indoor = w.lootSpawns.filter((l) => l.indoor);
    const onUpper = indoor.filter((l) => {
      const b = w.buildings.find((bb) => l.pos.x >= bb.min.x && l.pos.x <= bb.max.x && l.pos.z >= bb.min.z && l.pos.z <= bb.max.z);
      return b ? l.pos.y > groundFloorY(w, b) + 2 : false;
    });
    expect(onUpper.length).toBeGreaterThan(100);
    // Military loot is high tier.
    const mil = w.towns.find((t) => t.tier === 2)!;
    const milLoot = w.lootSpawns.filter((l) => Math.hypot(l.pos.x - mil.x, l.pos.z - mil.z) < mil.r);
    expect(milLoot.length).toBeGreaterThan(20);
    expect(milLoot.filter((l) => l.tier === 2).length / milLoot.length).toBeGreaterThan(0.6);
  });

  it('gives every building an enterable door gap at ground level', () => {
    const w = island();
    for (const b of w.buildings) expect(hasDoorGap(w, b), `building ${b.id} (${b.style})`).toBe(true);
  });

  it('makes every floor of every building reachable for a 0.35 m x 1.8 m character', () => {
    const w = island();
    for (const b of w.buildings) {
      const r = unreachableFloorSpots(w, b);
      expect(r.total).toBeGreaterThan(10);
      expect(r.unreachable, `building ${b.id} (${b.style}, ${b.floors} floors)`).toBe(0);
    }
  });

  it('builds stairs with rises of at most 0.3 m and walls of 0.25 m', () => {
    const w = island();
    let runs = 0;
    for (const b of w.buildings.filter((bb) => bb.floors > 1)) {
      const boxes = buildingBoxes(w, b);
      const floors = new Set(boxes.filter((x) => x.kind === 'floor').map((x) => x.max.y));
      const steps = boxes.filter((x) => x.kind === 'stairs' && floors.has(x.min.y));
      const byBase = new Map<number, number[]>();
      for (const s of steps) byBase.set(s.min.y, [...(byBase.get(s.min.y) ?? []), s.max.y]);
      expect(byBase.size).toBeGreaterThan(0);
      for (const [base, tops] of byBase) {
        tops.sort((a, c) => a - c);
        let prev = base;
        for (const t of tops) {
          expect(t - prev).toBeLessThanOrEqual(0.3);
          prev = t;
        }
        runs++;
      }
      // Step width >= 1.1 m.
      for (const s of steps) expect(Math.max(s.max.x - s.min.x, s.max.z - s.min.z)).toBeGreaterThanOrEqual(1.1);
      // Floor-to-floor ~3.2 m.
      const ys = [...floors].sort((a, c) => a - c);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(3.2, 2);
    }
    expect(runs).toBeGreaterThan(20);
    const walls = w.boxes.filter((x) => x.kind === 'wall' && x.building >= 0);
    const thin = walls.map((x) => Math.min(x.max.x - x.min.x, x.max.z - x.min.z));
    expect(thin.filter((t) => Math.abs(t - 0.25) < 0.002).length).toBeGreaterThan(walls.length * 0.5);
  });

  it('places vehicle spawns on clear, dry, flat ground', () => {
    const w = island();
    const R = 4;
    for (const v of w.vehicleSpawns) {
      expect(w.heightAt(v.pos.x, v.pos.z)).toBeGreaterThan(w.waterLevel);
      expect(v.pos.y).toBeCloseTo(w.heightAt(v.pos.x, v.pos.z), 2);
      expect(Number.isFinite(v.yaw)).toBe(true);
      for (const b of w.queryBoxes(v.pos.x - R, v.pos.z - R, v.pos.x + R, v.pos.z + R, [])) expect(circleHitsRect(v.pos.x, v.pos.z, R, b)).toBe(false);
      for (const t of w.queryTrees(v.pos.x - R - 1, v.pos.z - R - 1, v.pos.x + R + 1, v.pos.z + R + 1, [])) expect(Math.hypot(t.x - v.pos.x, t.z - v.pos.z)).toBeGreaterThanOrEqual(R + t.r);
      for (const r of w.queryRocks(v.pos.x - R - 6, v.pos.z - R - 6, v.pos.x + R + 6, v.pos.z + R + 6, [])) expect(Math.hypot(r.x - v.pos.x, r.z - v.pos.z)).toBeGreaterThanOrEqual(R + r.r);
      // Yaw is aligned with the nearest road.
      let best = Infinity, dir = 0;
      for (const r of w.roads) {
        const d = segDist(v.pos.x, v.pos.z, r.a.x, r.a.z, r.b.x, r.b.z);
        if (d < best) { best = d; dir = Math.atan2(-(r.b.x - r.a.x), -(r.b.z - r.a.z)); }
      }
      expect(best).toBeLessThan(4);
      const diff = Math.abs(Math.sin(v.yaw - dir));
      expect(diff).toBeLessThan(0.35);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

describe('spatial queries', () => {
  it('return exactly the overlapping subsets', () => {
    const w = island();
    const rng = new Rng(99);
    const boxOut: WorldBox[] = [], treeOut: TreeDef[] = [], rockOut: RockDef[] = [];
    for (let k = 0; k < 60; k++) {
      const x = rng.range(-480, 480), z = rng.range(-480, 480), sx = rng.range(0, 60), sz = rng.range(0, 60);
      const x0 = x, z0 = z, x1 = x + sx, z1 = z + sz;
      const eb = w.boxes.filter((b) => b.min.x <= x1 && b.max.x >= x0 && b.min.z <= z1 && b.max.z >= z0);
      const et = w.trees.filter((t) => t.x - t.r <= x1 && t.x + t.r >= x0 && t.z - t.r <= z1 && t.z + t.r >= z0);
      const er = w.rocks.filter((r) => r.x - r.r <= x1 && r.x + r.r >= x0 && r.z - r.r <= z1 && r.z + r.r >= z0);
      w.queryBoxes(x0, z0, x1, z1, boxOut);
      w.queryTrees(x0, z0, x1, z1, treeOut);
      w.queryRocks(x0, z0, x1, z1, rockOut);
      expect(new Set(boxOut).size).toBe(boxOut.length);
      expect(boxOut.map((b) => b.id).sort((a, c) => a - c)).toEqual(eb.map((b) => b.id).sort((a, c) => a - c));
      expect(new Set(treeOut)).toEqual(new Set(et));
      expect(treeOut.length).toBe(et.length);
      expect(new Set(rockOut)).toEqual(new Set(er));
      expect(rockOut.length).toBe(er.length);
    }
    // Queries around a town actually return things, and `out` is cleared first.
    const town = w.towns[0];
    w.queryBoxes(town.x - 40, town.z - 40, town.x + 40, town.z + 40, boxOut);
    expect(boxOut.length).toBeGreaterThan(50);
    w.queryBoxes(10000, 10000, 10001, 10001, boxOut);
    expect(boxOut.length).toBe(0);
    w.queryBoxes(NaN, 0, 1, 1, boxOut);
    expect(boxOut.length).toBe(0);
  });

  it('groundAt finds floors, roofs and terrain below a height', () => {
    const w = island();
    for (const b of w.buildings.slice(0, 40)) {
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      const top = w.groundAt(cx, cz);
      expect(top).toBeGreaterThan(w.heightAt(cx, cz));
      expect(top).toBeGreaterThanOrEqual(groundFloorY(w, b) - 0.21);
      // From just above the ground floor we land on the ground floor (or something on it).
      const g0 = groundFloorY(w, b);
      const g = w.groundAt(cx, cz, g0 + 0.2);
      expect(g).toBeGreaterThanOrEqual(g0 - 0.21);
      expect(g).toBeLessThanOrEqual(g0 + 0.21);
    }
    // Open terrain away from everything.
    const t = w.trees[0];
    expect(w.groundAt(t.x + 0.7, t.z)).toBeCloseTo(w.heightAt(t.x + 0.7, t.z), 6);
    expect(w.groundAt(0, 0, -100)).toBeCloseTo(w.heightAt(0, 0), 6);
  });
});

// ---------------------------------------------------------------------------------------------
// Training ground
// ---------------------------------------------------------------------------------------------

const ALL_ITEMS: Record<ItemId, true> = {
  pistol: true, smg: true, ar: true, shotgun: true, dmr: true, sniper: true,
  ammo_9mm: true, ammo_556: true, ammo_762: true, ammo_12g: true, ammo_300: true,
  bandage: true, firstaid: true, medkit: true, energy: true, fuel: true, frag: true,
  vest1: true, vest2: true, vest3: true, helmet1: true, helmet2: true, helmet3: true, pack1: true, pack2: true, pack3: true,
};

describe('training ground', () => {
  it('is a compact map with a layout', () => {
    const w = training();
    expect(w.kind).toBe('training');
    expect(w.size).toBe(TRAINING_MAP_SIZE);
    expect(w.training).not.toBeNull();
    const t = w.training!;
    expect(w.heightAt(t.spawn.x, t.spawn.z)).toBeGreaterThan(w.waterLevel);
    expect(t.spawn.y).toBeCloseTo(w.groundAt(t.spawn.x, t.spawn.z), 2);
    // Spawn faces the range: yaw 0 looks toward -Z where the targets are.
    const fwd = { x: -Math.sin(t.spawnYaw), z: -Math.cos(t.spawnYaw) };
    for (const tg of t.targets) expect((tg.pos.x - t.spawn.x) * fwd.x + (tg.pos.z - t.spawn.z) * fwd.z).toBeGreaterThan(0);
    // Water beyond the edges, flat plain in the middle.
    expect(w.heightAt(w.half - 2, 0)).toBeLessThan(w.waterLevel);
    expect(w.heightAt(-w.half + 2, w.half - 2)).toBeLessThan(w.waterLevel);
    expect(Math.abs(w.heightAt(0, 0) - w.heightAt(-50, 100))).toBeLessThan(0.5);
  });

  it('has a rack entry for every item, each standing on a rack box', () => {
    const w = training();
    const racks = w.training!.racks;
    const items = new Set(racks.map((r) => r.item));
    for (const id of Object.keys(ALL_ITEMS) as ItemId[]) expect(items.has(id), id).toBe(true);
    for (const r of racks) {
      const under = w.queryBoxes(r.pos.x, r.pos.z, r.pos.x, r.pos.z, []).filter((b) => b.kind === 'rack');
      expect(under.length).toBe(1);
      expect(r.pos.y).toBeCloseTo(under[0].max.y + 0.05, 3);
      expect(Math.hypot(r.pos.x - w.training!.spawn.x, r.pos.z - w.training!.spawn.z)).toBeLessThan(45);
    }
  });

  it('has static targets at every range, plus moving and pop-up targets', () => {
    const w = training();
    const t = w.training!;
    const statics = t.targets.filter((x) => x.kind === 'static');
    for (const range of [25, 50, 100, 200, 300, 400, 500, 600]) {
      const tg = statics.find((x) => x.range === range);
      expect(tg, `static ${range}`).toBeDefined();
      expect(Math.abs(t.firingLine.z - tg!.pos.z)).toBeCloseTo(range, 1);
      // Each static target is a ~0.6 x 1.8 m 'target' plate box (its id) on a post.
      const plate = w.boxes[tg!.id];
      expect(plate.kind).toBe('target');
      expect(plate.max.x - plate.min.x).toBeCloseTo(0.6, 1);
      expect(plate.max.y - plate.min.y).toBeCloseTo(1.8, 1);
      expect(plate.min.y).toBeGreaterThan(w.heightAt(tg!.pos.x, tg!.pos.z));
      expect(tg!.pos.y).toBeGreaterThan(plate.min.y);
      expect(tg!.pos.y).toBeLessThan(plate.max.y);
    }
    expect(new Set(statics.map((s) => s.pos.x)).size).toBeGreaterThanOrEqual(6);
    for (const range of [50, 100, 200]) {
      const m = t.targets.find((x) => x.kind === 'moving' && x.range === range);
      expect(m, `moving ${range}`).toBeDefined();
      expect(m!.a && m!.b && m!.speed).toBeTruthy();
      expect(Math.abs(t.firingLine.z - m!.a!.z)).toBeCloseTo(range, 1);
      expect(Math.hypot(m!.b!.x - m!.a!.x, m!.b!.z - m!.a!.z)).toBeGreaterThan(10);
    }
    const popups = t.targets.filter((x) => x.kind === 'popup');
    expect(popups.length).toBeGreaterThanOrEqual(3);
    for (const p of popups) {
      expect(p.range).toBeGreaterThanOrEqual(15);
      expect(p.range).toBeLessThanOrEqual(30);
    }
    expect(new Set(t.targets.map((x) => x.id)).size).toBe(t.targets.length);
    // Nothing blocks the line of fire from the firing line to the long targets except the target.
    for (const tg of statics) {
      const ground = w.heightAt(tg.pos.x, t.firingLine.z);
      for (let s = 5; s < tg.range - 2; s += 5) expect(w.heightAt(tg.pos.x, t.firingLine.z - s)).toBeLessThan(ground + 1.2);
    }
  });

  it('has CQB buildings, a vehicle track with ramps and two vehicles of each type', () => {
    const w = training();
    expect(w.buildings.length).toBeGreaterThanOrEqual(3);
    expect(w.buildings.length).toBeLessThanOrEqual(4);
    for (const b of w.buildings) {
      expect(hasDoorGap(w, b)).toBe(true);
      expect(unreachableFloorSpots(w, b).unreachable).toBe(0);
    }
    const ramps = w.boxes.filter((b) => b.kind === 'ramp');
    expect(ramps.length).toBeGreaterThan(10);
    for (const r of ramps) expect(w.roads.some((s) => segDist((r.min.x + r.max.x) / 2, (r.min.z + r.max.z) / 2, s.a.x, s.a.z, s.b.x, s.b.z) < s.width / 2)).toBe(true);
    for (const type of ['buggy', 'uaz', 'bike'] as const) expect(w.vehicleSpawns.filter((v) => v.type === type).length).toBe(2);
    for (const v of w.vehicleSpawns) {
      for (const b of w.queryBoxes(v.pos.x - 4, v.pos.z - 4, v.pos.x + 4, v.pos.z + 4, [])) expect(circleHitsRect(v.pos.x, v.pos.z, 4, b)).toBe(false);
      for (const t of w.queryTrees(v.pos.x - 5, v.pos.z - 5, v.pos.x + 5, v.pos.z + 5, [])) expect(Math.hypot(t.x - v.pos.x, t.z - v.pos.z)).toBeGreaterThan(4);
    }
    for (const l of w.lootSpawns) {
      const surface = w.groundAt(l.pos.x, l.pos.z, l.pos.y);
      expect(Math.abs(surface - (l.pos.y - 0.05))).toBeLessThan(0.011);
    }
  });
});
