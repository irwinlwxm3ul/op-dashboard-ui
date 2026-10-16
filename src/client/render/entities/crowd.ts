// Character drawables for the three LODs:
//   * NearSoldier: pooled SkinnedMesh (one draw call each) using the shared near geometry; gear and
//     weapon variants are switched by zero-scaling their bones; own material for colours / fade.
//   * MidCrowd: one InstancedMesh per coarse body part shared by all mid-LOD soldiers, instance
//     matrices = root * bone matrix from the same rig.
//   * FarCrowd: one InstancedMesh of team-tinted capsule silhouettes, no fog.
// All writes are allocation free; counts are reset every frame with begin()/end().

import * as THREE from 'three';
import { MAX_PLAYERS } from '../../../shared/constants';
import type { WeaponId } from '../../../shared/types';
import type { BodyFrame, MidBodyRenderer, NearBody, NearBodyProvider } from './bodies';
import { type EntityUniforms, type InstanceAttributes, addInstanceAttributes, createEntityMaterial } from './materials';
import { B } from './rig';
import {
  MID_HELMET_TINT, MID_VEST_TINT, NB_HELMET0, NB_PACK1, NB_VEST1, NB_WEAPON0, NEAR_BONE_BASE, NEAR_BONE_COUNT,
  buildFarImpostor, buildMidParts, buildNearSoldierGeometry,
} from './soldierModel';
import { WEAPON_HOLD, WEAPON_IDS } from './weaponModels';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4();
const _s = new THREE.Matrix4();

type EntityMaterial = THREE.MeshLambertMaterial & { userData: { uniforms: EntityUniforms } };

/** Loadout / look of one soldier for a frame. */
export interface SoldierLook {
  accent: THREE.Color;
  /** Fatigue tint (upper body; also the legs on the near procedural soldier). */
  cloth: THREE.Color;
  /** Lower-body tint used by the mid LOD (matches asset-based near bodies' trousers). */
  legs: THREE.Color;
  skin: THREE.Color;
  /** [helmet, vest, pack] levels */
  gear: readonly [number, number, number];
  /** Weapon shown in hands / slung (null = none). */
  weapon: WeaponId | null;
}

// ---------------------------------------------------------------------------
// Near
// ---------------------------------------------------------------------------

export class NearSoldier implements NearBody {
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[] = [];
  readonly uniforms: EntityUniforms;
  ownerId = -1;
  private readonly material: EntityMaterial;

  constructor(geometry: THREE.BufferGeometry) {
    this.material = createEntityMaterial({ mask: true, dither: true, rim: true, fogScale: 0.35 });
    this.uniforms = this.material.userData.uniforms;
    this.mesh = new THREE.SkinnedMesh(geometry, this.material);
    this.mesh.name = 'soldier-near';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = true;
    // Generous fixed bound around the feet (covers lying / reaching poses); avoids per-frame
    // recomputation from skinned vertices.
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.7, 0), 1.9);
    const inverses: THREE.Matrix4[] = [];
    for (let i = 0; i < NEAR_BONE_COUNT; i++) {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      this.bones.push(b);
      this.mesh.add(b);
      inverses.push(new THREE.Matrix4());
    }
    // Parts are modelled in bone space, so the bind pose is the identity for every bone.
    this.mesh.bind(new THREE.Skeleton(this.bones, inverses), new THREE.Matrix4());
    this.mesh.visible = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  setLook(look: SoldierLook): void {
    this.uniforms.uAccent.value.copy(look.accent);
    this.uniforms.uCloth.value.copy(look.cloth);
    this.uniforms.uSkin.value.copy(look.skin);
  }

  /** Pose the soldier from the procedural rig (bone matrices in model space). */
  apply(f: BodyFrame): void {
    const look = f.look, rig = f.rig, fade = f.fade;
    this.setLook(look);
    this.mesh.matrix.copy(f.root);
    this.mesh.matrixWorldNeedsUpdate = true;
    const [helmet, vest, pack] = look.gear;
    const wIdx = f.showWeapon && look.weapon ? WEAPON_IDS.indexOf(look.weapon) : -1;
    for (let i = 0; i < NEAR_BONE_COUNT; i++) {
      const bone = this.bones[i];
      let visible = true;
      if (i >= NB_HELMET0 && i < NB_VEST1) visible = i - NB_HELMET0 === helmet;
      else if (i >= NB_VEST1 && i < NB_PACK1) visible = i - NB_VEST1 + 1 === vest;
      else if (i >= NB_PACK1 && i < NB_WEAPON0) visible = i - NB_PACK1 + 1 === pack;
      else if (i >= NB_WEAPON0) visible = i - NB_WEAPON0 === wIdx;
      if (visible) bone.matrix.copy(rig[NEAR_BONE_BASE[i]]);
      else bone.matrix.copy(ZERO);
      bone.matrixWorldNeedsUpdate = true;
    }
    this.uniforms.uFade.value = fade;
    this.mesh.castShadow = f.shadows && fade > 0.5;
    this.mesh.visible = fade !== 0;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.skeleton.dispose();
  }
}

/** Procedural near-LOD backend: pool of skinned procedural soldiers sharing one geometry. */
export class NearPool implements NearBodyProvider {
  readonly name = 'procedural';
  private geometry = buildNearSoldierGeometry();
  private readonly all: NearSoldier[] = [];
  private readonly free: NearSoldier[] = [];

  constructor(private readonly parent: THREE.Object3D, private capacity: number) {}

  setCapacity(n: number): void {
    this.capacity = n;
  }

  /** Rebuild the shared soldier geometry (e.g. after real weapon models were registered). */
  rebuildGeometry(): void {
    const old = this.geometry;
    this.geometry = buildNearSoldierGeometry();
    for (const s of this.all) s.mesh.geometry = this.geometry;
    old.dispose();
  }

  get inUse(): number {
    return this.all.length - this.free.length;
  }

  /** Acquire a soldier (lazily created up to capacity). Null when the pool is exhausted. */
  acquire(ownerId: number): NearSoldier | null {
    let s = this.free.pop();
    if (!s) {
      if (this.all.length >= this.capacity) return null;
      s = new NearSoldier(this.geometry);
      this.all.push(s);
      this.parent.add(s.mesh);
    }
    s.ownerId = ownerId;
    return s;
  }

  release(body: NearBody): void {
    const s = body as NearSoldier;
    s.ownerId = -1;
    s.hide();
    this.free.push(s);
  }

  dispose(): void {
    for (const s of this.all) {
      this.parent.remove(s.mesh);
      s.dispose();
    }
    this.all.length = 0;
    this.free.length = 0;
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Mid
// ---------------------------------------------------------------------------

interface InstancedPart {
  mesh: THREE.InstancedMesh;
  attrs: InstanceAttributes;
  count: number;
  capacity: number;
}

function makePart(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number, name: string): InstancedPart {
  const attrs = addInstanceAttributes(geo, capacity);
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  return { mesh, attrs, count: 0, capacity };
}

function pushInstance(part: InstancedPart, m: THREE.Matrix4, accent: THREE.Color, cloth: THREE.Color, fade: number): void {
  if (part.count >= part.capacity) return;
  const i = part.count++;
  m.toArray(part.mesh.instanceMatrix.array as Float32Array, i * 16);
  const a = part.attrs.accent.array as Float32Array;
  a[i * 3] = accent.r; a[i * 3 + 1] = accent.g; a[i * 3 + 2] = accent.b;
  const c = part.attrs.cloth.array as Float32Array;
  c[i * 3] = cloth.r; c[i * 3 + 1] = cloth.g; c[i * 3 + 2] = cloth.b;
  (part.attrs.fade.array as Float32Array)[i] = fade;
}

function finishPart(part: InstancedPart): void {
  part.mesh.count = part.count;
  part.mesh.visible = part.count > 0;
  if (part.count > 0) {
    part.mesh.instanceMatrix.clearUpdateRanges();
    part.mesh.instanceMatrix.addUpdateRange(0, part.count * 16);
    part.mesh.instanceMatrix.needsUpdate = true;
    part.attrs.accent.clearUpdateRanges();
    part.attrs.accent.addUpdateRange(0, part.count * 3);
    part.attrs.accent.needsUpdate = true;
    part.attrs.cloth.clearUpdateRanges();
    part.attrs.cloth.addUpdateRange(0, part.count * 3);
    part.attrs.cloth.needsUpdate = true;
    part.attrs.fade.clearUpdateRanges();
    part.attrs.fade.addUpdateRange(0, part.count);
    part.attrs.fade.needsUpdate = true;
  }
}

const PACK_SCALE: readonly number[] = [0, 0.78, 1, 1.22];
const HELMET_SCALE: readonly number[] = [0, 0.94, 1, 1.07];

/** Procedural mid-LOD backend: coarse parts, one InstancedMesh per part for all soldiers. */
export class MidCrowd implements MidBodyRenderer {
  readonly name = 'procedural';
  private readonly material = createEntityMaterial({ mask: true, instanced: true, dither: true, rim: true, fogScale: 0.3 });
  private readonly parts: InstancedPart[] = [];
  private readonly pelvis: InstancedPart;
  private readonly torso: InstancedPart;
  private readonly vest: InstancedPart;
  private readonly head: InstancedPart;
  private readonly helmet: InstancedPart;
  private readonly pack: InstancedPart;
  private readonly upperArm: InstancedPart;
  private readonly foreArm: InstancedPart;
  private readonly thigh: InstancedPart;
  private readonly shin: InstancedPart;
  private readonly longGun: InstancedPart;
  private readonly pistol: InstancedPart;
  private readonly vestTints: THREE.Color[] = MID_VEST_TINT.map((h) => new THREE.Color(h));
  private readonly helmetTints: THREE.Color[] = MID_HELMET_TINT.map((h) => new THREE.Color(h));
  private readonly white = new THREE.Color(1, 1, 1);

  constructor(parent: THREE.Object3D, maxSoldiers = MAX_PLAYERS) {
    const g = buildMidParts();
    const one = maxSoldiers, two = maxSoldiers * 2;
    const mk = (geo: THREE.BufferGeometry, cap: number, name: string): InstancedPart => {
      const p = makePart(geo, this.material, cap, name);
      this.parts.push(p);
      parent.add(p.mesh);
      return p;
    };
    this.pelvis = mk(g.pelvis, one, 'mid-pelvis');
    this.torso = mk(g.torso, one, 'mid-torso');
    this.vest = mk(g.vest, one, 'mid-vest');
    this.head = mk(g.head, one, 'mid-head');
    this.helmet = mk(g.helmet, one, 'mid-helmet');
    this.pack = mk(g.pack, one, 'mid-pack');
    this.upperArm = mk(g.upperArm, two, 'mid-uarm');
    this.foreArm = mk(g.foreArm, two, 'mid-farm');
    this.thigh = mk(g.thigh, two, 'mid-thigh');
    this.shin = mk(g.shin, two, 'mid-shin');
    this.longGun = mk(g.longGun, one, 'mid-longgun');
    this.pistol = mk(g.pistol, one, 'mid-pistol');
  }

  begin(): void {
    for (const p of this.parts) p.count = 0;
  }

  private put(part: InstancedPart, root: THREE.Matrix4, bone: THREE.Matrix4, accent: THREE.Color, tint: THREE.Color, fade: number): void {
    _m.multiplyMatrices(root, bone);
    pushInstance(part, _m, accent, tint, fade);
  }

  add(f: BodyFrame): void {
    const root = f.root, rig = f.rig, look = f.look, showWeapon = f.showWeapon, fade = f.fade;
    if (fade === 0) return;
    const acc = look.accent, cloth = look.cloth, legs = look.legs, white = this.white;
    this.put(this.pelvis, root, rig[B.HIPS], acc, legs, fade);
    this.put(this.torso, root, rig[B.CHEST], acc, cloth, fade);
    this.put(this.head, root, rig[B.HEAD], acc, white, fade);
    this.put(this.upperArm, root, rig[B.UARM_L], acc, cloth, fade);
    this.put(this.upperArm, root, rig[B.UARM_R], acc, cloth, fade);
    this.put(this.foreArm, root, rig[B.FARM_L], acc, cloth, fade);
    this.put(this.foreArm, root, rig[B.FARM_R], acc, cloth, fade);
    this.put(this.thigh, root, rig[B.THIGH_L], acc, legs, fade);
    this.put(this.thigh, root, rig[B.THIGH_R], acc, legs, fade);
    this.put(this.shin, root, rig[B.SHIN_L], acc, legs, fade);
    this.put(this.shin, root, rig[B.SHIN_R], acc, legs, fade);
    const helmet = look.gear[0], vest = look.gear[1], pack = look.gear[2];
    if (vest > 0) this.put(this.vest, root, rig[B.CHEST], acc, this.vestTints[Math.min(3, vest)], fade);
    if (helmet > 0) {
      const s = HELMET_SCALE[Math.min(3, helmet)];
      _s.makeScale(s, s, s);
      _m.multiplyMatrices(root, rig[B.HEAD]).multiply(_s);
      pushInstance(this.helmet, _m, acc, this.helmetTints[Math.min(3, helmet)], fade);
    }
    if (pack > 0) {
      const s = PACK_SCALE[Math.min(3, pack)];
      _s.makeScale(s, s, 1 + (s - 1) * 0.6);
      _m.multiplyMatrices(root, rig[B.CHEST]).multiply(_s);
      pushInstance(this.pack, _m, acc, white, fade);
    }
    if (showWeapon && look.weapon) {
      const hold = WEAPON_HOLD[look.weapon];
      if (hold.pistol) {
        this.put(this.pistol, root, rig[B.WEAPON], acc, white, fade);
      } else {
        _s.makeScale(1, 1, hold.length / 0.9);
        _m.multiplyMatrices(root, rig[B.WEAPON]).multiply(_s);
        pushInstance(this.longGun, _m, acc, white, fade);
      }
    }
  }

  end(): void {
    for (const p of this.parts) finishPart(p);
  }

  clear(): void {
    this.begin();
    this.end();
  }

  dispose(): void {
    for (const p of this.parts) {
      p.mesh.removeFromParent();
      p.mesh.geometry.dispose();
      p.mesh.dispose();
    }
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Far
// ---------------------------------------------------------------------------

export class FarCrowd {
  private readonly material = createEntityMaterial({ mask: true, instanced: true, dither: true, rim: true, fogScale: 0 });
  private readonly part: InstancedPart;
  private readonly white = new THREE.Color(1, 1, 1);

  constructor(parent: THREE.Object3D, capacity = MAX_PLAYERS + 16) {
    this.part = makePart(buildFarImpostor(), this.material, capacity, 'soldier-far');
    parent.add(this.part.mesh);
  }

  begin(): void {
    this.part.count = 0;
  }

  /** `m` = full model->world matrix (including stance shaping and min-size scale). */
  add(m: THREE.Matrix4, accent: THREE.Color, fade: number): void {
    if (fade === 0) return;
    pushInstance(this.part, m, accent, this.white, fade);
  }

  end(): void {
    finishPart(this.part);
  }

  dispose(): void {
    this.part.mesh.removeFromParent();
    this.part.mesh.geometry.dispose();
    this.part.mesh.dispose();
    this.material.dispose();
  }
}
