// Soldier skeleton: bone layout, rest dimensions and the pose -> bone matrix evaluation (forward
// kinematics for hips/spine/chest/head/legs, weapon placement in aim space, analytic two-bone IK for
// both arms). Every bone matrix is in character model space (feet origin, facing -Z) and maps the
// bone's local part geometry (built around the joint) into model space. Allocation free.

import * as THREE from 'three';
import type { WeaponId } from '../../../shared/types';
import { P, type Pose } from './pose';
import { WEAPON_HOLD } from './weaponModels';

export const B = {
  HIPS: 0,
  SPINE: 1,
  CHEST: 2,
  HEAD: 3,
  UARM_L: 4,
  FARM_L: 5,
  UARM_R: 6,
  FARM_R: 7,
  THIGH_L: 8,
  SHIN_L: 9,
  THIGH_R: 10,
  SHIN_R: 11,
  WEAPON: 12,
} as const;
export const BONE_COUNT = 13;

/** Rest dimensions (metres). */
export const DIM = {
  standHipsY: 0.95,
  hipToSpine: 0.08,
  spineToChest: 0.19,
  chestToNeck: 0.28,
  shoulderX: 0.2,
  shoulderY: 0.23,
  hipJointX: 0.1,
  hipJointY: -0.03,
  thigh: 0.42,
  shin: 0.42,
  foot: 0.08,
  upperArm: 0.3,
  foreArm: 0.31,
  headCenter: 0.14,
} as const;

/** Slung-weapon placement in chest space for long guns (across the back) and pistols (thigh holster). */
const BACK_LONG = { pos: new THREE.Vector3(0.12, -0.12, 0.3), rot: new THREE.Euler(Math.PI / 2, 0, 0.62, 'ZYX') };
const BACK_PISTOL = { pos: new THREE.Vector3(0.21, -0.4, 0.02), rot: new THREE.Euler(-Math.PI / 2 + 0.15, 0, 0, 'YXZ') };

export interface RigInput {
  pose: Pose;
  /** Aim pitch (rad, + up) applied to the weapon (scaled by the pose's WAIM). */
  aimPitch: number;
  /** Aim yaw relative to the model's facing (passengers in vehicles), rad. */
  aimYaw: number;
  /** Held weapon (null = unarmed; weapon matrix still evaluated but unused). */
  weapon: WeaponId | null;
  /** Chest-space depth (z) of the back surface incl. backpack: where a slung long gun rests. */
  slungDepth: number;
}

// Scratch objects (module level: evaluation is synchronous and never re-entrant).
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _local = new THREE.Matrix4();
const _aim = new THREE.Matrix4();
const _back = new THREE.Matrix4();
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _sh = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _chestRot = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _mm = new THREE.Vector3();
const _el = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();

function rotLocal(out: THREE.Matrix4, x: number, y: number, z: number, pitch: number, yaw: number, roll: number): THREE.Matrix4 {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(_v.set(x, y, z), _q, _one);
}

/**
 * Two-bone IK. Shoulder S, target T, pole hint (direction the elbow should point), all in model
 * space. Writes the upper-arm matrix (local -Y along the upper arm, bend in its local YZ plane) and
 * the forearm matrix.
 */
function solveArm(
  S: THREE.Vector3, T: THREE.Vector3, pole: THREE.Vector3,
  upper: THREE.Matrix4, fore: THREE.Matrix4,
): void {
  const a = DIM.upperArm, b = DIM.foreArm;
  _n.subVectors(T, S);
  let d = _n.length();
  if (d < 1e-5) {
    _n.set(0, -1, 0);
    d = 1e-5;
  } else {
    _n.multiplyScalar(1 / d);
  }
  d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 0.02, d));
  const cosA = (a * a + d * d - b * b) / (2 * a * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  // Pole component perpendicular to the shoulder->target line.
  _mm.copy(pole).addScaledVector(_n, -pole.dot(_n));
  if (_mm.lengthSq() < 1e-8) {
    _mm.set(0, 0, 1).addScaledVector(_n, -_n.z);
    if (_mm.lengthSq() < 1e-8) _mm.set(1, 0, 0);
  }
  _mm.normalize();
  // Elbow.
  _el.copy(S).addScaledVector(_n, a * cosA).addScaledVector(_mm, a * sinA);
  _u.subVectors(_el, S).multiplyScalar(1 / a); // upper arm direction
  _tgt.copy(S).addScaledVector(_n, d); // reachable target
  _f.subVectors(_tgt, _el).normalize(); // forearm direction
  // Upper arm basis: local Y = -u, local Z = -(bend direction), X = Y x Z.
  _by.copy(_u).negate();
  _bz.copy(_f).addScaledVector(_u, -_f.dot(_u));
  if (_bz.lengthSq() < 1e-8) _bz.copy(_mm).negate();
  _bz.normalize().negate();
  _bx.crossVectors(_by, _bz).normalize();
  _bz.crossVectors(_bx, _by).normalize();
  upper.makeBasis(_bx, _by, _bz).setPosition(S);
  const elbow = Math.acos(Math.max(-1, Math.min(1, _u.dot(_f))));
  rotLocal(_local, 0, -a, 0, elbow, 0, 0);
  fore.multiplyMatrices(upper, _local);
}

/**
 * Evaluate a pose into bone matrices (model space). `out` must hold BONE_COUNT matrices.
 * Returns `out` for chaining.
 */
export function evaluateRig(inp: RigInput, out: THREE.Matrix4[]): THREE.Matrix4[] {
  const p = inp.pose;
  // --- Hips / spine / chest / head -------------------------------------------------------------
  rotLocal(out[B.HIPS], p[P.HX], p[P.HY], p[P.HZ], p[P.HPITCH], p[P.HYAW], p[P.HROLL]);
  rotLocal(_local, 0, DIM.hipToSpine, 0, p[P.SPITCH], p[P.SYAW], p[P.SROLL]);
  out[B.SPINE].multiplyMatrices(out[B.HIPS], _local);
  rotLocal(_local, 0, DIM.spineToChest, 0, p[P.CPITCH], p[P.CYAW], p[P.CROLL]);
  out[B.CHEST].multiplyMatrices(out[B.SPINE], _local);
  rotLocal(_local, 0, DIM.chestToNeck, 0, p[P.NPITCH], p[P.NYAW], p[P.NROLL]);
  out[B.HEAD].multiplyMatrices(out[B.CHEST], _local);

  // --- Legs -------------------------------------------------------------------------------------
  rotLocal(_local, -DIM.hipJointX, DIM.hipJointY, 0, p[P.LLP], 0, -p[P.LLR]);
  out[B.THIGH_L].multiplyMatrices(out[B.HIPS], _local);
  rotLocal(_local, 0, -DIM.thigh, 0, -p[P.LKNEE], 0, 0);
  out[B.SHIN_L].multiplyMatrices(out[B.THIGH_L], _local);
  rotLocal(_local, DIM.hipJointX, DIM.hipJointY, 0, p[P.RLP], 0, p[P.RLR]);
  out[B.THIGH_R].multiplyMatrices(out[B.HIPS], _local);
  rotLocal(_local, 0, -DIM.thigh, 0, -p[P.RKNEE], 0, 0);
  out[B.SHIN_R].multiplyMatrices(out[B.THIGH_R], _local);

  // --- Weapon -----------------------------------------------------------------------------------
  const chest = out[B.CHEST];
  const hold = inp.weapon ? WEAPON_HOLD[inp.weapon] : WEAPON_HOLD.ar;
  // In-hands placement: pivot (chest space) -> model space; orientation from the aim.
  _pA.set(p[P.WPX], p[P.WPY], p[P.WPZ]).applyMatrix4(chest);
  _e.set(inp.aimPitch * p[P.WAIM] + p[P.WPITCH], inp.aimYaw + p[P.WYAW], p[P.WROLL], 'YXZ');
  _qA.setFromEuler(_e);
  if (hold.pistol) {
    _v.set(0, -0.03, -0.42);
  } else {
    _v.set(-hold.butt[0], -hold.butt[1], -hold.butt[2]);
  }
  _pA.add(_v.applyQuaternion(_qA));
  // Slung placement (chest space).
  const slung = hold.pistol ? BACK_PISTOL : BACK_LONG;
  _back.makeRotationFromEuler(slung.rot).setPosition(slung.pos);
  if (!hold.pistol) _back.elements[14] = inp.slungDepth;
  _back.premultiply(chest);
  _back.decompose(_pB, _qB, _v);
  const h = p[P.WHOLSTER];
  if (h <= 0) {
    _aim.compose(_pA, _qA, _one);
  } else if (h >= 1) {
    _aim.compose(_pB, _qB, _one);
  } else {
    // Arc the gun over the shoulder instead of passing through the torso.
    _pA.lerp(_pB, h);
    _tmp.set(0, 0.22 * Math.sin(h * Math.PI), 0);
    _pA.add(_tmp);
    _q2.copy(_qA).slerp(_qB, h);
    _aim.compose(_pA, _q2, _one);
  }
  out[B.WEAPON].copy(_aim);

  // --- Arms (two-bone IK) -----------------------------------------------------------------------
  _chestRot.extractRotation(chest);
  // Left arm
  _sh.set(-DIM.shoulderX, DIM.shoulderY, 0).applyMatrix4(chest);
  _tgt.set(p[P.LCX], p[P.LCY], p[P.LCZ]).applyMatrix4(chest);
  if (p[P.LRW] > 0) _tgt.lerp(_tmp.set(p[P.LRX], p[P.LRY], p[P.LRZ]), Math.min(1, p[P.LRW]));
  if (p[P.LGRIP] > 0) {
    _grip.set(hold.fore[0], hold.fore[1], hold.fore[2]).applyMatrix4(_aim);
    _tgt.lerp(_grip, Math.min(1, p[P.LGRIP]));
  }
  _pole.set(p[P.LPX], p[P.LPY], p[P.LPZ]).applyMatrix4(_chestRot);
  const tL = _tmp.copy(_tgt);
  solveArm(_sh, tL, _pole, out[B.UARM_L], out[B.FARM_L]);
  // Right arm
  _sh.set(DIM.shoulderX, DIM.shoulderY, 0).applyMatrix4(chest);
  _tgt.set(p[P.RCX], p[P.RCY], p[P.RCZ]).applyMatrix4(chest);
  if (p[P.RRW] > 0) _tgt.lerp(_tmp.set(p[P.RRX], p[P.RRY], p[P.RRZ]), Math.min(1, p[P.RRW]));
  if (p[P.RGRIP] > 0) {
    _grip.set(0, 0, 0).applyMatrix4(_aim);
    _tgt.lerp(_grip, Math.min(1, p[P.RGRIP]));
  }
  _pole.set(p[P.RPX], p[P.RPY], p[P.RPZ]).applyMatrix4(_chestRot);
  const tR = _tmp.copy(_tgt);
  solveArm(_sh, tR, _pole, out[B.UARM_R], out[B.FARM_R]);
  return out;
}

/** Allocate a bone matrix array. */
export function createBoneMatrices(): THREE.Matrix4[] {
  const a: THREE.Matrix4[] = [];
  for (let i = 0; i < BONE_COUNT; i++) a.push(new THREE.Matrix4());
  return a;
}

/** Model-space head centre of an evaluated rig (for nameplate anchors). */
export function headPosition(bones: THREE.Matrix4[], out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, DIM.headCenter, 0).applyMatrix4(bones[B.HEAD]);
}
