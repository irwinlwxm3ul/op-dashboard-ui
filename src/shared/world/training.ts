// Training ground: a compact flat plain with a firing range (lanes, static targets from 25 to 600 m,
// moving and pop-up targets), weapon/gear racks holding every item, a small CQB village built with
// the building generator, and a vehicle test track with ramps.

import { TERRAIN_RES, TRAINING_MAP_SIZE } from '../constants';
import type { ItemId, TrainingTarget, Vec2, VehicleType } from '../types';
import { fbm2, hash32, Rng } from '../rng';
import {
  type BuildingPlan, type Rect, type RoomInfo, type Rot, doorApron, footprintHalf, generateBuilding, planBuilding,
  planDoorsWorld,
} from './buildings';
import { Heightfield, smooth01 } from './heightfield';
import { M_APRON, M_BUILDING, M_NOVEG, M_TOWN, OccupancyMask } from './mask';
import { TRAINING_TOWN_NAME } from './names';
import { PAL } from './palette';
import { type PropCtx, type PropInfo, placeBarrier, placeContainer, placeCrates } from './props';
import { type Road, flattenRoads, rasterizeRoads, resample, roadProfile, roadSegments } from './roads';
import { placeLoot } from './spawns';
import { SURF } from './surfaces';
import { placeVegetation } from './vegetation';
import { GeneratedWorld, pushBox } from './worldImpl';

/** Every item in the game, grouped into rack rows (compile-time complete via the Record). */
const ITEM_ROWS: Record<ItemId, number> = {
  pistol: 0, smg: 0, ar: 0, shotgun: 0, dmr: 0, sniper: 0,
  ammo_9mm: 1, ammo_556: 1, ammo_762: 1, ammo_12g: 1, ammo_300: 1,
  bandage: 2, firstaid: 2, medkit: 2, energy: 2, fuel: 2, frag: 2,
  vest1: 3, vest2: 3, vest3: 3, helmet1: 3, helmet2: 3, helmet3: 3, pack1: 3, pack2: 3, pack3: 3,
};
export const TRAINING_ITEMS = Object.keys(ITEM_ROWS) as ItemId[];

/** Static target distances from the firing line (m). */
export const TRAINING_RANGES = [25, 50, 100, 200, 300, 400, 500, 600] as const;
const MOVING_RANGES = [50, 100, 200] as const;
const POPUP_RANGES = [15, 20, 25, 30] as const;

const PLAIN = 3.0;
const FIRING_Z = 300;
const LANE_W = 10;
/** Lane i centre x. */
const laneX = (i: number): number => -75 + LANE_W * i;
const MOVING_X0 = 12, MOVING_X1 = 58;
const POPUP_X = [68, 74, 80, 86];

/** Facility areas that must stay flat and free of vegetation. */
const AREAS: Rect[] = [
  { x0: -130, z0: -335, x1: 100, z1: 345 }, // range + racks + spawn
  { x0: -325, z0: -265, x1: -125, z1: 165 }, // vehicle track
  { x0: 110, z0: 55, x1: 280, z1: 250 }, // CQB village
];
const CQB = { x: 195, z: 152 };
const TRACK = { xE: -160, xW: -300, zS: -180, zN: 80, cx: -230, r: 70 };

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function areaDist(x: number, z: number): number {
  let best = Infinity;
  for (const a of AREAS) {
    const dx = x < a.x0 ? a.x0 - x : x > a.x1 ? x - a.x1 : 0;
    const dz = z < a.z0 ? a.z0 - z : z > a.z1 ? z - a.z1 : 0;
    best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
  }
  return best;
}

/** tan(k*pi/16), k = 0..7: rational circle parametrisation without trig. */
const HALF_TANS = [0, 0.19891237, 0.41421356, 0.66817864, 1, 1.49660576, 2.41421356, 5.02733949];

/** Points of a half circle from angle 0 to pi (exclusive of the end) around (cx, cz) with sign sz. */
function halfCircle(cx: number, cz: number, r: number, sx: number, sz: number): Vec2[] {
  const out: Vec2[] = [];
  for (const t of HALF_TANS) {
    const d = 1 + t * t;
    out.push({ x: cx + sx * r * ((1 - t * t) / d), z: cz + sz * r * ((2 * t) / d) });
  }
  return out;
}

function trackPolyline(): Vec2[] {
  const { xE, xW, zS, zN, cx, r } = TRACK;
  const pts: Vec2[] = [];
  // East straight northbound, north arc east->west, west straight southbound, south arc west->east.
  pts.push({ x: xE, z: zS });
  for (const p of halfCircle(cx, zN, r, 1, 1)) pts.push(p);
  pts.push({ x: xW, z: zN });
  for (const p of halfCircle(cx, zS, r, -1, -1)) pts.push(p);
  pts.push({ x: xE, z: zS });
  return pts;
}

export function generateTraining(seed: number): GeneratedWorld {
  const size = TRAINING_MAP_SIZE;
  const hf = new Heightfield(size, TERRAIN_RES);
  const world = new GeneratedWorld(seed, 'training', hf);
  const half = hf.half;
  const sCoast = hash32(seed, 0x7c1), sHill = hash32(seed, 0x7c2);

  // ---- Terrain: flat plain, gentle hills near the edges, a backstop berm, sea beyond ---------------
  for (let j = 0; j < hf.res; j++) {
    const z = hf.coord(j);
    for (let i = 0; i < hf.res; i++) {
      const x = hf.coord(i);
      const e = half - Math.max(Math.abs(x), Math.abs(z));
      const ce = 26 + 6 * fbm2(sCoast, x / 90, z / 90, 2);
      const d = e - ce;
      let h: number;
      if (d < 0) h = Math.max(-10, -0.8 + 0.236 * d);
      else {
        h = -0.8 + (PLAIN + 0.8) * smooth01(d / 40);
        const band = smooth01((d - 8) / 25) * (1 - smooth01((e - 75) / 45));
        const n = Math.max(0, (fbm2(sHill, x / 80, z / 80, 3) * 0.5 + 0.5 - 0.3) / 0.7);
        const keep = smooth01((areaDist(x, z) - 4) / 30);
        h += band * keep * 11 * n;
        // Earth backstop behind the long-range targets.
        if (x > -135 && x < 105) {
          const q = (z + 338) / 14;
          if (q > -1 && q < 1) h += 7 * (1 - q * q) * (1 - q * q) * smooth01((Math.min(x + 135, 105 - x)) / 12);
        }
      }
      hf.h[j * hf.res + i] = h;
    }
  }
  const mask = new OccupancyMask(size);
  for (const a of AREAS) mask.markRect(a.x0, a.z0, a.x1, a.z1, M_TOWN);

  // ---- Roads: test track loop and service roads --------------------------------------------------
  const roads: Road[] = [];
  const addRoad = (pts: Vec2[], width: number): void => {
    const p = resample(pts, 10);
    roads.push({ pts: p, h: roadProfile(hf, p, 1.6), width });
  };
  addRoad(trackPolyline(), 10);
  addRoad([{ x: -110, z: 318 }, { x: -230, z: 318 }, { x: -230, z: TRACK.zN + TRACK.r }], 7);
  addRoad([{ x: 90, z: 318 }, { x: CQB.x, z: 318 }, { x: CQB.x, z: CQB.z + 60 }], 7);
  addRoad([{ x: CQB.x, z: CQB.z - 60 }, { x: CQB.x, z: CQB.z + 60 }], 6);
  const onRoad = flattenRoads(hf, roads);
  rasterizeRoads(mask, roads);

  // ---- Surfaces -----------------------------------------------------------------------------------
  for (let j = 0; j < hf.res; j++) {
    const z = hf.coord(j);
    for (let i = 0; i < hf.res; i++) {
      const x = hf.coord(i), v = j * hf.res + i, h = hf.h[v];
      let s: number = SURF.grass;
      if (h < 1.6) s = SURF.sand;
      else if (onRoad[v]) s = SURF.road;
      else if (z > FIRING_Z - 4 && z < FIRING_Z + 40 && x > -95 && x < 100) s = SURF.dirt;
      else if (h > PLAIN + 7) s = SURF.rock;
      world.surface[v] = s;
    }
  }

  const rng = new Rng(hash32(seed, 0x7c3));
  const boxes = world.boxes;
  const g = (x: number, z: number): number => hf.heightAt(x, z);

  // ---- CQB village (reuses the building generator) -------------------------------------------------
  const styles = ['house', 'apartment', 'shop', 'warehouse'] as const;
  const slots: { x: number; z: number; rot: Rot }[] = [
    { x: CQB.x - 24, z: CQB.z - 26, rot: 3 }, { x: CQB.x + 26, z: CQB.z - 26, rot: 1 },
    { x: CQB.x - 24, z: CQB.z + 26, rot: 3 }, { x: CQB.x + 28, z: CQB.z + 28, rot: 1 },
  ];
  const plans: BuildingPlan[] = [];
  for (let i = 0; i < styles.length; i++) {
    const plan = planBuilding(styles[i], rng, false);
    if (plan.style === 'house') plan.floors = Math.max(plan.floors, 2);
    plan.cx = slots[i].x;
    plan.cz = slots[i].z;
    plan.rot = slots[i].rot;
    plan.town = 0;
    // Re-plan doors/stairs if the forced floor count added a staircase.
    if (plan.floors > 1 && plan.stairSide === 0) {
      plan.stairSide = 1;
      plan.doors = plan.doors.filter((d) => d.side === 'front' || d.side === 'left');
    }
    plans.push(plan);
    const { hx, hz } = footprintHalf(plan.w, plan.d, plan.rot);
    mask.markRect(plan.cx - hx - 1, plan.cz - hz - 1, plan.cx + hx + 1, plan.cz + hz + 1, M_BUILDING);
    mask.markRect(plan.cx - hx - 2, plan.cz - hz - 2, plan.cx + hx + 2, plan.cz + hz + 2, M_NOVEG);
    for (const d of planDoorsWorld(plan)) {
      const a = doorApron(d, 3, 0.5);
      mask.markRect(a.x0, a.z0, a.x1, a.z1, M_APRON | M_NOVEG);
    }
  }
  const rooms: RoomInfo[] = [];
  const stairZones = new Map<number, Rect>();
  for (let i = 0; i < plans.length; i++) {
    const built = generateBuilding(plans[i], i, hf, boxes);
    world.buildings.push(built.def);
    rooms.push(...built.rooms);
    if (built.stairZone) stairZones.set(i, built.stairZone);
  }
  const props: PropInfo[] = [];
  const pctx: PropCtx = { boxes, hf, mask, rng };
  for (let i = 0, tries = 0; i < 10 && tries < 200; tries++) {
    const x = CQB.x + rng.range(-45, 45), z = CQB.z + rng.range(-45, 45);
    const kind = rng.next();
    const p = kind < 0.4 ? placeCrates(pctx, x, z, false) : kind < 0.75 ? placeBarrier(pctx, x, z, rng.chance(0.5)) : placeContainer(pctx, x, z, rng.chance(0.5), rng.chance(0.6), false);
    if (p) { props.push(p); i++; }
  }

  // ---- Firing range -------------------------------------------------------------------------------
  const gl = g(0, FIRING_Z);
  const firingLine = { x: 0, y: r3(gl), z: FIRING_Z };
  const targets: TrainingTarget[] = [];
  // Static targets: one per lane, steel plate on a short post.
  for (let i = 0; i < TRAINING_RANGES.length; i++) {
    const range = TRAINING_RANGES[i];
    const x = laneX(i), z = FIRING_Z - range, y = g(x, z);
    pushBox(boxes, x - 0.06, y - 0.3, z - 0.06, x + 0.06, y + 0.4, z + 0.06, 'misc', 'wood', PAL.targetPost, -1);
    const id = pushBox(boxes, x - 0.3, y + 0.4, z - 0.03, x + 0.3, y + 2.2, z + 0.03, 'target', 'metal', PAL.target, -1);
    targets.push({ id, pos: { x, y: r3(y + 1.3), z }, range, kind: 'static' });
    // Range board beside the target.
    pushBox(boxes, x + 2.2, y - 0.2, z - 0.05, x + 3.2, y + 1.4, z + 0.05, 'misc', 'wood', PAL.marker, -1, false);
  }
  // Lane dividers: marker posts along every lane boundary.
  for (let k = 0; k <= TRAINING_RANGES.length; k++) {
    const x = laneX(0) - LANE_W / 2 + k * LANE_W;
    for (const dist of [0, 10, 25, 50, 75, 100, 150, 200, 300, 400, 500, 600]) {
      const z = FIRING_Z - dist, y = g(x, z);
      pushBox(boxes, x - 0.08, y - 0.2, z - 0.08, x + 0.08, y + 0.6, z + 0.08, 'misc', 'wood', PAL.marker, -1, false);
    }
  }
  // Shooting benches behind the firing line for every lane (incl. moving and pop-up lanes).
  const benchXs = [...TRAINING_RANGES.map((_, i) => laneX(i) + 2.5), (MOVING_X0 + MOVING_X1) / 2, POPUP_X[0] + 4];
  for (const x of benchXs) {
    const y = g(x, FIRING_Z + 1);
    pushBox(boxes, x - 0.7, y - 0.1, FIRING_Z + 0.8, x + 0.7, y + 0.85, FIRING_Z + 1.5, 'misc', 'wood', PAL.bench, -1);
  }
  // Moving targets shuttle across their own lane on a low rail.
  for (let k = 0; k < MOVING_RANGES.length; k++) {
    const range = MOVING_RANGES[k], z = FIRING_Z - range, y = g((MOVING_X0 + MOVING_X1) / 2, z);
    pushBox(boxes, MOVING_X0 - 1, y - 0.2, z - 0.15, MOVING_X1 + 1, y + 0.15, z + 0.15, 'misc', 'metal', PAL.rail, -1, false);
    targets.push({
      id: -1, pos: { x: MOVING_X0, y: r3(y + 1.3), z }, range, kind: 'moving',
      a: { x: MOVING_X0, y: r3(y + 1.3), z }, b: { x: MOVING_X1, y: r3(y + 1.3), z }, speed: 2.5 + k,
    });
  }
  for (let k = 0; k < POPUP_RANGES.length; k++) {
    const range = POPUP_RANGES[k], x = POPUP_X[k], z = FIRING_Z - range, y = g(x, z);
    targets.push({ id: -1, pos: { x, y: r3(y + 1.3), z }, range, kind: 'popup' });
  }

  // ---- Racks: every item, grouped by row behind the spawn ------------------------------------------
  const racks: { pos: { x: number; y: number; z: number }; item: ItemId }[] = [];
  const rows: ItemId[][] = [[], [], [], []];
  for (const id of TRAINING_ITEMS) rows[ITEM_ROWS[id]].push(id);
  for (let r = 0; r < rows.length; r++) {
    const z = FIRING_Z + 12 + r * 6;
    const n = rows[r].length, spacing = 2.4;
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * spacing;
      const y = g(x, z);
      const top = y + 0.9;
      pushBox(boxes, x - 0.7, y - 0.15, z - 0.35, x + 0.7, top, z + 0.35, 'rack', 'wood', PAL.rack, -1);
      racks.push({ pos: { x, y: r3(top + 0.05), z }, item: rows[r][k] });
    }
  }

  // ---- Vehicle test track ramps --------------------------------------------------------------------
  // Hump on the east straight (both directions), jump ramp on the west straight (southbound).
  const rampW = 2.5;
  {
    const x = TRACK.xE, z0 = -120;
    for (let i = 0; i < 10; i++) {
      const top = g(x, z0 + i) + 0.15 * (i + 1);
      pushBox(boxes, x - rampW, top - 0.15 * (i + 1) - 0.1, z0 + i, x + rampW, top, z0 + i + 1, 'ramp', 'wood', PAL.ramp, -1);
    }
    pushBox(boxes, x - rampW, g(x, z0 + 12) - 0.1, z0 + 10, x + rampW, g(x, z0 + 12) + 1.5, z0 + 14, 'ramp', 'wood', PAL.ramp, -1);
    for (let i = 0; i < 10; i++) {
      const zz = z0 + 14 + i;
      const top = g(x, zz) + 0.15 * (10 - i);
      pushBox(boxes, x - rampW, g(x, zz) - 0.1, zz, x + rampW, top, zz + 1, 'ramp', 'wood', PAL.ramp, -1);
    }
  }
  {
    const x = TRACK.xW, zHigh = 0;
    for (let i = 0; i < 12; i++) {
      const zz = zHigh + i;
      const top = g(x, zz) + 0.13 * (12 - i);
      pushBox(boxes, x - rampW, g(x, zz) - 0.1, zz, x + rampW, top, zz + 1, 'ramp', 'wood', PAL.ramp, -1);
    }
  }

  // Static target ids are their plate box ids; moving / pop-up targets get ids past every box id.
  let nextId = boxes.length;
  for (const t of targets) if (t.id < 0) t.id = nextId++;

  world.reindexBoxes();

  // ---- Vehicle spawns: two of each type on a parking apron beside the east straight ----------------
  const types: VehicleType[] = ['buggy', 'buggy', 'uaz', 'uaz', 'bike', 'bike'];
  for (let k = 0; k < types.length; k++) {
    const x = TRACK.xE + 15, z = -60 + k * 12;
    // yaw = PI faces +Z (northbound, the track direction on the east straight).
    world.vehicleSpawns.push({ pos: { x, y: r3(g(x, z)), z }, yaw: r3(Math.PI), type: types[k] });
  }

  // ---- Vegetation on the outskirts -----------------------------------------------------------------
  placeVegetation(world, mask, new Rng(hash32(seed, 0x7c4)), {
    trees: 420, rocks: 160, bushes: 500, noiseSeed: hash32(seed, 0x7c5), minLandH: 2.2, forestBias: 0.1,
    exclude: (x, z) => areaDist(x, z) < 12,
  });

  // ---- Loot in the CQB buildings ---------------------------------------------------------------------
  placeLoot({
    world, rng: new Rng(hash32(seed, 0x7c6)), rooms, stairZones,
    buildingTier: () => 1, outdoorTier: () => 1, props, target: 70, indoorFrac: 0.9,
  });

  world.towns = [{ id: 0, name: TRAINING_TOWN_NAME, x: CQB.x, z: CQB.z, r: 75, tier: 1 }];
  world.roads = roadSegments(roads);
  const spawnX = 0, spawnZ = FIRING_Z + 6;
  world.training = {
    spawn: { x: spawnX, y: r3(g(spawnX, spawnZ)), z: spawnZ },
    spawnYaw: 0,
    racks,
    targets,
    firingLine,
  };
  return world;
}
