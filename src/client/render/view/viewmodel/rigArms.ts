// First-person arms from the character rig (Quaternius Ultimate Modular, see src/client/assets):
// the local player's own character variant, rendered in the viewmodel scene with everything but
// the arms and hands discarded per vertex (skin weight mask), posed every frame by two-bone IK so
// the wrists follow the viewmodel's hand targets (the procedural hands' transforms, which every
// animation layer already drives: holds, reloads, bolt / pump, items, throws).
//
// Calibration: at the weapon hold the rig must hold the gun exactly like the third-person
// character does. The right wrist therefore comes from the rig's measured weapon socket (weapon
// frame in the right-hand bone), the left wrist from the authored Rifle_Aim / Pistol_Aim_Neutral
// clips (left hand on the handguard / wrapped around the pistol), shifted to each gun's support
// point. A per-gun calibration maps the procedural hand frame to the rig wrist frame, so every
// other pose (items, throws, reload paths) carries over unchanged.

import * as THREE from 'three';
import {
  CHARACTER_VARIANT_IDS, cloneSkinned, getCharacterClip, loadCharacter,
  type CharacterAsset, type CharacterVariantId,
} from '../../../assets';
import { hash32 } from '../../../../shared/rng';
import { solveTwoBone } from '../cameraMath';
import type { GunModel } from './guns';

/** Bones whose skin weight keeps a vertex visible (upper arm down to the finger tips). */
const ARM_BONE = /^(UpperArm|LowerArm|Wrist|Index\d|Middle\d|Ring\d|Pinky\d|Thumb\d)[LR]$/;
const FINGER_BONE = /^(Index|Middle|Ring|Pinky|Thumb)\d[LR]$/;
/** Where the right upper-arm joint sits in viewmodel camera space (left is mirrored). */
const SHOULDER_R = new THREE.Vector3(0.19, -0.23, 0.04);
/** Arm bones may stretch this much (viewmodel arms are traditionally a little long). */
const MAX_STRETCH = 1.22;

/** Same deterministic pick as the third-person character library (render/entities). */
export function variantForPlayer(playerId: number): CharacterVariantId {
  return CHARACTER_VARIANT_IDS[hash32(playerId, 0xc4a7) % CHARACTER_VARIANT_IDS.length];
}

interface Side {
  upper: THREE.Bone;
  lower: THREE.Bone;
  wrist: THREE.Bone;
  middle1: THREE.Bone | null;
  restUpperPos: THREE.Vector3;
  restUpperQ: THREE.Quaternion;
  restLowerPos: THREE.Vector3;
  restLowerQ: THREE.Quaternion;
  restWristPos: THREE.Vector3;
  restWristQ: THREE.Quaternion;
  /** Bone lengths at rest, world units. */
  a: number;
  b: number;
  pole: THREE.Vector3;
}

interface Calib {
  right: THREE.Matrix4;
  left: THREE.Matrix4;
  pistol: boolean;
}

// Scratch
const m1 = new THREE.Matrix4();
const m2 = new THREE.Matrix4();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const q3 = new THREE.Quaternion();
const sc = new THREE.Vector3();
const elbow = { x: 0, y: 0, z: 0 };
const shoulderOut = { x: 0, y: 0, z: 0 };

export class RigArms {
  readonly root: THREE.Object3D;
  readonly variant: CharacterVariantId;
  private readonly material: THREE.Material;
  private readonly geometry: THREE.BufferGeometry;
  private readonly R: Side;
  private readonly L: Side;
  private readonly fingers: THREE.Bone[] = [];
  private readonly fingerRifle = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly fingerPistol = new Map<THREE.Bone, THREE.Quaternion>();
  /** Right wrist in the weapon frame (inverse of the rig's weapon socket). */
  private readonly rightInGun = new THREE.Matrix4();
  /** Left wrist in the weapon frame for a rifle hold / a two-handed pistol hold. */
  private readonly leftRifle = new THREE.Matrix4();
  private readonly leftPistol = new THREE.Matrix4();
  /** Left palm point (weapon frame) of the rifle hold, used to shift onto each gun's support. */
  private readonly leftRiflePalm = new THREE.Vector3();
  private readonly calibs = new WeakMap<GunModel, Calib>();
  private pistolFingers: boolean | null = null;

  private constructor(asset: CharacterAsset, parent: THREE.Object3D) {
    this.variant = asset.variant.id;
    const root = cloneSkinned(asset.template);
    root.name = 'vm-rig-arms';
    this.root = root;
    const byName = new Map<string, THREE.Object3D>();
    let body: THREE.SkinnedMesh | null = null;
    let bodyVerts = -1;
    root.traverse((o) => {
      if (!byName.has(o.name)) byName.set(o.name, o);
      const sm = o as THREE.SkinnedMesh;
      if (sm.isMesh) sm.frustumCulled = false;
      if (sm.isSkinnedMesh && o.name !== asset.variant.teamMesh) {
        const n = sm.geometry.getAttribute('position').count;
        if (n > bodyVerts) { bodyVerts = n; body = sm; }
      }
    });
    // The team armband sits on the left upper arm, out of view: hide it.
    const band = byName.get(asset.variant.teamMesh);
    if (band) band.visible = false;
    if (!body) throw new Error('character has no body mesh');
    const mesh = body as THREE.SkinnedMesh;
    const bone = (n: string): THREE.Bone => {
      const b = byName.get(n) as THREE.Bone | undefined;
      if (!b || !b.isBone) throw new Error(`missing bone ${n}`);
      return b;
    };

    // Own geometry (adds the arm mask attribute without touching the shared asset).
    this.geometry = mesh.geometry.clone();
    this.geometry.setAttribute('armW', armMask(this.geometry, mesh.skeleton));
    mesh.geometry = this.geometry;
    this.material = maskedMaterial(mesh.material as THREE.Material);
    mesh.material = this.material;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    mesh.skeleton.pose();
    root.updateMatrixWorld(true);
    // Put the right shoulder joint at SHOULDER_R (root-local == parent-local: no root rotation).
    const upperR = bone('UpperArmR');
    upperR.getWorldPosition(v1);
    root.position.copy(SHOULDER_R).sub(v1);
    parent.add(root);
    root.updateMatrixWorld(true);

    const side = (s: 'L' | 'R', pole: THREE.Vector3): Side => {
      const upper = bone(`UpperArm${s}`), lower = bone(`LowerArm${s}`), wrist = bone(`Wrist${s}`);
      const middle1 = (byName.get(`Middle1${s}`) as THREE.Bone | undefined) ?? null;
      upper.getWorldPosition(v1);
      lower.getWorldPosition(v2);
      wrist.getWorldPosition(v3);
      return {
        upper, lower, wrist, middle1,
        restUpperPos: upper.position.clone(), restUpperQ: upper.quaternion.clone(),
        restLowerPos: lower.position.clone(), restLowerQ: lower.quaternion.clone(),
        restWristPos: wrist.position.clone(), restWristQ: wrist.quaternion.clone(),
        a: v1.distanceTo(v2), b: v2.distanceTo(v3), pole,
      };
    };
    this.R = side('R', new THREE.Vector3(0.8, -1, 0.25));
    this.L = side('L', new THREE.Vector3(-0.8, -1, 0.25));
    root.traverse((o) => { if ((o as THREE.Bone).isBone && FINGER_BONE.test(o.name)) this.fingers.push(o as THREE.Bone); });

    // Weapon socket (weapon frame in the right-hand bone, scale-compensated like loader.ts).
    const s = asset.rig.socket;
    this.R.wrist.getWorldScale(sc);
    m1.compose(v1.fromArray(s.position), q1.fromArray(s.quaternion), v2.set(1 / sc.x, 1 / sc.y, 1 / sc.z));
    this.rightInGun.copy(m1).invert();

    // Hold poses from the rig's own clips: finger curls + the left wrist relative to the gun.
    this.sampleHold(asset, mesh, 'aimRifle', this.fingerRifle, this.leftRifle, true);
    this.sampleHold(asset, mesh, 'aimPistol', this.fingerPistol, this.leftPistol, false);
    this.resetArms();
  }

  /** Load the variant and build the arms under `parent`; null when the asset is unusable. */
  static async load(variant: CharacterVariantId, parent: THREE.Object3D): Promise<RigArms | null> {
    const asset = await loadCharacter(variant);
    if (!asset) return null;
    try {
      return new RigArms(asset, parent);
    } catch (err) {
      console.warn('[viewmodel] rig arms unavailable:', err);
      return null;
    }
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /**
   * Pose both arms. `rightHand` / `leftHand` are the procedural hand targets (children of the same
   * parent as the rig root, poses already set); `gun` is the shown gun or null (fists / items).
   */
  pose(rightHand: THREE.Object3D, leftHand: THREE.Object3D, gun: GunModel | null, fallbackGun: GunModel): void {
    const calib = this.calibFor(gun ?? fallbackGun);
    if (this.pistolFingers !== calib.pistol) {
      this.pistolFingers = calib.pistol;
      const pose = calib.pistol ? this.fingerPistol : this.fingerRifle;
      for (const f of this.fingers) {
        const q = pose.get(f);
        if (q) f.quaternion.copy(q);
      }
    }
    this.resetArms();
    const parent = this.root.parent!;
    parent.updateMatrixWorld(true);
    this.root.updateMatrixWorld(true);
    this.solveSide(this.R, rightHand, calib.right, parent);
    this.solveSide(this.L, leftHand, calib.left, parent);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  // ----------------------------------------------------------------------------------------------

  private resetArms(): void {
    for (const s of [this.R, this.L]) {
      s.upper.position.copy(s.restUpperPos);
      s.upper.quaternion.copy(s.restUpperQ);
      s.lower.position.copy(s.restLowerPos);
      s.lower.quaternion.copy(s.restLowerQ);
      s.wrist.position.copy(s.restWristPos);
      s.wrist.quaternion.copy(s.restWristQ);
    }
  }

  /** Hand target (parent space) * calibration -> wrist target; two-bone IK + wrist orientation. */
  private solveSide(s: Side, hand: THREE.Object3D, calib: THREE.Matrix4, parent: THREE.Object3D): void {
    hand.updateMatrix();
    // Wrist target in world space.
    m1.multiplyMatrices(parent.matrixWorld, hand.matrix).multiply(calib);
    m1.decompose(v3, q3, sc); // v3 = wrist position, q3 = wrist orientation
    s.upper.updateWorldMatrix(true, false);
    s.upper.getWorldPosition(v1); // shoulder joint
    // Stretch the arm a little when the target is out of reach.
    const dist = v1.distanceTo(v3);
    const k = Math.min(MAX_STRETCH, Math.max(1, dist / ((s.a + s.b) * 0.985)));
    s.lower.position.copy(s.restLowerPos).multiplyScalar(k);
    s.wrist.position.copy(s.restWristPos).multiplyScalar(k);
    solveTwoBone(v1.x, v1.y, v1.z, v3.x, v3.y, v3.z, s.a * k, s.b * k, s.pole.x, s.pole.y, s.pole.z, elbow, shoulderOut);
    // Shoulder pulled toward the target when even the stretched arm cannot reach.
    if (Math.abs(shoulderOut.x - v1.x) + Math.abs(shoulderOut.y - v1.y) + Math.abs(shoulderOut.z - v1.z) > 1e-5) {
      v2.set(shoulderOut.x, shoulderOut.y, shoulderOut.z);
      s.upper.parent!.worldToLocal(v2);
      s.upper.position.copy(v2);
      s.upper.updateWorldMatrix(false, false);
      v1.set(shoulderOut.x, shoulderOut.y, shoulderOut.z);
    }
    // Upper arm: swing its child direction onto shoulder -> elbow.
    this.aimBone(s.upper, s.lower, v1, v2.set(elbow.x, elbow.y, elbow.z));
    // Forearm: swing onto elbow -> wrist.
    this.aimBone(s.lower, s.wrist, v2.set(elbow.x, elbow.y, elbow.z), v3);
    // Wrist orientation: world target -> local.
    s.lower.updateWorldMatrix(false, false);
    s.lower.getWorldQuaternion(q1);
    s.wrist.quaternion.copy(q1.invert().multiply(q3));
    s.wrist.updateMatrixWorld(true);
  }

  /** Rotate `bone` (minimal swing) so the direction to `child` points from `from` to `to`. */
  private aimBone(bone: THREE.Bone, child: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3): void {
    bone.updateWorldMatrix(true, false);
    child.updateWorldMatrix(false, false);
    const bx = bone.matrixWorld.elements[12], by = bone.matrixWorld.elements[13], bz = bone.matrixWorld.elements[14];
    const cx = child.matrixWorld.elements[12], cy = child.matrixWorld.elements[13], cz = child.matrixWorld.elements[14];
    const ax = cx - bx, ay = cy - by, az = cz - bz;
    const al = Math.hypot(ax, ay, az) || 1;
    const tx = to.x - from.x, ty = to.y - from.y, tz = to.z - from.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    q1.setFromUnitVectors(sc.set(ax / al, ay / al, az / al), elbowDir.set(tx / tl, ty / tl, tz / tl));
    bone.getWorldQuaternion(q2);
    q2.premultiply(q1);
    bone.parent!.getWorldQuaternion(q1);
    bone.quaternion.copy(q1.invert().multiply(q2));
    bone.updateWorldMatrix(false, true);
  }

  /** Sample a hold clip at t = 0: finger curls and the left wrist relative to the weapon frame. */
  private sampleHold(
    asset: CharacterAsset, mesh: THREE.SkinnedMesh, key: 'aimRifle' | 'aimPistol',
    fingers: Map<THREE.Bone, THREE.Quaternion>, leftInGun: THREE.Matrix4, rifle: boolean,
  ): void {
    const clip = getCharacterClip(asset, key, 'full');
    mesh.skeleton.pose();
    if (clip) {
      const mixer = new THREE.AnimationMixer(this.root);
      const action = mixer.clipAction(clip);
      action.play();
      mixer.setTime(0);
      mixer.stopAllAction();
      mixer.uncacheRoot(this.root);
    }
    this.root.updateMatrixWorld(true);
    for (const f of this.fingers) fingers.set(f, f.quaternion.clone());
    // Gun frame in world = right wrist * socket; left wrist in the gun frame.
    m1.copy(this.R.wrist.matrixWorld).multiply(m2.copy(this.rightInGun).invert());
    m1.invert();
    leftInGun.multiplyMatrices(m1, this.L.wrist.matrixWorld);
    if (rifle) {
      // Palm point: half way from the wrist to the middle knuckle.
      this.L.wrist.getWorldPosition(v1);
      if (this.L.middle1) this.L.middle1.getWorldPosition(v2);
      else v2.copy(v1);
      this.leftRiflePalm.copy(v1).add(v2).multiplyScalar(0.5).applyMatrix4(m1);
    }
    mesh.skeleton.pose();
  }

  private calibFor(gun: GunModel): Calib {
    let c = this.calibs.get(gun);
    if (c) return c;
    const pistol = gun.id === 'pistol';
    // Right: rig wrist in the gun frame (fist centre at the procedural grip centre for box guns).
    const fist = gun.shared ? v1.set(0, 0, 0) : v1.set(0, -0.038, 0);
    const rigRight = new THREE.Matrix4().makeTranslation(fist.x, fist.y, fist.z).multiply(this.rightInGun);
    const boxRight = new THREE.Matrix4().compose(gun.gripOffset, q1.setFromEuler(gun.gripRot), v2.set(1, 1, 1));
    const right = boxRight.invert().multiply(rigRight);
    // Left: clip hold, shifted so the palm lands under the gun's support point.
    let rigLeft: THREE.Matrix4;
    if (pistol) {
      rigLeft = this.leftPistol.clone();
    } else {
      v3.copy(gun.support).y -= 0.012;
      v3.sub(this.leftRiflePalm);
      rigLeft = new THREE.Matrix4().makeTranslation(v3.x, v3.y, v3.z).multiply(this.leftRifle);
    }
    const boxLeft = new THREE.Matrix4().compose(gun.support, q1.setFromEuler(gun.supportRot), v2.set(1, 1, 1));
    const left = boxLeft.invert().multiply(rigLeft);
    c = { right, left, pistol };
    this.calibs.set(gun, c);
    return c;
  }
}

const elbowDir = new THREE.Vector3();

/** Per-vertex weight of arm / hand bones (1 = fully arm). */
function armMask(geom: THREE.BufferGeometry, skeleton: THREE.Skeleton): THREE.BufferAttribute {
  const idx = geom.getAttribute('skinIndex');
  const w = geom.getAttribute('skinWeight');
  const n = geom.getAttribute('position').count;
  const arm = skeleton.bones.map((b) => ARM_BONE.test(b.name));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const bi = idx.getComponent(i, k);
      if (arm[bi]) s += w.getComponent(i, k);
    }
    out[i] = s;
  }
  return new THREE.BufferAttribute(out, 1);
}

/** Clone of the outfit material that discards everything but the arms. */
function maskedMaterial(src: THREE.Material): THREE.Material {
  const mat = src.clone();
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float armW;\nvarying float vArmW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvArmW = armW;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vArmW;')
      .replace('void main() {', 'void main() {\n  if (vArmW < 0.5) discard;');
  };
  mat.customProgramCacheKey = () => 'vm-rig-arms';
  return mat;
}
