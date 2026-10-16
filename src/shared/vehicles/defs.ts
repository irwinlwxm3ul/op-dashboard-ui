// Vehicle definitions (public contract data) and the internal handling tuning that the physics
// step uses. Everything here is static data; nothing is mutated at runtime.
//
// Frame conventions (shared by physics, rendering and seat placement):
// * `VehicleState.pos` is the CENTRE of the collision box (OBB). At rest on flat ground the box
//   bottom sits `groundClearance` above the ground, i.e. pos.y = ground + rideHeight(def).
// * Local axes: +X right, +Y up, -Z forward (three.js convention, like a camera).
// * Orientation = Ry(yaw) * Rx(pitch) * Rz(roll)  (three.js Euler order 'YXZ'):
//   yaw > 0 turns left, pitch > 0 is nose up, roll > 0 lifts the RIGHT side (banks / leans left).
// * VehicleState.steer > 0 steers RIGHT (front wheels turn right); a car rolling forward with
//   positive steer has a negative yawRate.

import type { Vec3, VehicleType } from '../types';

export interface VehicleDef {
  type: VehicleType;
  seats: number;
  /** Top forward speed without boost (m/s). */
  maxSpeed: number;
  /** Top reverse speed (m/s). */
  reverseSpeed: number;
  /** Engine acceleration at standstill (m/s^2); tapers to 0 at maxSpeed. */
  accel: number;
  /** Service brake deceleration at full input (m/s^2). */
  brake: number;
  /** Front wheel lock angle (rad) at low speed. */
  steerMax: number;
  /** Rate (normalised steer units per second) at which the steering follows the input. */
  steerSpeed: number;
  /** Tyre friction coefficient (lateral grip, in g). */
  grip: number;
  /** kg — used for vehicle-vs-vehicle impulses. */
  mass: number;
  health: number;
  fuelMax: number;
  /** Fuel units per second at full throttle (boost doubles it). Idle consumes nothing. */
  fuelPerSec: number;
  /** Collision OBB half sizes (x width, y height, z length) around VehicleState.pos. */
  halfExtents: Vec3;
  /** Distance between front and rear axle (m). */
  wheelBase: number;
  /** Gap between the OBB bottom and the ground at rest (m). */
  groundClearance: number;
  /**
   * Seated occupant body origin per seat in local space (-Z forward), i.e. the point that plays the
   * role of CharacterBody.pos (feet level of a seated person). Hips are SEAT_HIP_HEIGHT above it,
   * the eyes SEATED_EYE_HEIGHT (physics tuning) above it.
   */
  seatOffsets: Vec3[];
  /** Whether the occupant of a seat may use weapons. The driver never can. */
  seatCanShoot: boolean[];
  isBike: boolean;
}

/** Height of a seated occupant's hips above the seat origin returned by seatWorldPosition. */
export const SEAT_HIP_HEIGHT = 0.4;

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const VEHICLES: Record<VehicleType, VehicleDef> = {
  // Open-frame dune buggy: light, quick, very grippy, long travel suspension.
  buggy: {
    type: 'buggy',
    seats: 2,
    maxSpeed: 33,
    reverseSpeed: 10,
    accel: 10,
    brake: 15,
    steerMax: 0.6,
    steerSpeed: 4.2,
    grip: 1.9,
    mass: 1100,
    health: 1000,
    fuelMax: 100,
    fuelPerSec: 0.28, // ~6.0 min of full throttle on a full tank
    halfExtents: v(0.95, 0.6, 1.8),
    wheelBase: 2.5,
    groundClearance: 0.35,
    seatOffsets: [v(-0.4, -0.65, 0.1), v(0.4, -0.65, 0.1)],
    seatCanShoot: [false, true],
    isBike: false,
  },
  // UAZ jeep: heavy, sturdy, softer suspension, 4 seats.
  uaz: {
    type: 'uaz',
    seats: 4,
    maxSpeed: 29,
    reverseSpeed: 8,
    accel: 7.5,
    brake: 13,
    steerMax: 0.54,
    steerSpeed: 3.4,
    grip: 1.5,
    mass: 1600,
    health: 1600,
    fuelMax: 100,
    fuelPerSec: 0.25, // ~6.7 min of full throttle
    halfExtents: v(0.98, 0.8, 2.0),
    wheelBase: 2.4,
    groundClearance: 0.4,
    seatOffsets: [v(-0.45, -0.65, -0.15), v(0.45, -0.65, -0.15), v(-0.45, -0.6, 0.85), v(0.45, -0.6, 0.85)],
    seatCanShoot: [false, true, true, true],
    isBike: false,
  },
  // Motorbike: fastest, nimble, fragile, leans into turns.
  bike: {
    type: 'bike',
    seats: 2,
    maxSpeed: 38,
    reverseSpeed: 5,
    accel: 11,
    brake: 14,
    steerMax: 0.5,
    steerSpeed: 4.6,
    grip: 1.7,
    mass: 260,
    health: 600,
    fuelMax: 100,
    fuelPerSec: 0.3, // ~5.6 min of full throttle
    halfExtents: v(0.38, 0.45, 1.05),
    wheelBase: 1.45,
    groundClearance: 0.3,
    seatOffsets: [v(0, -0.3, 0.0), v(0, -0.24, 0.48)],
    seatCanShoot: [false, true],
    isBike: true,
  },
};

/** Height of VehicleState.pos above flat ground when the vehicle rests on its suspension. */
export function rideHeight(def: VehicleDef): number {
  return def.groundClearance + def.halfExtents.y;
}

// ---------------------------------------------------------------------------
// Handling tuning (internal to the physics step but exported for renderers that want wheel
// placement consistent with the simulation).
// ---------------------------------------------------------------------------

export interface VehicleHandling {
  /** Lateral distance between left and right wheels (0 for the bike). */
  trackWidth: number;
  /** Visual wheel radius (m). */
  wheelRadius: number;
  /** Suspension extension below the rest position before a wheel leaves the ground (m). */
  droop: number;
  /** Suspension compression above rest before the bump stop (m). */
  bump: number;
  /** Suspension damping ratio. */
  damping: number;
  /** Highest ledge / box top the wheels roll onto instead of colliding with it (m). */
  stepUp: number;
  /** Rolling resistance (m/s^2, always on while grounded). */
  rollRes: number;
  /** Aerodynamic drag coefficient (1/m): decel = drag * v^2. */
  drag: number;
  /** Engine braking when coasting with the engine running (m/s^2). */
  engineBrake: number;
  /** Rate (1/s) at which lateral velocity is removed by the tyres (capped by grip * g). */
  lateralRate: number;
  /** Rate (1/s) at which the yaw rate follows the steering target while gripping. */
  yawRate: number;
  /** Fraction of grip left while the handbrake locks the rear wheels. */
  handbrakeGrip: number;
  /** Yaw target multiplier with the handbrake (rear steps out). */
  handbrakeYaw: number;
  /** Longitudinal deceleration from the locked rear wheels (m/s^2). */
  handbrakeDecel: number;
  /** Nose pitch per m/s^2 of longitudinal acceleration (weight transfer, rad). */
  pitchPerAccel: number;
  /** Body roll per m/s^2 of lateral acceleration (outward, rad). Bikes lean instead. */
  rollPerAccel: number;
  /** Bike: maximum lean angle (rad). */
  maxLean: number;
  /** Number of collision circles along the length. */
  circles: number;
}

export const HANDLING: Record<VehicleType, VehicleHandling> = {
  buggy: {
    trackWidth: 1.62,
    wheelRadius: 0.42,
    droop: 0.28,
    bump: 0.2,
    damping: 0.55,
    stepUp: 0.45,
    rollRes: 0.3,
    drag: 0.0021,
    engineBrake: 1.6,
    lateralRate: 11,
    yawRate: 10,
    handbrakeGrip: 0.3,
    handbrakeYaw: 1.6,
    handbrakeDecel: 5,
    pitchPerAccel: 0.005,
    rollPerAccel: 0.005,
    maxLean: 0,
    circles: 3,
  },
  uaz: {
    trackWidth: 1.5,
    wheelRadius: 0.4,
    droop: 0.25,
    bump: 0.18,
    damping: 0.5,
    stepUp: 0.45,
    rollRes: 0.4,
    drag: 0.003,
    engineBrake: 1.8,
    lateralRate: 9,
    yawRate: 8,
    handbrakeGrip: 0.38,
    handbrakeYaw: 1.5,
    handbrakeDecel: 5,
    pitchPerAccel: 0.008,
    rollPerAccel: 0.008,
    maxLean: 0,
    circles: 3,
  },
  bike: {
    trackWidth: 0,
    wheelRadius: 0.33,
    droop: 0.2,
    bump: 0.15,
    damping: 0.6,
    stepUp: 0.35,
    rollRes: 0.25,
    drag: 0.0016,
    engineBrake: 1.4,
    lateralRate: 12,
    yawRate: 12,
    handbrakeGrip: 0.42,
    handbrakeYaw: 1.45,
    handbrakeDecel: 4.5,
    pitchPerAccel: 0.004,
    rollPerAccel: 0,
    maxLean: 0.6,
    circles: 2,
  },
};

/**
 * Local-space wheel contact attachment points (bottom of the chassis box, where each suspension
 * strut meets the body). Order: front-left, front-right, rear-left, rear-right (cars) or
 * front, rear (bike). A wheel's centre sits `groundClearance - wheelRadius` below its attachment
 * at rest.
 */
export const WHEELS: Record<VehicleType, Vec3[]> = {
  buggy: carWheels('buggy'),
  uaz: carWheels('uaz'),
  bike: [
    v(0, -VEHICLES.bike.halfExtents.y, -VEHICLES.bike.wheelBase / 2),
    v(0, -VEHICLES.bike.halfExtents.y, VEHICLES.bike.wheelBase / 2),
  ],
};

function carWheels(t: VehicleType): Vec3[] {
  const d = VEHICLES[t], hw = HANDLING[t].trackWidth / 2, hb = d.wheelBase / 2, y = -d.halfExtents.y;
  return [v(-hw, y, -hb), v(hw, y, -hb), v(-hw, y, hb), v(hw, y, hb)];
}

/** Collision circle centres (local z, -Z forward) and radius used against world and vehicles. */
export interface CircleSet {
  z: number[];
  r: number;
}

export const CIRCLES: Record<VehicleType, CircleSet> = {
  buggy: circleSet('buggy'),
  uaz: circleSet('uaz'),
  bike: circleSet('bike'),
};

function circleSet(t: VehicleType): CircleSet {
  const d = VEHICLES[t], n = HANDLING[t].circles;
  const r = d.halfExtents.x;
  const span = Math.max(0, d.halfExtents.z - r);
  const z: number[] = [];
  for (let i = 0; i < n; i++) z.push(n === 1 ? 0 : -span + (2 * span * i) / (n - 1));
  return { z, r };
}
