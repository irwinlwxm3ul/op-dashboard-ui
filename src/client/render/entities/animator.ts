// Procedural character animation: turns a PlayerView (velocity, stance, mode, life, flags, gear,
// vehicle seat) into a blended Pose every frame.
//
// Layers:
//   1. Base poses (stand/walk/run/sprint, crouch, prone, swim, freefall, parachute, seated, downed,
//      airborne, revive kneel) blended with smoothed weights.
//   2. Overlays: aim pitch/yaw, ADS, reload, healing, lean, weapon kick, hit flinch, weapon draw.
//   3. Death: snapshot of the last live pose blended into a tumbling fall onto the ground.
// The gait phase advances with speed / stride length so the leg cycle matches footstep timing.

import * as THREE from 'three';
import { PF } from '../../../shared/protocol';
import { hashFloat } from '../../../shared/rng';
import type { VehicleType, WeaponId } from '../../../shared/types';
import type { PlayerView } from '../../game/types';
import {
  P, type Pose, accumulatePose, advancePhase, clearPose, createPose, easeInQuad, lerpPose, normalizeWeights, sat, smooth,
  strideLength,
} from './pose';
import { DIM } from './rig';
import { driverHandTargets } from './seating';
import { WEAPON_HOLD } from './weaponModels';

// Base pose weight slots.
const W_STAND = 0;
const W_CROUCH = 1;
const W_PRONE = 2;
const W_SWIM = 3;
const W_FREEFALL = 4;
const W_CHUTE = 5;
const W_SEAT = 6;
const W_DOWNED = 7;
const W_AIR = 8;
const W_KNEEL = 9;
const W_COUNT = 10;

/** Smoothing rates (1/s) when blending INTO each base pose. */
const W_RATE: readonly number[] = [9, 9, 4.5, 5, 5, 4, 18, 5, 10, 7];

/** Height (above the seat origin) of a seated occupant's hips (matches the vehicles module). */
export const SEATED_HIP_HEIGHT = 0.4;

export interface SeatInfo {
  type: VehicleType;
  seat: number;
  steer: number;
  /** |forward speed| / max speed (0..1). */
  speed: number;
  /** Vehicle roll (rad, + = right side up, i.e. a bike leaning left). */
  roll: number;
  /**
   * Contact points in the rider's root space (seat origin raised by the seat lift, vehicle
   * orientation, -Z forward): hand L, hand R (where the palms hold: handlebar grips, steering wheel
   * rim, the driver's waist / the tail for a bike passenger), foot L, foot R (footpeg tops).
   * Filled by the vehicle renderer for the model actually shown; valid per `hands` / `feet`.
   */
  readonly contacts: Float32Array;
  hands: boolean;
  feet: boolean;
}

/** A fresh SeatInfo (no contacts). */
export function createSeatInfo(): SeatInfo {
  return { type: 'buggy', seat: 0, steer: 0, speed: 0, roll: 0, contacts: new Float32Array(12), hands: false, feet: false };
}

export interface AnimInput {
  /** Player to animate (null = nothing to do). */
  view: PlayerView | null;
  /** Seat info when riding a vehicle (null otherwise). */
  seat: SeatInfo | null;
  /** Aim yaw relative to the model facing (passengers), rad. */
  aimYawRel: number;
  /** Horizontal velocity in the model frame (x right, z backward) — already rotated by the caller. */
  localVx: number;
  localVz: number;
  /** Seconds (render clock) for idle cycles. */
  time: number;
  dt: number;
}

/** Per-player animation state (pooled; reset() when reassigned). */
export class AnimState {
  readonly pose: Pose = createPose();
  readonly weights = new Float32Array(W_COUNT);
  readonly target = new Float32Array(W_COUNT);
  readonly scratch: Pose = createPose();
  readonly accum: Pose = createPose();
  readonly deathStart: Pose = createPose();
  readonly deathLie: Pose = createPose();

  phase = 0;
  speed = 0;
  legYaw = 0;
  legDir = 1;
  armed = 0;
  pistolW = 0;
  holsterDraw = 0;
  ads = 0;
  reload = 0;
  reloadT = 0;
  heal = 0;
  lean = 0;
  sprint = 0;
  dive = 0;
  steer = 0;
  kickX = 0;
  kickV = 0;
  flinchX = 0;
  flinchV = 0;
  flinchBx = 0;
  flinchBz = 0;
  lastWeapon: WeaponId | null = null;
  /** Death bookkeeping. */
  dead = false;
  deathFallSign = 1;
  deathSide = 0;
  deathSpin = 0;
  deathFromLying = false;
  /** First seen already dead: show the body lying, no fall. */
  deathInstant = false;
  /** Hit direction (bullet travel, model frame) recorded for the death fall. */
  lastHitBx = 0;
  lastHitBz = 0;
  lastHitAge = 1e9;
  seed = 0;
  initialized = false;

  reset(id: number): void {
    this.pose.fill(0);
    this.weights.fill(0);
    this.phase = hashFloat(id, 77) * Math.PI * 2;
    this.speed = 0;
    this.legYaw = 0;
    this.legDir = 1;
    this.armed = 0;
    this.pistolW = 0;
    this.holsterDraw = 0;
    this.ads = 0;
    this.reload = 0;
    this.reloadT = 0;
    this.heal = 0;
    this.lean = 0;
    this.sprint = 0;
    this.dive = 0;
    this.steer = 0;
    this.kickX = 0;
    this.kickV = 0;
    this.flinchX = 0;
    this.flinchV = 0;
    this.flinchBx = 0;
    this.flinchBz = 0;
    this.lastWeapon = null;
    this.dead = false;
    this.deathFallSign = 1;
    this.deathSide = 0;
    this.deathSpin = 0;
    this.deathFromLying = false;
    this.deathInstant = false;
    this.lastHitBx = 0;
    this.lastHitBz = 0;
    this.lastHitAge = 1e9;
    this.seed = id;
    this.initialized = false;
  }

  /** Weapon fired: kick impulse. */
  kick(strength: number): void {
    this.kickV += 9 * strength;
  }

  /** Took a hit: flinch impulse; (bx, bz) = bullet travel direction in the model frame. */
  hit(bx: number, bz: number, strength: number): void {
    const l = Math.hypot(bx, bz) || 1;
    this.flinchBx = bx / l;
    this.flinchBz = bz / l;
    this.flinchV += 7 * Math.min(1.5, strength);
    this.lastHitBx = bx / l;
    this.lastHitBz = bz / l;
    this.lastHitAge = 0;
  }

  /** Is the current pose lying on the ground (hips low)? */
  get lying(): boolean {
    return this.pose[P.HY] < 0.45;
  }
}

const exp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

// ---------------------------------------------------------------------------
// Shared helpers for pose generators
// ---------------------------------------------------------------------------

function setArm(
  p: Pose, left: boolean, cx: number, cy: number, cz: number, px: number, py: number, pz: number, grip: number,
): void {
  if (left) {
    p[P.LCX] = cx; p[P.LCY] = cy; p[P.LCZ] = cz; p[P.LPX] = px; p[P.LPY] = py; p[P.LPZ] = pz; p[P.LGRIP] = grip;
    p[P.LRW] = 0;
  } else {
    p[P.RCX] = cx; p[P.RCY] = cy; p[P.RCZ] = cz; p[P.RPX] = px; p[P.RPY] = py; p[P.RPZ] = pz; p[P.RGRIP] = grip;
    p[P.RRW] = 0;
  }
}

/** Standard two-handed weapon hold (long gun / pistol blended by pistolW), scaled by `armed`. */
function weaponHold(p: Pose, armed: number, pistolW: number): void {
  const lw = 1 - pistolW;
  p[P.WPX] = 0.13 * lw + 0.03 * pistolW;
  p[P.WPY] = 0.19 * lw + 0.17 * pistolW;
  p[P.WPZ] = -0.13 * lw - 0.12 * pistolW;
  p[P.WAIM] = 1;
  p[P.CYAW] += (-0.32 * lw - 0.08 * pistolW) * armed;
  p[P.SYAW] += (-0.16 * lw - 0.04 * pistolW) * armed;
  p[P.NYAW] += (0.46 * lw + 0.12 * pistolW) * armed;
  p[P.LGRIP] = armed;
  p[P.RGRIP] = armed;
  // Elbows: support elbow down, firing elbow out.
  p[P.LPX] = -0.35 * lw - 0.6 * pistolW; p[P.LPY] = -1; p[P.LPZ] = 0.15 * lw + 0.3 * pistolW;
  p[P.RPX] = 1 * lw + 0.6 * pistolW; p[P.RPY] = -0.7 * lw - 1 * pistolW; p[P.RPZ] = 0.3;
}

interface GenParams {
  phase: number;
  move: number;
  speedN: number;
  sprint: number;
  armed: number;
  pistolW: number;
  time: number;
  legYaw: number;
  dive: number;
  steer: number;
  seat: SeatInfo | null;
  hands: Float32Array;
}

function genStand(p: Pose, g: GenParams): void {
  clearPose(p);
  const m = g.move, s = Math.min(1.35, g.speedN), sp = g.sprint * m, ph = g.phase;
  const sinP = Math.sin(ph), sinQ = Math.sin(ph + Math.PI);
  const breath = Math.sin(g.time * 1.7) * 0.015;
  p[P.HY] = 0.95 - 0.015 * m + (0.022 + 0.03 * sp) * m * Math.cos(2 * ph);
  p[P.HROLL] = 0.035 * m * sinP;
  p[P.HYAW] = g.legYaw;
  p[P.SYAW] = -0.6 * g.legYaw;
  p[P.CYAW] = -0.4 * g.legYaw + 0.1 * m * sinP * (1 - g.armed * 0.7);
  p[P.SPITCH] = -(0.03 + 0.08 * s * m + 0.14 * sp);
  p[P.CPITCH] = -0.02 * m + breath;
  p[P.NPITCH] = 0.05 * s * m + 0.08 * sp;
  const A = (0.42 + 0.22 * s + 0.16 * sp) * m;
  const K = (0.45 + 0.55 * s + 0.45 * sp) * m;
  p[P.LLP] = A * sinP;
  p[P.RLP] = A * sinQ;
  p[P.LKNEE] = 0.06 + 0.1 * m + K * Math.pow(Math.max(0, Math.cos(ph)), 1.3);
  p[P.RKNEE] = 0.06 + 0.1 * m + K * Math.pow(Math.max(0, Math.cos(ph + Math.PI)), 1.3);
  p[P.LLR] = 0.04;
  p[P.RLR] = 0.04;
  // Unarmed arm swing (opposite to the legs); elbows bend more when running.
  const sw = (0.16 + 0.14 * s + 0.16 * sp) * m;
  const lift = 0.04 * m + 0.2 * sp + 0.06 * s * m;
  setArm(p, true, -0.22, -0.35 + lift + 0.06 * Math.abs(sinQ) * m, -sw * sinQ + 0.02, -0.25, 0, 1, 0);
  setArm(p, false, 0.22, -0.35 + lift + 0.06 * Math.abs(sinP) * m, -sw * sinP + 0.02, 0.25, 0, 1, 0);
  p[P.LCY] += breath; p[P.RCY] += breath;
  if (g.armed > 0) {
    weaponHold(p, g.armed, g.pistolW);
    // Sprint: low-ready across the chest, aim ignored.
    p[P.WPITCH] = -0.62 * sp + 0.02 * m * Math.cos(2 * ph);
    p[P.WYAW] = 0.55 * sp;
    p[P.WROLL] = 0.35 * sp;
    p[P.WPX] -= 0.06 * sp;
    p[P.WPY] -= 0.1 * sp;
    p[P.WPZ] -= 0.04 * sp;
    p[P.WAIM] = 1 - sp;
    p[P.CYAW] += 0.2 * sp * g.armed;
    p[P.WPY] += breath;
  }
  p[P.AIMBODY] = 1 - 0.7 * sp;
}

function genCrouch(p: Pose, g: GenParams): void {
  clearPose(p);
  const m = g.move, ph = g.phase;
  const breath = Math.sin(g.time * 1.5) * 0.012;
  p[P.HY] = 0.62 + 0.015 * m * Math.cos(2 * ph);
  p[P.HZ] = 0.03;
  p[P.HYAW] = g.legYaw;
  p[P.SYAW] = -0.6 * g.legYaw;
  p[P.CYAW] = -0.4 * g.legYaw;
  p[P.SPITCH] = -0.24 - 0.06 * m;
  p[P.CPITCH] = -0.04 + breath;
  p[P.NPITCH] = 0.22;
  // Static: tactical crouch (left foot planted forward, right knee low). Moving: alternating cycle.
  const sL = 1 - m;
  const cycL = 0.75 + 0.45 * Math.sin(ph), cycR = 0.75 + 0.45 * Math.sin(ph + Math.PI);
  p[P.LLP] = sL * 1.0 + m * cycL;
  p[P.RLP] = sL * 0.32 + m * cycR;
  p[P.LKNEE] = sL * 1.83 + m * (1.68 + 0.08 * Math.sin(ph) + 0.35 * Math.max(0, Math.cos(ph)));
  p[P.RKNEE] = sL * 1.62 + m * (1.68 + 0.08 * Math.sin(ph + Math.PI) + 0.35 * Math.max(0, Math.cos(ph + Math.PI)));
  p[P.LLR] = 0.08;
  p[P.RLR] = 0.12;
  setArm(p, true, -0.2, -0.3, -0.24, -0.4, -0.2, 1, 0);
  setArm(p, false, 0.2, -0.3, -0.24, 0.4, -0.2, 1, 0);
  if (g.armed > 0) {
    weaponHold(p, g.armed, g.pistolW);
    p[P.WPY] += breath;
  }
  p[P.AIMBODY] = 0.9;
}

function genProne(p: Pose, g: GenParams): void {
  clearPose(p);
  const m = g.move, ph = g.phase;
  const a = Math.max(0, Math.sin(ph)) * m, b = Math.max(0, Math.sin(ph + Math.PI)) * m;
  p[P.HY] = 0.12;
  p[P.HPITCH] = -Math.PI / 2 + 0.05;
  p[P.HROLL] = 0.06 * m * Math.sin(ph);
  p[P.SPITCH] = 0.2;
  p[P.CPITCH] = 0.24 + 0.02 * Math.sin(g.time * 1.4);
  p[P.CROLL] = 0.07 * m * Math.sin(ph);
  p[P.NPITCH] = 0.86;
  p[P.LLR] = 0.16 + 0.42 * a;
  p[P.RLR] = 0.16 + 0.42 * b;
  p[P.LKNEE] = 0.08 + 1.0 * a;
  p[P.RKNEE] = 0.08 + 1.0 * b;
  // Unarmed: forearms on the ground in front of the face, crawling alternately.
  setArm(p, true, -0.17, 0.42 + 0.18 * (b - a), -0.2, -0.6, 0, -1, 0);
  setArm(p, false, 0.17, 0.42 + 0.18 * (a - b), -0.2, 0.6, 0, -1, 0);
  if (g.armed > 0) {
    weaponHold(p, g.armed, g.pistolW);
    p[P.CYAW] *= 0.4;
    p[P.SYAW] *= 0.4;
    p[P.NYAW] *= 0.4;
    // Elbows on the ground.
    p[P.LPX] = -0.5; p[P.LPY] = 0; p[P.LPZ] = -1;
    p[P.RPX] = 0.6; p[P.RPY] = 0; p[P.RPZ] = -1;
    p[P.WPZ] += 0.05 * Math.sin(ph) * m;
  }
  p[P.AIMBODY] = 0.35;
}

function genSwim(p: Pose, g: GenParams): void {
  clearPose(p);
  const m = g.move, ph = g.phase, t = g.time;
  const tread = 1 - m;
  p[P.HY] = 1.05;
  p[P.HPITCH] = -1.2 * m - 0.3 * tread;
  p[P.SPITCH] = 0.15 * m;
  p[P.CPITCH] = 0.1 * m;
  p[P.NPITCH] = 0.9 * m + 0.15;
  // Breaststroke while moving, sculling while treading water.
  const c = Math.sin(ph), cc = Math.cos(ph);
  const bx = 0.1 + 0.32 * Math.max(0, c);
  const sx = 0.3 + 0.07 * Math.sin(t * 3.1);
  setArm(p, true, -(bx * m + sx * tread), (0.32 + 0.25 * cc) * m + 0.02 * tread, (-0.25 + 0.1 * c) * m - 0.3 * tread, -0.6, 0.2, 0.6, 0);
  setArm(p, false, bx * m + sx * tread, (0.32 + 0.25 * cc) * m + 0.02 * tread, (-0.25 + 0.1 * c) * m - 0.3 * tread, 0.6, 0.2, 0.6, 0);
  const kick = Math.sin(ph * 2);
  p[P.LLP] = 0.22 * kick * m + 0.35 * Math.sin(t * 2.3) * tread;
  p[P.RLP] = -0.22 * kick * m + 0.35 * Math.sin(t * 2.3 + Math.PI) * tread;
  p[P.LKNEE] = 0.25 + 0.25 * Math.max(0, kick) * m + 0.5 * Math.max(0, Math.cos(t * 2.3)) * tread;
  p[P.RKNEE] = 0.25 + 0.25 * Math.max(0, -kick) * m + 0.5 * Math.max(0, -Math.cos(t * 2.3)) * tread;
  p[P.LLR] = 0.12; p[P.RLR] = 0.12;
  p[P.WHOLSTER] = 1;
  p[P.AIMBODY] = 0;
}

function genFreefall(p: Pose, g: GenParams): void {
  clearPose(p);
  const d = g.dive, s = 1 - d, t = g.time;
  const flutter = Math.sin(t * 9) * 0.03;
  p[P.HY] = 0.95;
  p[P.HPITCH] = -1.38 * s - 2.35 * d;
  p[P.HROLL] = -0.35 * g.steer;
  p[P.SPITCH] = 0.25 * s;
  p[P.CPITCH] = 0.15 * s;
  p[P.NPITCH] = 0.75 * s + 0.25 * d;
  p[P.LLR] = 0.35 * s + 0.04 * d;
  p[P.RLR] = 0.35 * s + 0.04 * d;
  p[P.LKNEE] = 1.15 * s + 0.08 * d + flutter;
  p[P.RKNEE] = 1.15 * s + 0.08 * d - flutter;
  p[P.LLP] = -0.12 * s;
  p[P.RLP] = -0.12 * s;
  setArm(p, true, -0.56 * s - 0.2 * d, 0.32 * s - 0.38 * d + flutter, -0.05 * s + 0.12 * d, -0.4, 0, 1, 0);
  setArm(p, false, 0.56 * s + 0.2 * d, 0.32 * s - 0.38 * d - flutter, -0.05 * s + 0.12 * d, 0.4, 0, 1, 0);
  // Steering: drop one arm.
  p[P.LCY] -= 0.15 * Math.max(0, -g.steer) * s;
  p[P.RCY] -= 0.15 * Math.max(0, g.steer) * s;
  p[P.WHOLSTER] = 1;
}

function genChute(p: Pose, g: GenParams): void {
  clearPose(p);
  const t = g.time;
  p[P.HY] = 0.95;
  p[P.HPITCH] = 0.08;
  p[P.HROLL] = -0.15 * g.steer;
  p[P.SPITCH] = 0.04;
  p[P.NPITCH] = -0.12;
  p[P.LLP] = 0.24 + 0.06 * Math.sin(t * 1.3);
  p[P.RLP] = 0.18 + 0.06 * Math.sin(t * 1.3 + 1.1);
  p[P.LKNEE] = 0.35 + 0.05 * Math.sin(t * 1.7);
  p[P.RKNEE] = 0.3 + 0.05 * Math.sin(t * 1.7 + 0.8);
  p[P.LLR] = 0.08; p[P.RLR] = 0.08;
  const pullL = 0.33 * Math.max(0, -g.steer), pullR = 0.33 * Math.max(0, g.steer);
  setArm(p, true, -0.3, 0.56 - pullL, -0.04, -1, 0, 0.3, 0);
  setArm(p, false, 0.3, 0.56 - pullR, -0.04, 1, 0, 0.3, 0);
  p[P.WHOLSTER] = 1;
}

// --- Seated riders: hands on the controls, feet on the footpegs ---------------------------------

/** The rig's arm IK targets wrists: pull a palm contact back toward the shoulder by this much. */
const PALM_REACH = 0.065;
/** Boot sole below the ankle and ball of the foot ahead of the shin axis (shin space, see soldierModel). */
const SOLE_BELOW_ANKLE = 0.075;
const BALL_AHEAD = 0.09;

const _hq = new THREE.Quaternion();
const _hqi = new THREE.Quaternion();
const _he = new THREE.Euler(0, 0, 0, 'YXZ');
const _hj = new THREE.Vector3();
const _lt = new THREE.Vector3();
const _lt0 = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _ln = new THREE.Vector3();
const _lm = new THREE.Vector3();
const _lk = new THREE.Vector3();
const _lu = new THREE.Vector3();
const _ls = new THREE.Vector3();
const _lh = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lz = new THREE.Vector3();
const _lmat = new THREE.Matrix4();

/** Wrist target (model space) for a palm contact, approached from a shoulder at (sx, sy, sz). */
function seatHand(p: Pose, left: boolean, c: Float32Array, at: number, sx: number, sy: number, sz: number): void {
  const x = c[at], y = c[at + 1], z = c[at + 2];
  const dx = x - sx, dy = y - sy, dz = z - sz;
  const k = PALM_REACH / Math.max(0.1, Math.hypot(dx, dy, dz));
  if (left) {
    p[P.LRX] = x - dx * k; p[P.LRY] = y - dy * k; p[P.LRZ] = z - dz * k; p[P.LRW] = 1;
  } else {
    p[P.RRX] = x - dx * k; p[P.RRY] = y - dy * k; p[P.RRZ] = z - dz * k; p[P.RRW] = 1;
  }
}

/**
 * Two-bone solve in the hips frame: ankle target t (from the hip joint), knee toward `pole`.
 * Leaves the thigh direction in _lu, the shin direction in _ls and the knee hinge in _lh; returns
 * the knee bend.
 */
function legSolve(t: THREE.Vector3, pole: THREE.Vector3): number {
  const a = DIM.thigh, b = DIM.shin;
  let d = t.length();
  if (d < 1e-4) {
    t.set(0, -1e-4, 0);
    d = 1e-4;
  }
  _ln.copy(t).multiplyScalar(1 / d);
  d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 0.02, d));
  const along = (a * a - b * b + d * d) / (2 * d);
  const up = Math.sqrt(Math.max(0, a * a - along * along));
  _lm.copy(pole).addScaledVector(_ln, -pole.dot(_ln));
  if (_lm.lengthSq() < 1e-8) _lm.set(0, 0, -1).addScaledVector(_ln, _ln.z);
  _lm.normalize();
  _lk.copy(_ln).multiplyScalar(along).addScaledVector(_lm, up); // knee
  _lu.copy(_lk).normalize(); // thigh direction
  _ls.copy(_ln).multiplyScalar(d).sub(_lk).normalize(); // shin direction
  // Knee hinge = thigh-local X (the shin bends toward thigh-local +Z).
  _lh.crossVectors(_ls, _lu);
  if (_lh.lengthSq() < 1e-8) _lh.crossVectors(_lu, _lm);
  _lh.normalize();
  return Math.acos(Math.max(-1, Math.min(1, _lu.dot(_ls))));
}

/**
 * Leg IK onto a footpeg (ball of the boot on the peg top), written as the rig's thigh (pitch, yaw,
 * abduction) and knee channels. Uses the hips placement already in the pose; the knee bends toward
 * `pole` (model space). side: -1 left, +1 right.
 */
function seatLeg(p: Pose, side: number, px: number, py: number, pz: number, poleX: number, poleY: number, poleZ: number): void {
  _hq.setFromEuler(_he.set(p[P.HPITCH], p[P.HYAW], p[P.HROLL], 'YXZ'));
  _hqi.copy(_hq).invert();
  _hj.set(side * DIM.hipJointX, DIM.hipJointY, 0).applyQuaternion(_hq);
  _hj.x += p[P.HX]; _hj.y += p[P.HY]; _hj.z += p[P.HZ];
  // Peg and knee pole in the hips frame.
  _lt0.set(px, py, pz).sub(_hj).applyQuaternion(_hqi);
  _lp.set(poleX, poleY, poleZ).applyQuaternion(_hqi);
  // First guess: ankle straight above the peg; then put the ball of the boot (rigid with the shin)
  // onto the peg for that shin orientation and solve again.
  _lt.copy(_lt0);
  _lt.y += SOLE_BELOW_ANKLE;
  legSolve(_lt, _lp);
  _lz.crossVectors(_ls, _lh); // shin-local +Z
  _lt.copy(_lt0).addScaledVector(_ls, -SOLE_BELOW_ANKLE).addScaledVector(_lz, BALL_AHEAD);
  const knee = legSolve(_lt, _lp);
  // Thigh basis: local -Y along the thigh, local X = knee hinge.
  _ly.copy(_lu).negate();
  _lz.crossVectors(_lh, _ly).normalize();
  _lh.crossVectors(_ly, _lz);
  _lmat.makeBasis(_lh, _ly, _lz);
  _he.setFromRotationMatrix(_lmat, 'YXZ');
  if (side < 0) {
    p[P.LLP] = _he.x; p[P.LLY] = _he.y; p[P.LLR] = -_he.z; p[P.LKNEE] = knee;
  } else {
    p[P.RLP] = _he.x; p[P.RLY] = _he.y; p[P.RLR] = _he.z; p[P.RKNEE] = knee;
  }
}

function genSeat(p: Pose, g: GenParams): void {
  clearPose(p);
  const seat = g.seat;
  const bike = seat?.type === 'bike';
  const driver = seat !== null && seat.seat === 0;
  p[P.HY] = SEATED_HIP_HEIGHT;
  const breath = Math.sin(g.time * 1.6) * 0.01;
  if (seat && bike) {
    // Forward lean that grows with speed; leaning into turns beyond the bike's own roll, head
    // kept nearer the horizon.
    const sp = seat.speed;
    p[P.HPITCH] = driver ? -(0.2 + 0.24 * sp) : -(0.1 + 0.1 * sp);
    p[P.SPITCH] = driver ? -(0.1 + 0.12 * sp) : -0.06;
    p[P.CPITCH] = -0.06 + breath;
    p[P.SROLL] = 0.3 * seat.roll - (driver ? 0.06 * g.steer : 0);
    p[P.CROLL] = 0.1 * seat.roll;
    p[P.NPITCH] = -0.85 * (p[P.HPITCH] + p[P.SPITCH] + p[P.CPITCH]);
    p[P.NROLL] = -0.6 * (seat.roll + p[P.SROLL] + p[P.CROLL]);
    p[P.LLP] = 1.05; p[P.RLP] = 1.05;
    p[P.LLR] = 0.3; p[P.RLR] = 0.3;
    p[P.LKNEE] = 1.5; p[P.RKNEE] = 1.5;
    if (seat.feet) {
      // Feet on the pegs, knees forward and a little out (gripping the tank).
      const c = seat.contacts;
      seatLeg(p, -1, c[6], c[7], c[8], -0.35, 0.25, -1);
      seatLeg(p, 1, c[9], c[10], c[11], 0.35, 0.25, -1);
    }
  } else {
    p[P.HPITCH] = 0.15;
    p[P.SPITCH] = -0.06;
    p[P.CPITCH] = -0.05 + breath;
    p[P.NPITCH] = -0.03;
    p[P.LLP] = 1.35; p[P.RLP] = 1.35;
    p[P.LLR] = 0.1; p[P.RLR] = 0.1;
    p[P.LKNEE] = 0.72; p[P.RKNEE] = 0.68;
  }
  if (driver && seat) {
    if (seat.hands) {
      // Palms on the grips / rim (contacts follow the steering of the model shown).
      const c = seat.contacts;
      const sz = bike ? -0.2 : -0.05;
      seatHand(p, true, c, 0, -DIM.shoulderX, 0.85, sz);
      seatHand(p, false, c, 3, DIM.shoulderX, 0.85, sz);
    } else {
      driverHandTargets(seat.type, g.steer, g.hands);
      p[P.LRX] = g.hands[0]; p[P.LRY] = g.hands[1]; p[P.LRZ] = g.hands[2]; p[P.LRW] = 1;
      p[P.RRX] = g.hands[3]; p[P.RRY] = g.hands[4]; p[P.RRZ] = g.hands[5]; p[P.RRW] = 1;
    }
    p[P.LCX] = -0.2; p[P.LCY] = -0.1; p[P.LCZ] = -0.35;
    p[P.RCX] = 0.2; p[P.RCY] = -0.1; p[P.RCZ] = -0.35;
    if (bike) {
      // Elbows out and up a little (attack position).
      p[P.LPX] = -0.9; p[P.LPY] = -0.45; p[P.LPZ] = 0.35;
      p[P.RPX] = 0.9; p[P.RPY] = -0.45; p[P.RPZ] = 0.35;
    } else {
      p[P.LPX] = -0.7; p[P.LPY] = -1; p[P.LPZ] = 0.3;
      p[P.RPX] = 0.7; p[P.RPY] = -1; p[P.RPZ] = 0.3;
      p[P.SROLL] = -0.06 * g.steer;
    }
    p[P.WHOLSTER] = 1;
    p[P.NYAW] = -0.15 * g.steer;
    p[P.AIMBODY] = 0;
    return;
  }
  // Passenger: hands on the driver's waist / the tail (bike) or the thighs, or holding the weapon.
  if (seat && bike && seat.hands) {
    seatHand(p, true, seat.contacts, 0, -DIM.shoulderX, 0.86, -0.08);
    seatHand(p, false, seat.contacts, 3, DIM.shoulderX, 0.86, -0.08);
    p[P.LPX] = -0.8; p[P.LPY] = -0.7; p[P.LPZ] = 0.4;
    p[P.RPX] = 0.8; p[P.RPY] = -0.7; p[P.RPZ] = 0.4;
  } else {
    if (bike) {
      p[P.LRX] = -0.17; p[P.LRY] = 0.62; p[P.LRZ] = -0.28; p[P.LRW] = 1;
      p[P.RRX] = 0.17; p[P.RRY] = 0.62; p[P.RRZ] = -0.28; p[P.RRW] = 1;
    } else {
      p[P.LRX] = -0.15; p[P.LRY] = 0.44; p[P.LRZ] = -0.32; p[P.LRW] = 1;
      p[P.RRX] = 0.15; p[P.RRY] = 0.44; p[P.RRZ] = -0.32; p[P.RRW] = 1;
    }
    p[P.LPX] = -0.6; p[P.LPY] = -0.4; p[P.LPZ] = 1;
    p[P.RPX] = 0.6; p[P.RPY] = -0.4; p[P.RPZ] = 1;
  }
  if (g.armed > 0) {
    weaponHold(p, g.armed, g.pistolW);
    p[P.LRW] = 1 - g.armed;
    p[P.RRW] = 1 - g.armed;
  }
  p[P.AIMBODY] = 0.8;
}

function genDowned(p: Pose, g: GenParams): void {
  clearPose(p);
  const m = g.move, ph = g.phase, t = g.time;
  const pain = Math.sin(t * 2.2) * 0.02;
  p[P.HY] = 0.16;
  p[P.HPITCH] = -Math.PI / 2 + 0.22;
  p[P.HROLL] = 0.22 + 0.05 * Math.sin(ph) * m;
  p[P.SPITCH] = 0.16 + pain;
  p[P.CPITCH] = 0.12;
  p[P.CROLL] = -0.1;
  p[P.NPITCH] = 0.75;
  p[P.NROLL] = -0.2;
  const a = Math.sin(ph) * m, b = Math.sin(ph + Math.PI) * m;
  p[P.LLR] = 0.12 + 0.2 * Math.max(0, a);
  p[P.RLR] = 0.08 + 0.2 * Math.max(0, b);
  p[P.LKNEE] = 0.45 + 0.7 * Math.max(0, a);
  p[P.RKNEE] = 0.22 + 0.7 * Math.max(0, b);
  p[P.LLP] = 0.1; p[P.RLP] = -0.08;
  // One arm reaching forward along the ground (pulling when crawling), the other on the wound.
  setArm(p, true, -0.24, 0.72 - 0.28 * Math.max(0, b) + pain, -0.13, -0.6, 0.2, -1, 0);
  setArm(p, false, 0.08 + 0.18 * m * Math.max(0, a), -0.12 + 0.6 * m * Math.max(0, a), -0.17, 0.6, -0.3, -1, 0);
  p[P.WHOLSTER] = 1;
}

function genAir(p: Pose, g: GenParams): void {
  clearPose(p);
  p[P.HY] = 0.95;
  p[P.SPITCH] = -0.06;
  p[P.NPITCH] = 0.05;
  p[P.LLP] = 0.55; p[P.LKNEE] = 0.95;
  p[P.RLP] = 0.12; p[P.RKNEE] = 0.55;
  p[P.LLR] = 0.06; p[P.RLR] = 0.06;
  setArm(p, true, -0.32, -0.2, -0.05, -0.4, 0, 1, 0);
  setArm(p, false, 0.32, -0.2, -0.05, 0.4, 0, 1, 0);
  if (g.armed > 0) weaponHold(p, g.armed, g.pistolW);
  p[P.AIMBODY] = 1;
}

function genKneel(p: Pose, g: GenParams): void {
  clearPose(p);
  const pump = Math.sin(g.time * 7) * 0.045;
  p[P.HY] = 0.5;
  p[P.HZ] = 0.1;
  p[P.SPITCH] = -0.38;
  p[P.CPITCH] = -0.22;
  p[P.NPITCH] = -0.3;
  p[P.LLP] = 1.4; p[P.LKNEE] = 1.42;
  p[P.RLP] = -0.2; p[P.RKNEE] = 1.38;
  p[P.LLR] = 0.12; p[P.RLR] = 0.08;
  setArm(p, true, -0.1, -0.36 + pump, -0.46, -0.6, -0.4, 1, 0);
  setArm(p, false, 0.1, -0.36 + pump, -0.46, 0.6, -0.4, 1, 0);
  p[P.WHOLSTER] = 1;
}

const GENERATORS: readonly ((p: Pose, g: GenParams) => void)[] = [
  genStand, genCrouch, genProne, genSwim, genFreefall, genChute, genSeat, genDowned, genAir, genKneel,
];

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------

/** Seconds the death fall takes. */
export const DEATH_FALL_TIME = 0.6;
/** Seconds after death before the body starts to fade / sink, and the fade duration. */
export const DEATH_FADE_START = 5;
export const DEATH_FADE_TIME = 1.4;

function buildDeathLie(st: AnimState, out: Pose): void {
  clearPose(out);
  const back = st.deathFallSign > 0; // falls on the back
  out[P.HY] = 0.13;
  out[P.HZ] = back ? 0.35 : -0.35;
  out[P.HPITCH] = back ? Math.PI / 2 - 0.04 : -Math.PI / 2 + 0.04;
  out[P.HROLL] = 0.3 * st.deathSide;
  out[P.HYAW] = st.deathSpin;
  out[P.SPITCH] = back ? -0.05 : 0.05;
  out[P.SROLL] = -0.12 * st.deathSide;
  out[P.NPITCH] = back ? -0.3 : 0.25;
  out[P.NYAW] = 0.7 * st.deathSide;
  out[P.LLP] = 0.15; out[P.RLP] = -0.05 + 0.3 * Math.max(0, st.deathSide);
  out[P.LLR] = 0.22; out[P.RLR] = 0.12;
  out[P.LKNEE] = 0.12; out[P.RKNEE] = 0.28 + 0.22 * Math.abs(st.deathSide);
  // Arms flung out, lying flat.
  const zArm = back ? 0.05 : -0.05;
  out[P.LCX] = -0.56; out[P.LCY] = 0.12; out[P.LCZ] = zArm;
  out[P.RCX] = 0.5; out[P.RCY] = -0.28; out[P.RCZ] = zArm;
  out[P.LPX] = 0; out[P.LPY] = 0; out[P.LPZ] = back ? -1 : 1;
  out[P.RPX] = 0; out[P.RPY] = 0; out[P.RPZ] = back ? -1 : 1;
  out[P.WHOLSTER] = 1;
}

/** Death pose at time t (s) since death: tumble from the last live pose to lying. */
function evalDeath(st: AnimState, t: number, lie: Pose, out: Pose): void {
  const fall = st.deathFromLying ? smooth(t / 0.5) : easeInQuad(t / DEATH_FALL_TIME);
  lerpPose(out, st.deathStart, lie, fall);
  if (!st.deathFromLying) {
    // Knees buckle first, then the body tips over; a small bounce on impact.
    const buckle = Math.sin(Math.min(1, t / DEATH_FALL_TIME) * Math.PI);
    out[P.LKNEE] += 0.9 * buckle;
    out[P.RKNEE] += 0.7 * buckle;
    out[P.HY] -= 0.12 * buckle * (1 - fall);
    const after = t - DEATH_FALL_TIME;
    if (after > 0 && after < 0.35) {
      const bounce = Math.sin((after / 0.35) * Math.PI) * (1 - after / 0.35);
      out[P.HY] += 0.05 * bounce;
      out[P.HPITCH] -= 0.08 * bounce * st.deathFallSign;
    }
  }
  // Arms and head go limp quickly regardless of the fall.
  const limp = smooth(t / 0.3);
  out[P.LGRIP] *= 1 - limp;
  out[P.RGRIP] *= 1 - limp;
  out[P.LRW] *= 1 - limp;
  out[P.RRW] *= 1 - limp;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

const gen: GenParams = {
  phase: 0, move: 0, speedN: 0, sprint: 0, armed: 0, pistolW: 0, time: 0, legYaw: 0, dive: 0, steer: 0, seat: null,
  hands: new Float32Array(6),
};

/** Advance the animation state and write the blended pose into st.pose. */
export function animate(st: AnimState, inp: AnimInput): void {
  const v = inp.view;
  if (!v) return;
  const dt = Math.min(0.1, Math.max(0, inp.dt));
  const flags = v.flags;
  const tw = st.weights;
  const target = st.target;

  // --- Death ---------------------------------------------------------------------------------
  if (v.life === 'dead') {
    if (!st.dead) {
      st.deathInstant = !st.initialized;
      if (st.deathInstant) {
        // First seen already dead: start from a neutral standing pose; shown fully fallen.
        st.pose.fill(0);
        st.pose[P.HY] = 0.95;
      }
      beginDeath(st);
    }
    const t = v.deadFor >= 0 ? v.deadFor : 0;
    evalDeath(st, st.deathInstant ? Math.max(t, 2) : t, st.deathLie, st.pose);
    st.initialized = true;
    return;
  }
  if (st.dead) {
    // Respawned (training) or revived after a stale death flag: start fresh.
    st.dead = false;
    st.initialized = false;
  }

  // --- Locomotion inputs ------------------------------------------------------------------------
  const hs = Math.hypot(inp.localVx, inp.localVz);
  st.speed += (hs - st.speed) * exp(14, dt);
  const sprinting = (flags & PF.SPRINT) !== 0;
  st.sprint += ((sprinting ? 1 : 0) - st.sprint) * exp(8, dt);
  const onGround = (flags & PF.ON_GROUND) !== 0;

  // Target weights.
  target.fill(0);
  let gait: 'stand' | 'crouch' | 'prone' | 'swim' | 'downed' = 'stand';
  if (v.life === 'downed') {
    target[W_DOWNED] = 1;
    gait = 'downed';
  } else {
    switch (v.mode) {
      case 'vehicle':
        target[W_SEAT] = 1;
        break;
      case 'freefall':
        target[W_FREEFALL] = 1;
        break;
      case 'parachute':
        target[W_CHUTE] = 1;
        break;
      case 'swim':
        target[W_SWIM] = 1;
        gait = 'swim';
        break;
      default:
        if ((flags & PF.REVIVING) !== 0) {
          target[W_KNEEL] = 1;
        } else if (!onGround && Math.abs(v.vel.y) > 1.2 && v.stance !== 'prone') {
          target[W_AIR] = 1;
        } else if (v.stance === 'prone') {
          target[W_PRONE] = 1;
          gait = 'prone';
        } else if (v.stance === 'crouch') {
          target[W_CROUCH] = 1;
          gait = 'crouch';
        } else {
          target[W_STAND] = 1;
        }
    }
  }
  if (!st.initialized) {
    tw.set(target);
  } else {
    for (let i = 0; i < W_COUNT; i++) {
      const goingUp = target[i] > tw[i];
      tw[i] += (target[i] - tw[i]) * exp(goingUp ? W_RATE[i] : W_RATE[i] * 1.2, dt);
    }
  }
  normalizeWeights(tw, 0.002);

  // Gait phase (stride-synced).
  const stride = strideLength(gait, st.speed, sprinting);
  st.phase = advancePhase(st.phase, st.speed * st.legDir, stride, dt);

  // Strafing: legs turn toward the movement direction; walking backward reverses the cycle.
  let legYawT = 0;
  let dir = 1;
  if (st.speed > 0.4 && (target[W_STAND] > 0 || target[W_CROUCH] > 0)) {
    // Model frame: forward = -z, right = +x.
    const fwd = -inp.localVz, side = inp.localVx;
    const ang = Math.atan2(side, fwd); // 0 forward, + right
    if (Math.abs(ang) <= 1.92) {
      legYawT = -Math.max(-1, Math.min(1, ang));
    } else {
      const back = ang > 0 ? ang - Math.PI : ang + Math.PI;
      legYawT = -Math.max(-1, Math.min(1, back));
      dir = -1;
    }
  }
  st.legDir = dir;
  st.legYaw += (legYawT - st.legYaw) * exp(8, dt);

  // Weapon state.
  const armedT = v.weapon !== null ? 1 : 0;
  if (v.weapon !== st.lastWeapon) {
    if (v.weapon !== null && st.initialized) st.holsterDraw = 1; // draw from the back
    st.lastWeapon = v.weapon;
  }
  st.armed += (armedT - st.armed) * exp(12, dt);
  if (!st.initialized) st.armed = armedT;
  const pistolT = v.weapon !== null && WEAPON_HOLD[v.weapon].pistol ? 1 : 0;
  st.pistolW += (pistolT - st.pistolW) * exp(14, dt);
  if (!st.initialized) st.pistolW = pistolT;
  st.holsterDraw = Math.max(0, st.holsterDraw - dt * ((flags & PF.DRAWING) !== 0 ? 2.6 : 5));

  st.ads += (((flags & PF.ADS) !== 0 ? 1 : 0) - st.ads) * exp(12, dt);
  const reloading = (flags & PF.RELOADING) !== 0;
  if (reloading) st.reloadT += dt;
  else st.reloadT = 0;
  st.reload += ((reloading ? 1 : 0) - st.reload) * exp(10, dt);
  st.heal += (((flags & PF.HEALING) !== 0 ? 1 : 0) - st.heal) * exp(7, dt);
  const leanT = (flags & PF.LEAN_L) !== 0 ? 1 : (flags & PF.LEAN_R) !== 0 ? -1 : 0;
  st.lean += (leanT - st.lean) * exp(10, dt);
  // Freefall dive amount from descent speed.
  const diveT = v.mode === 'freefall' ? sat((-v.vel.y - 54) / 10) : 0;
  st.dive += (diveT - st.dive) * exp(4, dt);
  // Steering from lateral velocity (drop) or vehicle steering.
  const steerT = inp.seat ? inp.seat.steer : v.mode === 'freefall' || v.mode === 'parachute' ? Math.max(-1, Math.min(1, inp.localVx / 6)) : 0;
  st.steer += (steerT - st.steer) * exp(inp.seat ? 20 : 3, dt);

  // Springs: weapon kick and hit flinch.
  const kA = -900 * st.kickX - 42 * st.kickV;
  st.kickV += kA * dt;
  st.kickX += st.kickV * dt;
  const fA = -260 * st.flinchX - 24 * st.flinchV;
  st.flinchV += fA * dt;
  st.flinchX += st.flinchV * dt;
  st.lastHitAge += dt;

  // --- Base pose blend --------------------------------------------------------------------------
  const move = sat((st.speed - 0.15) / 0.9);
  gen.phase = st.phase;
  gen.move = move;
  gen.speedN = st.speed / 4.7;
  gen.sprint = st.sprint;
  gen.armed = st.armed;
  gen.pistolW = st.pistolW;
  gen.time = inp.time + st.seed * 0.37;
  gen.legYaw = st.legYaw;
  gen.dive = st.dive;
  gen.steer = st.steer;
  gen.seat = inp.seat;
  const acc = st.accum;
  const scratch = st.scratch;
  clearPose(acc);
  for (let i = 0; i < W_COUNT; i++) {
    const w = tw[i];
    if (w <= 0) continue;
    GENERATORS[i](scratch, gen);
    accumulatePose(acc, scratch, w);
  }

  // --- Overlays ---------------------------------------------------------------------------------
  const p = acc;
  const armed = st.armed;
  // Aim yaw (passengers) twists the torso toward the aim.
  const yawTw = Math.max(-1.3, Math.min(1.3, inp.aimYawRel)) * armed;
  p[P.SYAW] += 0.35 * yawTw;
  p[P.CYAW] += 0.45 * yawTw;
  p[P.NYAW] += 0.2 * Math.max(-1.3, Math.min(1.3, inp.aimYawRel));
  // Aim pitch bends the upper body / head.
  const ap = Math.max(-1.3, Math.min(1.3, v.pitch)) * p[P.AIMBODY];
  p[P.SPITCH] += 0.22 * ap;
  p[P.CPITCH] += 0.28 * ap;
  p[P.NPITCH] += 0.35 * ap;
  // ADS: weapon to the cheek, head tilted onto the stock.
  const ads = st.ads * armed;
  if (ads > 0.001) {
    const lw = 1 - st.pistolW;
    p[P.WPX] += ((0.06 - 0.13) * lw + (0.03 - 0.03) * st.pistolW) * ads;
    p[P.WPY] += ((0.25 - 0.19) * lw + (0.22 - 0.17) * st.pistolW) * ads;
    p[P.WPZ] += ((-0.1 + 0.13) * lw + (-0.06 + 0.12) * st.pistolW) * ads;
    p[P.NPITCH] -= 0.07 * ads * lw;
    p[P.NROLL] -= 0.14 * ads * lw;
    p[P.WAIM] += (1 - p[P.WAIM]) * ads;
  }
  // Reload: tilt the weapon, support hand goes to the pouch and back.
  if (st.reload > 0.001 && armed > 0.01) {
    const r = st.reload * armed;
    const u = (st.reloadT % 2.2) / 2.2;
    const away = smooth(u / 0.18) * (1 - smooth((u - 0.82) / 0.18));
    const atPouch = smooth((u - 0.25) / 0.15) * (1 - smooth((u - 0.55) / 0.15));
    p[P.WROLL] += 0.5 * r;
    p[P.WPITCH] += 0.14 * r;
    p[P.WPY] -= 0.05 * r;
    p[P.WPX] -= 0.04 * r;
    p[P.WAIM] *= 1 - 0.6 * r;
    p[P.LGRIP] *= 1 - away * r;
    const mx = 0.04 - 0.12 * atPouch, my = 0.0 - 0.12 * atPouch, mz = -0.33 + 0.1 * atPouch;
    const blend = away * r;
    p[P.LCX] += (mx - p[P.LCX]) * blend;
    p[P.LCY] += (my - p[P.LCY]) * blend;
    p[P.LCZ] += (mz - p[P.LCZ]) * blend;
    p[P.LRW] *= 1 - blend;
    p[P.NPITCH] -= 0.18 * r;
  }
  // Healing: weapon away, hands working at the chest, head down.
  if (st.heal > 0.001) {
    const h = st.heal;
    const tt = gen.time * 6;
    p[P.WHOLSTER] += (1 - p[P.WHOLSTER]) * h;
    p[P.LGRIP] *= 1 - h;
    p[P.RGRIP] *= 1 - h;
    p[P.LRW] *= 1 - h;
    p[P.RRW] *= 1 - h;
    const lx = -0.07 + 0.04 * Math.sin(tt), rx = 0.06 - 0.04 * Math.sin(tt);
    const y = -0.02 + 0.03 * Math.cos(tt);
    p[P.LCX] += (lx - p[P.LCX]) * h; p[P.LCY] += (y - p[P.LCY]) * h; p[P.LCZ] += (-0.3 - p[P.LCZ]) * h;
    p[P.RCX] += (rx - p[P.RCX]) * h; p[P.RCY] += (y - p[P.RCY]) * h; p[P.RCZ] += (-0.3 - p[P.RCZ]) * h;
    p[P.NPITCH] -= 0.42 * h;
  }
  // Weapon draw: comes from the slung position.
  if (st.holsterDraw > 0) p[P.WHOLSTER] = Math.max(p[P.WHOLSTER], smooth(st.holsterDraw));
  // Lean (Q/E): upper body tilts, head stays more level.
  if (Math.abs(st.lean) > 0.001) {
    p[P.SROLL] += 0.22 * st.lean;
    p[P.CROLL] += 0.15 * st.lean;
    p[P.HX] -= 0.03 * st.lean;
    p[P.NROLL] -= 0.16 * st.lean;
  }
  // Weapon kick.
  p[P.WPZ] += 0.05 * st.kickX;
  p[P.WPITCH] += 0.1 * st.kickX;
  p[P.CPITCH] += 0.025 * st.kickX;
  // Hit flinch: torso jerks along the bullet direction.
  p[P.SPITCH] += 0.25 * st.flinchBz * st.flinchX;
  p[P.SROLL] -= 0.2 * st.flinchBx * st.flinchX;
  p[P.NPITCH] += 0.18 * st.flinchBz * st.flinchX;
  // Clamp blend-sensitive weights.
  p[P.LGRIP] = sat(p[P.LGRIP]);
  p[P.RGRIP] = sat(p[P.RGRIP]);
  p[P.WHOLSTER] = sat(p[P.WHOLSTER]);

  st.pose.set(p);
  st.initialized = true;
}

/** Enter the dead state: snapshot the live pose and choose the fall (away from the last hit). */
function beginDeath(st: AnimState): void {
  st.dead = true;
  st.deathStart.set(st.pose);
  st.deathFromLying = st.pose[P.HY] < 0.5;
  const rnd = hashFloat(st.seed, 1313);
  if (st.lastHitAge < 2) {
    st.deathFallSign = st.lastHitBz >= 0 ? 1 : -1;
    st.deathSide = Math.max(-1, Math.min(1, st.lastHitBx * 1.5));
  } else {
    st.deathFallSign = rnd < 0.55 ? 1 : -1;
    st.deathSide = hashFloat(st.seed, 1717) * 2 - 1;
  }
  if (st.deathFromLying) st.deathFallSign = st.deathStart[P.HPITCH] > 0 ? 1 : -1;
  st.deathSpin = (hashFloat(st.seed, 2121) * 2 - 1) * 0.7;
  buildDeathLie(st, st.deathLie);
}

/** 0..1 visibility of a dead body (fade-out after DEATH_FADE_START). */
export function deathVisibility(deadFor: number): number {
  if (deadFor < DEATH_FADE_START) return 1;
  return 1 - sat((deadFor - DEATH_FADE_START) / DEATH_FADE_TIME);
}

/** Metres the dead body has sunk into the ground. */
export function deathSink(deadFor: number): number {
  return deadFor < DEATH_FADE_START ? 0 : 0.35 * sat((deadFor - DEATH_FADE_START) / DEATH_FADE_TIME);
}
