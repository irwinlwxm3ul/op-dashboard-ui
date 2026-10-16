// Vehicles: procedural buggy (open frame, roll cage, big wheels), UAZ-like 4x4 (boxy body, dark
// glass) and motorbike, all drawn by ONE BatchedMesh (paint shells tinted per vehicle, unpainted
// chassis, wheels, bike fork). Dimensions come from the shared vehicle definitions so the visuals
// match the physics. Wheels spin with speed, front wheels / fork steer, wrecks turn dark, and damaged
// vehicles smoke (< 40 % hp) or burn.

import * as THREE from 'three';
import { HANDLING, VEHICLES, WHEELS } from '../../../shared/vehicles';
import type { EntityId, VehicleType } from '../../../shared/types';
import type { VehicleView } from '../../game/types';
import { GeoBuilder, type PartStyle, xform } from './geometry';
import { createEntityMaterial } from './materials';
import { WRECK_TINT, vehiclePaintHex } from './palette';
import { ParticleSystem } from './particles';
import { DRIVER_CONTROLS } from './seating';

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
  const t = (x: number, y: number, z: number, len: number, rx: number, rz: number): void => {
    chassis.cyl(0.035, 0.035, len, 6, xform(x, y, z, rx, 0, rz), { color: TUBE });
  };
  const topY = hy - 0.02, baseY = floorY + 0.05, cx = hx * 0.72;
  const fz = -0.35, rz = 0.8;
  const postH = topY - baseY;
  for (const x of [-cx, cx]) {
    t(x, baseY + postH / 2, fz, postH, -0.12, 0);
    t(x, baseY + postH / 2, rz, postH, 0, 0);
    t(x, topY, (fz + rz) / 2, rz - fz, Math.PI / 2, 0);
    // Front diagonal down to the nose.
    t(x * 0.9, (topY + floorY + 0.25) / 2, fz - 0.55, 1.25, -0.95, 0);
    // Rear diagonal to the engine.
    t(x * 0.95, (topY + floorY + 0.3) / 2, rz + 0.45, 1.0, 0.8, 0);
  }
  t(0, topY, fz, cx * 2, 0, Math.PI / 2);
  t(0, topY, rz, cx * 2, 0, Math.PI / 2);
  t(0, topY - 0.02, (fz + rz) / 2, cx * 2, 0, Math.PI / 2);
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
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(w * 1.04, 0.05, r * 0.32, xform(0, Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97, -a), { color: 0x141414 });
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

/** Instance layout per vehicle: [paint, chassis, wheels..., (fork)] */
export class VehicleRenderer {
  private readonly material = createEntityMaterial({ rim: true, fogScale: 0.35 });
  private readonly batch: THREE.BatchedMesh;
  private readonly geo: Record<VehicleType, { paint: number; chassis: number; wheel: number; fork: number }>;
  private readonly slots = new Map<EntityId, VehicleSlot>();
  private readonly smoke: ParticleSystem;
  private readonly fire: ParticleSystem;
  private frameNo = 0;
  private readonly bike = bikeAxis();
  private readonly removeList: EntityId[] = [];

  constructor(parent: THREE.Object3D) {
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
      s = { id: v.id, type: v.type, instances, wheelAngle: 0, seen: 0, smokeAcc: 0, fireAcc: 0, destroyedFor: 0 };
      this.slots.set(v.id, s);
      _c.setHex(vehiclePaintHex(v.id));
      this.batch.setColorAt(instances[0], _c);
      for (let i = 1; i < instances.length; i++) this.batch.setColorAt(instances[i], _white);
    }
    return s;
  }

  private free(s: VehicleSlot): void {
    for (const i of s.instances) this.batch.deleteInstance(i);
    this.slots.delete(s.id);
  }

  /**
   * Update all vehicles. `camPos` for distance culling; `scale` = viewport px focal length for
   * particle sizing; `maxDist` = render distance.
   */
  update(vehicles: ReadonlyMap<EntityId, VehicleView>, camPos: THREE.Vector3, dt: number, scale: number, maxDist: number): void {
    this.frameNo++;
    const maxD2 = maxDist * maxDist;
    vehicles.forEach((v) => {
      const s = this.slot(v);
      s.seen = this.frameNo;
      const def = VEHICLES[v.type];
      const dx = v.pos.x - camPos.x, dy = v.pos.y - camPos.y, dz = v.pos.z - camPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const visible = d2 < maxD2;
      for (const i of s.instances) this.batch.setVisibleAt(i, visible);
      if (!visible) return;
      // Body transform (Ry * Rx * Rz).
      _e.set(v.pitch, v.yaw, v.roll, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(v.pos.x, v.pos.y, v.pos.z);
      _m.compose(_p, _q, _one);
      this.batch.setMatrixAt(s.instances[0], _m);
      this.batch.setMatrixAt(s.instances[1], _m);
      // Wheels.
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
          const front = i < 2;
          _e.set(s.wheelAngle, front ? steerAngle : 0, 0, 'YXZ');
          _r.makeRotationFromEuler(_e).setPosition(wp.x, wy, wp.z);
          _w.multiplyMatrices(_m, _r);
          this.batch.setMatrixAt(s.instances[2 + i], _w);
        }
      }
      // Wreck tint.
      const wrecked = v.destroyed;
      const tint = wrecked ? _wreck : null;
      if (wrecked !== (s.destroyedFor > 0)) {
        _c.setHex(vehiclePaintHex(v.id));
        this.batch.setColorAt(s.instances[0], tint ?? _c);
        for (let i = 1; i < s.instances.length; i++) this.batch.setColorAt(s.instances[i], tint ?? _white);
      }
      s.destroyedFor = wrecked ? s.destroyedFor + dt : 0;
      // Damage smoke / fire (only when reasonably close).
      if (d2 < 600 * 600) this.emitDamage(v, s, _m, dt);
    });
    // Remove vehicles that disappeared.
    this.removeList.length = 0;
    this.slots.forEach((s) => {
      if (s.seen !== this.frameNo) this.removeList.push(s.id);
    });
    for (const id of this.removeList) {
      const s = this.slots.get(id);
      if (s) this.free(s);
    }
    this.smoke.update(dt, 1.2, 0.6, scale);
    this.fire.update(dt, 0.4, 0.2, scale);
  }

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
  }
}
