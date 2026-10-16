// The battle royale island: organic coastline with beaches, rolling hills and one mountain ridge,
// ~10 named towns (one military base) linked by a terrain-aware road network, ~110 enterable
// buildings, cover props, forests, rocks, loot and vehicle spawns.

import { MAP_SIZE, TERRAIN_RES } from '../constants';
import type { BuildingStyle, TownDef } from '../types';
import { hash32, Rng } from '../rng';
import {
  type BuildingPlan, type Rect, type RoomInfo, type Rot, doorApron, footprintHalf, generateBuilding, planBuilding,
  planDoorsWorld,
} from './buildings';
import { Heightfield, smooth01 } from './heightfield';
import { M_APRON, M_BUILDING, M_NOVEG, M_PROP, M_ROAD, M_TOWN, OccupancyMask } from './mask';
import { MILITARY_NAMES, TOWN_NAMES } from './names';
import { Noise2 } from './noise';
import { type PropCtx, type PropInfo, placeBarrier, placeContainer, placeCrates, placeFence, placeSandbags } from './props';
import {
  type Road, chaikin, distToSegment, flattenRoads, rasterizeRoads, resample, roadProfile, roadSegments, routeRoad,
} from './roads';
import { placeLoot, placeVehicles } from './spawns';
import { SURF } from './surfaces';
import { placeVegetation } from './vegetation';
import { GeneratedWorld } from './worldImpl';

// Stage seeds: each stage draws from its own stream so tweaks stay local.
const S_SHAPE = 0x15a7, S_TOWNS = 0x70e5, S_ROADS = 0x40ad, S_BUILD = 0xb1d6, S_PROPS = 0x9409;
const S_VEG = 0x7ee5, S_LOOT = 0x1007, S_VEH = 0xca75, S_SURF = 0x5c2f;

const ROAD_W = 7;
const STREET_W = 6;
const TARGET_TREES = 4000;
const TARGET_ROCKS = 1200;
const TARGET_BUSHES = 2500;
const TARGET_LOOT = 1800;
const TARGET_VEHICLES = 22;

type TownSize = 'military' | 'large' | 'medium' | 'small';
interface TownPlan {
  def: TownDef;
  size: TownSize;
  plateau: number;
}

const TOWN_LAYOUT: { size: TownSize; r: number }[] = [
  { size: 'military', r: 72 },
  { size: 'large', r: 70 },
  { size: 'large', r: 70 },
  { size: 'medium', r: 55 },
  { size: 'medium', r: 55 },
  { size: 'medium', r: 55 },
  { size: 'small', r: 42 },
  { size: 'small', r: 42 },
  { size: 'small', r: 42 },
  { size: 'small', r: 42 },
];

/** Building programme per town size, biggest first. */
const TOWN_STYLES: Record<TownSize, BuildingStyle[]> = {
  military: ['warehouse', 'apartment', 'apartment', 'tower', 'tower', 'tower', 'bunker', 'bunker', 'bunker', 'shed'],
  large: ['warehouse', 'apartment', 'apartment', 'apartment', 'apartment', 'shop', 'shop', 'shop', 'tower',
    'house', 'house', 'house', 'house', 'house', 'house', 'house', 'house', 'shed'],
  medium: ['warehouse', 'barn', 'apartment', 'shop', 'shop', 'house', 'house', 'house', 'house', 'house', 'house', 'shed'],
  small: ['barn', 'house', 'house', 'house', 'house', 'shed', 'shed'],
};

/** Unit vectors at 60 degree steps (sampling rings without trig). */
const HEX: readonly [number, number][] = [
  [1, 0], [0.5, 0.8660254], [-0.5, 0.8660254], [-1, 0], [-0.5, -0.8660254], [0.5, -0.8660254],
];

const r1 = (v: number): number => Math.round(v * 10) / 10;

// ============================================================================================
// Island shape
// ============================================================================================

interface IslandShape {
  /** Signed distance to the coastline (positive inland). */
  coastDist(x: number, z: number): number;
  /** Mountain influence 0..1. */
  mountain(x: number, z: number): number;
  height(x: number, z: number): number;
}

function makeShape(seed: number): IslandShape {
  const rng = new Rng(hash32(seed, S_SHAPE));
  const nCoast = new Noise2(hash32(seed, 1)), nCoast2 = new Noise2(hash32(seed, 5)), nHill = new Noise2(hash32(seed, 2));
  const nDetail = new Noise2(hash32(seed, 3)), nMount = new Noise2(hash32(seed, 4));
  // Mountain ridge: a segment roughly tangential to a circle of radius ~180 m.
  let dx = rng.range(-1, 1), dz = rng.range(-1, 1);
  let l = Math.sqrt(dx * dx + dz * dz);
  if (l < 0.2) { dx = 0.7; dz = 0.7; l = Math.sqrt(0.98); }
  dx /= l; dz /= l;
  const mr = rng.range(150, 200);
  const mcx = dx * mr, mcz = dz * mr;
  let rx = -dz + rng.range(-0.5, 0.5), rz = dx + rng.range(-0.5, 0.5);
  const rl = Math.sqrt(rx * rx + rz * rz);
  rx /= rl; rz /= rl;
  const halfLen = rng.range(60, 90);
  const ax = mcx - rx * halfLen, az = mcz - rz * halfLen, bx = mcx + rx * halfLen, bz = mcz + rz * halfLen;
  const seg = { d: 0, t: 0 };

  const coastDist = (x: number, z: number): number => {
    const r = Math.sqrt(x * x + z * z);
    const ux = x / (r + 1), uz = z / (r + 1);
    const n1 = nCoast.fbm(ux * 1.7 + 5.3, uz * 1.7 + 2.1, 3);
    const n2 = nCoast2.fbm(x / 150, z / 150, 3);
    return 437 + 32 * n1 + 12 * n2 - r;
  };
  const mountain = (x: number, z: number): number => {
    distToSegment(x, z, ax, az, bx, bz, seg);
    const q = seg.d / 125;
    if (q >= 1) return 0;
    const f = 1 - q * q;
    const along = 1 - 0.35 * (2 * seg.t - 1) * (2 * seg.t - 1);
    return f * f * f * along;
  };
  const height = (x: number, z: number): number => {
    const d = coastDist(x, z);
    const shore = d >= 0 ? -0.8 + (3.3 * d) / (d + 14) : Math.max(-12, -0.8 + 0.236 * d);
    if (d <= 8) return shore;
    const inland = smooth01((d - 8) / 102);
    const h01 = nHill.fbm(x / 260 + 11.3, z / 260 - 4.7, 4) * 0.5 + 0.5;
    const t = Math.min(1, Math.max(0, (h01 - 0.22) / 0.62));
    const hills = 40 * t * t;
    const m = mountain(x, z);
    const ridged = 1 - Math.abs(nMount.fbm(x / 60, z / 60, 3));
    const mount = m * (72 + 14 * ridged);
    const detail = 2.2 * nDetail.fbm(x / 40, z / 40, 3);
    const land = hills * (1 - 0.6 * Math.min(1, m * 1.5)) + mount + detail;
    return shore + inland * Math.max(0, land);
  };
  return { coastDist, mountain, height };
}

// ============================================================================================
// Towns
// ============================================================================================

function placeTowns(seed: number, shape: IslandShape): TownPlan[] {
  const rng = new Rng(hash32(seed, S_TOWNS));
  const names = rng.shuffle(TOWN_NAMES.slice());
  const milName = rng.pick(MILITARY_NAMES);
  const towns: TownPlan[] = [];
  let mediumTier1 = false;
  for (const spec of TOWN_LAYOUT) {
    const R = spec.r;
    for (let attempt = 0; attempt < 900; attempt++) {
      const relax = attempt / 900;
      const x = rng.range(-370, 370), z = rng.range(-370, 370);
      if (x * x + z * z > 370 * 370) continue;
      if (shape.coastDist(x, z) < R + 28 - 18 * relax) continue;
      if (shape.mountain(x, z) > 0.04 + 0.12 * relax) continue;
      let ok = true;
      for (const t of towns) {
        if (Math.hypot(t.def.x - x, t.def.z - z) < R + t.def.r + 75 - 35 * relax) { ok = false; break; }
      }
      if (!ok) continue;
      let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
      const sample = (sx: number, sz: number): void => {
        const h = shape.height(sx, sz);
        mn = Math.min(mn, h);
        mx = Math.max(mx, h);
        sum += h;
        n++;
      };
      sample(x, z);
      for (const [hx, hz] of HEX) {
        sample(x + hx * R * 0.5, z + hz * R * 0.5);
        sample(x + hx * R, z + hz * R);
      }
      if (mn < 2.5 || mx - mn > 10 + 12 * relax) continue;
      let tier: 0 | 1 | 2;
      if (spec.size === 'military') tier = 2;
      else if (spec.size === 'large') tier = 1;
      else if (spec.size === 'medium') {
        tier = !mediumTier1 || rng.chance(0.4) ? 1 : 0;
        mediumTier1 = true;
      } else tier = 0;
      const id = towns.length;
      const name = spec.size === 'military' ? milName : names[id % names.length];
      towns.push({ def: { id, name, x: r1(x), z: r1(z), r: R, tier }, size: spec.size, plateau: Math.max(3, sum / n) });
      break;
    }
  }
  return towns;
}

// ============================================================================================
// Roads
// ============================================================================================

function buildRoads(seed: number, hf: Heightfield, towns: TownPlan[]): { roads: Road[]; trunk: Road[] } {
  const rng = new Rng(hash32(seed, S_ROADS));
  const n = towns.length;
  const dist = (i: number, j: number): number => Math.hypot(towns[i].def.x - towns[j].def.x, towns[i].def.z - towns[j].def.z);
  // Minimum spanning tree (Prim) plus a few short extra links for loops.
  const edges: [number, number][] = [];
  const inTree = new Array<boolean>(n).fill(false);
  if (n > 0) inTree[0] = true;
  for (let added = 1; added < n; added++) {
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const d = dist(i, j);
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    if (bj < 0) break;
    inTree[bj] = true;
    edges.push([bi, bj]);
  }
  const dirOf = (i: number, j: number): [number, number] => {
    const d = dist(i, j) || 1;
    return [(towns[j].def.x - towns[i].def.x) / d, (towns[j].def.z - towns[i].def.z) / d];
  };
  const candidates: [number, number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) candidates.push([i, j, dist(i, j)]);
  }
  candidates.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
  let extra = 0;
  for (const [i, j, d] of candidates) {
    if (extra >= 3 || d > 360) break;
    // Reject links nearly parallel to an existing link at either end.
    const ok = [i, j].every((a) => {
      const b = a === i ? j : i;
      const [ux, uz] = dirOf(a, b);
      return edges.every(([p, q]) => {
        if (p !== a && q !== a) return true;
        const o = p === a ? q : p;
        const [vx, vz] = dirOf(a, o);
        return ux * vx + uz * vz < 0.77;
      });
    });
    if (!ok) continue;
    edges.push([i, j]);
    extra++;
  }

  const trunk: Road[] = [];
  for (const [i, j] of edges) {
    const A = towns[i].def, B = towns[j].def;
    const path = routeRoad(hf, A.x, A.z, B.x, B.z, 16, (x, z, h) => {
      if (h < 1.8) return Infinity;
      let p = h > 30 ? (h - 30) * 0.08 : 0;
      // Mild preference to skirt other towns rather than cut through their centres.
      for (const t of towns) {
        if (t.def.id === A.id || t.def.id === B.id) continue;
        const d = Math.hypot(t.def.x - x, t.def.z - z);
        if (d < t.def.r * 0.6) p += 0.6;
      }
      return p;
    });
    if (!path) continue;
    const pts = resample(chaikin(path, 3), 10);
    trunk.push({ pts, h: roadProfile(hf, pts, 1.6), width: ROAD_W });
  }

  // Straight, axis-aligned streets inside towns.
  const streets: Road[] = [];
  for (const t of towns) {
    const axes: ('x' | 'z')[] = t.size === 'large' ? ['x', 'z'] : t.size === 'small' ? [] : [rng.chance(0.5) ? 'x' : 'z'];
    const L = t.def.r * (t.size === 'military' ? 0.7 : 0.85);
    for (const ax of axes) {
      let a = { x: t.def.x - (ax === 'x' ? L : 0), z: t.def.z - (ax === 'z' ? L : 0) };
      let b = { x: t.def.x + (ax === 'x' ? L : 0), z: t.def.z + (ax === 'z' ? L : 0) };
      if (hf.heightAt(a.x, a.z) < 2) a = { x: (a.x + t.def.x) / 2, z: (a.z + t.def.z) / 2 };
      if (hf.heightAt(b.x, b.z) < 2) b = { x: (b.x + t.def.x) / 2, z: (b.z + t.def.z) / 2 };
      const pts = resample([a, b], 10);
      streets.push({ pts, h: roadProfile(hf, pts, 1.6), width: STREET_W });
    }
  }
  return { roads: trunk.concat(streets), trunk };
}

// ============================================================================================
// Building placement
// ============================================================================================

/** Rotation whose front (local -Z) faces the axis direction closest to (fx, fz). */
function facing(fx: number, fz: number): Rot {
  if (Math.abs(fx) > Math.abs(fz)) return fx < 0 ? 1 : 3;
  return fz < 0 ? 0 : 2;
}

interface PlacementCtx {
  hf: Heightfield;
  mask: OccupancyMask;
  rng: Rng;
  plans: BuildingPlan[];
  tiers: (0 | 1 | 2)[];
}

/** Validate a placed plan against the mask and terrain; reserves its area when accepted. */
function tryAccept(ctx: PlacementCtx, plan: BuildingPlan, within: (r: Rect) => boolean, tier: 0 | 1 | 2): boolean {
  const { hx, hz } = footprintHalf(plan.w, plan.d, plan.rot);
  const fp: Rect = { x0: plan.cx - hx, z0: plan.cz - hz, x1: plan.cx + hx, z1: plan.cz + hz };
  const { mask, hf } = ctx;
  if (Math.abs(fp.x0) > hf.half - 20 || Math.abs(fp.x1) > hf.half - 20 || Math.abs(fp.z0) > hf.half - 20 || Math.abs(fp.z1) > hf.half - 20) return false;
  if (!within(fp)) return false;
  if (mask.anyRect(fp.x0 - 2, fp.z0 - 2, fp.x1 + 2, fp.z1 + 2, M_BUILDING | M_PROP)) return false;
  if (mask.anyRect(fp.x0 - 1.5, fp.z0 - 1.5, fp.x1 + 1.5, fp.z1 + 1.5, M_ROAD)) return false;
  if (mask.anyRect(fp.x0 - 0.5, fp.z0 - 0.5, fp.x1 + 0.5, fp.z1 + 0.5, M_APRON)) return false;
  const doors = planDoorsWorld(plan);
  const aprons = doors.map((d) => doorApron(d, 3, 0.5));
  for (const a of aprons) if (mask.anyRect(a.x0, a.z0, a.x1, a.z1, M_BUILDING | M_PROP)) return false;
  const range = hf.rangeIn(fp.x0, fp.z0, fp.x1, fp.z1);
  if (range.min < 1.8 || range.max - range.min > 3.5) return false;
  for (const a of aprons) {
    const h = hf.heightAt((a.x0 + a.x1) / 2, (a.z0 + a.z1) / 2);
    if (h < 1.0) return false;
  }
  mask.markRect(fp.x0 - 1, fp.z0 - 1, fp.x1 + 1, fp.z1 + 1, M_BUILDING);
  mask.markRect(fp.x0 - 2, fp.z0 - 2, fp.x1 + 2, fp.z1 + 2, M_NOVEG);
  for (const a of aprons) mask.markRect(a.x0, a.z0, a.x1, a.z1, M_APRON | M_NOVEG);
  ctx.plans.push(plan);
  ctx.tiers.push(tier);
  return true;
}

interface Seg { ax: number; az: number; bx: number; bz: number; w: number }

function nearestRoadDir(segs: Seg[], x: number, z: number): [number, number] | null {
  let best = Infinity, fx = 0, fz = 0;
  const s = { d: 0, t: 0 };
  for (const g of segs) {
    distToSegment(x, z, g.ax, g.az, g.bx, g.bz, s);
    if (s.d < best) {
      best = s.d;
      fx = g.ax + (g.bx - g.ax) * s.t - x;
      fz = g.az + (g.bz - g.az) * s.t - z;
    }
  }
  return best < Infinity && best > 1e-6 ? [fx, fz] : null;
}

/** Candidate centre beside a road segment, facing it. */
function besideRoad(ctx: PlacementCtx, plan: BuildingPlan, g: Seg, extraOff: number): void {
  const { rng } = ctx;
  const t = rng.range(0.05, 0.95);
  const px = g.ax + (g.bx - g.ax) * t, pz = g.az + (g.bz - g.az) * t;
  const len = Math.hypot(g.bx - g.ax, g.bz - g.az) || 1;
  const dx = (g.bx - g.ax) / len, dz = (g.bz - g.az) / len;
  const side = rng.chance(0.5) ? 1 : -1;
  const nx = -dz * side, nz = dx * side;
  plan.rot = facing(-nx, -nz);
  const { hx, hz } = footprintHalf(plan.w, plan.d, plan.rot);
  const ext = Math.abs(nx) * hx + Math.abs(nz) * hz;
  const off = g.w / 2 + 2.6 + extraOff + ext;
  plan.cx = r1(px + nx * off);
  plan.cz = r1(pz + nz * off);
}

function placeTownBuildings(ctx: PlacementCtx, town: TownPlan, segs: Seg[]): void {
  const { rng } = ctx;
  const t = town.def;
  const military = town.size === 'military';
  const local = segs.filter((g) => {
    const s = distToSegment(t.x, t.z, g.ax, g.az, g.bx, g.bz);
    return s.d < t.r;
  });
  const within = military
    ? (r: Rect): boolean => r.x0 > t.x - t.r + 9 && r.x1 < t.x + t.r - 9 && r.z0 > t.z - t.r + 9 && r.z1 < t.z + t.r - 9
    : (r: Rect): boolean => [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]].every(([x, z]) => Math.hypot(x - t.x, z - t.z) < t.r + 4);
  for (const style of TOWN_STYLES[town.size]) {
    const plan = planBuilding(style, rng, military);
    plan.town = t.id;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (local.length > 0 && rng.chance(0.7)) {
        besideRoad(ctx, plan, rng.pick(local), rng.range(0, 3.5));
      } else {
        const rr = t.r * (military ? 0.75 : 0.85);
        let x = 0, z = 0;
        do { x = rng.range(-rr, rr); z = rng.range(-rr, rr); } while (x * x + z * z > rr * rr);
        x += t.x;
        z += t.z;
        const dir = nearestRoadDir(local, x, z) ?? [t.x - x, t.z - z];
        plan.rot = facing(dir[0], dir[1]);
        plan.cx = r1(x);
        plan.cz = r1(z);
      }
      if (tryAccept(ctx, plan, within, t.tier)) break;
    }
  }
}

/** Small farmsteads (barn, house, shed) along trunk roads between towns. */
function placeFarmsteads(ctx: PlacementCtx, towns: TownPlan[], trunk: Road[], count: number): void {
  const { rng } = ctx;
  if (trunk.length === 0 || towns.length === 0) return;
  let made = 0;
  for (let attempt = 0; attempt < 300 && made < count; attempt++) {
    const road = rng.pick(trunk);
    if (road.pts.length < 3) continue;
    const k = rng.int(1, road.pts.length - 2);
    const a = road.pts[k], b = road.pts[k + 1];
    if (towns.some((t) => Math.hypot(t.def.x - a.x, t.def.z - a.z) < t.def.r + 60)) continue;
    let nearest = towns[0];
    for (const t of towns) if (Math.hypot(t.def.x - a.x, t.def.z - a.z) < Math.hypot(nearest.def.x - a.x, nearest.def.z - a.z)) nearest = t;
    const g: Seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, w: road.width };
    let placedHere = 0;
    for (const style of ['barn', 'house', 'shed'] as BuildingStyle[]) {
      const plan = planBuilding(style, rng, false);
      plan.town = nearest.def.id;
      for (let tries = 0; tries < 40; tries++) {
        besideRoad(ctx, plan, g, rng.range(1, 12));
        if (tryAccept(ctx, plan, () => true, 0)) { placedHere++; break; }
      }
    }
    if (placedHere > 0) made++;
  }
}

// ============================================================================================
// Props
// ============================================================================================

function placeTownProps(ctx: PropCtx, town: TownPlan, plans: BuildingPlan[], props: PropInfo[]): void {
  const { rng } = ctx;
  const t = town.def;
  const mine = plans.filter((p) => p.town === t.id && Math.hypot(p.cx - t.x, p.cz - t.z) < t.r + 10);
  const randomIn = (frac: number): [number, number] => {
    const rr = t.r * frac;
    let x = 0, z = 0;
    do { x = rng.range(-rr, rr); z = rng.range(-rr, rr); } while (x * x + z * z > rr * rr);
    return [t.x + x, t.z + z];
  };
  const push = (p: PropInfo | null): boolean => {
    if (p) props.push(p);
    return p !== null;
  };
  if (town.size === 'military') {
    for (let i = 0, tries = 0; i < 9 && tries < 200; tries++) {
      const [x, z] = randomIn(0.75);
      if (push(placeContainer(ctx, x, z, rng.chance(0.5), rng.chance(0.5), rng.chance(0.6)))) i++;
    }
    for (let i = 0, tries = 0; i < 12 && tries < 200; tries++) {
      const [x, z] = randomIn(0.8);
      const along = rng.chance(0.5), len = rng.range(3, 5);
      if (!push(placeSandbags(ctx, x, z, len, along))) continue;
      i++;
      // Some walls get a return to form an L-shaped position.
      if (rng.chance(0.4)) {
        const sx = along ? x + (rng.chance(0.5) ? 1 : -1) * (len / 2 + 0.3) : x + (rng.chance(0.5) ? 1.6 : -1.6);
        const sz = along ? z + (rng.chance(0.5) ? 1.6 : -1.6) : z + (rng.chance(0.5) ? 1 : -1) * (len / 2 + 0.3);
        push(placeSandbags(ctx, sx, sz, 2.6, !along, false));
      }
    }
    for (let i = 0, tries = 0; i < 12 && tries < 200; tries++) {
      const [x, z] = randomIn(0.8);
      if (push(placeCrates(ctx, x, z, true))) i++;
    }
    for (let i = 0, tries = 0; i < 4 && tries < 100; tries++) {
      const [x, z] = randomIn(0.85);
      if (push(placeBarrier(ctx, x, z, rng.chance(0.5)))) i++;
    }
    // Perimeter chain-link fence with a gap on every side (plus gaps where roads cross).
    const F = t.r - 3;
    const sides: [number, number, number, number][] = [
      [t.x - F, t.z - F, t.x + F, t.z - F], [t.x - F, t.z + F, t.x + F, t.z + F],
      [t.x - F, t.z - F, t.x - F, t.z + F], [t.x + F, t.z - F, t.x + F, t.z + F],
    ];
    for (const [x0, z0, x1, z1] of sides) {
      const g = rng.range(0.2, 0.8), gw = 7 / (2 * F);
      const mx0 = x0 + (x1 - x0) * (g - gw / 2), mz0 = z0 + (z1 - z0) * (g - gw / 2);
      const mx1 = x0 + (x1 - x0) * (g + gw / 2), mz1 = z0 + (z1 - z0) * (g + gw / 2);
      placeFence(ctx, x0, z0, mx0, mz0, false);
      placeFence(ctx, mx1, mz1, x1, z1, false);
    }
    return;
  }
  const crates = town.size === 'large' ? 8 : town.size === 'medium' ? 5 : 3;
  for (let i = 0, tries = 0; i < crates && tries < 120 && mine.length > 0; tries++) {
    // Beside a building wall.
    const p = rng.pick(mine);
    const { hx, hz } = footprintHalf(p.w, p.d, p.rot);
    const side = rng.int(0, 3), off = rng.range(1.9, 2.6);
    const x = side === 0 ? p.cx - hx - off : side === 1 ? p.cx + hx + off : p.cx + rng.range(-hx, hx);
    const z = side === 2 ? p.cz - hz - off : side === 3 ? p.cz + hz + off : p.cz + rng.range(-hz, hz);
    if (push(placeCrates(ctx, x, z, false))) i++;
  }
  const containers = town.size === 'large' ? 3 : town.size === 'medium' ? 2 : 0;
  const wh = mine.find((p) => p.style === 'warehouse');
  for (let i = 0, tries = 0; i < containers && tries < 120; tries++) {
    let x: number, z: number;
    if (wh && rng.chance(0.7)) {
      const { hx, hz } = footprintHalf(wh.w, wh.d, wh.rot);
      x = wh.cx + rng.range(-hx - 9, hx + 9);
      z = wh.cz + rng.range(-hz - 9, hz + 9);
    } else [x, z] = randomIn(0.85);
    if (push(placeContainer(ctx, x, z, rng.chance(0.5), rng.chance(0.4), false))) i++;
  }
  const barriers = town.size === 'large' ? 4 : town.size === 'medium' ? 2 : 1;
  for (let i = 0, tries = 0; i < barriers && tries < 80; tries++) {
    const [x, z] = randomIn(0.9);
    if (push(placeBarrier(ctx, x, z, rng.chance(0.5)))) i++;
  }
}

/** Low wooden fences around the back and sides of some house yards. */
function placeYardFences(ctx: PropCtx, plans: BuildingPlan[]): void {
  const { rng } = ctx;
  for (const p of plans) {
    if ((p.style !== 'house' && p.style !== 'barn') || !rng.chance(0.45)) continue;
    const { hx, hz } = footprintHalf(p.w, p.d, p.rot);
    const e = 3.6;
    const x0 = p.cx - hx - e, x1 = p.cx + hx + e, z0 = p.cz - hz - e, z1 = p.cz + hz + e;
    // The side containing the main door stays open.
    const front = planDoorsWorld(p)[0];
    const sides: [number, number, number, number, boolean][] = [
      [x0, z0, x1, z0, front.nz < -0.5], [x0, z1, x1, z1, front.nz > 0.5],
      [x0, z0, x0, z1, front.nx < -0.5], [x1, z0, x1, z1, front.nx > 0.5],
    ];
    for (const [ax, az, bx, bz, open] of sides) if (!open) placeFence(ctx, ax, az, bx, bz, true);
  }
}

// ============================================================================================
// Surfaces
// ============================================================================================

function computeSurfaces(world: GeneratedWorld, onRoad: Uint8Array, towns: TownPlan[], seed: number): void {
  const hf = world.hf, res = hf.res, h = hf.h, cell = hf.cell;
  const nDirt = new Noise2(hash32(seed, S_SURF)), nRock = new Noise2(hash32(seed, S_SURF + 1));
  for (let j = 0; j < res; j++) {
    const z = hf.coord(j);
    for (let i = 0; i < res; i++) {
      const x = hf.coord(i), v = j * res + i, hv = h[v];
      let s: number;
      if (hv < 1.6) s = SURF.sand;
      else if (onRoad[v]) s = SURF.road;
      else {
        const gx = (h[j * res + Math.min(res - 1, i + 1)] - h[j * res + Math.max(0, i - 1)]) / (2 * cell);
        const gz = (h[Math.min(res - 1, j + 1) * res + i] - h[Math.max(0, j - 1) * res + i]) / (2 * cell);
        const ny = 1 / Math.sqrt(gx * gx + gz * gz + 1);
        const dirt = nDirt.fbm(x / 55, z / 55, 3);
        if (ny < 0.8 || hv > 64 + 10 * nRock.fbm(x / 40, z / 40, 2)) s = SURF.rock;
        else if (hv < 2.4) s = dirt > 0.1 ? SURF.sand : SURF.grass;
        else {
          let townDirt = false;
          for (const t of towns) {
            const d = Math.hypot(t.def.x - x, t.def.z - z);
            if (d < t.def.r * 0.9 && dirt > -0.1) { townDirt = true; break; }
          }
          s = townDirt || dirt > 0.36 ? SURF.dirt : SURF.grass;
        }
      }
      world.surface[v] = s;
    }
  }
}

// ============================================================================================
// Orchestration
// ============================================================================================

export function generateIsland(seed: number): GeneratedWorld {
  const hf = new Heightfield(MAP_SIZE, TERRAIN_RES);
  const world = new GeneratedWorld(seed, 'island', hf);
  const shape = makeShape(seed);
  for (let j = 0; j < hf.res; j++) {
    const z = hf.coord(j);
    for (let i = 0; i < hf.res; i++) hf.h[j * hf.res + i] = shape.height(hf.coord(i), z);
  }

  // Towns sit on smoothly blended plateaus.
  const towns = placeTowns(seed, shape);
  for (const t of towns) hf.flattenDisc(t.def.x, t.def.z, t.plateau, t.def.r + 6, t.def.r + 45);

  // Roads.
  const { roads, trunk } = buildRoads(seed, hf, towns);
  const onRoad = flattenRoads(hf, roads);
  const mask = new OccupancyMask(MAP_SIZE);
  rasterizeRoads(mask, roads);
  for (const t of towns) mask.markCircle(t.def.x, t.def.z, t.def.r + 8, M_TOWN);

  // Building plans, then local terrain levelling under each footprint.
  const segs: Seg[] = [];
  for (const r of roads) for (let i = 0; i + 1 < r.pts.length; i++) segs.push({ ax: r.pts[i].x, az: r.pts[i].z, bx: r.pts[i + 1].x, bz: r.pts[i + 1].z, w: r.width });
  const pctx: PlacementCtx = { hf, mask, rng: new Rng(hash32(seed, S_BUILD)), plans: [], tiers: [] };
  for (const t of towns) placeTownBuildings(pctx, t, segs);
  placeFarmsteads(pctx, towns, trunk, 3);
  for (const p of pctx.plans) {
    const { hx, hz } = footprintHalf(p.w, p.d, p.rot);
    const target = hf.meanIn(p.cx - hx, p.cz - hz, p.cx + hx, p.cz + hz);
    hf.flattenRect(p.cx - hx, p.cz - hz, p.cx + hx, p.cz + hz, target, 1.5, 6);
  }
  // Terrain is final from here on.
  computeSurfaces(world, onRoad, towns, seed);

  const rooms: RoomInfo[] = [];
  const stairZones = new Map<number, Rect>();
  const tierOf: (0 | 1 | 2)[] = [];
  for (let i = 0; i < pctx.plans.length; i++) {
    const built = generateBuilding(pctx.plans[i], i, hf, world.boxes);
    world.buildings.push(built.def);
    for (const r of built.rooms) rooms.push(r);
    if (built.stairZone) stairZones.set(i, built.stairZone);
    tierOf.push(pctx.tiers[i]);
  }

  // Props.
  const props: PropInfo[] = [];
  const propCtx: PropCtx = { boxes: world.boxes, hf, mask, rng: new Rng(hash32(seed, S_PROPS)) };
  for (const t of towns) placeTownProps(propCtx, t, pctx.plans, props);
  placeYardFences(propCtx, pctx.plans);
  world.reindexBoxes();

  // Vegetation.
  placeVegetation(world, mask, new Rng(hash32(seed, S_VEG)), {
    trees: TARGET_TREES, rocks: TARGET_ROCKS, bushes: TARGET_BUSHES, noiseSeed: hash32(seed, S_VEG + 1), minLandH: 2.2,
  });

  // Loot.
  const townDefs = towns.map((t) => t.def);
  placeLoot({
    world,
    rng: new Rng(hash32(seed, S_LOOT)),
    rooms,
    stairZones,
    buildingTier: (b) => tierOf[b] ?? 0,
    outdoorTier: (x, z) => {
      for (const t of townDefs) if (Math.hypot(t.x - x, t.z - z) < t.r + 30) return t.tier;
      return 0;
    },
    props,
    target: TARGET_LOOT,
    indoorFrac: 0.88,
  });

  // Vehicles on trunk roads.
  placeVehicles(world, new Rng(hash32(seed, S_VEH)), trunk, townDefs, TARGET_VEHICLES);

  world.towns = townDefs;
  world.roads = roadSegments(roads);
  return world;
}

