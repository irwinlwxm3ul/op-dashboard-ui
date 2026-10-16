// Vehicles: procedural buggy (open frame, roll cage, big wheels), UAZ-like 4x4 (boxy body, dark
// glass) and motorbike, all drawn by ONE BatchedMesh (paint shells tinted per vehicle, unpainted
// chassis, wheels, bike fork). Dimensions come from the shared vehicle definitions so the visuals
// match the physics. Once the curated real models (src/client/assets VEHICLE_MODELS: UAZ, bike) are
// loaded, vehicles of those types within ~300 m use pooled per-vehicle clones instead (wheel nodes
// spin / steer, the bike's fork steers about its raked axis, wrecks switch to charred materials);
// farther ones and the buggy stay batched. Wheels spin with speed, front wheels / fork steer, wrecks
// turn dark, and damaged vehicles smoke (< 40 % hp) or burn.

import * as THREE from 'three';
import { LOD_HYSTERESIS } from '../../../shared/constants';
import { HANDLING, SEAT_HIP_HEIGHT, VEHICLES, WHEELS } from '../../../shared/vehicles';
import type { VehicleModel } from '../../assets';
import type { EntityId, VehicleType } from '../../../shared/types';
import type { VehicleView } from '../../game/types';
import { GeoBuilder, type PartStyle, xform } from './geometry';
import { LOD_HIDDEN_IDX, type LodFade, type LodLevel, createLodFade, effectiveLodDistance, fadeCode, stepLodFade } from './lod';
import { type EntityUniforms, applyEntityShader, casterDepthMaterial, createEntityMaterial, createEntityUniforms } from './materials';
import { WRECK_TINT, vehiclePaintHex } from './palette';
import { ParticleSystem } from './particles';
import type { SeatInfo } from './animator';
import { BIKE_MODEL_GRIP, BIKE_MODEL_PEGS, BIKE_PROC_PEGS, DRIVER_CONTROLS, UAZ_MODEL_WHEEL, ringGrips } from './seating';

const TYPES: readonly VehicleType[] = ['buggy', 'uaz', 'bike'];
const PAINT: PartStyle = { color: 0xffffff };
const TUBE = 0x2c2d2e;
const BLACK = 0x1c1d1e;
const SEAT = 0x3a2e24;
const GLASS = 0x1a232c;
const LENS = 0x3a4046;
const METAL = 0x6a6e70;

/** Engine (smoke / fire source) position per type in vehicle local space. */
const ENGINE_POS: Record<VehicleType, readonly [number, number, number]> = {
  buggy: [0, 0.0, 1.35],
  uaz: [0, 0.15, -1.45],
  bike: [0, -0.1, 0.0],
};

/** Bike steering axis: from the front axle up to the handlebar centre (vehicle local). */
function bikeAxis(): { axle: THREE.Vector3; head: THREE.Vector3; rake: number; len: number } {
  const def = VEHICLES.bike, h = HANDLING.bike;
  const w = WHEELS.bike[0];
  const axle = new THREE.Vector3(w.x, w.y - (def.groundClearance - h.wheelRadius), w.z);
  const seat = def.seatOffsets[0];
  const c = DRIVER_CONTROLS.bike.center;
  const head = new THREE.Vector3(seat.x + c[0], seat.y + c[1], seat.z + c[2]);
  const d = new THREE.Vector3().subVectors(head, axle);
  return { axle, head, rake: Math.atan2(d.z, d.y), len: d.length() };
}

function wheelCenterY(type: VehicleType): number {
  const def = VEHICLES[type];
  return -def.halfExtents.y - (def.groundClearance - HANDLING[type].wheelRadius);
}

function seatBlock(b: GeoBuilder, sx: number, sy: number, sz: number, w = 0.46): void {
  // sy = seat origin (feet level); hips are 0.4 above.
  b.box(w, 0.1, 0.46, xform(sx, sy + 0.3, sz + 0.04), { color: SEAT });
  b.box(w, 0.6, 0.1, xform(sx, sy + 0.62, sz + 0.3, 0.16), { color: SEAT });
}

function steeringWheel(b: GeoBuilder, type: VehicleType): void {
  const def = VEHICLES[type];
  const s = def.seatOffsets[0];
  const c = DRIVER_CONTROLS[type];
  const cx = s.x + c.center[0], cy = s.y + c.center[1], cz = s.z + c.center[2];
  // Ring facing the driver (normal along the column), tilted by c.tilt.
  b.ring(c.radius, 0.018, 4, 14, xform(cx, cy, cz, Math.PI / 2 - c.tilt), { color: BLACK });
  b.box(c.radius * 2, 0.02, 0.02, xform(cx, cy, cz, -c.tilt), { color: BLACK });
  b.cyl(0.025, 0.025, 0.5, 6, xform(cx, cy - 0.16, cz - 0.2, Math.PI / 2 - c.tilt - 0.5), { color: BLACK });
}

function buildBuggy(paint: GeoBuilder, chassis: GeoBuilder): void {
  const d = VEHICLES.buggy;
  const hx = d.halfExtents.x, hy = d.halfExtents.y, hz = d.halfExtents.z;
  const floorY = -hy + 0.08;
  chassis.box(hx * 1.55, 0.1, hz * 1.75, xform(0, floorY, 0.05), { color: TUBE });
  // Body panels (paint): nose wedge, side pods, engine cover.
  paint.taper(hx * 1.5, 0.95, hx * 1.25, 0.6, 0.34, xform(0, floorY + 0.2, -hz + 0.5, 0.0), PAINT, 0.12);
  paint.box(0.18, 0.26, 1.5, xform(-hx + 0.12, floorY + 0.16, 0.1), PAINT);
  paint.box(0.18, 0.26, 1.5, xform(hx - 0.12, floorY + 0.16, 0.1), PAINT);
  paint.taper(hx * 1.4, 0.85, hx * 1.2, 0.7, 0.42, xform(0, floorY + 0.25, hz - 0.5), PAINT);
  // Roll cage (tubes).
  const tube = { color: TUBE };
  const topY = hy - 0.02, baseY = floorY + 0.05, cx = hx * 0.72;
  const fz = -0.35, rz = 0.8;
  for (const x of [-cx, cx]) {
    chassis.strut(x, baseY, fz - 0.08, x, topY, fz, 0.035, 6, tube);
    chassis.strut(x, baseY, rz, x, topY, rz, 0.035, 6, tube);
    chassis.strut(x, topY, fz, x, topY, rz, 0.035, 6, tube);
    // Front bar down to the nose, rear bar down to the engine bay.
    chassis.strut(x, topY, fz, x * 0.85, floorY + 0.32, -hz + 0.35, 0.03, 6, tube);
    chassis.strut(x, topY, rz, x * 0.9, floorY + 0.42, hz - 0.2, 0.03, 6, tube);
  }
  chassis.strut(-cx, topY, fz, cx, topY, fz, 0.035, 6, tube);
  chassis.strut(-cx, topY, rz, cx, topY, rz, 0.035, 6, tube);
  chassis.strut(-cx, topY, (fz + rz) / 2, cx, topY, (fz + rz) / 2, 0.03, 6, tube);
  chassis.strut(-cx, topY, rz, cx, baseY + 0.2, rz, 0.028, 6, tube);
  // Seats, steering wheel, dash, lights, exhaust, engine.
  for (const s of d.seatOffsets) seatBlock(chassis, s.x, s.y, s.z, 0.44);
  steeringWheel(chassis, 'buggy');
  chassis.box(hx * 1.4, 0.18, 0.12, xform(0, floorY + 0.42, -0.62), { color: BLACK });
  for (const x of [-0.42, 0.42]) {
    chassis.cyl(0.08, 0.08, 0.06, 8, xform(x, floorY + 0.38, -hz + 0.12, Math.PI / 2), { color: LENS });
    chassis.cyl(0.045, 0.05, 0.5, 6, xform(x * 0.7, floorY + 0.2, hz - 0.05, Math.PI / 2 + 0.2), { color: METAL });
  }
  chassis.box(0.7, 0.35, 0.5, xform(0, floorY + 0.25, hz - 0.45), { color: 0x3b3d3f });
  chassis.box(hx * 1.7, 0.08, 0.1, xform(0, floorY + 0.06, -hz + 0.05), { color: TUBE });
}

function buildUaz(paint: GeoBuilder, chassis: GeoBuilder): void {
  const d = VEHICLES.uaz;
  const hx = d.halfExtents.x, hy = d.halfExtents.y, hz = d.halfExtents.z;
  const bottom = -hy + 0.05;
  const belt = bottom + 0.82;
  // Lower body + hood (paint).
  paint.box(hx * 1.94, belt - bottom, hz * 1.9, xform(0, (belt + bottom) / 2, 0), PAINT);
  paint.taper(hx * 1.86, 1.2, hx * 1.8, 1.1, 0.12, xform(0, belt + 0.06, -hz + 0.68), PAINT);
  // Fenders.
  for (const x of [-hx + 0.05, hx - 0.05]) {
    for (const z of [-d.wheelBase / 2, d.wheelBase / 2]) paint.box(0.16, 0.12, 0.95, xform(x, belt - 0.12, z), PAINT);
  }
  // Cabin: roof, pillars, dark windshield and rear glass, open sides (passengers can shoot).
  const roofY = hy - 0.06, cabF = -0.62, cabB = hz - 0.12;
  paint.box(hx * 1.92, 0.08, cabB - cabF + 0.1, xform(0, roofY, (cabF + cabB) / 2), PAINT);
  const pillarH = roofY - belt;
  for (const x of [-hx + 0.06, hx - 0.06]) {
    paint.box(0.07, pillarH, 0.07, xform(x, belt + pillarH / 2, cabF + 0.05, -0.2), PAINT);
    paint.box(0.07, pillarH, 0.08, xform(x, belt + pillarH / 2, 0.42), PAINT);
    paint.box(0.08, pillarH, 0.08, xform(x, belt + pillarH / 2, cabB - 0.04), PAINT);
  }
  chassis.box(hx * 1.8, pillarH * 0.95, 0.04, xform(0, belt + pillarH / 2, cabF + 0.07, -0.2), { color: GLASS });
  chassis.box(hx * 1.7, pillarH * 0.8, 0.04, xform(0, belt + pillarH / 2, cabB - 0.02), { color: GLASS });
  // Grille, lights, bumpers, spare wheel, mirrors.
  chassis.box(hx * 1.3, 0.42, 0.06, xform(0, belt - 0.24, -hz - 0.02), { color: BLACK });
  for (const x of [-0.62, 0.62]) chassis.cyl(0.1, 0.1, 0.06, 10, xform(x, belt - 0.2, -hz - 0.03, Math.PI / 2), { color: LENS });
  chassis.box(hx * 2.04, 0.14, 0.14, xform(0, bottom + 0.12, -hz - 0.06), { color: BLACK });
  chassis.box(hx * 2.04, 0.14, 0.14, xform(0, bottom + 0.12, hz + 0.06), { color: BLACK });
  chassis.cyl(0.36, 0.36, 0.22, 12, xform(0, belt + 0.05, hz + 0.16, Math.PI / 2), { color: BLACK });
  for (const x of [-hx - 0.05, hx + 0.05]) chassis.box(0.04, 0.1, 0.14, xform(x, belt + 0.18, cabF + 0.1), { color: BLACK });
  // Interior.
  for (const s of d.seatOffsets) seatBlock(chassis, s.x, s.y, s.z, 0.5);
  steeringWheel(chassis, 'uaz');
  chassis.box(hx * 1.85, 0.2, 0.25, xform(0, belt - 0.02, cabF + 0.25), { color: BLACK });
  chassis.box(hx * 1.85, 0.06, hz * 1.85, xform(0, bottom + 0.2, 0), { color: 0x2a2826 });
}

function buildBike(paint: GeoBuilder, chassis: GeoBuilder): void {
  const d = VEHICLES.bike;
  const s0 = d.seatOffsets[0], s1 = d.seatOffsets[1];
  // Tank + tail (paint).
  paint.taper(0.26, 0.5, 0.3, 0.46, 0.22, xform(0, s0.y + 0.42, s0.z - 0.28), PAINT);
  paint.box(0.22, 0.12, 0.42, xform(0, s1.y + 0.3, s1.z + 0.16, -0.12), PAINT);
  // Frame, engine, exhaust, seat, footpegs.
  const ax = bikeAxis();
  chassis.cyl(0.035, 0.035, 0.9, 6, xform(0, s0.y + 0.38, -0.2, Math.PI / 2 + 0.25), { color: TUBE });
  chassis.cyl(0.03, 0.03, 0.7, 6, xform(0, s0.y + 0.12, 0.15, Math.PI / 2 - 0.5), { color: TUBE });
  chassis.box(0.28, 0.3, 0.42, xform(0, s0.y + 0.08, -0.05), { color: 0x45484b });
  chassis.box(0.3, 0.12, 0.25, xform(0, s0.y + 0.26, -0.05), { color: METAL });
  chassis.cyl(0.04, 0.05, 0.8, 8, xform(0.17, s0.y + 0.02, 0.35, Math.PI / 2 - 0.12), { color: METAL });
  chassis.box(0.26, 0.07, 0.62, xform(0, s0.y + 0.33, (s0.z + s1.z) / 2 + 0.02), { color: BLACK });
  // Rear swing arm to the rear axle.
  const rw = WHEELS.bike[1];
  const rAxleY = rw.y - (d.groundClearance - HANDLING.bike.wheelRadius);
  chassis.box(0.05, 0.05, Math.abs(rw.z - 0.1), xform(0.08, (rAxleY + s0.y + 0.05) / 2, (rw.z + 0.1) / 2, 0.15), { color: TUBE });
  chassis.box(0.05, 0.05, Math.abs(rw.z - 0.1), xform(-0.08, (rAxleY + s0.y + 0.05) / 2, (rw.z + 0.1) / 2, 0.15), { color: TUBE });
  chassis.box(0.5, 0.03, 0.06, xform(0, s0.y + 0.05, s0.z + 0.05), { color: METAL }); // pegs
  for (const sx of [-1, 1]) chassis.box(0.12, 0.03, 0.05, xform(sx * 0.18, s1.y + 0.02, s1.z + 0.02), { color: METAL }); // passenger pegs
  chassis.box(0.06, 0.06, 0.08, xform(0, ax.head.y - 0.05, ax.head.z + 0.04), { color: TUBE });
}

/** Bike fork (steers): fork-local frame = origin at the front axle, +Y up the steering axis. */
function buildBikeFork(b: GeoBuilder): void {
  const ax = bikeAxis();
  const L = ax.len, half = DRIVER_CONTROLS.bike.radius;
  b.cyl(0.03, 0.03, L * 0.92, 6, xform(-0.09, L * 0.46, 0), { color: METAL });
  b.cyl(0.03, 0.03, L * 0.92, 6, xform(0.09, L * 0.46, 0), { color: METAL });
  b.box(0.22, 0.06, 0.08, xform(0, L * 0.86, 0), { color: TUBE });
  b.cyl(0.018, 0.018, half * 2, 6, xform(0, L, 0, 0, 0, Math.PI / 2), { color: BLACK });
  b.cyl(0.028, 0.028, 0.12, 6, xform(-half + 0.06, L, 0, 0, 0, Math.PI / 2), { color: BLACK });
  b.cyl(0.028, 0.028, 0.12, 6, xform(half - 0.06, L, 0, 0, 0, Math.PI / 2), { color: BLACK });
  b.cyl(0.075, 0.075, 0.08, 10, xform(0, L * 0.78, -0.1, Math.PI / 2), { color: LENS }); // headlight (off)
  b.box(0.16, 0.04, 0.5, xform(0, HANDLING.bike.wheelRadius + 0.05, 0.02, -0.1), { color: 0xffffff }); // fender
}

function buildWheel(type: VehicleType): THREE.BufferGeometry {
  const r = HANDLING[type].wheelRadius;
  const w = type === 'bike' ? 0.12 : type === 'buggy' ? 0.32 : 0.26;
  const b = new GeoBuilder();
  const rz = Math.PI / 2;
  b.cyl(r, r, w, 14, xform(0, 0, 0, 0, 0, rz), { color: 0x1a1a1a });
  // Tread blocks so the spin reads.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    b.box(w * 0.9, 0.035, r * 0.2, xform(0, Math.cos(a) * r, Math.sin(a) * r, a), { color: 0x121212 });
  }
  const rim = type === 'bike' ? METAL : 0x4a4f45;
  b.cyl(r * 0.55, r * 0.55, w * 1.06, 10, xform(0, 0, 0, 0, 0, rz), { color: rim });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.box(w * 1.1, r * 0.08, r * 0.08, xform(0, Math.cos(a) * r * 0.32, Math.sin(a) * r * 0.32), { color: 0x2c2e2a });
  }
  return b.build();
}

interface VehicleSlot {
  id: EntityId;
  type: VehicleType;
  instances: number[];
  wheelAngle: number;
  seen: number;
  smokeAcc: number;
  fireAcc: number;
  destroyedFor: number;
  /** Real model instance while close enough (null = procedural batched model). */
  glb: GlbVehicle | null;
  /** Hysteresis state of the real-model distance band. */
  useGlb: boolean;
  /** Inside the render distance (with the LOD hysteresis band, like the players). */
  shown: boolean;
  /** Dithered crossfade between the real model (level 0), the batched procedural one (1), hidden (3). */
  fade: LodFade;
  /** Share of the drawn pixels that belong to the real model (0..1): blends rider lift / contacts. */
  glbW: number;
  /** Dither code last written into the batched instances' colour alpha (NaN = never). */
  batchCode: number;
}

// ---------------------------------------------------------------------------
// Real vehicle models (curated glTF; per-vehicle clones near the camera)
// ---------------------------------------------------------------------------

/** Real models are used inside this band (m, with hysteresis); the batched procedural beyond. */
const GLB_NEAR = 280;
const GLB_FAR = 320;

interface GlbWheel {
  node: THREE.Object3D;
  steers: boolean;
  radius: number;
}

interface GlbVehicle {
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
  /** Per-clone normal / charred materials of each mesh (own uniforms: per-vehicle dither fade). */
  normalMats: THREE.Material[];
  wreckMats: THREE.Material[];
  uniforms: EntityUniforms;
  wheels: GlbWheel[];
  fork: THREE.Object3D | null;
  forkRake: number;
  wrecked: boolean;
}

interface GlbVehicleType {
  model: VehicleModel;
  template: THREE.Object3D;
  /** Entity-patched materials (rim, reduced fog) and charred wreck variants, by template material. */
  normal: Map<THREE.Material, THREE.Material>;
  wreck: Map<THREE.Material, THREE.Material>;
  free: GlbVehicle[];
  /** Every clone made (for disposal). */
  all: GlbVehicle[];
  /** Fork node rest position (model space) and rake, for the handlebar grips (bike). */
  forkPos: THREE.Vector3 | null;
  forkRake: number;
}

/** Loaded real vehicle templates (types without a model keep the procedural one). */
export interface VehicleTemplates {
  models: Partial<Record<VehicleType, { model: VehicleModel; template: THREE.Object3D }>>;
}

const _m = new THREE.Matrix4();
const _w = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _wreck = new THREE.Color().setHex(WRECK_TINT);
const _v = new THREE.Vector3();
const _ex = new THREE.Euler(0, 0, 0, 'XYZ');
const _c4 = new THREE.Vector4();
const _sph = new THREE.Sphere(new THREE.Vector3(), 3);
/** Reference field of view for zoom-adjusted distances (matches the player LODs). */
const REF_FOV = 65;
/** Real <-> procedural crossfade duration (s). */
const VEHICLE_FADE_TIME = 0.45;
/** Upper bound on simultaneous real-model clones (each costs a few draw calls). */
const MAX_GLB_VEHICLES = 16;
/** Hand travel round the real UAZ's (static) steering wheel per unit steer (rad). */
const REAL_WHEEL_TURN = 1.2;

/** Instance layout per vehicle: [paint, chassis, wheels..., (fork)] */
export class VehicleRenderer {
  private readonly material = createEntityMaterial({ rim: true, fogScale: 0.35, dither: true, batchFade: true });
  private readonly batch: THREE.BatchedMesh;
  private readonly geo: Record<VehicleType, { paint: number; chassis: number; wheel: number; fork: number }>;
  private readonly slots = new Map<EntityId, VehicleSlot>();
  private readonly smoke: ParticleSystem;
  private readonly fire: ParticleSystem;
  private frameNo = 0;
  private readonly bike = bikeAxis();
  private readonly removeList: EntityId[] = [];

  private readonly parentObj: THREE.Object3D;

  constructor(parent: THREE.Object3D) {
    this.parentObj = parent;
    const built: { type: VehicleType; paint: THREE.BufferGeometry; chassis: THREE.BufferGeometry; wheel: THREE.BufferGeometry; fork: THREE.BufferGeometry | null }[] = [];
    let verts = 0;
    for (const type of TYPES) {
      const p = new GeoBuilder(), c = new GeoBuilder();
      if (type === 'buggy') buildBuggy(p, c);
      else if (type === 'uaz') buildUaz(p, c);
      else buildBike(p, c);
      let fork: THREE.BufferGeometry | null = null;
      if (type === 'bike') {
        const f = new GeoBuilder();
        buildBikeFork(f);
        fork = f.build();
      }
      const e = { type, paint: p.build(), chassis: c.build(), wheel: buildWheel(type), fork };
      verts += e.paint.getAttribute('position').count + e.chassis.getAttribute('position').count + e.wheel.getAttribute('position').count;
      if (fork) verts += fork.getAttribute('position').count;
      built.push(e);
    }
    const maxInstances = 24 * 7 + 16;
    this.batch = new THREE.BatchedMesh(maxInstances, verts + 16, 0, this.material);
    this.batch.name = 'vehicles';
    this.batch.castShadow = true;
    this.batch.customDepthMaterial = casterDepthMaterial('batched');
    this.batch.receiveShadow = true;
    this.batch.frustumCulled = false;
    const geo = {} as Record<VehicleType, { paint: number; chassis: number; wheel: number; fork: number }>;
    for (const e of built) {
      geo[e.type] = {
        paint: this.batch.addGeometry(e.paint),
        chassis: this.batch.addGeometry(e.chassis),
        wheel: this.batch.addGeometry(e.wheel),
        fork: e.fork ? this.batch.addGeometry(e.fork) : -1,
      };
      e.paint.dispose();
      e.chassis.dispose();
      e.wheel.dispose();
      e.fork?.dispose();
    }
    this.geo = geo;
    parent.add(this.batch);
    this.smoke = new ParticleSystem(parent, 900, 'smoke');
    this.fire = new ParticleSystem(parent, 400, 'fire');
  }

  private slot(v: VehicleView): VehicleSlot {
    let s = this.slots.get(v.id);
    if (s && s.type !== v.type) {
      this.free(s);
      s = undefined;
    }
    if (!s) {
      const g = this.geo[v.type];
      const instances: number[] = [this.batch.addInstance(g.paint), this.batch.addInstance(g.chassis)];
      const wheels = v.type === 'bike' ? 2 : 4;
      for (let i = 0; i < wheels; i++) instances.push(this.batch.addInstance(g.wheel));
      if (g.fork >= 0) instances.push(this.batch.addInstance(g.fork));
      s = {
        id: v.id, type: v.type, instances, wheelAngle: 0, seen: 0, smokeAcc: 0, fireAcc: 0, destroyedFor: 0,
        glb: null, useGlb: false, shown: false, fade: createLodFade(LOD_HIDDEN_IDX), glbW: 0, batchCode: Number.NaN,
      };
      this.slots.set(v.id, s);
      _c.setHex(vehiclePaintHex(v.id));
      this.batch.setColorAt(instances[0], _c);
      for (let i = 1; i < instances.length; i++) this.batch.setColorAt(instances[i], _white);
    }
    return s;
  }

  private free(s: VehicleSlot): void {
    for (const i of s.instances) this.batch.deleteInstance(i);
    this.releaseGlb(s);
    this.slots.delete(s.id);
  }

  // --- Real models -----------------------------------------------------------------------------

  private readonly glbTypes: Partial<Record<VehicleType, GlbVehicleType>> = {};
  private readonly glbUniforms = createEntityUniforms(0.35);
  private readonly glbMaterials: THREE.Material[] = [];

  /** Install loaded real models; vehicles of those types switch to them near the camera. */
  setModels(t: VehicleTemplates): void {
    for (const type of TYPES) {
      const entry = t.models[type];
      if (!entry || this.glbTypes[type]) continue;
      const normal = new Map<THREE.Material, THREE.Material>();
      const wreck = new Map<THREE.Material, THREE.Material>();
      entry.template.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (normal.has(m)) continue;
          const glass = m.transparent;
          const n = m.clone();
          if (!glass) applyEntityShader(n, { rim: true }, this.glbUniforms);
          const w = m.clone();
          // Charred wreck: darken (the models are not paint-tintable), no shine.
          const std = w as THREE.MeshStandardMaterial;
          if (std.color) std.color.multiplyScalar(glass ? 0.25 : 0.16);
          if (std.roughness !== undefined) std.roughness = 1;
          if (std.metalness !== undefined) std.metalness = 0;
          if (!glass) applyEntityShader(w, { rim: true }, this.glbUniforms);
          normal.set(m, n);
          wreck.set(m, w);
          this.glbMaterials.push(n, w);
        }
      });
      let forkPos: THREE.Vector3 | null = null;
      let forkRake = 0;
      const forkNode = entry.model.fork ? entry.template.getObjectByName(entry.model.fork.node) : undefined;
      if (forkNode) {
        // Model space (the template root's own transform is replaced by the vehicle matrix).
        entry.template.updateMatrixWorld(true);
        _m.copy(entry.template.matrixWorld).invert().multiply(forkNode.matrixWorld);
        forkPos = new THREE.Vector3().setFromMatrixPosition(_m);
        forkRake = forkNode.rotation.x;
      }
      this.glbTypes[type] = { model: entry.model, template: entry.template, normal, wreck, free: [], all: [], forkPos, forkRake };
    }
  }

  private acquireGlb(type: VehicleType): GlbVehicle | null {
    const t = this.glbTypes[type];
    if (!t) return null;
    const pooled = t.free.pop();
    if (pooled) {
      pooled.root.visible = true;
      this.glbInUse++;
      return pooled;
    }
    const root = t.template.clone(true);
    root.matrixAutoUpdate = false;
    const meshes: THREE.Mesh[] = [];
    const normalMats: THREE.Material[] = [];
    const wreckMats: THREE.Material[] = [];
    const uniforms = createEntityUniforms(0.35);
    // Per-clone material copies sharing one uniform set, so each vehicle dithers on its own.
    const own = (src: THREE.Material): THREE.Material => {
      const m = src.clone();
      applyEntityShader(m, src.transparent ? { dither: true } : { rim: true, dither: true }, uniforms);
      return m;
    };
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
      meshes.push(mesh);
      normalMats.push(own(t.normal.get(m) ?? m));
      wreckMats.push(own(t.wreck.get(m) ?? m));
      mesh.material = normalMats[normalMats.length - 1];
      mesh.castShadow = !m.transparent;
      mesh.receiveShadow = true;
    });
    const wheels: GlbWheel[] = [];
    for (const w of t.model.wheels) {
      const node = root.getObjectByName(w.node);
      if (!node) continue;
      node.rotation.order = 'YXZ';
      wheels.push({ node, steers: w.steers && !w.parent, radius: w.radius });
    }
    let fork: THREE.Object3D | null = null;
    let forkRake = 0;
    if (t.model.fork) {
      fork = root.getObjectByName(t.model.fork.node) ?? null;
      if (fork) {
        forkRake = fork.rotation.x;
        fork.rotation.order = 'XYZ';
      }
    }
    const g: GlbVehicle = { root, meshes, normalMats, wreckMats, uniforms, wheels, fork, forkRake, wrecked: false };
    t.all.push(g);
    this.glbInUse++;
    this.parentObj.add(root);
    return g;
  }

  private releaseGlb(s: VehicleSlot): void {
    const g = s.glb;
    if (!g) return;
    g.root.visible = false;
    this.glbTypes[s.type]?.free.push(g);
    s.glb = null;
    this.glbInUse--;
  }

  /** Whether a vehicle is currently drawn (inside the render distance); riders follow it. */
  isShown(vehicleId: EntityId): boolean {
    return this.slots.get(vehicleId)?.shown ?? false;
  }

  /**
   * Extra lift (m, along the vehicle's up axis) for a rider of `seat` so they sit on the real
   * model's seat surface instead of the physics hip height. 0 for procedural models.
   */
  riderLift(vehicleId: EntityId, seat: number): number {
    const s = this.slots.get(vehicleId);
    if (!s || !s.glb || s.glbW <= 0) return 0;
    const model = this.glbTypes[s.type]?.model;
    const def = VEHICLES[s.type];
    if (!model || seat < 0 || seat >= def.seatOffsets.length) return 0;
    const surface = model.seatSurfaceY[seat];
    if (surface === null || surface === undefined) return 0;
    // Blended with the crossfade so riders move smoothly between the two models' seats.
    return Math.max(0, surface - (def.seatOffsets[seat].y + SEAT_HIP_HEIGHT)) * s.glbW;
  }

  /**
   * Rider contact points for the model currently shown (real or procedural), in the rider's root
   * space (seat origin raised by `lift` along the vehicle up axis, vehicle orientation): the
   * driver's hands on the handlebar grips / steering wheel rim (following the steering exactly
   * like the drawn fork / wheel), a bike passenger's hands on the driver's waist (or the tail when
   * riding alone) and bike riders' feet on the footpegs. Writes info.contacts / hands / feet.
   */
  riderContacts(v: VehicleView, info: SeatInfo, lift: number): void {
    const s = this.slots.get(v.id);
    const t = this.glbTypes[v.type];
    const w = s && s.glb && t ? s.glbW : 0;
    // During the real <-> procedural crossfade the contacts blend like the drawn models do.
    this.contactsFor(v, info, lift, w >= 1 ? t : undefined, info.contacts);
    if (w > 0 && w < 1 && t) {
      const c = info.contacts, r = this.contactScratch;
      this.contactsFor(v, info, lift, t, r);
      for (let i = 0; i < 12; i++) c[i] += (r[i] - c[i]) * w;
    }
  }

  private readonly contactScratch = new Float32Array(12);

  /** Contacts for one model (real when `real` is given, else procedural) into `c`. */
  private contactsFor(v: VehicleView, info: SeatInfo, lift: number, real: GlbVehicleType | undefined, c: Float32Array): void {
    info.hands = false;
    info.feet = false;
    const def = VEHICLES[v.type];
    const seat = info.seat;
    if (seat < 0 || seat >= def.seatOffsets.length) return;
    if (v.type === 'bike') {
      if (seat === 0) {
        // Grips rotate with the fork: R = Rx(rake) * Ry(steer) about the fork pivot.
        let gx: number, gy: number, gz: number, rake: number;
        let pivot: THREE.Vector3;
        if (real && real.forkPos) {
          pivot = real.forkPos;
          rake = real.forkRake;
          gx = BIKE_MODEL_GRIP[0]; gy = BIKE_MODEL_GRIP[1]; gz = BIKE_MODEL_GRIP[2];
        } else {
          pivot = this.bike.axle;
          rake = this.bike.rake;
          gx = DRIVER_CONTROLS.bike.radius - 0.06; gy = this.bike.len; gz = 0;
        }
        _ex.set(rake, -v.steer * def.steerMax, 0, 'XYZ');
        _q.setFromEuler(_ex);
        _v.set(-gx, gy, gz).applyQuaternion(_q).add(pivot);
        c[0] = _v.x; c[1] = _v.y; c[2] = _v.z;
        _v.set(gx, gy, gz).applyQuaternion(_q).add(pivot);
        c[3] = _v.x; c[4] = _v.y; c[5] = _v.z;
      } else if (v.seats[0] !== null && v.seats[0] !== undefined) {
        // Passenger: hands on the driver's waist.
        const s0 = def.seatOffsets[0];
        const y = s0.y + SEAT_HIP_HEIGHT + this.riderLift(v.id, 0) + 0.12;
        c[0] = -0.17; c[1] = y; c[2] = s0.z + 0.04;
        c[3] = 0.17; c[4] = y; c[5] = s0.z + 0.04;
      } else {
        // Riding alone on the back: hands on the tail behind the hips.
        const so = def.seatOffsets[seat];
        const y = so.y + SEAT_HIP_HEIGHT + lift - 0.03;
        c[0] = -0.16; c[1] = y; c[2] = so.z + 0.2;
        c[3] = 0.16; c[4] = y; c[5] = so.z + 0.2;
      }
      info.hands = true;
      const pg = (real ? BIKE_MODEL_PEGS : BIKE_PROC_PEGS)[Math.min(seat, 1)];
      c[6] = -pg[0]; c[7] = pg[1]; c[8] = pg[2];
      c[9] = pg[0]; c[10] = pg[1]; c[11] = pg[2];
      info.feet = true;
    } else if (seat === 0) {
      if (real && v.type === 'uaz') {
        // The real wheel has no node of its own (it does not turn): hands slide round the rim.
        const w = UAZ_MODEL_WHEEL;
        ringGrips(w.center[0], w.center[1], w.center[2], w.radius, w.upY, w.upZ, v.steer * REAL_WHEEL_TURN, c);
      } else {
        const k = DRIVER_CONTROLS[v.type];
        const so = def.seatOffsets[0];
        ringGrips(so.x + k.center[0], so.y + k.center[1], so.z + k.center[2], k.radius, Math.cos(k.tilt), Math.sin(k.tilt), v.steer * k.wheelTurn, c);
      }
      info.hands = true;
    } else {
      return;
    }
    // Vehicle-local -> rider root space (only the entries written above).
    const so = def.seatOffsets[seat];
    for (let i = info.hands ? 0 : 6, n = info.feet ? 12 : 6; i < n; i += 3) {
      c[i] -= so.x;
      c[i + 1] -= so.y + lift;
      c[i + 2] -= so.z;
    }
  }

  private poseGlb(s: VehicleSlot, v: VehicleView, m: THREE.Matrix4, steerAngle: number): void {
    const g = s.glb!;
    g.root.matrix.copy(m);
    g.root.matrixWorldNeedsUpdate = true;
    // Wheels: spin (signed forward speed / radius, accumulated in wheelAngle for the physics
    // radius; rescaled to the model radius) and steer.
    const spinScale = HANDLING[v.type].wheelRadius;
    for (const w of g.wheels) {
      w.node.rotation.x = (s.wheelAngle * spinScale) / w.radius;
      w.node.rotation.y = w.steers ? steerAngle : 0;
    }
    if (g.fork) g.fork.rotation.set(g.forkRake, steerAngle, 0, 'XYZ');
    if (g.wrecked !== v.destroyed) {
      g.wrecked = v.destroyed;
      for (let i = 0; i < g.meshes.length; i++) g.meshes[i].material = v.destroyed ? g.wreckMats[i] : g.normalMats[i];
    }
  }

  /**
   * Update all vehicles. `camPos` for distance culling; `scale` = viewport px focal length for
   * particle sizing; `maxDist` = render distance.
   */
  update(
    vehicles: ReadonlyMap<EntityId, VehicleView>, camPos: THREE.Vector3, dt: number, scale: number, maxDist: number,
    fovDeg = REF_FOV, frustum: THREE.Frustum | null = null,
  ): void {
    this.frameNo++;
    this.cam.copy(camPos);
    this.dt = dt;
    this.fov = fovDeg;
    this.frustum = frustum;
    const showD = Math.max(0, maxDist - LOD_HYSTERESIS), hideD = maxDist + LOD_HYSTERESIS;
    this.showD2 = showD * showD;
    this.hideD2 = hideD * hideD;
    vehicles.forEach(this.visit);
    // Remove vehicles that disappeared.
    this.removeList.length = 0;
    this.slots.forEach(this.collectStale);
    for (const id of this.removeList) {
      const s = this.slots.get(id);
      if (s) this.free(s);
    }
    this.smoke.update(dt, 1.2, 0.6, scale);
    this.fire.update(dt, 0.4, 0.2, scale);
  }

  // Per-frame parameters for the bound visitors below (avoids allocating closures every frame).
  private readonly cam = new THREE.Vector3();
  private dt = 0;
  private showD2 = 0;
  private hideD2 = 0;
  private fov = REF_FOV;
  private frustum: THREE.Frustum | null = null;
  /** Real-model clones currently in use (capped). */
  private glbInUse = 0;

  private readonly collectStale = (s: VehicleSlot): void => {
    if (s.seen !== this.frameNo) this.removeList.push(s.id);
  };

  private readonly visit = (v: VehicleView): void => {
    const dt = this.dt;
    const s = this.slot(v);
    s.seen = this.frameNo;
    const def = VEHICLES[v.type];
    const dx = v.pos.x - this.cam.x, dy = v.pos.y - this.cam.y, dz = v.pos.z - this.cam.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    // Render-distance cut with hysteresis (no flicker at the edge; riders follow this flag).
    s.shown = s.shown ? d2 < this.hideD2 : d2 < this.showD2;
    // Real model near the camera, the batched procedural one beyond: picked on the zoom-adjusted
    // distance (on screen; off-screen vehicles use the true one) with hysteresis, and crossfaded
    // with the entity dither like the player LODs.
    let target: LodLevel = LOD_HIDDEN_IDX;
    if (s.shown) {
      let d = Math.sqrt(d2);
      if (this.frustum) {
        _sph.center.set(v.pos.x, v.pos.y, v.pos.z);
        if (this.frustum.intersectsSphere(_sph)) d = effectiveLodDistance(d, this.fov, REF_FOV);
      }
      if (this.glbTypes[v.type]) s.useGlb = s.useGlb ? d < GLB_FAR : d < GLB_NEAR && this.glbInUse < MAX_GLB_VEHICLES;
      else s.useGlb = false;
      target = s.useGlb ? 0 : 1;
    } else {
      s.useGlb = false;
    }
    stepLodFade(s.fade, target, dt, VEHICLE_FADE_TIME);
    const codeGlb = fadeCode(s.fade, 0, 1), codeBatch = fadeCode(s.fade, 1, 1);
    if (codeGlb !== 0 && !s.glb) s.glb = this.acquireGlb(v.type);
    else if (codeGlb === 0 && s.glb) this.releaseGlb(s);
    const glbVis = s.glb ? Math.abs(codeGlb) : 0, batchVis = Math.abs(codeBatch);
    s.glbW = glbVis + batchVis > 0 ? glbVis / (glbVis + batchVis) : 0;
    const batchVisible = codeBatch !== 0;
    for (let i = 0; i < s.instances.length; i++) this.batch.setVisibleAt(s.instances[i], batchVisible);
    if (batchVisible && codeBatch !== s.batchCode) {
      // Per-instance dither code in the instance colour's alpha (rgb = paint / wreck tint).
      s.batchCode = codeBatch;
      for (let i = 0; i < s.instances.length; i++) {
        this.batch.getColorAt(s.instances[i], _c4);
        _c4.w = codeBatch;
        this.batch.setColorAt(s.instances[i], _c4);
      }
    }
    if (s.glb) s.glb.uniforms.uFade.value = codeGlb;
    if (codeGlb === 0 && codeBatch === 0) return;
    // Body transform (Ry * Rx * Rz).
    _e.set(v.pitch, v.yaw, v.roll, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(v.pos.x, v.pos.y, v.pos.z);
    _m.compose(_p, _q, _one);
    this.batch.setMatrixAt(s.instances[0], _m);
    this.batch.setMatrixAt(s.instances[1], _m);
    // Wheels: spin with the signed forward speed, front wheels steer (steer > 0 = right).
    const h = HANDLING[v.type];
    if (!v.destroyed) s.wheelAngle = (s.wheelAngle - (v.speed / h.wheelRadius) * dt) % (Math.PI * 2);
    const steerAngle = -v.steer * def.steerMax;
    const wy = wheelCenterY(v.type);
    const wheels = WHEELS[v.type];
    if (v.type === 'bike') {
      // Fork: rotate about the raked steering axis through the front axle.
      const ax = this.bike;
      _e.set(ax.rake, 0, 0, 'YXZ');
      _r.makeRotationFromEuler(_e);
      _w.makeRotationY(steerAngle);
      _r.multiply(_w).setPosition(ax.axle);
      _w.multiplyMatrices(_m, _r);
      this.batch.setMatrixAt(s.instances[4], _w);
      _r.makeRotationX(s.wheelAngle);
      _w.multiply(_r);
      this.batch.setMatrixAt(s.instances[2], _w);
      const rw = wheels[1];
      _r.makeRotationX(s.wheelAngle).setPosition(rw.x, wy, rw.z);
      _w.multiplyMatrices(_m, _r);
      this.batch.setMatrixAt(s.instances[3], _w);
    } else {
      for (let i = 0; i < 4; i++) {
        const wp = wheels[i];
        _e.set(s.wheelAngle, i < 2 ? steerAngle : 0, 0, 'YXZ');
        _r.makeRotationFromEuler(_e).setPosition(wp.x, wy, wp.z);
        _w.multiplyMatrices(_m, _r);
        this.batch.setMatrixAt(s.instances[2 + i], _w);
      }
    }
    if (s.glb) this.poseGlb(s, v, _m, steerAngle);
    // Burnt wreck tint (switch colours only on state changes).
    const wrecked = v.destroyed;
    if (wrecked !== (s.destroyedFor > 0)) {
      _c.setHex(vehiclePaintHex(v.id));
      this.batch.setColorAt(s.instances[0], wrecked ? _wreck : _c);
      for (let i = 1; i < s.instances.length; i++) this.batch.setColorAt(s.instances[i], wrecked ? _wreck : _white);
    }
    s.destroyedFor = wrecked ? s.destroyedFor + Math.max(dt, 1e-4) : 0;
    // Damage smoke / fire (only when reasonably close).
    if (d2 < 600 * 600) this.emitDamage(v, s, _m, dt);
  };

  private emitDamage(v: VehicleView, s: VehicleSlot, m: THREE.Matrix4, dt: number): void {
    const hpFrac = v.hp / VEHICLES[v.type].health;
    let smokeRate = 0, fireRate = 0, shade = 0.55, size = 1.4;
    if (v.burning) {
      fireRate = 34;
      smokeRate = 20;
      shade = 0.08;
      size = 2.6;
    } else if (v.destroyed) {
      // Wrecks keep smouldering for a while.
      smokeRate = s.destroyedFor < 25 ? 7 * (1 - s.destroyedFor / 25) + 1 : 0;
      shade = 0.12;
      size = 2.2;
    } else if (hpFrac < 0.4) {
      smokeRate = 4 + 14 * (1 - hpFrac / 0.4);
      shade = 0.6 - 0.35 * (1 - hpFrac / 0.4);
      size = 1.2 + 0.8 * (1 - hpFrac / 0.4);
    }
    const ep = ENGINE_POS[v.type];
    _v.set(ep[0], ep[1], ep[2]).applyMatrix4(m);
    s.smokeAcc += smokeRate * dt;
    while (s.smokeAcc >= 1) {
      s.smokeAcc -= 1;
      const j = Math.random();
      this.smoke.emit(
        _v.x + (j - 0.5) * 0.4, _v.y + 0.2, _v.z + (Math.random() - 0.5) * 0.4,
        v.vel.x * 0.3 + (Math.random() - 0.5) * 0.6, 1.4 + Math.random() * 1.2, v.vel.z * 0.3 + (Math.random() - 0.5) * 0.6,
        3.5 + Math.random() * 2.5, size * 0.5, size * (2.2 + Math.random()), Math.min(1, shade + Math.random() * 0.1),
      );
    }
    s.fireAcc += fireRate * dt;
    while (s.fireAcc >= 1) {
      s.fireAcc -= 1;
      this.fire.emit(
        _v.x + (Math.random() - 0.5) * 0.9, _v.y + Math.random() * 0.3, _v.z + (Math.random() - 0.5) * 0.9,
        (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.8, (Math.random() - 0.5) * 0.8,
        0.45 + Math.random() * 0.4, 0.9 + Math.random() * 0.5, 0.3, 0.7 + Math.random() * 0.3,
      );
    }
  }

  dispose(): void {
    this.batch.removeFromParent();
    this.batch.dispose();
    this.material.dispose();
    this.smoke.dispose();
    this.fire.dispose();
    this.slots.forEach((s) => this.releaseGlb(s));
    for (const type of TYPES) {
      const t = this.glbTypes[type];
      if (!t) continue;
      for (const g of t.all) {
        g.root.removeFromParent();
        for (const m of g.normalMats) m.dispose();
        for (const m of g.wreckMats) m.dispose();
      }
      t.free.length = 0;
      t.all.length = 0;
    }
    for (const m of this.glbMaterials) m.dispose();
  }
}
