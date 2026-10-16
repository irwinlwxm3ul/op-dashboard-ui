// Loot spawn points (mostly on building floors, some outdoors next to cover) and vehicle spawns.

import type { TownDef, VehicleType, WorldBox } from '../types';
import { yawTo } from '../math';
import { Rng } from '../rng';
import type { Rect, RoomInfo } from './buildings';
import type { PropInfo } from './props';
import type { Road } from './roads';
import type { GeneratedWorld } from './worldImpl';
import { len2 } from './util';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Clearance radius around loot (XZ) that must be free of boxes above the surface. */
const LOOT_CLEAR = 0.35;
/** Height above the surface that must be free. */
const LOOT_HEAD = 0.8;

const scratch: WorldBox[] = [];

/** True if no box occupies the space just above a surface at height y around (x, z). */
export function lootSpotFree(world: GeneratedWorld, x: number, z: number, y: number): boolean {
  world.queryBoxes(x - LOOT_CLEAR, z - LOOT_CLEAR, x + LOOT_CLEAR, z + LOOT_CLEAR, scratch);
  for (const b of scratch) {
    if (b.max.y > y + 0.02 && b.min.y < y + LOOT_HEAD) return false;
  }
  return true;
}

function inside(r: Rect, x: number, z: number, pad: number): boolean {
  return x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;
}

export interface LootContext {
  world: GeneratedWorld;
  rng: Rng;
  rooms: RoomInfo[];
  /** Stair zone per building id. */
  stairZones: Map<number, Rect>;
  /** Base tier for a building id. */
  buildingTier: (building: number) => 0 | 1 | 2;
  /** Base tier for an outdoor position. */
  outdoorTier: (x: number, z: number) => 0 | 1 | 2;
  props: PropInfo[];
  target: number;
  /** Fraction of spawns placed indoors. */
  indoorFrac: number;
}

function jitterTier(rng: Rng, base: 0 | 1 | 2): 0 | 1 | 2 {
  const r = rng.next();
  let t: number = base;
  if (base === 2) t = r < 0.15 ? 1 : 2;
  else if (r < 0.12) t = base + 1;
  else if (r < 0.2) t = base - 1;
  return Math.min(2, Math.max(0, t)) as 0 | 1 | 2;
}

export function placeLoot(c: LootContext): void {
  const { world, rng } = c;
  const out = world.lootSpawns;
  const indoorTarget = Math.round(c.target * c.indoorFrac);

  // ---- Indoor: distribute over rooms by usable area ---------------------------------------------
  const areas: number[] = [];
  let total = 0;
  for (const room of c.rooms) {
    // Open roofs get a sparse sprinkle compared with interiors.
    const a = Math.max(0, room.x1 - room.x0 - 1) * Math.max(0, room.z1 - room.z0 - 1) * (room.indoor ? 1 : 0.15);
    areas.push(a);
    total += a;
  }
  const density = total > 0 ? indoorTarget / total : 0;
  const perRoom: { x: number; z: number }[][] = c.rooms.map(() => []);
  /** One placement attempt in room i. */
  const tryRoom = (i: number): boolean => {
    const room = c.rooms[i];
    const x = r2(rng.range(room.x0 + 0.5, room.x1 - 0.5));
    const z = r2(rng.range(room.z0 + 0.5, room.z1 - 0.5));
    const sz = c.stairZones.get(room.building);
    if (sz && inside(sz, x, z, 0.5)) return false;
    const placed = perRoom[i];
    for (const p of placed) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 1.0) return false;
    let y = room.y;
    if (!lootSpotFree(world, x, z, y)) {
      // A crate or similar may sit here: use its top if it is a clean surface.
      const top = world.groundAt(x, z, room.y + 3);
      if (top <= room.y + 0.05 || top > room.y + 2.2 || !lootSpotFree(world, x, z, top)) return false;
      y = top;
    }
    if (Math.abs(world.groundAt(x, z, y) - y) > 0.005) return false;
    placed.push({ x, z });
    out.push({ pos: { x, y: r3(y + 0.05), z }, tier: jitterTier(rng, c.buildingTier(room.building)), indoor: room.indoor });
    return true;
  };
  for (let i = 0; i < c.rooms.length; i++) {
    if (areas[i] < 1) continue;
    const expected = areas[i] * density;
    let n = Math.floor(expected) + (rng.next() < expected - Math.floor(expected) ? 1 : 0);
    if (n === 0 && c.rooms[i].indoor && areas[i] >= 4) n = 1;
    for (let k = 0, tries = 0; k < n && tries < n * 25; tries++) if (tryRoom(i)) k++;
  }
  // Top up rooms (area weighted) when crowded rooms rejected spots.
  if (total > 0) {
    const cum: number[] = [];
    let acc = 0;
    for (let i = 0; i < areas.length; i++) cum.push((acc += c.rooms[i].indoor ? areas[i] : 0));
    for (let tries = 0, max = indoorTarget * 20; out.length < indoorTarget && tries < max && acc > 0; tries++) {
      const r = rng.next() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= r) lo = mid + 1; else hi = mid;
      }
      tryRoom(lo);
    }
  }

  // ---- Outdoor: beside props and inside open containers ---------------------------------------
  const outdoorTarget = Math.max(0, c.target - out.length);
  const props = rng.shuffle(c.props.slice());
  let placed = 0;
  const tryOutdoor = (x: number, z: number, onBox: number | null, indoor: boolean): boolean => {
    x = r2(x);
    z = r2(z);
    if (!world.inBounds(x, z)) return false;
    let y: number;
    if (onBox !== null) {
      y = onBox;
    } else {
      y = world.heightAt(x, z);
      if (y < world.waterLevel + 0.4) return false;
      if (world.hf.flatness(x, z) < 0.8) return false;
    }
    if (!lootSpotFree(world, x, z, y)) return false;
    if (Math.abs(world.groundAt(x, z, y) - y) > 0.005) return false;
    for (let i = out.length - 1, stop = Math.max(0, out.length - 40); i >= stop; i--) {
      const p = out[i].pos;
      if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 1.2) return false;
    }
    out.push({ pos: { x, y: r3(y + 0.05), z }, tier: jitterTier(rng, c.outdoorTier(x, z)), indoor });
    placed++;
    return true;
  };
  for (let pass = 0; pass < 3 && placed < outdoorTarget; pass++) {
    for (const p of props) {
      if (placed >= outdoorTarget) break;
      if (p.kind === 'fence') continue;
      if (p.interior && p.floorY !== undefined && pass === 0) {
        const r = p.interior;
        for (let t = 0; t < 6; t++) {
          if (tryOutdoor(rng.range(r.x0 + 0.45, r.x1 - 0.45), rng.range(r.z0 + 0.45, r.z1 - 0.45), p.floorY, true)) break;
        }
        continue;
      }
      const chance = p.military ? 0.9 : 0.55;
      if (!rng.chance(chance)) continue;
      for (let t = 0; t < 6; t++) {
        const side = rng.int(0, 3), off = rng.range(0.7, 1.6);
        const r = p.rect;
        let x: number, z: number;
        if (side === 0) { x = r.x0 - off; z = rng.range(r.z0, r.z1); }
        else if (side === 1) { x = r.x1 + off; z = rng.range(r.z0, r.z1); }
        else if (side === 2) { z = r.z0 - off; x = rng.range(r.x0, r.x1); }
        else { z = r.z1 + off; x = rng.range(r.x0, r.x1); }
        if (tryOutdoor(x, z, null, false)) break;
      }
    }
  }
  // Fallback: around building exteriors.
  for (let tries = 0; placed < outdoorTarget && tries < outdoorTarget * 30 && world.buildings.length > 0; tries++) {
    const b = rng.pick(world.buildings);
    const side = rng.int(0, 3), off = rng.range(1.0, 2.0);
    let x: number, z: number;
    if (side === 0) { x = b.min.x - off; z = rng.range(b.min.z, b.max.z); }
    else if (side === 1) { x = b.max.x + off; z = rng.range(b.min.z, b.max.z); }
    else if (side === 2) { z = b.min.z - off; x = rng.range(b.min.x, b.max.x); }
    else { z = b.max.z + off; x = rng.range(b.min.x, b.max.x); }
    tryOutdoor(x, z, null, false);
  }
}

/** Vehicle spawn clearance (m). */
export const VEHICLE_CLEAR = 4;

/** True if a disc of `radius` around (x, z) touches no box, tree trunk or rock. */
export function vehicleSpotClear(world: GeneratedWorld, x: number, z: number, radius: number): boolean {
  const boxes = world.queryBoxes(x - radius, z - radius, x + radius, z + radius, []);
  for (const b of boxes) {
    const cx = Math.min(Math.max(x, b.min.x), b.max.x), cz = Math.min(Math.max(z, b.min.z), b.max.z);
    if ((cx - x) * (cx - x) + (cz - z) * (cz - z) < radius * radius) return false;
  }
  for (const t of world.queryTrees(x - radius - 1, z - radius - 1, x + radius + 1, z + radius + 1, [])) {
    if (len2(t.x - x, t.z - z) < radius + t.r) return false;
  }
  for (const r of world.queryRocks(x - radius - 5, z - radius - 5, x + radius + 5, z + radius + 5, [])) {
    if (len2(r.x - x, r.z - z) < radius + r.r) return false;
  }
  return true;
}

/**
 * Vehicle spawns along roads outside towns, in the lane, aligned with the road direction and
 * clear of colliders.
 */
export function placeVehicles(world: GeneratedWorld, rng: Rng, roads: Road[], towns: TownDef[], count: number): void {
  const types: VehicleType[] = [];
  const nBike = Math.round(count * 0.27), nBuggy = Math.round(count * 0.36);
  for (let i = 0; i < count; i++) types.push(i < nBike ? 'bike' : i < nBike + nBuggy ? 'buggy' : 'uaz');
  rng.shuffle(types);
  // Length-weighted segment list.
  const segs: { a: { x: number; z: number }; b: { x: number; z: number }; w: number; len: number }[] = [];
  for (const r of roads) for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    segs.push({ a, b, w: r.width, len: len2(b.x - a.x, b.z - a.z) });
  }
  if (segs.length === 0) return;
  // Cumulative lengths for length-weighted sampling.
  const cum: number[] = [];
  let acc = 0;
  for (const s of segs) cum.push((acc += s.len));
  const pickSeg = (): (typeof segs)[number] => {
    const r = rng.next() * acc;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1; else hi = mid;
    }
    return segs[lo];
  };
  for (let spacing = 60; world.vehicleSpawns.length < count && spacing >= 15; spacing -= 15) {
    for (let tries = 0; world.vehicleSpawns.length < count && tries < 3000; tries++) {
      const s = pickSeg();
      if (s.len < 1) continue;
      const t = rng.range(0.1, 0.9);
      const dx = (s.b.x - s.a.x) / s.len, dz = (s.b.z - s.a.z) / s.len;
      const lane = (rng.chance(0.5) ? 1 : -1) * Math.min(1.8, s.w / 4);
      const x = r2(s.a.x + (s.b.x - s.a.x) * t - dz * lane);
      const z = r2(s.a.z + (s.b.z - s.a.z) * t + dx * lane);
      if (towns.some((tw) => len2(tw.x - x, tw.z - z) < tw.r + 12)) continue;
      if (world.heightAt(x, z) < world.waterLevel + 1) continue;
      if (world.hf.flatness(x, z) < 0.96) continue;
      if (world.vehicleSpawns.some((v) => len2(v.pos.x - x, v.pos.z - z) < spacing)) continue;
      if (!vehicleSpotClear(world, x, z, VEHICLE_CLEAR)) continue;
      const forwardSign = lane > 0 ? 1 : -1;
      const yaw = yawTo({ x: 0, z: 0 }, { x: dx * forwardSign, z: dz * forwardSign });
      world.vehicleSpawns.push({ pos: { x, y: r3(world.heightAt(x, z)), z }, yaw: r3(yaw), type: types[world.vehicleSpawns.length] });
    }
  }
}

