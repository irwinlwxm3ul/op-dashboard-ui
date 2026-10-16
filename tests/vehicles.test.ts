import { describe, expect, it } from 'vitest';
import {
  CIRCLES, VEHICLES, createVehicle, crashDamage, exitPosition, raycastVehicle, rideHeight,
  seatWorldPosition, stepVehicle, vehicleHitsPoint,
} from '../src/shared/vehicles';
import type { VehicleControls, VehicleStepEvents } from '../src/shared/vehicles';
import { PLAYER_RADIUS } from '../src/shared/constants';
import { Rng } from '../src/shared/rng';
import type {
  BoxKind, RockDef, TreeDef, Vec3, VehicleState, VehicleType, World, WorldBox,
} from '../src/shared/types';

// ---------------------------------------------------------------------------
// Small fake world: analytic heightmap + linear-scan colliders.
// ---------------------------------------------------------------------------

interface FakeOpts {
  half?: number;
  height?: (x: number, z: number) => number;
  boxes?: WorldBox[];
  trees?: TreeDef[];
  rocks?: RockDef[];
  waterLevel?: number;
}

let boxId = 0;
function box(min: Vec3, max: Vec3, kind: BoxKind = 'wall'): WorldBox {
  return { id: boxId++, min, max, kind, material: 'concrete', color: 0x888888, building: -1, blocksBullets: true };
}
function tree(x: number, z: number, r = 0.25, h = 9): TreeDef {
  return { x, y: 0, z, kind: 'pine', scale: 1, r, h, rot: 0 };
}

function makeWorld(o: FakeOpts = {}): World {
  const half = o.half ?? 512;
  const hf = o.height ?? (() => 0);
  const boxes = o.boxes ?? [];
  const trees = o.trees ?? [];
  const rocks = o.rocks ?? [];
  return {
    seed: 1, kind: 'training', size: half * 2, half, res: 2, cell: half * 2,
    heights: new Float32Array(4), surface: new Uint8Array(4), waterLevel: o.waterLevel ?? -100,
    boxes, buildings: [], trees, rocks, bushes: [], roads: [], towns: [], lootSpawns: [],
    vehicleSpawns: [], training: null,
    heightAt: (x, z) => hf(x, z),
    normalAt: (x, z, out = { x: 0, y: 1, z: 0 }) => {
      const e = 0.5;
      const dx = (hf(x + e, z) - hf(x - e, z)) / (2 * e), dz = (hf(x, z + e) - hf(x, z - e)) / (2 * e);
      const l = Math.hypot(dx, 1, dz);
      out.x = -dx / l; out.y = 1 / l; out.z = -dz / l;
      return out;
    },
    surfaceAt: () => 'grass',
    groundAt: (x, z, fromY = Infinity) => {
      let g = hf(x, z);
      for (const b of boxes) {
        if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= fromY + 0.01 && b.max.y > g) g = b.max.y;
      }
      return g;
    },
    inBounds: (x, z) => Math.abs(x) <= half && Math.abs(z) <= half,
    queryBoxes: (x0, z0, x1, z1, out) => {
      for (const b of boxes) if (b.max.x >= x0 && b.min.x <= x1 && b.max.z >= z0 && b.min.z <= z1) out.push(b);
      return out;
    },
    queryTrees: (x0, z0, x1, z1, out) => {
      for (const t of trees) if (t.x + t.r >= x0 && t.x - t.r <= x1 && t.z + t.r >= z0 && t.z - t.r <= z1) out.push(t);
      return out;
    },
    queryRocks: (x0, z0, x1, z1, out) => {
      for (const t of rocks) if (t.x + t.r >= x0 && t.x - t.r <= x1 && t.z + t.r >= z0 && t.z - t.r <= z1) out.push(t);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DT = 1 / 30;
const TYPES: VehicleType[] = ['buggy', 'uaz', 'bike'];

function ctl(throttle: number, steer = 0, handbrake = false, boost = false): VehicleControls {
  return { throttle, steer, handbrake, boost };
}
function spawn(type: VehicleType, x = 0, z = 0, yaw = 0, groundY = 0, fuel = 1): VehicleState {
  return createVehicle(1, { pos: { x, y: groundY, z }, yaw, type }, fuel);
}
function events(): VehicleStepEvents {
  return { crash: 0, crashPos: null, inWater: false };
}
/** Run n ticks; returns the largest crash seen. */
function run(v: VehicleState, c: VehicleControls | null, n: number, w: World, others: VehicleState[] = [], ev = events()): number {
  let maxCrash = 0;
  for (let i = 0; i < n; i++) {
    stepVehicle(v, c, DT, w, others, ev);
    if (ev.crash > maxCrash) maxCrash = ev.crash;
  }
  return maxCrash;
}
/** Lateral (rightward) velocity in the vehicle frame. */
function lateral(v: VehicleState): number {
  return v.vel.x * Math.cos(v.yaw) - v.vel.z * Math.sin(v.yaw);
}
/** Give a vehicle a forward velocity along its heading. */
function launch(v: VehicleState, speed: number): void {
  v.vel.x = -Math.sin(v.yaw) * speed;
  v.vel.z = -Math.cos(v.yaw) * speed;
  v.speed = speed;
}
/** Whether a standing player capsule at feet position p overlaps any box / tree / rock. */
function capsuleBlocked(w: World, p: Vec3): boolean {
  const r = PLAYER_RADIUS;
  for (const b of w.boxes) {
    if (b.max.y <= p.y + 0.05 || b.min.y >= p.y + 1.8) continue;
    const cx = Math.max(b.min.x, Math.min(p.x, b.max.x)), cz = Math.max(b.min.z, Math.min(p.z, b.max.z));
    if (Math.hypot(p.x - cx, p.z - cz) < r) return true;
  }
  for (const t of w.trees) if (Math.hypot(p.x - t.x, p.z - t.z) < r + t.r) return true;
  for (const k of w.rocks) if (k.y + k.h > p.y + 0.05 && Math.hypot(p.x - k.x, p.z - k.z) < r + k.r) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Definitions & construction
// ---------------------------------------------------------------------------

describe('vehicle definitions', () => {
  it('matches the design (seats, speeds, health, fuel, shooting seats)', () => {
    expect(VEHICLES.buggy.seats).toBe(2);
    expect(VEHICLES.uaz.seats).toBe(4);
    expect(VEHICLES.bike.seats).toBe(2);
    expect(VEHICLES.bike.maxSpeed).toBeGreaterThan(VEHICLES.buggy.maxSpeed);
    expect(VEHICLES.buggy.maxSpeed).toBeGreaterThan(VEHICLES.uaz.maxSpeed);
    expect(VEHICLES.uaz.mass).toBeGreaterThan(VEHICLES.buggy.mass);
    expect([VEHICLES.buggy.health, VEHICLES.uaz.health, VEHICLES.bike.health]).toEqual([1000, 1600, 600]);
    for (const t of TYPES) {
      const d = VEHICLES[t];
      expect(d.type).toBe(t);
      expect(d.seatOffsets).toHaveLength(d.seats);
      expect(d.seatCanShoot).toHaveLength(d.seats);
      expect(d.seatCanShoot[0]).toBe(false);
      expect(d.seatCanShoot.slice(1).every(Boolean)).toBe(true);
      expect(d.fuelMax).toBe(100);
      const fullThrottleSeconds = d.fuelMax / d.fuelPerSec;
      expect(fullThrottleSeconds).toBeGreaterThanOrEqual(300);
      expect(fullThrottleSeconds).toBeLessThanOrEqual(420);
    }
    expect(VEHICLES.bike.isBike).toBe(true);
    expect(VEHICLES.bike.halfExtents.x).toBeLessThan(VEHICLES.buggy.halfExtents.x);
  });

  it('creates a vehicle resting on the ground at the spawn', () => {
    const v = createVehicle(7, { pos: { x: 10, y: 3, z: -4 }, yaw: 1, type: 'uaz' });
    expect(v.id).toBe(7);
    expect(v.pos).toEqual({ x: 10, y: 3 + rideHeight(VEHICLES.uaz), z: -4 });
    expect(v.yaw).toBe(1);
    expect(v.seats).toEqual([null, null, null, null]);
    expect(v.fuel).toBeCloseTo(60);
    expect(v.health).toBe(1600);
    expect(v.destroyed).toBe(false);
    // A parked vehicle on flat ground stays exactly where it is.
    const w = makeWorld({ height: () => 3 });
    const before = JSON.parse(JSON.stringify(v));
    run(v, null, 90, w);
    expect(v.pos.x).toBeCloseTo(before.pos.x, 6);
    expect(v.pos.z).toBeCloseTo(before.pos.z, 6);
    expect(v.pos.y).toBeCloseTo(before.pos.y, 3);
    expect(v.rpm).toBe(0);
    expect(v.onGround).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

describe('driving', () => {
  it.each(TYPES)('%s accelerates to near maxSpeed and never exceeds it without boost', (t) => {
    const w = makeWorld();
    const v = spawn(t, 0, 500);
    const max = VEHICLES[t].maxSpeed;
    let top = 0;
    let at5s = 0;
    for (let i = 0; i < 30 * 20; i++) {
      stepVehicle(v, ctl(1), DT, w, []);
      top = Math.max(top, v.speed);
      if (i === 30 * 5) at5s = v.speed;
    }
    expect(top).toBeLessThanOrEqual(max + 1e-6);
    expect(v.speed).toBeGreaterThan(max * 0.97);
    expect(at5s).toBeGreaterThan(max * 0.6); // punchy acceleration
    expect(v.rpm).toBeGreaterThan(4000);
    expect(v.rpm).toBeLessThanOrEqual(6500);
    expect(v.onGround).toBe(true);
  });

  it('boost adds about 15% top speed and burns fuel twice as fast', () => {
    const w = makeWorld();
    const a = spawn('buggy', 0, 500);
    const b = spawn('buggy', 10, 500);
    run(a, ctl(1, 0, false, true), 30 * 15, w);
    run(b, ctl(1), 30 * 15, w);
    expect(a.speed).toBeGreaterThan(VEHICLES.buggy.maxSpeed * 1.1);
    expect(a.speed).toBeLessThanOrEqual(VEHICLES.buggy.maxSpeed * 1.15 + 1e-6);
    const usedA = 100 - a.fuel, usedB = 100 - b.fuel;
    expect(usedA / usedB).toBeCloseTo(2, 1);
    // Releasing boost settles back to the normal top speed.
    run(a, ctl(1), 30 * 10, w);
    expect(a.speed).toBeLessThanOrEqual(VEHICLES.buggy.maxSpeed + 0.2);
  });

  it.each(TYPES)('%s brakes to a stop and then reverses (capped at reverseSpeed)', (t) => {
    const w = makeWorld();
    const v = spawn(t, 0, 500);
    run(v, ctl(1), 30 * 8, w);
    const s0 = v.speed;
    expect(s0).toBeGreaterThan(20);
    const z0 = v.pos.z;
    let ticks = 0;
    while (v.speed > 0.5 && ticks < 30 * 6) {
      stepVehicle(v, ctl(-1), DT, w, []);
      ticks++;
    }
    expect(ticks * DT).toBeLessThan(3.5);
    expect(z0 - v.pos.z).toBeLessThan(60);
    expect(v.pitch).toBeLessThan(0); // nose dives under braking
    let minSpeed = 0;
    for (let i = 0; i < 30 * 8; i++) {
      stepVehicle(v, ctl(-1), DT, w, []);
      minSpeed = Math.min(minSpeed, v.speed);
    }
    expect(v.speed).toBeLessThan(-0.8 * VEHICLES[t].reverseSpeed);
    expect(minSpeed).toBeGreaterThanOrEqual(-VEHICLES[t].reverseSpeed - 1e-6);
    // Forward throttle while reversing brakes first.
    stepVehicle(v, ctl(1), DT, w, []);
    run(v, ctl(1), 30, w);
    expect(v.speed).toBeGreaterThan(-0.5);
  });

  it('coasting slows down, and a vehicle without a driver rolls to a stop', () => {
    const w = makeWorld();
    const v = spawn('buggy', 0, 500);
    run(v, ctl(1), 30 * 6, w);
    const s0 = v.speed;
    run(v, ctl(0), 30 * 2, w);
    expect(v.speed).toBeLessThan(s0 - 4);
    expect(v.speed).toBeGreaterThan(0);
    run(v, null, 30 * 20, w);
    expect(Math.abs(v.speed)).toBeLessThan(0.01);
    expect(v.rpm).toBe(0);
  });

  it.each(TYPES)('%s turns with the correct yaw sign (steer right => yaw decreases)', (t) => {
    const w = makeWorld();
    const right = spawn(t, 0, 0);
    launch(right, 12);
    run(right, ctl(0.6, 1), 20, w);
    expect(right.yaw).toBeLessThan(-0.2);
    expect(right.yawRate).toBeLessThan(0);
    const left = spawn(t, 0, 0);
    launch(left, 12);
    run(left, ctl(0.6, -1), 20, w);
    expect(left.yaw).toBeGreaterThan(0.2);
    expect(left.yawRate).toBeGreaterThan(0);
    expect(right.steer).toBeGreaterThan(0.9);
    // Reversing with the wheels turned right swings the nose left.
    const rev = spawn(t, 0, 0);
    rev.vel.z = 4; // moving backwards (heading -Z)
    run(rev, ctl(-1, 1), 20, w);
    expect(rev.speed).toBeLessThan(0);
    expect(rev.yaw).toBeGreaterThan(0.05);
    // No speed, no rotation.
    const still = spawn(t, 0, 0);
    run(still, ctl(0, 1), 30, w);
    expect(Math.abs(still.yaw)).toBeLessThan(1e-9);
  });

  it('corners tighter at low speed than at high speed and keeps grip without the handbrake', () => {
    const w = makeWorld();
    const radius = (speed: number): { r: number; slip: number } => {
      const v = spawn('buggy', 0, 0);
      launch(v, speed);
      // Hold speed roughly constant with partial throttle while turning.
      for (let i = 0; i < 45; i++) stepVehicle(v, ctl(v.speed < speed ? 1 : 0, 1), DT, w, []);
      return { r: Math.abs(v.speed / v.yawRate), slip: Math.abs(lateral(v)) };
    };
    const slow = radius(6), fast = radius(28);
    expect(slow.r).toBeLessThan(fast.r / 3);
    expect(fast.r).toBeGreaterThan(25);
    expect(fast.r).toBeLessThan(90);
    expect(fast.slip).toBeLessThan(3);
  });

  it('handbrake makes the rear step out (drift: much larger lateral velocity)', () => {
    const w = makeWorld();
    const grip = spawn('buggy', 0, 300);
    const drift = spawn('buggy', 20, 300);
    run(grip, ctl(1), 30 * 3, w);
    run(drift, ctl(1), 30 * 3, w);
    let latGrip = 0, latDrift = 0;
    for (let i = 0; i < 18; i++) {
      stepVehicle(grip, ctl(1, -1), DT, w, []);
      stepVehicle(drift, ctl(1, -1, true), DT, w, []);
      latGrip = Math.max(latGrip, Math.abs(lateral(grip)));
      latDrift = Math.max(latDrift, Math.abs(lateral(drift)));
    }
    expect(latDrift).toBeGreaterThan(4);
    expect(latDrift).toBeGreaterThan(latGrip * 2.5);
    expect(drift.yaw).toBeGreaterThan(grip.yaw); // rotates further into the turn
    // Releasing the handbrake regains grip.
    run(drift, ctl(1), 30 * 2, w);
    expect(Math.abs(lateral(drift))).toBeLessThan(1);
  });

  it('bike leans into turns, cars roll outward', () => {
    const w = makeWorld();
    const bike = spawn('bike', 0, 0);
    launch(bike, 20);
    run(bike, ctl(1, -1), 30, w); // left turn
    expect(bike.yawRate).toBeGreaterThan(0);
    expect(bike.roll).toBeGreaterThan(0.25); // positive roll = right side up = leaning left
    const car = spawn('uaz', 0, 0);
    launch(car, 20);
    run(car, ctl(1, -1), 30, w);
    expect(car.roll).toBeLessThan(0); // body rolls to the outside (right)
  });

  it('holds on a slope when parked and climbs it under power', () => {
    const k = Math.tan((20 * Math.PI) / 180);
    const w = makeWorld({ height: (_x, z) => -z * k }); // uphill toward -Z (forward)
    const v = spawn('buggy', 0, 0);
    run(v, null, 60, w);
    expect(Math.abs(v.pos.z)).toBeLessThan(0.01);
    expect(v.pitch).toBeCloseTo(Math.atan(k), 2);
    run(v, ctl(1), 30 * 3, w);
    expect(v.speed).toBeGreaterThan(12);
    expect(v.pos.y).toBeGreaterThan(6);
    const ground = w.heightAt(v.pos.x, v.pos.z);
    expect(v.pos.y - ground).toBeGreaterThan(0.5);
    expect(v.pos.y - ground).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------------

describe('fuel', () => {
  it('burns with throttle only and stops the engine at 0', () => {
    const w = makeWorld();
    const v = spawn('buggy', 0, 400, 0, 0, 0.5);
    run(v, ctl(0), 30 * 5, w);
    expect(v.fuel).toBeCloseTo(50, 9); // idle consumes nothing
    expect(v.rpm).toBeGreaterThan(700); // but the engine idles
    run(v, null, 30, w);
    expect(v.fuel).toBeCloseTo(50, 9);
    run(v, ctl(1), 30 * 5, w);
    expect(v.fuel).toBeLessThan(50);
    expect(v.fuel).toBeCloseTo(50 - VEHICLES.buggy.fuelPerSec * 5, 0);

    const empty = spawn('uaz', 0, 0, 0, 0, 0);
    expect(empty.fuel).toBe(0);
    run(empty, ctl(1), 30 * 3, w);
    expect(Math.abs(empty.speed)).toBeLessThan(1e-6);
    expect(empty.rpm).toBe(0);

    // Running dry while driving: no more drive force, the vehicle coasts to a stop.
    const dry = spawn('bike', 0, 300, 0, 0, 0.004);
    run(dry, ctl(1), 30 * 3, w);
    expect(dry.fuel).toBe(0);
    run(dry, ctl(1), 30 * 15, w);
    expect(Math.abs(dry.speed)).toBeLessThan(0.01);
    expect(dry.rpm).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

describe('collisions', () => {
  it.each(TYPES)('%s hits a wall: stops, reports impact ~speed, no penetration', (t) => {
    const wallZ = 0.15;
    const w = makeWorld({ boxes: [box({ x: -50, y: -1, z: -0.15 }, { x: 50, y: 3, z: wallZ })] });
    const v = spawn(t, 0, 80);
    const ev = events();
    let speedBefore = 0, crash = 0, crashPos: Vec3 | null = null;
    for (let i = 0; i < 30 * 6 && crash === 0; i++) {
      speedBefore = v.speed;
      stepVehicle(v, ctl(1), DT, w, [], ev);
      if (ev.crash > 0) { crash = ev.crash; crashPos = ev.crashPos; }
    }
    expect(speedBefore).toBeGreaterThan(20);
    expect(crash).toBeGreaterThan(speedBefore * 0.85);
    expect(crash).toBeLessThan(speedBefore * 1.1);
    expect(crashPos).not.toBeNull();
    expect(crashPos!.z).toBeCloseTo(wallZ, 0);
    expect(v.speed).toBeLessThan(2); // stopped (or bouncing back)
    run(v, ctl(1), 60, w);
    expect(v.pos.z - VEHICLES[t].halfExtents.z).toBeGreaterThan(wallZ - 0.05);
    expect(Math.abs(v.speed)).toBeLessThan(1);
  });

  it('a glancing wall hit deflects the vehicle along the wall', () => {
    const w = makeWorld({ boxes: [box({ x: -3.2, y: -1, z: -200 }, { x: -3, y: 3, z: 200 })] });
    const v = spawn('buggy', 3, 30, 0.5);
    launch(v, 25);
    const crash = run(v, ctl(1), 60, w);
    expect(crash).toBeGreaterThan(8);
    expect(crash).toBeLessThan(18); // ~25 * sin(0.5)
    expect(Math.abs(v.yaw)).toBeLessThan(0.15); // aligned with the wall
    expect(v.speed).toBeGreaterThan(15); // keeps most of its speed
    expect(v.pos.x).toBeGreaterThan(-3 + VEHICLES.buggy.halfExtents.x - 0.05);
  });

  it.each(TYPES)('%s never passes through thin walls or trees at max speed', (t) => {
    const rng = new Rng(42);
    for (let k = 0; k < 24; k++) {
      const yaw = rng.range(-0.7, 0.7);
      const w = makeWorld({ boxes: [box({ x: -300, y: -1, z: -0.05 }, { x: 300, y: 3, z: 0.05 })] });
      const v = spawn(t, 0, 50, yaw);
      launch(v, VEHICLES[t].maxSpeed * 1.15);
      for (let i = 0; i < 75; i++) {
        stepVehicle(v, ctl(1, rng.range(-1, 1), k % 3 === 0, true), DT, w, []);
        expect(v.pos.z).toBeGreaterThan(0);
      }
    }
    const cs = CIRCLES[t];
    for (let k = 0; k < 24; k++) {
      const tr = tree(0, 0, 0.12);
      const w = makeWorld({ trees: [tr] });
      const v = spawn(t, -1.2 + k * 0.1, 60);
      launch(v, VEHICLES[t].maxSpeed * 1.15);
      for (let i = 0; i < 60; i++) {
        stepVehicle(v, ctl(1, 0, false, true), DT, w, []);
        for (const lz of cs.z) {
          const cx = v.pos.x + Math.sin(v.yaw) * lz, cz = v.pos.z + Math.cos(v.yaw) * lz;
          expect(Math.hypot(cx - tr.x, cz - tr.z)).toBeGreaterThan(cs.r + tr.r - 1e-3);
        }
      }
    }
  });

  it('rocks block, small rocks are driven over', () => {
    const big: RockDef = { x: 0, y: 0, z: 0, r: 1.2, h: 1.5, rot: 0, seed: 1 };
    const w1 = makeWorld({ rocks: [big] });
    const v1 = spawn('uaz', 0, 40);
    const crash = run(v1, ctl(1), 30 * 4, w1);
    expect(crash).toBeGreaterThan(10);
    expect(v1.pos.z).toBeGreaterThan(0);
    const small: RockDef = { x: 0, y: 0, z: 0, r: 0.5, h: 0.25, rot: 0, seed: 2 };
    const w2 = makeWorld({ rocks: [small] });
    const v2 = spawn('uaz', 0, 40);
    const crash2 = run(v2, ctl(1), 30 * 4, w2);
    expect(crash2).toBe(0);
    expect(v2.pos.z).toBeLessThan(-10);
  });

  it('vehicles collide with each other (mass weighted, both reported, no overlap)', () => {
    const w = makeWorld();
    const uaz = spawn('uaz', 0, 30);
    const buggy = createVehicle(2, { pos: { x: 0, y: 0, z: 0 }, yaw: 0, type: 'buggy' }, 1);
    launch(uaz, 20);
    const all = [uaz, buggy];
    const evA = events(), evB = events();
    let crashA = 0, hitB = 0, crashBOwn = 0;
    for (let i = 0; i < 60; i++) {
      stepVehicle(uaz, ctl(0), DT, w, all, evA);
      crashA = Math.max(crashA, evA.crash);
      if (evA.hitVehicle === buggy.id) hitB = Math.max(hitB, evA.hitVehicleImpact ?? 0);
      stepVehicle(buggy, null, DT, w, all, evB);
      crashBOwn = Math.max(crashBOwn, evB.crash);
      // Circle sets never overlap after a step.
      const ca = CIRCLES.uaz, cb = CIRCLES.buggy;
      for (const za of ca.z) {
        for (const zb of cb.z) {
          const d = Math.hypot(uaz.pos.x + Math.sin(uaz.yaw) * za - buggy.pos.x - Math.sin(buggy.yaw) * zb,
            uaz.pos.z + Math.cos(uaz.yaw) * za - buggy.pos.z - Math.cos(buggy.yaw) * zb);
          expect(d).toBeGreaterThan(ca.r + cb.r - 0.02);
        }
      }
    }
    expect(crashA).toBeGreaterThan(4);
    expect(hitB).toBeGreaterThan(crashA); // the lighter buggy takes the larger velocity change
    expect(hitB / crashA).toBeCloseTo(VEHICLES.uaz.mass / VEHICLES.buggy.mass, 1);
    expect(buggy.pos.z).toBeLessThan(-3); // shoved forward
    expect(crashBOwn).toBe(0);
  });

  it('head-on vehicle crash at speed', () => {
    const w = makeWorld();
    const a = spawn('buggy', 0, 30);
    const b = createVehicle(2, { pos: { x: 0, y: 0, z: -30 }, yaw: Math.PI, type: 'buggy' }, 1);
    launch(a, 25);
    launch(b, 25);
    const evA = events(), evB = events();
    let crashA = 0, hitB = 0;
    for (let i = 0; i < 60; i++) {
      stepVehicle(a, ctl(1), DT, w, [a, b], evA);
      crashA = Math.max(crashA, evA.crash);
      hitB = Math.max(hitB, evA.hitVehicleImpact ?? 0);
      stepVehicle(b, ctl(1), DT, w, [a, b], evB);
      crashA = Math.max(crashA, evB.hitVehicleImpact ?? 0);
      hitB = Math.max(hitB, evB.crash);
    }
    expect(crashA).toBeGreaterThan(20);
    expect(hitB).toBeGreaterThan(20);
    expect(a.pos.z - b.pos.z).toBeGreaterThan(2 * VEHICLES.buggy.halfExtents.z - 0.2);
  });

  it('stays inside the map bounds', () => {
    const w = makeWorld({ half: 100 });
    const v = spawn('bike', 0, -80);
    run(v, ctl(1, 0, false, true), 30 * 5, w);
    expect(v.pos.z).toBeGreaterThanOrEqual(-100);
    expect(v.pos.z).toBeLessThan(-95);
  });
});

// ---------------------------------------------------------------------------
// Terrain, air, water
// ---------------------------------------------------------------------------

describe('terrain, airtime and water', () => {
  it.each(TYPES)('%s goes airborne off a cliff and lands (hard landing = crash)', (t) => {
    const w = makeWorld({ height: (_x, z) => (z < 0 ? -8 : 0) });
    const v = spawn(t, 0, 60);
    const ev = events();
    let airTicks = 0, landed = false, landingCrash = 0;
    for (let i = 0; i < 30 * 8; i++) {
      stepVehicle(v, ctl(1), DT, w, [], ev);
      if (!v.onGround) airTicks++;
      else if (airTicks > 0) landed = true;
      if (airTicks > 0) landingCrash = Math.max(landingCrash, ev.crash);
    }
    expect(airTicks).toBeGreaterThan(20); // ~1.2 s of free fall from 8 m
    expect(landed).toBe(true);
    expect(landingCrash).toBeGreaterThan(8);
    expect(landingCrash).toBeLessThan(14);
    expect(v.pos.y).toBeCloseTo(-8 + rideHeight(VEHICLES[t]), 1);
    expect(v.speed).toBeGreaterThan(15); // keeps driving afterwards
  });

  it('jumps off a stepped box ramp at speed instead of crashing into it', () => {
    const boxes: WorldBox[] = [];
    for (let k = 0; k < 8; k++) {
      boxes.push(box({ x: -3, y: -1, z: -20 - (k + 1) * 1.2 }, { x: 3, y: 0.25 * (k + 1), z: -20 - k * 1.2 }, 'ramp'));
    }
    const w = makeWorld({ boxes });
    for (const t of TYPES) {
      const v = spawn(t, 0, 120);
      const ev = events();
      let maxY = 0, airTicks = 0, impact = 0;
      for (let i = 0; i < 30 * 12; i++) {
        stepVehicle(v, ctl(1), DT, w, [], ev);
        if (v.pos.z > -20) impact = Math.max(impact, ev.crash); // approaching / on the ramp
        if (!v.onGround) airTicks++;
        maxY = Math.max(maxY, v.pos.y);
      }
      expect(impact).toBe(0);
      expect(maxY).toBeGreaterThan(2 + rideHeight(VEHICLES[t]) + 1); // flew above the ramp top
      expect(airTicks).toBeGreaterThan(20);
      expect(v.onGround).toBe(true);
      expect(v.pos.y).toBeCloseTo(rideHeight(VEHICLES[t]), 1);
    }
  });

  it('cannot drive up a tall box (wall-like ledge), drives onto a low one', () => {
    const w = makeWorld({ boxes: [box({ x: -5, y: 0, z: -10 }, { x: 5, y: 1.0, z: -5 }, 'crate')] });
    const v = spawn('buggy', 0, 20);
    const crash = run(v, ctl(1), 30 * 3, w);
    expect(crash).toBeGreaterThan(5);
    expect(v.pos.z).toBeGreaterThan(-5);
    const w2 = makeWorld({ boxes: [box({ x: -5, y: 0, z: -40 }, { x: 5, y: 0.3, z: -5 }, 'floor')] });
    const v2 = spawn('buggy', 0, 20);
    const crash2 = run(v2, ctl(1), 30 * 4, w2);
    expect(crash2).toBe(0);
    expect(v2.pos.z).toBeLessThan(-6);
    expect(v2.pos.y).toBeGreaterThan(0.3 + rideHeight(VEHICLES.buggy) - 0.25);
  });

  it('deep water drowns the engine and stops the vehicle', () => {
    const w = makeWorld({ height: (_x, z) => (z < -10 ? -3 : z < 0 ? z * 0.3 : 0), waterLevel: 0 });
    const v = spawn('buggy', 0, 60);
    const ev = events();
    let inWater = false;
    for (let i = 0; i < 30 * 8; i++) {
      stepVehicle(v, ctl(1), DT, w, [], ev);
      inWater = inWater || ev.inWater;
    }
    expect(inWater).toBe(true);
    expect(ev.inWater).toBe(true);
    expect(Math.abs(v.speed)).toBeLessThan(0.2);
    expect(v.rpm).toBe(0);
    expect(v.pos.z).toBeGreaterThan(-25);
  });
});

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

describe('crashDamage', () => {
  it('is monotonic, zero for small bumps and superlinear', () => {
    for (const t of TYPES) {
      let pv = 0, po = 0;
      for (let s = 0; s <= 60; s += 0.25) {
        const d = crashDamage(s, t);
        expect(d.vehicle).toBeGreaterThanOrEqual(pv);
        expect(d.occupants).toBeGreaterThanOrEqual(po);
        pv = d.vehicle;
        po = d.occupants;
      }
      expect(crashDamage(4, t).vehicle).toBe(0);
      expect(crashDamage(9, t).occupants).toBe(0);
      const d10 = crashDamage(16, t).vehicle - crashDamage(10, t).vehicle;
      const d20 = crashDamage(26, t).vehicle - crashDamage(20, t).vehicle;
      expect(d20).toBeGreaterThan(d10);
    }
    expect(crashDamage(7, 'buggy').vehicle).toBeGreaterThan(0);
    // Bikes are fragile.
    expect(crashDamage(12, 'bike').vehicle / VEHICLES.bike.health)
      .toBeGreaterThan(crashDamage(12, 'buggy').vehicle / VEHICLES.buggy.health);
    expect(crashDamage(5, 'bike').vehicle).toBeGreaterThan(0);
  });

  it('occupants: a 12 m/s bump hurts a little, a 30 m/s wall nearly kills', () => {
    for (const t of TYPES) {
      const bump = crashDamage(12, t).occupants;
      expect(bump).toBeGreaterThan(0);
      expect(bump).toBeLessThan(10);
      const wall = crashDamage(30, t).occupants;
      expect(wall).toBeGreaterThan(70);
    }
    expect(crashDamage(30, 'buggy').occupants).toBeLessThan(100);
    expect(crashDamage(30, 'buggy').vehicle).toBeLessThan(VEHICLES.buggy.health);
    expect(crashDamage(-30, 'buggy')).toEqual(crashDamage(30, 'buggy'));
    expect(crashDamage(Number.NaN, 'uaz')).toEqual({ vehicle: 0, occupants: 0 });
  });
});

// ---------------------------------------------------------------------------
// Geometry queries
// ---------------------------------------------------------------------------

describe('seats and exits', () => {
  it('places seats in the rotated vehicle frame', () => {
    const v = spawn('uaz', 10, 20);
    const d = seatWorldPosition(v, 0);
    expect(d.x).toBeLessThan(10); // driver on the left
    expect(d.z).toBeLessThan(20); // front row ahead of centre
    const rear = seatWorldPosition(v, 3);
    expect(rear.x).toBeGreaterThan(10);
    expect(rear.z).toBeGreaterThan(20);
    expect(d.y).toBeGreaterThan(0); // above the ground
    expect(d.y).toBeLessThan(v.pos.y);
    // Facing +X (yaw = -90 deg): the driver's left side is -Z.
    v.yaw = -Math.PI / 2;
    const d2 = seatWorldPosition(v, 0, { x: 0, y: 0, z: 0 });
    expect(d2.z).toBeLessThan(20);
    expect(d2.x).toBeGreaterThan(10);
    // Out-of-range seats clamp.
    expect(seatWorldPosition(v, 99)).toEqual(seatWorldPosition(v, 3));
    // Bike passenger sits behind the rider.
    const b = spawn('bike', 0, 0);
    expect(seatWorldPosition(b, 1).z).toBeGreaterThan(seatWorldPosition(b, 0).z);
  });

  it('exits beside the seat, avoiding colliders, at ground height', () => {
    const w0 = makeWorld({ height: () => 1.5 });
    const v = spawn('buggy', 0, 0, 0, 1.5);
    const e = exitPosition(v, 0, w0);
    expect(e.x).toBeLessThan(-VEHICLES.buggy.halfExtents.x); // driver gets out on the left
    expect(e.y).toBeCloseTo(1.5, 5);
    expect(capsuleBlocked(w0, e)).toBe(false);
    const p = exitPosition(v, 1, w0);
    expect(p.x).toBeGreaterThan(VEHICLES.buggy.halfExtents.x); // passenger on the right

    // Wall on the driver's side: exit on the other side.
    const wallLeft = box({ x: -2.2, y: 0, z: -10 }, { x: -1.0, y: 4, z: 10 });
    const w1 = makeWorld({ height: () => 1.5, boxes: [wallLeft] });
    const e1 = exitPosition(v, 0, w1);
    expect(e1.x).toBeGreaterThan(0);
    expect(capsuleBlocked(w1, e1)).toBe(false);

    // Both sides blocked (narrow alley): exit behind or in front.
    const wallRight = box({ x: 1.0, y: 0, z: -10 }, { x: 2.2, y: 4, z: 10 });
    const w2 = makeWorld({ height: () => 1.5, boxes: [wallLeft, wallRight] });
    const e2 = exitPosition(v, 0, w2);
    expect(Math.abs(e2.x)).toBeLessThan(1);
    expect(Math.abs(e2.z)).toBeGreaterThan(VEHICLES.buggy.halfExtents.z);
    expect(capsuleBlocked(w2, e2)).toBe(false);

    // Boxed in completely: stand on top of the vehicle.
    const front = box({ x: -2.2, y: 0, z: -3.0 }, { x: 2.2, y: 4, z: -1.9 });
    const back = box({ x: -2.2, y: 0, z: 1.9 }, { x: 2.2, y: 4, z: 3.0 });
    const w3 = makeWorld({ height: () => 1.5, boxes: [wallLeft, wallRight, front, back] });
    const e3 = exitPosition(v, 0, w3);
    expect(e3.y).toBeGreaterThan(v.pos.y + VEHICLES.buggy.halfExtents.y - 0.01);

    // A tree right where the driver would step out: climb out on the other side.
    const w4 = makeWorld({ height: () => 1.5, trees: [tree(-1.6, 0.1, 0.4)] });
    const e4 = exitPosition(v, 0, w4);
    expect(capsuleBlocked(w4, e4)).toBe(false);
    expect(e4.x).toBeGreaterThan(VEHICLES.buggy.halfExtents.x);
  });

  it('exits onto the floor the vehicle stands on, not through a thin wall', () => {
    // Vehicle parked on a raised slab; a thin wall stands just beyond the driver's door, with
    // room behind it: the exit must not be placed on the far side of the wall.
    const slab = box({ x: -20, y: 0, z: -20 }, { x: 20, y: 1, z: 20 }, 'floor');
    const thinWall = box({ x: -1.5, y: 1, z: -10 }, { x: -1.4, y: 4, z: 10 });
    const w = makeWorld({ boxes: [slab, thinWall] });
    const v = spawn('buggy', 0, 0, 0, 1);
    const e = exitPosition(v, 0, w);
    expect(e.y).toBeCloseTo(1, 5);
    expect(e.x).toBeGreaterThan(-1.4);
    expect(capsuleBlocked(w, e)).toBe(false);
  });
});

describe('raycastVehicle / vehicleHitsPoint', () => {
  it('hits the oriented box with correct distances', () => {
    const v = spawn('buggy', 0, 0);
    const he = VEHICLES.buggy.halfExtents;
    const c = v.pos;
    // From the front (-Z side), aiming +Z.
    expect(raycastVehicle(v, { x: 0, y: c.y, z: -10 }, { x: 0, y: 0, z: 1 }, 100)).toBeCloseTo(10 - he.z, 6);
    // From the side.
    expect(raycastVehicle(v, { x: 10, y: c.y, z: 0 }, { x: -1, y: 0, z: 0 }, 100)).toBeCloseTo(10 - he.x, 6);
    // From above.
    expect(raycastVehicle(v, { x: 0, y: c.y + 10, z: 0 }, { x: 0, y: -1, z: 0 }, 100)).toBeCloseTo(10 - he.y, 6);
    // Miss: passes beside the vehicle.
    expect(raycastVehicle(v, { x: he.x + 0.1, y: c.y, z: -10 }, { x: 0, y: 0, z: 1 }, 100)).toBe(-1);
    // Out of range.
    expect(raycastVehicle(v, { x: 0, y: c.y, z: -10 }, { x: 0, y: 0, z: 1 }, 5)).toBe(-1);
    // Inside.
    expect(raycastVehicle(v, { x: c.x, y: c.y, z: c.z }, { x: 0, y: 0, z: 1 }, 5)).toBe(0);

    // Rotated 90 deg: the long axis now lies along X.
    v.yaw = Math.PI / 2;
    expect(raycastVehicle(v, { x: 10, y: c.y, z: 0 }, { x: -1, y: 0, z: 0 }, 100)).toBeCloseTo(10 - he.z, 6);
    expect(raycastVehicle(v, { x: he.x + 0.3, y: c.y, z: -10 }, { x: 0, y: 0, z: 1 }, 100)).toBeCloseTo(10 - he.x, 6);
    expect(raycastVehicle(v, { x: 0, y: c.y, z: -10 }, { x: 0, y: 0, z: 1 }, 100)).toBeCloseTo(10 - he.x, 6);

    // Pitched nose-up 30 deg (yaw 0): a horizontal ray just above the roof at the front now hits
    // the raised nose.
    v.yaw = 0;
    v.pitch = Math.PI / 6;
    const o = { x: 0, y: c.y + he.y + 0.3, z: -10 };
    expect(raycastVehicle(v, o, { x: 0, y: 0, z: 1 }, 100)).toBeGreaterThan(0);
    v.pitch = 0;
    expect(raycastVehicle(v, o, { x: 0, y: 0, z: 1 }, 100)).toBe(-1);
    // Rolled 90 deg: width and height swap.
    v.roll = Math.PI / 2;
    expect(raycastVehicle(v, { x: 10, y: c.y, z: 0 }, { x: -1, y: 0, z: 0 }, 100)).toBeCloseTo(10 - he.y, 6);
  });

  it('detects run-over points within the inflated box', () => {
    const v = spawn('uaz', 0, 0, Math.PI / 2); // facing -X
    const he = VEHICLES.uaz.halfExtents;
    const groundY = 0;
    // Person standing just in front of the bumper (front is -X now).
    expect(vehicleHitsPoint(v, { x: -he.z - 0.2, y: groundY + 0.9, z: 0 }, 0.35)).toBe(true);
    expect(vehicleHitsPoint(v, { x: -he.z - 0.5, y: groundY + 0.9, z: 0 }, 0.35)).toBe(false);
    expect(vehicleHitsPoint(v, { x: 0, y: groundY + 0.9, z: he.x + 0.3 }, 0.35)).toBe(true);
    expect(vehicleHitsPoint(v, { x: 0, y: groundY + 0.9, z: he.x + 0.4 }, 0.35)).toBe(false);
    // High above the roof.
    expect(vehicleHitsPoint(v, { x: 0, y: v.pos.y + he.y + 1, z: 0 }, 0.35)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('identical inputs give bit-identical states', () => {
    const simulate = (): unknown => {
      const w = makeWorld({
        height: (x, z) => 2 * Math.sin(x * 0.03) * Math.cos(z * 0.025),
        boxes: [box({ x: 20, y: -5, z: -40 }, { x: 24, y: 4, z: 40 }), box({ x: -30, y: -5, z: -60 }, { x: 30, y: 1.2, z: -55 }, 'ramp')],
        trees: [tree(-10, -20), tree(5, -35, 0.4), tree(-4, 10)],
        rocks: [{ x: 8, y: 0, z: -10, r: 1, h: 1.2, rot: 0, seed: 3 }],
      });
      const a = createVehicle(1, { pos: { x: 0, y: w.heightAt(0, 20), z: 20 }, yaw: 0.2, type: 'buggy' }, 1);
      const b = createVehicle(2, { pos: { x: 6, y: w.heightAt(6, 0), z: 0 }, yaw: -0.4, type: 'uaz' }, 1);
      const c = createVehicle(3, { pos: { x: -6, y: w.heightAt(-6, 5), z: 5 }, yaw: 2, type: 'bike' }, 1);
      const all = [a, b, c];
      const rng = new Rng(1234);
      const log: number[] = [];
      const ev = events();
      for (let i = 0; i < 30 * 20; i++) {
        for (const v of all) {
          const control = v === c && i % 200 > 150 ? null : ctl(rng.range(-0.5, 1), rng.range(-1, 1), rng.chance(0.1), rng.chance(0.2));
          stepVehicle(v, control, DT, w, all, ev);
          log.push(ev.crash);
        }
      }
      return { all, log };
    };
    const r1 = simulate();
    const r2 = simulate();
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('destroyed vehicles ignore controls and grind to a halt', () => {
    const w = makeWorld();
    const v = spawn('buggy', 0, 300);
    launch(v, 25);
    v.destroyed = true;
    run(v, ctl(1, 1, false, true), 30 * 5, w);
    expect(Math.abs(v.speed)).toBeLessThan(0.01);
    expect(Math.abs(v.yaw)).toBeLessThan(0.05);
    expect(v.rpm).toBe(0);
  });

  it('survives garbage inputs and dt values', () => {
    const w = makeWorld();
    const v = spawn('bike', 0, 0);
    const ev = stepVehicle(v, ctl(Number.NaN, Number.POSITIVE_INFINITY), DT, w, []);
    expect(ev.crash).toBe(0);
    stepVehicle(v, ctl(1), 0, w, []);
    stepVehicle(v, ctl(1), -1, w, []);
    stepVehicle(v, ctl(1), Number.NaN, w, []);
    stepVehicle(v, ctl(5, -9), 3, w, []); // huge dt is clamped
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Number.isFinite(v.pos[k])).toBe(true);
      expect(Number.isFinite(v.vel[k])).toBe(true);
    }
    expect(v.steer).toBeGreaterThanOrEqual(-1);
    expect(v.throttle).toBeLessThanOrEqual(1);
  });
});
