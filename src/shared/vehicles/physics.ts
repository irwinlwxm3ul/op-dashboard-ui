// Arcade vehicle dynamics: engine / brakes / tyres on a heading-based model (bicycle steering,
// grip-limited cornering, handbrake drift), spring-damper suspension over terrain and box tops,
// ballistic airtime, and collisions against world colliders and other vehicles.
//
// The step is deterministic (pure function of state, controls, dt and world) and allocation free
// in the hot path: the server runs it authoritatively and the client re-runs it for driver
// prediction. All scratch storage is module level (single threaded, no re-entrancy).

import { GRAVITY } from '../constants';
import { clamp, wrapAngle } from '../math';
import type { EntityId, RockDef, TreeDef, Vec3, VehicleSpawn, VehicleState, World, WorldBox } from '../types';
import { CIRCLES, HANDLING, VEHICLES, WHEELS, rideHeight } from './defs';
import type { VehicleDef, VehicleHandling } from './defs';
import { basisFromAngles, makeBasis } from './geometry';

export interface VehicleControls {
  /** -1..1: forward throttle (+) / brake-then-reverse (-). */
  throttle: number;
  /** -1..1: steer right (+) / left (-). */
  steer: number;
  handbrake: boolean;
  boost: boolean;
}

export interface VehicleStepEvents {
  /** Largest impact this step (m/s closing speed along the contact normal), 0 if none. */
  crash: number;
  /** World position of that impact. */
  crashPos: Vec3 | null;
  /** Vehicle centre is in water deeper than 1 m (engine drowned). */
  inWater: boolean;
  /** Other vehicle hit this step (-1 if none). Its own step will not see the contact again. */
  hitVehicle?: EntityId;
  /** Impact (m/s) suffered by `hitVehicle` in that collision. */
  hitVehicleImpact?: number;
}

// ---------------------------------------------------------------------------
// Tuning shared by every vehicle type
// ---------------------------------------------------------------------------

/** Longest physics sub-step (s). */
const MAX_SUB_DT = 1 / 120;
/** Longest distance travelled per sub-step (m): well under the thinnest collision radius. */
const SUB_MOVE = 0.2;
const MAX_SUBSTEPS = 24;
/** Clamp for absurd dt (e.g. a stalled tab). */
const MAX_DT = 0.25;
/** Boost raises top speed and acceleration by this factor (and doubles fuel use). */
export const BOOST_MUL = 1.15;
/** Normalised throttle change per second (keyboard input is smoothed slightly). */
const THROTTLE_RATE = 9;
/** Steering returns to centre / reverses this much faster than it winds in. */
const STEER_RETURN_MUL = 1.6;
/** Fraction of the steering angle (and rate) left at top speed. */
const HIGH_SPEED_STEER = 0.5;
const HIGH_SPEED_STEER_RATE = 0.7;
/** Portion of the tyre grip used for steady cornering (the rest is margin so it never slides). */
const CORNER_GRIP_USE = 0.9;
/** Lateral slip (m/s) where the tyres start to lose grip, range to the full loss, and the loss. */
const SLIDE_START = 2.5;
const SLIDE_RANGE = 6;
const SLIDE_GRIP_LOSS = 0.3;
/** Longitudinal traction (fraction of grip * g) available for the engine. */
const DRIVE_TRACTION = 0.6;
/** Below this forward speed the vehicle can come to a full stop / hold on slopes (m/s). */
const HOLD_SPEED = 0.35;
/** Parked vehicles hold on slopes whose gravity pull is below this fraction of grip * g. */
const HOLD_GRIP = 0.6;
/** Speed thresholds that separate braking from driving the other way (m/s). */
const DIRECTION_SWITCH_SPEED = 0.5;
/** Engine force fraction available in reverse. */
const REVERSE_ACCEL_MUL = 0.7;
/** Friction of a wreck / of a vehicle without a driver (in gear, engine off) (m/s^2). */
const WRECK_FRICTION = 7;
const NO_DRIVER_BRAKE = 2.5;
/** Yaw rate damping while airborne (1/s). */
const AIR_YAW_DAMP = 0.4;
/** Orientation smoothing rates (1/s) on the ground / in the air. */
const ORIENT_RATE = 10;
const AIR_PITCH_RATE = 1.2;
const AIR_ROLL_RATE = 1.0;
/** Fraction of the flight path angle the nose follows in the air. */
const AIR_PITCH_FOLLOW = 0.35;
/** Visual bike lean as a fraction of the physically balanced lean angle. */
const BIKE_LEAN_MUL = 0.85;
/** Weight transfer limits (rad). */
const MAX_WEIGHT_PITCH = 0.09;
const MAX_WEIGHT_ROLL = 0.1;
/** Wheel contact tolerance (m). */
const CONTACT_EPS = 0.02;
/** Vertical landing speed above which a touchdown counts as a crash (m/s). */
const LANDING_CRASH_SPEED = 8;
/** Impacts below this are resting / scraping contacts and are not reported (m/s). */
const MIN_REPORTED_IMPACT = 1;
/** Coefficient of restitution for walls, trees, rocks and vehicles. */
const RESTITUTION = 0.2;
/** Tangential friction along walls as a fraction of the normal impulse. */
const WALL_FRICTION = 0.25;
/** Rotational inertia multiplier (>1 = less spin from off-centre hits; keeps it controllable). */
const INERTIA_SCALE = 1.6;
/** Collision passes per sub-step. */
const COLLISION_ITERS = 3;
/** Water: centre depth that drowns the engine, damping rate, fording drag. */
const WATER_STOP_DEPTH = 1.0;
const WATER_DAMP = 2.5;
const FORD_START_DEPTH = 0.25;
const FORD_DRAG = 4;
/** Lean / pitch / slope angles are clamped to this (rad). */
const MAX_GROUND_ANGLE = 1.1;
/** Vehicles are kept this far inside the map edge (m). */
const BOUNDS_MARGIN = 2;
/** If the body ends up this far under its ride height (teleport / spawn mismatch) it is snapped up. */
const DEEP_PENETRATION = 1.5;
/** Engine sound model. */
export const IDLE_RPM = 900;
export const MAX_RPM = 6500;
const REDLINE_RPM = 6300;
const SHIFT_RPM = 3400;
const REVERSE_TOP_RPM = 5200;
const RPM_RATE = 10;
const RPM_OFF_RATE = 3;
/** Upshift points as a fraction of maxSpeed (6 gears; the last covers boost overspeed). */
const GEARS = [0, 0.16, 0.32, 0.5, 0.72, 1.0, 1.25];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** New vehicle resting on its suspension at the spawn (spawn.pos is on the ground). */
export function createVehicle(id: EntityId, spawn: VehicleSpawn, fuelFraction = 0.6): VehicleState {
  const def = VEHICLES[spawn.type];
  const f = Number.isFinite(fuelFraction) ? clamp(fuelFraction, 0, 1) : 0.6;
  const seats: (EntityId | null)[] = [];
  for (let i = 0; i < def.seats; i++) seats.push(null);
  return {
    id,
    type: spawn.type,
    pos: { x: spawn.pos.x, y: spawn.pos.y + rideHeight(def), z: spawn.pos.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: wrapAngle(spawn.yaw),
    pitch: 0,
    roll: 0,
    yawRate: 0,
    speed: 0,
    steer: 0,
    throttle: 0,
    rpm: 0,
    health: def.health,
    fuel: def.fuelMax * f,
    seats,
    onGround: true,
    destroyed: false,
    burnTimer: 0,
    lastDriver: null,
  };
}

// ---------------------------------------------------------------------------
// Module scratch
// ---------------------------------------------------------------------------

const boxBuf: WorldBox[] = [];
const treeBuf: TreeDef[] = [];
const rockBuf: RockDef[] = [];
let boxes: WorldBox[] = boxBuf;
let trees: TreeDef[] = treeBuf;
let rocks: RockDef[] = rockBuf;

const B = makeBasis();
const wheelG = [0, 0, 0, 0];

/** Per-call accumulators (reset at the start of stepVehicle). */
let crashMax = 0;
let crashX = 0, crashY = 0, crashZ = 0;
let hitOther: EntityId = -1;
let hitOtherImpact = 0;
let waterFlag = false;
let groundedPrev = true;
let engineRunning = false;

/** Per-sub-step ground fit (written by sampleGround). */
const ground = { y: 0, pitch: 0, roll: 0, contacts: 0, count: 1 };

function noteCrash(impact: number, x: number, y: number, z: number): void {
  if (impact > crashMax) {
    crashMax = impact;
    crashX = x; crashY = y; crashZ = z;
  }
}

// ---------------------------------------------------------------------------
// Public step
// ---------------------------------------------------------------------------

/**
 * Advance one vehicle by `dt` seconds (internally sub-stepped). `ctl` is the driver's controls or
 * null when nobody drives (engine off). `others` may contain `v` itself (skipped); colliding
 * vehicles receive their share of the impulse and are pushed apart. Returns `out` (or a new
 * object) with the largest crash impact of this step.
 */
export function stepVehicle(
  v: VehicleState,
  ctl: VehicleControls | null,
  dt: number,
  world: World,
  others: VehicleState[],
  out?: VehicleStepEvents,
): VehicleStepEvents {
  const ev: VehicleStepEvents = out ?? { crash: 0, crashPos: null, inWater: false };
  ev.crash = 0;
  ev.crashPos = null;
  ev.inWater = false;
  ev.hitVehicle = -1;
  ev.hitVehicleImpact = 0;
  if (!(dt > 0)) return ev;
  if (dt > MAX_DT) dt = MAX_DT;

  const def = VEHICLES[v.type];
  const hd = HANDLING[v.type];
  sanitize(v);

  const driven = ctl !== null && !v.destroyed;
  const thrIn = driven ? finiteClamp(ctl.throttle, -1, 1) : 0;
  const steerIn = driven ? finiteClamp(ctl.steer, -1, 1) : 0;
  const handbrake = driven && ctl.handbrake === true;
  const boost = driven && ctl.boost === true;

  crashMax = 0;
  hitOther = -1;
  hitOtherImpact = 0;
  waterFlag = false;
  groundedPrev = v.onGround;
  engineRunning = false;

  const vx = v.vel.x, vy = v.vel.y, vz = v.vel.z;
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  let n = Math.ceil(dt / MAX_SUB_DT - 1e-9);
  const nMove = Math.ceil((speed * dt) / SUB_MOVE);
  if (nMove > n) n = nMove;
  if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
  if (n < 1) n = 1;
  const h = dt / n;

  gatherColliders(world, v, def, speed * dt + 2);

  for (let i = 0; i < n; i++) {
    substep(v, def, hd, driven, thrIn, steerIn, handbrake, boost, h, world, others);
  }

  v.yaw = wrapAngle(v.yaw);
  v.speed = -Math.sin(v.yaw) * v.vel.x - Math.cos(v.yaw) * v.vel.z;
  updateRpm(v, def, dt);

  if (crashMax >= MIN_REPORTED_IMPACT) {
    ev.crash = crashMax;
    ev.crashPos = { x: crashX, y: crashY, z: crashZ };
  }
  ev.inWater = waterFlag;
  ev.hitVehicle = hitOther;
  ev.hitVehicleImpact = hitOtherImpact;
  return ev;
}

function finiteClamp(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? clamp(x, lo, hi) : 0;
}

/** Repair non-finite state (defensive: one bad value must never poison the simulation). */
function sanitize(v: VehicleState): void {
  if (!Number.isFinite(v.vel.x) || !Number.isFinite(v.vel.y) || !Number.isFinite(v.vel.z)) {
    v.vel.x = 0; v.vel.y = 0; v.vel.z = 0;
  }
  if (!Number.isFinite(v.yaw)) v.yaw = 0;
  if (!Number.isFinite(v.pitch)) v.pitch = 0;
  if (!Number.isFinite(v.roll)) v.roll = 0;
  if (!Number.isFinite(v.yawRate)) v.yawRate = 0;
  if (!Number.isFinite(v.steer)) v.steer = 0;
  if (!Number.isFinite(v.throttle)) v.throttle = 0;
  if (!Number.isFinite(v.rpm)) v.rpm = 0;
  if (!Number.isFinite(v.fuel)) v.fuel = 0;
}

function gatherColliders(world: World, v: VehicleState, def: VehicleDef, reach: number): void {
  const m = def.halfExtents.z + def.halfExtents.x + reach;
  boxBuf.length = 0;
  treeBuf.length = 0;
  rockBuf.length = 0;
  const x = v.pos.x, z = v.pos.z;
  boxes = world.queryBoxes(x - m, z - m, x + m, z + m, boxBuf);
  trees = world.queryTrees(x - m, z - m, x + m, z + m, treeBuf);
  rocks = world.queryRocks(x - m, z - m, x + m, z + m, rockBuf);
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/**
 * Highest drivable surface under (x, z) at or below refY: terrain, box tops (roads on bridges,
 * floors, ramps, low steps) and rock domes.
 */
function groundHeight(world: World, x: number, z: number, refY: number): number {
  let g = world.heightAt(x, z);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const top = b.max.y;
    if (top > g && top <= refY && x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) g = top;
  }
  for (let i = 0; i < rocks.length; i++) {
    const k = rocks[i];
    if (k.y + k.h <= g) continue;
    const dx = x - k.x, dz = z - k.z, r2 = k.r * k.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r2) continue;
    // Dome profile so wheels roll over small rocks instead of popping up a step.
    const top = k.y + k.h * Math.sqrt(1 - d2 / r2);
    if (top > g && top <= refY) g = top;
  }
  return g;
}

/** Sample the ground under every wheel and fit the ground plane (height, pitch, roll). */
function sampleGround(v: VehicleState, def: VehicleDef, hd: VehicleHandling, world: World): void {
  const wheels = WHEELS[v.type];
  basisFromAngles(v.yaw, v.pitch, v.roll, B);
  const cl = def.groundClearance;
  let sum = 0, contacts = 0;
  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i];
    const ax = v.pos.x + B.right.x * w.x + B.up.x * w.y + B.back.x * w.z;
    const ay = v.pos.y + B.right.y * w.x + B.up.y * w.y + B.back.y * w.z;
    const az = v.pos.z + B.right.z * w.x + B.up.z * w.y + B.back.z * w.z;
    const bottom = ay - cl;
    const g = groundHeight(world, ax, az, bottom + hd.stepUp);
    wheelG[i] = g;
    sum += g;
    if (bottom - hd.droop <= g + CONTACT_EPS) contacts++;
  }
  const cnt = wheels.length;
  let pitch: number, roll: number;
  if (cnt === 2) {
    pitch = Math.atan2(wheelG[0] - wheelG[1], def.wheelBase);
    roll = 0;
  } else {
    const front = (wheelG[0] + wheelG[1]) * 0.5, rear = (wheelG[2] + wheelG[3]) * 0.5;
    const left = (wheelG[0] + wheelG[2]) * 0.5, right = (wheelG[1] + wheelG[3]) * 0.5;
    pitch = Math.atan2(front - rear, def.wheelBase);
    roll = Math.atan2(right - left, hd.trackWidth);
  }
  ground.pitch = clamp(pitch, -MAX_GROUND_ANGLE, MAX_GROUND_ANGLE);
  ground.roll = clamp(roll, -MAX_GROUND_ANGLE, MAX_GROUND_ANGLE);
  ground.y = sum / cnt;
  ground.contacts = contacts;
  ground.count = cnt;
}

// ---------------------------------------------------------------------------
// Sub-step
// ---------------------------------------------------------------------------

function substep(
  v: VehicleState, def: VehicleDef, hd: VehicleHandling,
  driven: boolean, thrIn: number, steerIn: number, handbrake: boolean, boost: boolean,
  h: number, world: World, others: VehicleState[],
): void {
  const G = GRAVITY;
  const vel = v.vel, pos = v.pos;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  const fx = -sy, fz = -cy; // forward
  const rx = cy, rz = -sy; // right

  sampleGround(v, def, hd, world);
  const grounded = ground.contacts > 0;
  const traction = ground.contacts / ground.count;
  const gp = ground.pitch, gr = ground.roll;

  // ---- Water ----
  const depth = world.waterLevel - ground.y;
  const drowned = depth > WATER_STOP_DEPTH;
  if (drowned) waterFlag = true;

  // ---- Controls (smoothed) ----
  let vf = vel.x * fx + vel.z * fz;
  let vl = vel.x * rx + vel.z * rz;
  const absVf = Math.abs(vf);
  const speedFrac = absVf / def.maxSpeed > 1 ? 1 : absVf / def.maxSpeed;
  const steerRate = def.steerSpeed * (1 - (1 - HIGH_SPEED_STEER_RATE) * speedFrac)
    * (steerIn === 0 || steerIn * v.steer < 0 ? STEER_RETURN_MUL : 1);
  v.steer = approach(v.steer, steerIn, steerRate * h);
  v.throttle = approach(v.throttle, thrIn, THROTTLE_RATE * h);
  const thr = v.throttle;

  const engineOn = driven && v.fuel > 0 && !drowned;
  if (engineOn) engineRunning = true;

  // ---- Touchdown ----
  const gvy = clamp(vf * Math.tan(gp) + vl * Math.tan(gr), -40, 40); // ground vertical velocity
  if (grounded && !groundedPrev) {
    const closing = gvy - vel.y;
    if (closing > LANDING_CRASH_SPEED) noteCrash(closing, pos.x, pos.y - rideHeight(def), pos.z);
  }
  groundedPrev = grounded;
  v.onGround = grounded;

  let aTire = 0;
  if (grounded) {
    // ---- Longitudinal ----
    const boosting = boost && engineOn && thr > 0 && vf >= -DIRECTION_SWITCH_SPEED;
    const mul = boosting ? BOOST_MUL : 1;
    const vmax = def.maxSpeed * mul;
    let drive = 0; // signed engine acceleration
    let decel = 0; // magnitude, always toward zero speed
    let fuelUse = 0;
    if (thr > 0.01) {
      if (vf < -DIRECTION_SWITCH_SPEED) decel += def.brake * thr;
      else if (engineOn) {
        // Power curve tapering to zero at top speed, plus enough extra force to cancel rolling
        // resistance and drag, so full throttle settles exactly at vmax (never above it).
        const u = vf / vmax;
        let a = def.accel * mul * thr * (1 - u * u);
        if (a < -def.accel) a = -def.accel;
        const vc = vf < 0 ? 0 : vf < vmax ? vf : vmax;
        drive = a + thr * (hd.rollRes + hd.drag * vc * vc);
        fuelUse = thr * (boosting ? 2 : 1);
      }
    } else if (thr < -0.01) {
      const t = -thr;
      if (vf > DIRECTION_SWITCH_SPEED) decel += def.brake * t;
      else if (engineOn) {
        const u = -vf / def.reverseSpeed;
        let a = def.accel * REVERSE_ACCEL_MUL * t * (1 - u * u);
        if (a < -def.accel) a = -def.accel;
        const vc = vf > 0 ? 0 : -vf < def.reverseSpeed ? -vf : def.reverseSpeed;
        drive = -(a + t * (hd.rollRes + hd.drag * vc * vc));
        fuelUse = t;
      }
    } else if (engineOn) {
      decel += hd.engineBrake;
    }
    if (handbrake) {
      drive *= 0.5;
      decel += hd.handbrakeDecel;
    }
    if (!driven) decel += v.destroyed ? WRECK_FRICTION : NO_DRIVER_BRAKE;
    decel += hd.rollRes;
    if (depth > FORD_START_DEPTH) decel += FORD_DRAG * Math.min(1, (depth - FORD_START_DEPTH) / (WATER_STOP_DEPTH - FORD_START_DEPTH));

    // Engine force is limited by longitudinal traction (steep climbs, wheels in the air).
    const maxDrive = def.grip * DRIVE_TRACTION * G * Math.cos(gp);
    if (drive > maxDrive) drive = maxDrive;
    else if (drive < -maxDrive) drive = -maxDrive;

    if (fuelUse > 0) {
      v.fuel -= def.fuelPerSec * fuelUse * h;
      if (v.fuel < 0) v.fuel = 0;
    }

    const vf0 = vf;
    vf += drive * traction * h;
    const dv = decel * traction * h + hd.drag * vf * vf * h;
    if (vf > dv) vf -= dv;
    else if (vf < -dv) vf += dv;
    else vf = 0;
    aTire = (vf - vf0) / h;

    // Gravity along the slope; parked / idle vehicles hold on moderate slopes.
    const slopeLong = -G * Math.sin(gp);
    const idle = Math.abs(thr) < 0.05 || !driven || handbrake;
    if (idle && Math.abs(vf) < HOLD_SPEED && Math.abs(slopeLong) < def.grip * G * HOLD_GRIP) vf = 0;
    else vf += slopeLong * h;

    // ---- Lateral (tyres) ----
    vl += -G * Math.sin(gr) * h;
    // Sliding tyres grip less than rolling ones (kinetic < static friction): once the tail is
    // out it stays out for a moment, which makes drifts controllable instead of snapping back.
    const absVl = Math.abs(vl);
    const slide = absVl > SLIDE_START ? Math.min(1, (absVl - SLIDE_START) / SLIDE_RANGE) : 0;
    const gripMul = (handbrake ? hd.handbrakeGrip : 1) * (1 - SLIDE_GRIP_LOSS * slide);
    const latLimit = def.grip * G * traction * gripMul * Math.cos(gr);
    let remove = vl * (1 - Math.exp(-hd.lateralRate * traction * h));
    const maxRemove = latLimit * h;
    if (remove > maxRemove) remove = maxRemove;
    else if (remove < -maxRemove) remove = -maxRemove;
    vl -= remove;

    // ---- Yaw (bicycle model, grip limited) ----
    const absF = Math.abs(vf);
    const steerAngle = def.steerMax * (1 - (1 - HIGH_SPEED_STEER) * speedFrac);
    const bicycle = (absF / def.wheelBase) * Math.tan(steerAngle);
    const gripYaw = absF > 0.5 ? (def.grip * G * CORNER_GRIP_USE) / absF : Infinity;
    let yawMax = bicycle < gripYaw ? bicycle : gripYaw;
    let track = hd.yawRate;
    if (handbrake && absF > 2) {
      // Locked rear wheels let the tail step out: more rotation than grip would allow, and the
      // body keeps its rotational momentum (slower tracking).
      const hbYaw = gripYaw * hd.handbrakeYaw;
      yawMax = bicycle < hbYaw ? bicycle : hbYaw;
      track *= 0.4;
    }
    const target = -v.steer * yawMax * (vf >= 0 ? 1 : -1);
    v.yawRate += (target - v.yawRate) * (1 - Math.exp(-track * traction * h));

    vel.x = fx * vf + rx * vl;
    vel.z = fz * vf + rz * vl;
  } else {
    v.yawRate *= Math.exp(-AIR_YAW_DAMP * h);
    // Light air drag.
    const hs2 = vel.x * vel.x + vel.z * vel.z;
    const k = 1 - hd.drag * Math.sqrt(hs2) * h;
    vel.x *= k;
    vel.z *= k;
  }

  if (drowned) {
    const f = Math.exp(-WATER_DAMP * h);
    vel.x *= f;
    vel.z *= f;
    vel.y *= f;
    v.yawRate *= f;
  }

  // ---- Suspension / gravity ----
  const tilt = Math.cos(gp) * Math.cos(gr);
  const targetY = ground.y + rideHeight(def) / (tilt > 0.5 ? tilt : 0.5);
  const K = G / hd.droop;
  const C = 2 * hd.damping * Math.sqrt(K);
  const ext = pos.y - targetY;
  let ay = -G;
  if (ext < hd.droop) {
    let f = K * (hd.droop - ext) - C * (vel.y - gvy);
    if (f < 0) f = 0;
    ay += f;
  }
  vel.y += ay * h;

  // ---- Integrate ----
  pos.x += vel.x * h;
  pos.y += vel.y * h;
  pos.z += vel.z * h;
  v.yaw += v.yawRate * h;

  // Bump stop: the suspension bottoms out; never sink into the ground.
  const minY = targetY - hd.bump;
  if (pos.y < minY) {
    pos.y = pos.y < targetY - DEEP_PENETRATION ? targetY : minY;
    if (vel.y < gvy) vel.y = gvy;
  }

  // ---- Orientation (visual weight transfer + ground following) ----
  if (grounded) {
    const k = 1 - Math.exp(-ORIENT_RATE * h);
    const aLat = vf * v.yawRate;
    const tp = gp + clamp(hd.pitchPerAccel * aTire, -MAX_WEIGHT_PITCH, MAX_WEIGHT_PITCH);
    let tr: number;
    if (def.isBike) tr = clamp(BIKE_LEAN_MUL * Math.atan(aLat / G), -hd.maxLean, hd.maxLean);
    else tr = gr - clamp(hd.rollPerAccel * aLat, -MAX_WEIGHT_ROLL, MAX_WEIGHT_ROLL);
    v.pitch += (tp - v.pitch) * k;
    v.roll += (tr - v.roll) * k;
  } else {
    const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const tp = clamp(AIR_PITCH_FOLLOW * Math.atan2(vel.y, hs > 1 ? hs : 1), -0.45, 0.35);
    v.pitch += (tp - v.pitch) * (1 - Math.exp(-AIR_PITCH_RATE * h));
    v.roll += (0 - v.roll) * (1 - Math.exp(-AIR_ROLL_RATE * h));
  }

  // ---- Collisions ----
  collideWorld(v, def, hd);
  if (others.length > 0) collideVehicles(v, def, others);
  clampBounds(v, world);
}

function approach(x: number, target: number, maxDelta: number): number {
  if (x < target) return x + maxDelta < target ? x + maxDelta : target;
  if (x > target) return x - maxDelta > target ? x - maxDelta : target;
  return x;
}

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

/** Push-out normal and depth written by the penetration helpers. */
let pnx = 0, pnz = 0;

function penetrateBox(b: WorldBox, x: number, z: number, r: number): number {
  const cx = x < b.min.x ? b.min.x : x > b.max.x ? b.max.x : x;
  const cz = z < b.min.z ? b.min.z : z > b.max.z ? b.max.z : z;
  const dx = x - cx, dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return 0;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    pnx = dx / d;
    pnz = dz / d;
    return r - d;
  }
  // Centre inside the rectangle: leave through the nearest face (fixed tie-break order).
  let m = x - b.min.x;
  pnx = -1; pnz = 0;
  const toMaxX = b.max.x - x, toMinZ = z - b.min.z, toMaxZ = b.max.z - z;
  if (toMaxX < m) { m = toMaxX; pnx = 1; pnz = 0; }
  if (toMinZ < m) { m = toMinZ; pnx = 0; pnz = -1; }
  if (toMaxZ < m) { m = toMaxZ; pnx = 0; pnz = 1; }
  return m + r;
}

function penetrateCylinder(cx: number, cz: number, cr: number, x: number, z: number, r: number): number {
  const dx = x - cx, dz = z - cz;
  const R = cr + r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= R * R) return 0;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    pnx = dx / d;
    pnz = dz / d;
    return R - d;
  }
  pnx = 1;
  pnz = 0;
  return R;
}

/** Rotational inertia per unit mass about the vertical axis (box), scaled for controllability. */
function yawInertia(def: VehicleDef): number {
  const L = def.halfExtents.z * 2, W = def.halfExtents.x * 2;
  return ((L * L + W * W) / 12) * INERTIA_SCALE;
}

/** Tree trunks collide up to this fraction of the tree height (matches the physics module). */
const TREE_TRUNK_FRAC = 0.6;

/**
 * Resolve the vehicle's circle set against static colliders: push out, then apply an impulse at
 * the contact point (restitution, wall friction, spin from off-centre hits).
 */
function collideWorld(v: VehicleState, def: VehicleDef, hd: VehicleHandling): void {
  const cs = CIRCLES[v.type];
  const r = cs.r;
  const I = yawInertia(def);
  const he = def.halfExtents;
  const cl = def.groundClearance;
  for (let iter = 0; iter < COLLISION_ITERS; iter++) {
    let any = false;
    const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
    const sp = Math.sin(v.pitch), upY = Math.cos(v.pitch) * Math.cos(v.roll);
    for (let c = 0; c < cs.z.length; c++) {
      const lz = cs.z[c];
      const ox = sy * lz, oz = cy * lz; // circle centre offset (local +Z is back)
      const yMid = -sp * lz;
      const bottom = v.pos.y + yMid - upY * (he.y + cl);
      const top = v.pos.y + yMid + upY * he.y;
      const low = bottom + hd.stepUp;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.max.y <= low || b.min.y >= top) continue;
        const d = penetrateBox(b, v.pos.x + ox, v.pos.z + oz, r);
        if (d > 0) { resolveStatic(v, ox, oz, r, d, I, bottom + he.y); any = true; }
      }
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        if (t.y + t.h * TREE_TRUNK_FRAC <= low || t.y >= top) continue;
        const d = penetrateCylinder(t.x, t.z, t.r, v.pos.x + ox, v.pos.z + oz, r);
        if (d > 0) { resolveStatic(v, ox, oz, r, d, I, bottom + he.y); any = true; }
      }
      for (let i = 0; i < rocks.length; i++) {
        const k = rocks[i];
        if (k.y + k.h <= low || k.y >= top) continue;
        const d = penetrateCylinder(k.x, k.z, k.r, v.pos.x + ox, v.pos.z + oz, r);
        if (d > 0) { resolveStatic(v, ox, oz, r, d, I, bottom + he.y); any = true; }
      }
    }
    if (!any) break;
  }
}

/** Uses the normal in pnx/pnz. (ox, oz) = circle centre offset from pos. */
function resolveStatic(v: VehicleState, ox: number, oz: number, r: number, depth: number, I: number, cy: number): void {
  const nx = pnx, nz = pnz;
  v.pos.x += nx * depth;
  v.pos.z += nz * depth;
  // Contact point relative to the vehicle centre.
  const rx = ox - nx * r, rz = oz - nz * r;
  const w = v.yawRate;
  const pvx = v.vel.x + w * rz, pvz = v.vel.z - w * rx;
  const vn = pvx * nx + pvz * nz;
  if (vn >= 0) return;
  const rn = rz * nx - rx * nz;
  const j = (-(1 + RESTITUTION) * vn) / (1 + (rn * rn) / I);
  v.vel.x += j * nx;
  v.vel.z += j * nz;
  v.yawRate += (j * rn) / I;
  // Scrape: friction along the surface.
  const tx = pvx - vn * nx, tz = pvz - vn * nz;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (tl > 1e-6) {
    let f = WALL_FRICTION * j;
    if (f > tl * 0.5) f = tl * 0.5;
    v.vel.x -= (tx / tl) * f;
    v.vel.z -= (tz / tl) * f;
  }
  noteCrash(-vn, v.pos.x + rx, cy, v.pos.z + rz);
}

/** Vehicle-vs-vehicle: circle sets, mass weighted push-out and impulse applied to both. */
function collideVehicles(a: VehicleState, defA: VehicleDef, others: VehicleState[]): void {
  const csA = CIRCLES[a.type];
  const ma = defA.mass, Ia = yawInertia(defA);
  const reachA = defA.halfExtents.z + defA.halfExtents.x;
  const aBottom = a.pos.y - rideHeight(defA) + 0.15, aTop = a.pos.y + defA.halfExtents.y;
  for (let oi = 0; oi < others.length; oi++) {
    const b = others[oi];
    if (b === a || b.id === a.id) continue;
    const defB = VEHICLES[b.type];
    const reach = reachA + defB.halfExtents.z + defB.halfExtents.x;
    const dx0 = a.pos.x - b.pos.x, dz0 = a.pos.z - b.pos.z;
    if (dx0 * dx0 + dz0 * dz0 > reach * reach) continue;
    const bBottom = b.pos.y - rideHeight(defB) + 0.15, bTop = b.pos.y + defB.halfExtents.y;
    if (aBottom >= bTop || bBottom >= aTop) continue;
    const csB = CIRCLES[b.type];
    const mb = defB.mass, Ib = yawInertia(defB);
    const wa = mb / (ma + mb), wb = ma / (ma + mb);
    for (let i = 0; i < csA.z.length; i++) {
      for (let k = 0; k < csB.z.length; k++) {
        const sa = Math.sin(a.yaw), ca = Math.cos(a.yaw);
        const sb = Math.sin(b.yaw), cb = Math.cos(b.yaw);
        const aox = sa * csA.z[i], aoz = ca * csA.z[i];
        const box = sb * csB.z[k], boz = cb * csB.z[k];
        const dx = a.pos.x + aox - (b.pos.x + box), dz = a.pos.z + aoz - (b.pos.z + boz);
        const R = csA.r + csB.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R) continue;
        let nx = 1, nz = 0, d = 0;
        if (d2 > 1e-12) { d = Math.sqrt(d2); nx = dx / d; nz = dz / d; }
        const pen = R - d;
        a.pos.x += nx * pen * wa; a.pos.z += nz * pen * wa;
        b.pos.x -= nx * pen * wb; b.pos.z -= nz * pen * wb;
        // Contact point on A's circle surface, relative to each centre.
        const px = a.pos.x + aox - nx * csA.r, pz = a.pos.z + aoz - nz * csA.r;
        const rax = px - a.pos.x, raz = pz - a.pos.z;
        const rbx = px - b.pos.x, rbz = pz - b.pos.z;
        const pvx = a.vel.x + a.yawRate * raz - (b.vel.x + b.yawRate * rbz);
        const pvz = a.vel.z - a.yawRate * rax - (b.vel.z - b.yawRate * rbx);
        const vn = pvx * nx + pvz * nz;
        if (vn >= 0) continue;
        const rna = raz * nx - rax * nz;
        const rnb = rbz * nx - rbx * nz;
        const denom = 1 / ma + 1 / mb + (rna * rna) / (ma * Ia) + (rnb * rnb) / (mb * Ib);
        const j = (-(1 + RESTITUTION) * vn) / denom;
        a.vel.x += (nx * j) / ma; a.vel.z += (nz * j) / ma;
        a.yawRate += (j * rna) / (ma * Ia);
        b.vel.x -= (nx * j) / mb; b.vel.z -= (nz * j) / mb;
        b.yawRate -= (j * rnb) / (mb * Ib);
        // Report the closing speed each body absorbed (bounce excluded, like walls).
        const impA = j / ma / (1 + RESTITUTION);
        const impB = j / mb / (1 + RESTITUTION);
        noteCrash(impA, px, (a.pos.y + b.pos.y) * 0.5, pz);
        if (impB > hitOtherImpact) {
          hitOtherImpact = impB;
          hitOther = b.id;
        }
      }
    }
  }
}

function clampBounds(v: VehicleState, world: World): void {
  const lim = world.half - BOUNDS_MARGIN;
  const p = v.pos, vel = v.vel;
  if (p.x < -lim) { p.x = -lim; if (vel.x < 0) vel.x = 0; }
  else if (p.x > lim) { p.x = lim; if (vel.x > 0) vel.x = 0; }
  if (p.z < -lim) { p.z = -lim; if (vel.z < 0) vel.z = 0; }
  else if (p.z > lim) { p.z = lim; if (vel.z > 0) vel.z = 0; }
}

// ---------------------------------------------------------------------------
// Engine sound model
// ---------------------------------------------------------------------------

/**
 * RPM for the engine sound: a virtual gearbox (saw-tooth through 6 gears), loaded/unloaded by the
 * throttle, revving freely in the air or when stuck. 0 means the engine is off.
 */
function updateRpm(v: VehicleState, def: VehicleDef, dt: number): void {
  let target = 0;
  if (engineRunning) {
    const thr = Math.abs(v.throttle);
    const s = Math.abs(v.speed);
    if (!v.onGround) {
      target = IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * thr;
    } else if (v.speed < -DIRECTION_SWITCH_SPEED) {
      const u = Math.min(1, s / def.reverseSpeed);
      target = IDLE_RPM + (REVERSE_TOP_RPM - IDLE_RPM) * u;
    } else {
      const u = s / def.maxSpeed;
      let g = 0;
      while (g < GEARS.length - 2 && u > GEARS[g + 1]) g++;
      const lo = GEARS[g], hi = GEARS[g + 1];
      const frac = Math.min(1, (u - lo) / (hi - lo));
      const base = g === 0 ? IDLE_RPM + 500 : SHIFT_RPM;
      target = base + (REDLINE_RPM - base) * frac;
      // Throttle against resistance at (near) standstill revs the engine up.
      if (u < 0.05 && thr > 0.05) {
        const rev = IDLE_RPM + 2600 * thr;
        if (rev > target) target = rev;
      }
    }
    target *= 0.82 + 0.18 * thr;
    if (target < IDLE_RPM) target = IDLE_RPM;
    if (target > MAX_RPM) target = MAX_RPM;
  }
  const rate = engineRunning ? RPM_RATE : RPM_OFF_RATE;
  v.rpm += (target - v.rpm) * (1 - Math.exp(-rate * dt));
  if (!engineRunning && v.rpm < 50) v.rpm = 0;
}
