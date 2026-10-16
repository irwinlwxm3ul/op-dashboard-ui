// Procedural, fully enterable buildings made only of axis-aligned WorldBox pieces.
//
// Local frame: footprint centred on the origin, width `w` along local X, depth `d` along local Z,
// the front (main door) faces local -Z. The plan is rotated by multiples of 90 degrees into the
// world, so every collider remains an AABB.
//
// Vertical layout: the ground-floor slab top is `baseY`; storeys are `storey` m of clear height
// plus a 0.2 m slab (3.2 m floor-to-floor for standard storeys). Exterior walls (0.25 m) are split
// into boxes around door gaps (>= 1.3 x 2.2 m) and window gaps (sill 1.0 m, head 2.0 m).
//
// Stairs live in a reserved "stair zone" against the back wall made of two 1.3 m strips:
// run k (floor k -> k+1) uses strip A (against the wall) for even k and strip B for odd k, so
// consecutive runs form a switchback. Every run is 11 solid step boxes (rise 3.2/12 = 0.267 m,
// run 0.3 m); the slab above has a hole over the run, guarded by rails. Interior partitions are a
// BSP of the remaining floor area; every split wall gets a doorway and later splits never abut an
// existing opening, so every room on a floor is connected.

import type { BoxKind, BuildingDef, BuildingStyle, SurfaceMaterial, WorldBox } from '../types';
import { Rng } from '../rng';
import { Heightfield } from './heightfield';
import { PAL } from './palette';
import { pushBox } from './worldImpl';

export type Side = 'front' | 'back' | 'left' | 'right';
export type Rot = 0 | 1 | 2 | 3;

export interface DoorPlan {
  side: Side;
  /** Door centre along the wall (local x for front/back, local z for left/right). */
  u: number;
  width: number;
  height: number;
}

export interface BuildingPlan {
  style: BuildingStyle;
  w: number;
  d: number;
  floors: number;
  roofAccess: boolean;
  /** Stair zone against the local -X (-1) or +X (1) end of the back wall; 0 = no stairs. */
  stairSide: -1 | 0 | 1;
  doors: DoorPlan[];
  military: boolean;
  seed: number;
  cx: number;
  cz: number;
  rot: Rot;
  town: number;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface RoomInfo extends Rect {
  /** Walkable floor height. */
  y: number;
  floor: number;
  indoor: boolean;
  building: number;
}

export interface DoorInfo {
  /** Centre of the door gap on the outer wall face. */
  x: number;
  z: number;
  /** Outward normal. */
  nx: number;
  nz: number;
  width: number;
}

export interface BuiltBuilding {
  def: BuildingDef;
  baseY: number;
  rooms: RoomInfo[];
  /** Stair zone (world), excluded from loot placement on every floor. */
  stairZone: Rect | null;
  doors: DoorInfo[];
}

export const WALL_T = 0.25;
export const SLAB = 0.2;
export const DOOR_W = 1.4;
export const DOOR_H = 2.2;
export const WIN_SILL = 1.0;
export const WIN_TOP = 2.0;
const PART_T = 0.15;
const STOREY = 3.0;
const STEP_RUN = 0.3;
const MAX_RISE = 0.28;
const STRIP = 1.3;
const LANDING = 1.0;
const INNER_DOOR_W = 1.2;
const MIN_ROOM = 2.6;
const RAIL_T = 0.08;
const RAIL_H = 1.0;
/** Free depth required in front of the stair zone. */
const STAIR_FRONT = 1.4;

interface StyleSpec {
  w: [number, number];
  d: [number, number];
  floors: [number, number];
  roofAccess: number;
  storey: number;
  roof: 'gable' | 'flat';
  bsp: number;
  winW: [number, number];
  winGap: [number, number];
  winSkip: number;
  bigDoor: boolean;
  secondDoor: number;
}

const SPECS: Record<BuildingStyle, StyleSpec> = {
  house: { w: [8, 11], d: [7, 9.5], floors: [1, 2], roofAccess: 0, storey: STOREY, roof: 'gable', bsp: 2, winW: [1.0, 1.3], winGap: [1.4, 2.2], winSkip: 0.15, bigDoor: false, secondDoor: 0.5 },
  barn: { w: [10, 14], d: [8, 11], floors: [1, 1], roofAccess: 0, storey: 4.8, roof: 'gable', bsp: 0, winW: [1.0, 1.2], winGap: [3, 4.5], winSkip: 0.3, bigDoor: true, secondDoor: 1 },
  apartment: { w: [12, 16], d: [9, 12], floors: [2, 3], roofAccess: 0.85, storey: STOREY, roof: 'flat', bsp: 3, winW: [1.1, 1.4], winGap: [1.3, 1.8], winSkip: 0.08, bigDoor: false, secondDoor: 0.6 },
  warehouse: { w: [16, 22], d: [12, 15], floors: [1, 1], roofAccess: 0, storey: 6.0, roof: 'flat', bsp: 1, winW: [1.2, 1.6], winGap: [3, 4.5], winSkip: 0.2, bigDoor: true, secondDoor: 1 },
  shed: { w: [4, 5.2], d: [3.6, 4.6], floors: [1, 1], roofAccess: 0, storey: 2.7, roof: 'flat', bsp: 0, winW: [0.8, 1.0], winGap: [1.5, 2], winSkip: 0.4, bigDoor: false, secondDoor: 0 },
  tower: { w: [6, 6.6], d: [5.2, 5.8], floors: [3, 3], roofAccess: 1, storey: STOREY, roof: 'flat', bsp: 0, winW: [1.0, 1.2], winGap: [1.0, 1.4], winSkip: 0.1, bigDoor: false, secondDoor: 0 },
  bunker: { w: [8, 10], d: [6, 7.5], floors: [1, 1], roofAccess: 0, storey: 2.6, roof: 'flat', bsp: 1, winW: [1.0, 1.4], winGap: [2, 3], winSkip: 0.25, bigDoor: false, secondDoor: 0.4 },
  shop: { w: [9, 12], d: [8, 10], floors: [1, 2], roofAccess: 0.5, storey: STOREY, roof: 'flat', bsp: 1, winW: [1.6, 2.2], winGap: [1.0, 1.6], winSkip: 0.05, bigDoor: false, secondDoor: 0.6 },
};

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Stair geometry for a storey of `storey` m clear height. */
function stairGeom(storey: number): { steps: number; rise: number; len: number } {
  const fh = storey + SLAB;
  const steps = Math.ceil(fh / MAX_RISE);
  return { steps, rise: fh / steps, len: (steps - 1) * STEP_RUN };
}

/** Required interior width for the stair zone. */
export function stairZoneWidth(): number {
  return LANDING * 2 + stairGeom(STOREY).len;
}

/** World-space extents (half sizes) of a plan's footprint for a rotation. */
export function footprintHalf(w: number, d: number, rot: Rot): { hx: number; hz: number } {
  return rot % 2 === 1 ? { hx: d / 2, hz: w / 2 } : { hx: w / 2, hz: d / 2 };
}

/** Local -> world transform for 90 degree rotations (front -Z maps to forward(rot * 90deg)). */
function toWorldX(cx: number, rot: Rot, lx: number, lz: number): number {
  return rot === 0 ? cx + lx : rot === 1 ? cx + lz : rot === 2 ? cx - lx : cx - lz;
}
function toWorldZ(cz: number, rot: Rot, lx: number, lz: number): number {
  return rot === 0 ? cz + lz : rot === 1 ? cz - lx : rot === 2 ? cz - lz : cz + lx;
}

export function localRectToWorld(p: { cx: number; cz: number; rot: Rot }, x0: number, z0: number, x1: number, z1: number): Rect {
  const ax = toWorldX(p.cx, p.rot, x0, z0), az = toWorldZ(p.cz, p.rot, x0, z0);
  const bx = toWorldX(p.cx, p.rot, x1, z1), bz = toWorldZ(p.cz, p.rot, x1, z1);
  return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
}

/** Door centre (outer face, local) and outward normal (local). */
function doorLocal(plan: { w: number; d: number }, door: DoorPlan): { x: number; z: number; nx: number; nz: number } {
  const hw = plan.w / 2, hd = plan.d / 2;
  switch (door.side) {
    case 'front': return { x: door.u, z: -hd, nx: 0, nz: -1 };
    case 'back': return { x: door.u, z: hd, nx: 0, nz: 1 };
    case 'left': return { x: -hw, z: door.u, nx: -1, nz: 0 };
    default: return { x: hw, z: door.u, nx: 1, nz: 0 };
  }
}

/** World-space door centres and outward normals of a placed plan. */
export function planDoorsWorld(plan: BuildingPlan): DoorInfo[] {
  return plan.doors.map((door) => {
    const l = doorLocal(plan, door);
    const x = toWorldX(plan.cx, plan.rot, l.x, l.z), z = toWorldZ(plan.cz, plan.rot, l.x, l.z);
    const nx = toWorldX(0, plan.rot, l.nx, l.nz), nz = toWorldZ(0, plan.rot, l.nx, l.nz);
    return { x, z, nx, nz, width: door.width };
  });
}

/** World rectangle in front of a door (`depth` m deep, door width + 2*`pad` wide). */
export function doorApron(door: DoorInfo, depth: number, pad: number): Rect {
  const hw = door.width / 2 + pad;
  const ex = door.x + door.nx * depth, ez = door.z + door.nz * depth;
  const lx = Math.abs(door.nz) * hw, lz = Math.abs(door.nx) * hw;
  return {
    x0: Math.min(door.x, ex) - lx, x1: Math.max(door.x, ex) + lx,
    z0: Math.min(door.z, ez) - lz, z1: Math.max(door.z, ez) + lz,
  };
}

/** Choose dimensions, floors, stairs and doors for a style (placement fields left at defaults). */
export function planBuilding(style: BuildingStyle, rng: Rng, military: boolean): BuildingPlan {
  const spec = SPECS[style];
  const w = r1(rng.range(spec.w[0], spec.w[1]));
  const d = r1(rng.range(spec.d[0], spec.d[1]));
  const floors = rng.int(spec.floors[0], spec.floors[1]);
  const roofAccess = spec.roof === 'flat' && rng.chance(spec.roofAccess);
  const runs = floors - 1 + (roofAccess ? 1 : 0);
  const stairSide: -1 | 0 | 1 = runs > 0 ? (rng.chance(0.5) ? -1 : 1) : 0;
  const ix0 = -w / 2 + WALL_T, ix1 = w / 2 - WALL_T, iz0 = -d / 2 + WALL_T, iz1 = d / 2 - WALL_T;
  const doors: DoorPlan[] = [];

  // Main door on the front wall.
  const fw = spec.bigDoor ? r1(rng.range(3.2, 4.0)) : DOOR_W;
  const fh = spec.bigDoor ? Math.min(spec.storey - 0.8, 4.0) : DOOR_H;
  {
    const lo = ix0 + 0.5 + fw / 2, hi = ix1 - 0.5 - fw / 2;
    const t = style === 'shop' || style === 'barn' || style === 'warehouse' ? rng.range(0.4, 0.6) : rng.range(0.2, 0.8);
    doors.push({ side: 'front', u: r1(lo + (hi - lo) * t), width: fw, height: fh });
  }

  // Optional second (normal) door on the back or a side wall, away from the stair zone.
  if (rng.chance(spec.secondDoor)) {
    const sz = stairZoneWidth();
    let sides: Side[];
    if (stairSide === 0) sides = ['back', 'left', 'right'];
    else sides = [stairSide < 0 ? 'right' : 'left'];
    const side = rng.pick(sides);
    let lo: number, hi: number;
    if (side === 'back') {
      lo = ix0 + 0.5 + DOOR_W / 2;
      hi = ix1 - 0.5 - DOOR_W / 2;
    } else {
      lo = iz0 + 0.5 + DOOR_W / 2;
      hi = iz1 - 0.5 - DOOR_W / 2;
      // The stair zone reaches close to this side wall: keep the door in front of it.
      if (stairSide !== 0 && ix1 - ix0 - sz < 1.2) hi = iz1 - 2 * STRIP - 0.5 - DOOR_W / 2;
    }
    if (hi >= lo) doors.push({ side, u: r1(rng.range(lo, hi)), width: DOOR_W, height: DOOR_H });
  }
  return { style, w, d, floors, roofAccess, stairSide, doors, military, seed: rng.int(1, 0x7ffffffe), cx: 0, cz: 0, rot: 0, town: -1 };
}

interface Palette {
  wall: number;
  wallMat: SurfaceMaterial;
  interior: number;
  floor: number;
  floorMat: SurfaceMaterial;
  roof: number;
  roofMat: SurfaceMaterial;
  stair: number;
  stairMat: SurfaceMaterial;
  rail: number;
}

function pickPalette(style: BuildingStyle, military: boolean, rng: Rng): Palette {
  const concreteish = (wall: number, roof: number, roofMat: SurfaceMaterial): Palette => ({
    wall, wallMat: 'concrete', interior: rng.pick(PAL.interior), floor: PAL.floorConcrete, floorMat: 'concrete',
    roof, roofMat, stair: PAL.stairConcrete, stairMat: 'concrete', rail: PAL.rail,
  });
  switch (style) {
    case 'house': {
      const k = rng.int(0, 2);
      const roof = rng.chance(0.55) ? rng.pick(PAL.roofTile) : rng.pick(PAL.roofDark);
      if (k === 2) {
        const wall = rng.pick(PAL.wood);
        return { wall, wallMat: 'wood', interior: wall, floor: PAL.floorWood, floorMat: 'wood', roof, roofMat: 'wood', stair: PAL.stairWood, stairMat: 'wood', rail: PAL.railWood };
      }
      const wall = k === 0 ? rng.pick(PAL.plaster) : rng.pick(PAL.brick);
      return { wall, wallMat: 'concrete', interior: rng.pick(PAL.interior), floor: PAL.floorWood, floorMat: 'wood', roof, roofMat: 'wood', stair: PAL.stairWood, stairMat: 'wood', rail: PAL.railWood };
    }
    case 'barn': {
      const wall = rng.chance(0.6) ? rng.pick(PAL.barnRed) : rng.pick(PAL.wood);
      const metalRoof = rng.chance(0.5);
      return {
        wall, wallMat: 'wood', interior: wall, floor: PAL.floorWood, floorMat: 'wood',
        roof: metalRoof ? rng.pick(PAL.roofMetal) : rng.pick(PAL.roofDark), roofMat: metalRoof ? 'metal' : 'wood',
        stair: PAL.stairWood, stairMat: 'wood', rail: PAL.railWood,
      };
    }
    case 'warehouse': {
      const wall = military ? rng.pick(PAL.military) : rng.pick(PAL.metal);
      return { wall, wallMat: 'metal', interior: wall, floor: PAL.floorConcrete, floorMat: 'concrete', roof: military ? rng.pick(PAL.roofMilitary) : rng.pick(PAL.roofMetal), roofMat: 'metal', stair: PAL.stairConcrete, stairMat: 'metal', rail: PAL.rail };
    }
    case 'shed': {
      if (rng.chance(0.5)) {
        const wall = rng.pick(PAL.wood);
        return { wall, wallMat: 'wood', interior: wall, floor: PAL.floorWood, floorMat: 'wood', roof: rng.pick(PAL.roofDark), roofMat: 'wood', stair: PAL.stairWood, stairMat: 'wood', rail: PAL.railWood };
      }
      const wall = military ? rng.pick(PAL.military) : rng.pick(PAL.metal);
      return { wall, wallMat: 'metal', interior: wall, floor: PAL.floorMetal, floorMat: 'metal', roof: rng.pick(PAL.roofMetal), roofMat: 'metal', stair: PAL.stairConcrete, stairMat: 'metal', rail: PAL.rail };
    }
    case 'apartment':
      return military
        ? concreteish(rng.pick(PAL.military), rng.pick(PAL.roofMilitary), 'concrete')
        : concreteish(rng.chance(0.6) ? rng.pick(PAL.concrete) : rng.pick(PAL.plaster), rng.pick(PAL.roofConcrete), 'concrete');
    case 'tower':
    case 'bunker':
      return military || rng.chance(0.3)
        ? concreteish(rng.pick(PAL.military), rng.pick(PAL.roofMilitary), 'concrete')
        : concreteish(rng.pick(PAL.concrete), rng.pick(PAL.roofConcrete), 'concrete');
    case 'shop':
    default:
      return concreteish(rng.chance(0.6) ? rng.pick(PAL.plaster) : rng.pick(PAL.brick), rng.chance(0.5) ? rng.pick(PAL.roofConcrete) : rng.pick(PAL.roofDark), 'concrete');
  }
}

interface Opening {
  u0: number;
  u1: number;
  bottom: number;
  top: number;
  door: boolean;
}

/** An opening on a wall line, used to keep later partitions from abutting it. */
interface OpeningLine {
  /** 'x': the wall runs along local X (front/back walls, z-splits); 'z': runs along local Z. */
  axis: 'x' | 'z';
  /** Fixed coordinate of the wall centre line. */
  c: number;
  u0: number;
  u1: number;
}

const SIDE_INDEX: Record<Side, number> = { front: 0, back: 1, left: 2, right: 3 };

function intersects(a: Rect, b: Rect, pad = 0): boolean {
  return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;
}

/**
 * Emit all boxes of a placed building into `boxes` (ids are box indices). Terrain under the
 * footprint must be final: the floor level is derived from it.
 */
export function generateBuilding(plan: BuildingPlan, id: number, hf: Heightfield, boxes: WorldBox[]): BuiltBuilding {
  const rng = new Rng(plan.seed);
  const spec = SPECS[plan.style];
  const pal = pickPalette(plan.style, plan.military, rng);
  const W = plan.w, D = plan.d, hw = W / 2, hd = D / 2, T = WALL_T;
  const ix0 = -hw + T, ix1 = hw - T, iz0 = -hd + T, iz1 = hd - T;
  const storey = spec.storey, FH = storey + SLAB;
  const floors = plan.floors;
  const fp = localRectToWorld(plan, -hw, -hd, hw, hd);
  const range = hf.rangeIn(fp.x0, fp.z0, fp.x1, fp.z1);
  const baseY = r3(range.max + 0.2);
  const floorTop = (f: number): number => baseY + f * FH;
  const ids: number[] = [];
  let topY = baseY;

  const box = (
    lx0: number, y0: number, lz0: number, lx1: number, y1: number, lz1: number,
    kind: BoxKind, mat: SurfaceMaterial, color: number, bullets = true,
  ): void => {
    const ax = toWorldX(plan.cx, plan.rot, lx0, lz0), az = toWorldZ(plan.cz, plan.rot, lx0, lz0);
    const bx = toWorldX(plan.cx, plan.rot, lx1, lz1), bz = toWorldZ(plan.cz, plan.rot, lx1, lz1);
    const bid = pushBox(boxes, ax, y0, az, bx, y1, bz, kind, mat, color, id, bullets);
    if (bid >= 0) {
      ids.push(bid);
      if (y1 > topY) topY = y1;
    }
  };

  // ---- Foundation and ground slab -------------------------------------------------------------
  box(-hw, range.min - 0.6, -hd, hw, baseY - SLAB, hd, 'misc', 'concrete', PAL.foundation);
  box(-hw, baseY - SLAB, -hd, hw, baseY, hd, 'floor', pal.floorMat, pal.floor);

  // ---- Stair zone ------------------------------------------------------------------------------
  const runs = floors - 1 + (plan.roofAccess ? 1 : 0);
  const sg = stairGeom(storey);
  const L = sg.len;
  let xs = 0;
  let S: Rect | null = null;
  if (runs > 0 && plan.stairSide !== 0) {
    xs = plan.stairSide < 0 ? ix0 + LANDING : ix1 - LANDING - L;
    S = { x0: xs - LANDING, z0: iz1 - 2 * STRIP, x1: xs + L + LANDING, z1: iz1 };
  }

  // ---- Exterior openings -----------------------------------------------------------------------
  const openings: Opening[][][] = [];
  for (let f = 0; f < floors; f++) openings.push([[], [], [], []]);
  for (const door of plan.doors) {
    openings[0][SIDE_INDEX[door.side]].push({ u0: door.u - door.width / 2, u1: door.u + door.width / 2, bottom: 0, top: door.height, door: true });
  }
  const winW = r1(rng.range(spec.winW[0], spec.winW[1]));
  const winGap = rng.range(spec.winGap[0], spec.winGap[1]);
  for (let f = 0; f < floors; f++) {
    for (let s = 0; s < 4; s++) {
      const alongX = s < 2;
      const a = (alongX ? ix0 : iz0) + 0.45, b = (alongX ? ix1 : iz1) - 0.45;
      const blocked: [number, number][] = [];
      for (const o of openings[f][s]) blocked.push([o.u0 - 0.5, o.u1 + 0.5]);
      if (S) {
        if (s === 1) blocked.push([S.x0 - 0.3, S.x1 + 0.3]);
        if (s === 2 && S.x0 <= ix0 + 1.0) blocked.push([S.z0 - 0.3, S.z1 + 0.3]);
        if (s === 3 && S.x1 >= ix1 - 1.0) blocked.push([S.z0 - 0.3, S.z1 + 0.3]);
      }
      blocked.sort((p, q) => p[0] - q[0]);
      // Free intervals between blocked spans.
      const free: [number, number][] = [];
      let cur = a;
      for (const [p, q] of blocked) {
        if (p > cur) free.push([cur, Math.min(p, b)]);
        if (q > cur) cur = q;
        if (cur >= b) break;
      }
      if (cur < b) free.push([cur, b]);
      for (const [p, q] of free) {
        const len = q - p;
        const n = Math.floor((len + winGap) / (winW + winGap));
        if (n <= 0) continue;
        const total = n * winW + (n - 1) * winGap;
        const start = p + (len - total) / 2;
        for (let k = 0; k < n; k++) {
          if (rng.chance(spec.winSkip)) continue;
          const u0 = start + k * (winW + winGap);
          openings[f][s].push({ u0, u1: u0 + winW, bottom: WIN_SILL, top: WIN_TOP, door: false });
        }
      }
      openings[f][s].sort((p, q) => p.u0 - q.u0);
    }
  }

  // ---- Exterior walls --------------------------------------------------------------------------
  const wallPiece = (s: number, uA: number, uB: number, ya: number, yb: number, kind: BoxKind): void => {
    if (uB - uA < 0.01 || yb - ya < 0.01) return;
    if (s === 0) box(uA, ya, -hd, uB, yb, -hd + T, kind, pal.wallMat, pal.wall);
    else if (s === 1) box(uA, ya, hd - T, uB, yb, hd, kind, pal.wallMat, pal.wall);
    else if (s === 2) box(-hw, ya, uA, -hw + T, yb, uB, kind, pal.wallMat, pal.wall);
    else box(hw - T, ya, uA, hw, yb, uB, kind, pal.wallMat, pal.wall);
  };
  for (let f = 0; f < floors; f++) {
    const y0 = floorTop(f), y1 = y0 + storey;
    for (let s = 0; s < 4; s++) {
      const uStart = s < 2 ? -hw : iz0, uEnd = s < 2 ? hw : iz1;
      let u = uStart;
      for (const o of openings[f][s]) {
        if (o.u0 > u) wallPiece(s, u, o.u0, y0, y1, 'wall');
        const frame: BoxKind = o.door ? 'door_frame' : 'window_frame';
        if (o.bottom > 0) wallPiece(s, o.u0, o.u1, y0, y0 + o.bottom, frame);
        if (o.top < storey) wallPiece(s, o.u0, o.u1, y0 + o.top, y1, frame);
        u = Math.max(u, o.u1);
      }
      if (u < uEnd) wallPiece(s, u, uEnd, y0, y1, 'wall');
    }
  }

  // ---- Interior partitions (BSP per floor) ------------------------------------------------------
  const rooms: RoomInfo[] = [];
  /** Ground-floor partition walls and doorway clearances (local), kept free of interior clutter. */
  const groundWalls: Rect[] = [];
  const groundDoorways: Rect[] = [];
  const exteriorLines = (f: number): OpeningLine[] => {
    const lines: OpeningLine[] = [];
    const cs = [-hd + T / 2, hd - T / 2, -hw + T / 2, hw - T / 2];
    for (let s = 0; s < 4; s++) for (const o of openings[f][s]) lines.push({ axis: s < 2 ? 'x' : 'z', c: cs[s], u0: o.u0, u1: o.u1 });
    return lines;
  };
  const endpointBlocked = (lines: OpeningLine[], axis: 'x' | 'z', at0: number, at1: number, c: number): boolean => {
    for (const l of lines) {
      if (l.axis !== axis) continue;
      if (Math.abs(l.c - at0) > 0.3 && Math.abs(l.c - at1) > 0.3) continue;
      if (l.u0 - 0.35 < c + PART_T / 2 && l.u1 + 0.35 > c - PART_T / 2) return true;
    }
    return false;
  };
  const partitionColor = pal.interior;
  const bsp = (r: Rect, depth: number, f: number, lines: OpeningLine[]): void => {
    if (depth > 0) {
      const wx = r.x1 - r.x0, wz = r.z1 - r.z0;
      const axes: ('x' | 'z')[] = wx >= wz ? ['x', 'z'] : ['z', 'x'];
      if (rng.chance(0.25)) axes.reverse();
      for (const ax of axes) {
        const len = ax === 'x' ? wx : wz;
        if (len < 2 * MIN_ROOM + PART_T) continue;
        for (let attempt = 0; attempt < 8; attempt++) {
          const lo = ax === 'x' ? r.x0 : r.z0;
          const c = lo + MIN_ROOM + PART_T / 2 + rng.next() * (len - 2 * MIN_ROOM - PART_T);
          // Wall rectangle in plan.
          const wall: Rect = ax === 'x'
            ? { x0: c - PART_T / 2, z0: r.z0, x1: c + PART_T / 2, z1: r.z1 }
            : { x0: r.x0, z0: c - PART_T / 2, x1: r.x1, z1: c + PART_T / 2 };
          if (S && intersects(wall, S, 0.05)) continue;
          if (S && ax === 'z' && S.z0 >= c && S.z0 - (c + PART_T / 2) < STAIR_FRONT && S.x0 < r.x1 && S.x1 > r.x0) continue;
          // x-split walls run along Z and end on walls running along X (and vice versa).
          if (ax === 'x' ? endpointBlocked(lines, 'x', r.z0, r.z1, c) : endpointBlocked(lines, 'z', r.x0, r.x1, c)) continue;
          // Doorway along the new wall.
          const dlo = (ax === 'x' ? r.z0 : r.x0) + 0.45, dhi = (ax === 'x' ? r.z1 : r.x1) - 0.45 - INNER_DOOR_W;
          if (dhi < dlo) continue;
          let door = NaN;
          for (let k = 0; k < 6; k++) {
            const p = dlo + rng.next() * (dhi - dlo);
            const clear: Rect = ax === 'x'
              ? { x0: c - 1.0, z0: p, x1: c + 1.0, z1: p + INNER_DOOR_W }
              : { x0: p, z0: c - 1.0, x1: p + INNER_DOOR_W, z1: c + 1.0 };
            if (S && intersects(clear, S)) continue;
            door = p;
            break;
          }
          if (Number.isNaN(door)) continue;
          const y0 = floorTop(f), y1 = y0 + storey;
          if (f === 0) {
            groundWalls.push(wall);
            groundDoorways.push(ax === 'x'
              ? { x0: c - 1.4, z0: door - 0.3, x1: c + 1.4, z1: door + INNER_DOOR_W + 0.3 }
              : { x0: door - 0.3, z0: c - 1.4, x1: door + INNER_DOOR_W + 0.3, z1: c + 1.4 });
          }
          if (ax === 'x') {
            box(c - PART_T / 2, y0, r.z0, c + PART_T / 2, y1, door, 'wall', pal.wallMat, partitionColor);
            box(c - PART_T / 2, y0, door + INNER_DOOR_W, c + PART_T / 2, y1, r.z1, 'wall', pal.wallMat, partitionColor);
            box(c - PART_T / 2, y0 + DOOR_H, door, c + PART_T / 2, y1, door + INNER_DOOR_W, 'door_frame', pal.wallMat, partitionColor);
            lines.push({ axis: 'z', c, u0: door, u1: door + INNER_DOOR_W });
            bsp({ x0: r.x0, z0: r.z0, x1: c - PART_T / 2, z1: r.z1 }, depth - 1, f, lines);
            bsp({ x0: c + PART_T / 2, z0: r.z0, x1: r.x1, z1: r.z1 }, depth - 1, f, lines);
          } else {
            box(r.x0, y0, c - PART_T / 2, door, y1, c + PART_T / 2, 'wall', pal.wallMat, partitionColor);
            box(door + INNER_DOOR_W, y0, c - PART_T / 2, r.x1, y1, c + PART_T / 2, 'wall', pal.wallMat, partitionColor);
            box(door, y0 + DOOR_H, c - PART_T / 2, door + INNER_DOOR_W, y1, c + PART_T / 2, 'door_frame', pal.wallMat, partitionColor);
            lines.push({ axis: 'x', c, u0: door, u1: door + INNER_DOOR_W });
            bsp({ x0: r.x0, z0: r.z0, x1: r.x1, z1: c - PART_T / 2 }, depth - 1, f, lines);
            bsp({ x0: r.x0, z0: c + PART_T / 2, x1: r.x1, z1: r.z1 }, depth - 1, f, lines);
          }
          return;
        }
      }
    }
    const wr = localRectToWorld(plan, r.x0, r.z0, r.x1, r.z1);
    rooms.push({ ...wr, y: floorTop(f), floor: f, indoor: true, building: id });
  };
  for (let f = 0; f < floors; f++) {
    const depth = f === 0 ? spec.bsp : Math.max(0, spec.bsp - (rng.chance(0.4) ? 1 : 0));
    bsp({ x0: ix0, z0: iz0, x1: ix1, z1: iz1 }, depth, f, exteriorLines(f));
  }

  // ---- Upper slabs / roof slab (with stairwell holes) -------------------------------------------
  const holeOf = (k: number): Rect => k % 2 === 0
    ? { x0: xs, z0: iz1 - STRIP, x1: xs + L, z1: iz1 }
    : { x0: xs, z0: iz1 - 2 * STRIP, x1: xs + L, z1: iz1 - STRIP };
  for (let g = 1; g <= floors; g++) {
    const y1 = floorTop(g), y0 = y1 - SLAB;
    const isRoof = g === floors;
    const kind: BoxKind = isRoof ? 'roof' : 'floor';
    const mat = isRoof ? (spec.roof === 'flat' ? pal.roofMat : pal.floorMat) : pal.floorMat;
    const col = isRoof ? (spec.roof === 'flat' ? pal.roof : pal.wall) : pal.floor;
    const hole = S && g - 1 < runs ? holeOf(g - 1) : null;
    if (!hole) {
      box(-hw, y0, -hd, hw, y1, hd, kind, mat, col);
    } else {
      box(-hw, y0, -hd, hw, y1, hole.z0, kind, mat, col);
      box(-hw, y0, hole.z1, hw, y1, hd, kind, mat, col);
      box(-hw, y0, hole.z0, hole.x0, y1, hole.z1, kind, mat, col);
      box(hole.x1, y0, hole.z0, hw, y1, hole.z1, kind, mat, col);
      // Rails around the drop edges (the arrival end stays open).
      const ry0 = y0, ry1 = y1 + RAIL_H;
      const railMat: SurfaceMaterial = pal.stairMat === 'wood' ? 'wood' : 'metal';
      if ((g - 1) % 2 === 0) {
        box(xs, ry0, iz1 - STRIP, xs + L, ry1, iz1 - STRIP + RAIL_T, 'misc', railMat, pal.rail);
        box(xs, ry0, iz1 - STRIP, xs + RAIL_T, ry1, iz1, 'misc', railMat, pal.rail);
      } else {
        box(xs, ry0, iz1 - 2 * STRIP, xs + L, ry1, iz1 - 2 * STRIP + RAIL_T, 'misc', railMat, pal.rail);
        box(xs, ry0, iz1 - STRIP - RAIL_T, xs + L, ry1, iz1 - STRIP, 'misc', railMat, pal.rail);
        box(xs + L - RAIL_T, ry0, iz1 - 2 * STRIP, xs + L, ry1, iz1 - STRIP, 'misc', railMat, pal.rail);
      }
    }
  }

  // ---- Stairs ----------------------------------------------------------------------------------
  if (S) {
    for (let k = 0; k < runs; k++) {
      const y0 = floorTop(k);
      for (let i = 1; i < sg.steps; i++) {
        const top = y0 + i * sg.rise;
        if (k % 2 === 0) {
          box(xs + (i - 1) * STEP_RUN, y0, iz1 - STRIP, xs + i * STEP_RUN, top, iz1, 'stairs', pal.stairMat, pal.stair);
        } else {
          box(xs + L - i * STEP_RUN, y0, iz1 - 2 * STRIP, xs + L - (i - 1) * STEP_RUN, top, iz1 - STRIP, 'stairs', pal.stairMat, pal.stair);
        }
      }
    }
  }

  // ---- Roof ------------------------------------------------------------------------------------
  const roofY = floorTop(floors);
  if (spec.roof === 'gable') {
    const layers = plan.style === 'barn' ? 6 : 4;
    const lh = plan.style === 'barn' ? 0.5 : 0.4;
    const ov = 0.35;
    const alongX = W >= D;
    const halfSpan = (alongX ? hd : hw) + ov;
    for (let i = 0; i < layers; i++) {
      const hs = Math.max(0.45, halfSpan * (1 - i / layers));
      const y0 = roofY + i * lh, y1 = y0 + lh;
      if (alongX) box(-hw - ov, y0, -hs, hw + ov, y1, hs, 'roof', pal.roofMat, pal.roof);
      else box(-hs, y0, -hd - ov, hs, y1, hd + ov, 'roof', pal.roofMat, pal.roof);
    }
  } else {
    const ph = plan.roofAccess ? 1.0 : 0.4, pt = 0.2;
    box(-hw, roofY, -hd, hw, roofY + ph, -hd + pt, 'wall', pal.wallMat, pal.wall);
    box(-hw, roofY, hd - pt, hw, roofY + ph, hd, 'wall', pal.wallMat, pal.wall);
    box(-hw, roofY, -hd + pt, -hw + pt, roofY + ph, hd - pt, 'wall', pal.wallMat, pal.wall);
    box(hw - pt, roofY, -hd + pt, hw, roofY + ph, hd - pt, 'wall', pal.wallMat, pal.wall);
    if (plan.roofAccess) {
      const wr = localRectToWorld(plan, -hw + pt, -hd + pt, hw - pt, hd - pt);
      rooms.push({ ...wr, y: roofY, floor: floors, indoor: false, building: id });
    }
  }

  // ---- Entrance steps ----------------------------------------------------------------------------
  // Treads (rise <= 0.25 m, 0.35 m deep) lead down from the threshold until they meet the terrain.
  const doorsWorld = planDoorsWorld(plan);
  for (const door of plan.doors) {
    const l = doorLocal(plan, door);
    const lat = door.width / 2 + 0.3;
    // Lowest terrain under a tread spanning [a, b] metres out from the wall face.
    const treadLow = (a: number, b: number): number => {
      let lo = Infinity;
      for (const d of [a, (a + b) / 2, b]) {
        for (const t of [-lat, 0, lat]) {
          const lx = l.nz !== 0 ? l.x + t : l.x + l.nx * d;
          const lz = l.nz !== 0 ? l.z + l.nz * d : l.z + t;
          lo = Math.min(lo, hf.heightAt(toWorldX(plan.cx, plan.rot, lx, lz), toWorldZ(plan.cz, plan.rot, lx, lz)));
        }
      }
      return lo;
    };
    let top = baseY;
    for (let j = 1; j <= 16; j++) {
      const a = (j - 1) * 0.35, b = j * 0.35;
      const ground = treadLow(a, b);
      if (top - ground <= 0.3) break;
      top = top - 0.25;
      const bottom = Math.min(ground, top) - 0.5;
      if (l.nz !== 0) box(l.x - lat, bottom, l.z + l.nz * a, l.x + lat, top, l.z + l.nz * b, 'stairs', 'concrete', PAL.foundation);
      else box(l.x + l.nx * a, bottom, l.z - lat, l.x + l.nx * b, top, l.z + lat, 'stairs', 'concrete', PAL.foundation);
    }
  }

  // ---- Interior clutter (crates / hay) for open-plan buildings -----------------------------------
  if (plan.style === 'warehouse' || plan.style === 'barn') {
    const placed: Rect[] = [];
    const keepOut: Rect[] = groundDoorways.slice();
    for (const door of plan.doors) {
      const l = doorLocal(plan, door);
      const hwid = door.width / 2 + 1.0;
      if (l.nz !== 0) keepOut.push({ x0: l.x - hwid, x1: l.x + hwid, z0: Math.min(l.z, l.z - l.nz * 4), z1: Math.max(l.z, l.z - l.nz * 4) });
      else keepOut.push({ x0: Math.min(l.x, l.x - l.nx * 4), x1: Math.max(l.x, l.x - l.nx * 4), z0: l.z - hwid, z1: l.z + hwid });
    }
    const count = plan.style === 'warehouse' ? rng.int(4, 7) : rng.int(2, 4);
    for (let c = 0, tries = 0; c < count && tries < 60; tries++) {
      const s = plan.style === 'warehouse' ? r1(rng.range(1.1, 1.5)) : 1.2;
      const sx = plan.style === 'barn' ? 1.6 : s;
      const x = rng.range(ix0 + 0.1 + sx / 2, ix1 - 0.1 - sx / 2);
      const z = rng.range(iz0 + 0.1 + s / 2, iz1 - 0.1 - s / 2);
      const rr: Rect = { x0: x - sx / 2, z0: z - s / 2, x1: x + sx / 2, z1: z + s / 2 };
      if (keepOut.some((k) => intersects(k, rr)) || placed.some((p) => intersects(p, rr, 1.2))) continue;
      // Keep crates off walls slightly or flush against them, never leaving a sub-body-width gap.
      const gx = Math.min(rr.x0 - ix0, ix1 - rr.x1), gz = Math.min(rr.z0 - iz0, iz1 - rr.z1);
      if ((gx > 0.15 && gx < 0.9) || (gz > 0.15 && gz < 0.9)) continue;
      if (groundWalls.some((wr) => intersects(wr, rr, 0.9))) continue;
      placed.push(rr);
      c++;
      const y0 = baseY;
      if (plan.style === 'barn') {
        box(rr.x0, y0, rr.z0, rr.x1, y0 + 0.9, rr.z1, 'crate', 'wood', PAL.hay);
        if (rng.chance(0.5)) box(rr.x0, y0 + 0.9, rr.z0, rr.x1, y0 + 1.8, rr.z1, 'crate', 'wood', PAL.hay);
      } else {
        const col = plan.military ? rng.pick(PAL.crateMilitary) : rng.pick(PAL.crate);
        box(rr.x0, y0, rr.z0, rr.x1, y0 + s, rr.z1, 'crate', 'wood', col);
        if (rng.chance(0.45)) {
          const t = s * 0.8, ox = (s - t) / 2;
          box(rr.x0 + ox, y0 + s, rr.z0 + ox, rr.x0 + ox + t, y0 + s + t, rr.z0 + ox + t, 'crate', 'wood', col);
        }
      }
    }
  }

  const def: BuildingDef = {
    id,
    style: plan.style,
    min: { x: r3(fp.x0), y: r3(range.min), z: r3(fp.z0) },
    max: { x: r3(fp.x1), y: r3(topY), z: r3(fp.z1) },
    floors,
    boxIds: ids,
    wallColor: pal.wall,
    roofColor: pal.roof,
    town: plan.town,
  };
  const stairZone = S ? localRectToWorld(plan, S.x0, S.z0, S.x1, S.z1) : null;
  return { def, baseY, rooms, stairZone, doors: doorsWorld };
}
