// Asset-based near-LOD bodies: the curated CC0 skinned characters (src/client/assets) driven by one
// AnimationMixer per visible near player.
//
//  * Clips come from the manifest's logical key map (CHARACTER_CLIPS): a full-body base state
//    (locomotion speed-matched to the gait cadence, directional variants for strafing / walking
//    backwards) plus an upper-body overlay (weapon hold / aim / shoot / reload / sprint carry,
//    parachute hang) layered over the base clip's lower-body part, with crossfades.
//  * After sampling, the spine (Abdomen + Chest) is rotated so the gun points exactly along the
//    player's aim, and lean / hit flinch / fire kick are added procedurally. Free fall gets its body
//    pitch from the procedural pose (the clip is upright).
//  * Gear (helmet / vest / backpack levels, with the team-colour stripes) and the held or slung gun
//    are ONE extra skinned mesh whose proxy bones ride on the character's Head / Chest bones and
//    the weapon socket. 3 draw calls per character (body, team armband, gear+gun).
//  * Every material gets the entity shader patch (rim light, dither fade, reduced fog).

import * as THREE from 'three';
import {
  CHARACTER_BONES, CHARACTER_CLIPS, CHARACTER_VARIANT_IDS, CHARACTER_VARIANTS, characterVariantFor, createCharacterInstance,
  getCharacterClip, loadCharacter, type CharacterAnimKey, type CharacterAsset, type CharacterInstance,
  type CharacterVariantId,
} from '../../assets';
import { dirFromAngles } from '../../../shared/math';
import type { Vec3 } from '../../../shared/types';
import type { LogicalAnimState } from './animState';
import type { BodyFrame, NearBody, NearBodyProvider } from './bodies';
import { GeoBuilder } from './geometry';
import { type EntityUniforms, applyEntityShader, createEntityUniforms } from './materials';
import { P } from './pose';
import { slungLongGunMatrix } from './rig';
import { SLUNG_DEPTH, buildHelmet, buildPack, buildVest } from './soldierModel';
import { WEAPON_HOLD, WEAPON_IDS, buildWeapon } from './weaponModels';

// ---------------------------------------------------------------------------
// Gear geometry layout (bone indices of the shared gear skinned mesh)
// ---------------------------------------------------------------------------

const G_HELMET1 = 0; // 0..2 helmet level 1..3 (Head)
const G_VEST1 = 3; // 3..5 vest level 1..3 (Chest)
const G_PACK1 = 6; // 6..8 pack level 1..3 (Chest)
const G_WEAPON0 = 9; // 9..14 weapons in WEAPON_IDS order (weapon holder)
const G_COUNT = G_WEAPON0 + WEAPON_IDS.length;

function buildGearGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const I = new THREE.Matrix4();
  for (let l = 1; l <= 3; l++) buildHelmet(l, b, I, G_HELMET1 + l - 1);
  for (let l = 1; l <= 3; l++) buildVest(l, b, I, G_VEST1 + l - 1);
  for (let l = 1; l <= 3; l++) buildPack(l, b, I, G_PACK1 + l - 1);
  WEAPON_IDS.forEach((id, i) => buildWeapon(id, b, I, G_WEAPON0 + i));
  return b.build({ mask: true, skin: true });
}

// ---------------------------------------------------------------------------
// Per-variant fitting data (computed once from the bind pose)
// ---------------------------------------------------------------------------

/** Procedural head (head-bone space): centre and half width; torso (chest-bone space): centre, half size. */
const PROC_HEAD_CENTER = new THREE.Vector3(0, 0.14, -0.006);
const PROC_HEAD_HALF_WIDTH = 0.098;
const PROC_HEAD_HALF_HEIGHT = 0.115;
const PROC_TORSO_CENTER = new THREE.Vector3(0, 0.12, 0);
const PROC_TORSO_HALF = new THREE.Vector3(0.19, 0.16, 0.118);

const UPPER_TINT_BONES = new Set(['Abdomen', 'Torso', 'Chest', 'ShoulderL', 'ShoulderR', 'UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR']);
const LOWER_TINT_BONES = new Set(['Body', 'Hips', 'UpperLegL', 'UpperLegR', 'LowerLegL', 'LowerLegR']);

export interface VariantData {
  id: CharacterVariantId;
  asset: CharacterAsset;
  /** Gear proxy local matrices: helmet under Head, vest / pack under Chest. */
  helmetLocal: THREE.Matrix4;
  torsoLocal: THREE.Matrix4;
  /** Slung long gun under Chest, per backpack level 0..3. */
  slungLocal: THREE.Matrix4[];
  /** Average outfit colours (linear) for tinting the procedural mid LOD. */
  upper: THREE.Color;
  lower: THREE.Color;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

function findBodyMesh(root: THREE.Object3D, teamMesh: string): THREE.SkinnedMesh | null {
  let body: THREE.SkinnedMesh | null = null;
  let bestCount = -1;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || m.name === teamMesh) return;
    const n = m.geometry.getAttribute('position').count;
    if (n > bestCount) {
      bestCount = n;
      body = m;
    }
  });
  return body;
}

function fitVariant(id: CharacterVariantId, asset: CharacterAsset): VariantData | null {
  const inst = createCharacterInstance(asset);
  try {
    inst.root.updateMatrixWorld(true);
    const body = findBodyMesh(inst.root, asset.variant.teamMesh);
    const head = inst.bones.head, chest = inst.bones.chest;
    if (!body || !head || !chest) return null;
    const bones = body.skeleton.bones;
    const pos = body.geometry.getAttribute('position');
    const si = body.geometry.getAttribute('skinIndex');
    const sw = body.geometry.getAttribute('skinWeight');
    const col = body.geometry.getAttribute('color');
    const headBox = new THREE.Box3(), torsoBox = new THREE.Box3();
    const v = new THREE.Vector3();
    let headZ = 0, headN = 0;
    const up = new THREE.Color(0, 0, 0), lo = new THREE.Color(0, 0, 0);
    let upN = 0, loN = 0;
    for (let i = 0; i < pos.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) { bw = w; best = si.getComponent(i, k); }
      }
      const name = bones[best]?.name ?? '';
      body.getVertexPosition(i, v);
      if (name === CHARACTER_BONES.head) {
        headBox.expandByPoint(v);
        headZ += v.z;
        headN++;
      } else if (name === CHARACTER_BONES.chest || name === 'Torso') {
        torsoBox.expandByPoint(v);
      }
      if (col) {
        if (UPPER_TINT_BONES.has(name)) {
          up.r += col.getX(i); up.g += col.getY(i); up.b += col.getZ(i); upN++;
        } else if (LOWER_TINT_BONES.has(name)) {
          lo.r += col.getX(i); lo.g += col.getY(i); lo.b += col.getZ(i); loN++;
        }
      }
    }
    if (headBox.isEmpty() || torsoBox.isEmpty()) return null;
    // Helmet: scale to the head width, sit on top of the head (hair included).
    const hHalf = (headBox.max.x - headBox.min.x) / 2;
    const hs = clamp(hHalf / PROC_HEAD_HALF_WIDTH, 0.9, 1.3);
    const headFit = new THREE.Matrix4()
      .makeTranslation((headBox.min.x + headBox.max.x) / 2, headBox.max.y - PROC_HEAD_HALF_HEIGHT * hs, headZ / Math.max(1, headN))
      .multiply(new THREE.Matrix4().makeScale(hs, hs, hs))
      .multiply(new THREE.Matrix4().makeTranslation(-PROC_HEAD_CENTER.x, -PROC_HEAD_CENTER.y, -PROC_HEAD_CENTER.z));
    const helmetLocal = new THREE.Matrix4().copy(head.matrixWorld).invert().multiply(headFit);
    // Torso: centre + per-axis scale so the vest wraps the chest and the pack sits on the back.
    const tc = torsoBox.getCenter(new THREE.Vector3());
    const th = torsoBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const torsoFit = new THREE.Matrix4()
      .makeTranslation(tc.x, tc.y, tc.z)
      .multiply(new THREE.Matrix4().makeScale(
        clamp(th.x / PROC_TORSO_HALF.x, 0.8, 1.35), clamp(th.y / PROC_TORSO_HALF.y, 0.8, 1.35), clamp(th.z / PROC_TORSO_HALF.z, 0.8, 1.45),
      ))
      .multiply(new THREE.Matrix4().makeTranslation(-PROC_TORSO_CENTER.x, -PROC_TORSO_CENTER.y, -PROC_TORSO_CENTER.z));
    const chestInv = new THREE.Matrix4().copy(chest.matrixWorld).invert();
    const torsoLocal = new THREE.Matrix4().copy(chestInv).multiply(torsoFit);
    // Slung rifle: position through the torso fit, rigid orientation.
    const slungLocal: THREE.Matrix4[] = [];
    const s = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (let lvl = 0; lvl < 4; lvl++) {
      slungLongGunMatrix(SLUNG_DEPTH[lvl], s);
      s.decompose(p, q, sc);
      p.applyMatrix4(torsoFit);
      const world = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
      slungLocal.push(new THREE.Matrix4().copy(chestInv).multiply(world));
    }
    if (upN) up.multiplyScalar(1 / upN); else up.setRGB(0.3, 0.32, 0.25);
    if (loN) lo.multiplyScalar(1 / loN); else lo.copy(up);
    // The procedural mid parts' cloth base colours are light greys: compensate so the tint matches.
    up.multiplyScalar(1.15);
    lo.multiplyScalar(1.4);
    return { id, asset, helmetLocal, torsoLocal, slungLocal, upper: up, lower: lo };
  } finally {
    inst.dispose();
  }
}

/** Every loaded character variant plus the shared gear geometry. */
export class CharacterLibrary {
  readonly gearGeometry = buildGearGeometry();
  private readonly loaded: VariantData[] = [];

  private constructor(readonly variants: ReadonlyMap<CharacterVariantId, VariantData>) {
    variants.forEach((v) => this.loaded.push(v));
  }

  /** Load every variant (in parallel); null when none could be loaded. Never rejects. */
  static async load(): Promise<CharacterLibrary | null> {
    const map = new Map<CharacterVariantId, VariantData>();
    const assets = await Promise.all(CHARACTER_VARIANT_IDS.map((id) => loadCharacter(id).catch(() => null)));
    CHARACTER_VARIANT_IDS.forEach((id, i) => {
      const a = assets[i];
      if (!a) return;
      try {
        const v = fitVariant(id, a);
        if (v) map.set(id, v);
      } catch (err) {
        console.warn(`[entities] character ${id} unusable:`, err);
      }
    });
    return map.size ? new CharacterLibrary(map) : null;
  }

  /** Variant for a player (deterministic; falls back to a loaded one of the same rig, then any). */
  variantFor(playerId: number): VariantData {
    const want = characterVariantFor(playerId);
    const v = this.variants.get(want);
    if (v) return v;
    const rig = CHARACTER_VARIANTS[want].rig;
    for (const x of this.loaded) if (x.asset.rig.id === rig) return x;
    return this.loaded[Math.abs(playerId) % this.loaded.length];
  }

  dispose(): void {
    this.gearGeometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Clip selection
// ---------------------------------------------------------------------------

/** Base states that can carry the weapon overlay (legs play the base clip's lower part). */
const ARMED_STATES = new Set<LogicalAnimState>(['idle', 'walk', 'run', 'sprint', 'jump', 'crouchIdle', 'crouchWalk', 'ride']);
/** Locomotion states with directional variants: [forward, back, left, right]. */
const DIRECTIONAL: Partial<Record<LogicalAnimState, readonly [CharacterAnimKey, CharacterAnimKey, CharacterAnimKey, CharacterAnimKey]>> = {
  walk: ['walk', 'walkBack', 'walkLeft', 'walkRight'],
  run: ['run', 'runBack', 'runLeft', 'runRight'],
  crouchWalk: ['crouchWalk', 'crouchBack', 'crouchLeft', 'crouchRight'],
  crawl: ['crawl', 'crawlBack', 'crawlLeft', 'crawlRight'],
};
/** Fallback chain when a key has no clip. */
const FALLBACK: Partial<Record<CharacterAnimKey, CharacterAnimKey>> = {
  dive: 'freefall', freefall: 'jump', jump: 'idle', parachute: 'jump',
  downedCrawl: 'downed', downed: 'prone', crawl: 'prone', prone: 'crouchIdle', crouchWalk: 'walk', crouchIdle: 'idle',
  swim: 'swimIdle', swimIdle: 'idle', ride: 'sit', drive: 'sit', sit: 'crouchIdle', revive: 'crouchIdle', heal: 'idle',
  sprint: 'run', run: 'walk', walk: 'idle', death2: 'death',
  walkBack: 'walk', walkLeft: 'walk', walkRight: 'walk', runBack: 'run', runLeft: 'run', runRight: 'run',
  crouchBack: 'crouchWalk', crouchLeft: 'crouchWalk', crouchRight: 'crouchWalk',
  crawlBack: 'crawl', crawlLeft: 'crawl', crawlRight: 'crawl',
  aimRifle: 'holdRifle', shootRifle: 'aimRifle', reloadRifle: 'holdRifle', sprintRifle: 'holdRifle',
  aimPistol: 'holdPistol', shootPistol: 'aimPistol', reloadPistol: 'holdPistol', parachuteHang: 'holdRifle',
};

type AimMode = 'none' | 'track' | 'pitch';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qRoot = new THREE.Quaternion();
const _qId = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _des = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dir: Vec3 = { x: 0, y: 0, z: 0 };
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const HIP_PIVOT = 0.95;

class GltfNearBody implements NearBody {
  ownerId = -1;
  readonly inst: CharacterInstance;
  private readonly uniforms: EntityUniforms;
  private readonly materials: THREE.Material[] = [];
  private readonly body: THREE.SkinnedMesh | null;
  private readonly band: THREE.SkinnedMesh | null;
  private readonly bandMat: THREE.MeshStandardMaterial | null;
  private readonly gear: THREE.SkinnedMesh;
  private readonly proxies: THREE.Bone[] = [];
  private readonly holder = new THREE.Object3D();
  private readonly slungAnchor = new THREE.Object3D();
  private readonly spine: THREE.Bone | null;
  private readonly chest: THREE.Bone | null;
  private readonly actions = new Map<THREE.AnimationClip, THREE.AnimationAction>();
  private baseKey: CharacterAnimKey | null = null;
  private baseClip: THREE.AnimationClip | null = null;
  private baseAction: THREE.AnimationAction | null = null;
  private overlayClip: THREE.AnimationClip | null = null;
  private overlayAction: THREE.AnimationAction | null = null;
  private overlayKey: CharacterAnimKey | null = null;
  private orientW = 0;
  private slungLevel = -1;

  constructor(readonly variant: VariantData, gearGeometry: THREE.BufferGeometry) {
    this.inst = createCharacterInstance(variant.asset);
    const root = this.inst.root;
    root.matrixAutoUpdate = false;
    root.visible = false;
    this.uniforms = createEntityUniforms(0.35);
    const opts = { dither: true, rim: true };
    // Body + armband: per-body material clones carrying the shared fade uniform.
    this.body = findBodyMesh(root, variant.asset.variant.teamMesh);
    if (this.body) {
      const m = (this.body.material as THREE.Material).clone();
      applyEntityShader(m, opts, this.uniforms);
      this.body.material = m;
      this.materials.push(m);
      this.body.castShadow = true;
      this.body.receiveShadow = true;
    }
    this.band = this.inst.teamBand;
    if (this.band) {
      const m = (this.band.material as THREE.MeshStandardMaterial).clone();
      applyEntityShader(m, opts, this.uniforms);
      this.band.material = m;
      this.materials.push(m);
      this.bandMat = m;
    } else {
      this.bandMat = null;
    }
    // Gear + gun: one skinned mesh on proxy bones attached to the character's bones.
    const gearMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    applyEntityShader(gearMat, { mask: true, dither: true, rim: true }, this.uniforms);
    this.materials.push(gearMat);
    this.gear = new THREE.SkinnedMesh(gearGeometry, gearMat);
    this.gear.name = 'dz_gear';
    this.gear.frustumCulled = false;
    this.gear.castShadow = true;
    const head = this.inst.bones.head, chest = this.inst.bones.chest;
    this.spine = this.inst.bones.spine;
    this.chest = chest;
    this.holder.name = 'dz_weapon_holder';
    this.slungAnchor.name = 'dz_slung_anchor';
    this.slungAnchor.matrixAutoUpdate = false;
    this.holder.matrixAutoUpdate = false;
    chest?.add(this.slungAnchor);
    const inverses: THREE.Matrix4[] = [];
    for (let i = 0; i < G_COUNT; i++) {
      const b = new THREE.Bone();
      b.name = 'dz_gear_' + i;
      b.matrixAutoUpdate = false;
      b.matrix.copy(ZERO);
      const parent = i < G_VEST1 ? head : i < G_WEAPON0 ? chest : this.holder;
      (parent ?? root).add(b);
      this.proxies.push(b);
      inverses.push(new THREE.Matrix4());
    }
    this.gear.bind(new THREE.Skeleton(this.proxies, inverses), new THREE.Matrix4());
    root.add(this.gear);
    this.inst.weaponSocket.add(this.holder);
  }

  private action(clip: THREE.AnimationClip): THREE.AnimationAction {
    let a = this.actions.get(clip);
    if (!a) {
      a = this.inst.mixer.clipAction(clip);
      this.actions.set(clip, a);
    }
    return a;
  }

  /** Key that `clipFor` actually resolved (after fallbacks). */
  private resolvedKey: CharacterAnimKey = 'idle';

  /** Resolve a key (with fallbacks) to a clip of the requested part; sets `resolvedKey`. */
  private clipFor(key: CharacterAnimKey, part: 'full' | 'upper' | 'lower'): THREE.AnimationClip | null {
    let k: CharacterAnimKey | undefined = key;
    for (let guard = 0; k && guard < 8; guard++) {
      const c = getCharacterClip(this.variant.asset, k, part);
      if (c) {
        this.resolvedKey = k;
        return c;
      }
      k = FALLBACK[k];
    }
    return null;
  }

  private chooseBaseKey(f: BodyFrame): CharacterAnimKey {
    const st = f.logical.state;
    if (st === 'death') return f.anim.deathFallSign < 0 ? 'death2' : 'death';
    // Parachute: legs from the airborne loop under the hanging upper body.
    if (st === 'parachute') return 'jump';
    const dirs = DIRECTIONAL[st];
    if (!dirs) return st;
    const fwd = -f.moveZ, side = f.moveX;
    const ang = Math.atan2(side, fwd);
    const a = Math.abs(ang);
    if (a < 0.8) return dirs[0];
    if (a > 2.35) return dirs[1];
    return ang > 0 ? dirs[3] : dirs[2];
  }

  private chooseOverlayKey(f: BodyFrame): CharacterAnimKey | null {
    const L = f.logical;
    if (L.state === 'parachute') return 'parachuteHang';
    if (!f.showWeapon || L.weaponClass === 'none' || !ARMED_STATES.has(L.state)) return null;
    if (L.weaponClass === 'pistol') {
      return L.overlay === 'reload' ? 'reloadPistol' : L.overlay === 'shoot' ? 'shootPistol' : L.overlay === 'aim' ? 'aimPistol' : 'holdPistol';
    }
    if (L.overlay === 'reload') return 'reloadRifle';
    if (L.overlay === 'shoot') return 'shootRifle';
    if (L.overlay === 'aim') return 'aimRifle';
    return L.state === 'sprint' ? 'sprintRifle' : 'holdRifle';
  }

  private crossfade(prev: THREE.AnimationAction | null, next: THREE.AnimationAction, key: CharacterAnimKey, syncFrom: THREE.AnimationAction | null): void {
    const spec = CHARACTER_CLIPS[key];
    const fade = spec ? spec.fade : 0.2;
    const loop = key === 'shootRifle' || key === 'shootPistol' ? true : spec ? spec.loop : true;
    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    if (syncFrom && spec?.cycles) {
      const pd = syncFrom.getClip().duration;
      if (pd > 0) next.time = ((syncFrom.time % pd) / pd) * next.getClip().duration;
    }
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) {
      prev.fadeOut(fade);
      next.fadeIn(fade);
    }
  }

  apply(f: BodyFrame): void {
    const root = this.inst.root;
    root.visible = true;
    // --- Root (free-fall body pitch from the procedural pose; clips are upright) ---------------
    const freefall = f.logical.state === 'freefall' || f.logical.state === 'dive';
    this.orientW += ((freefall ? 1 : 0) - this.orientW) * (1 - Math.exp(-5 * Math.min(0.1, f.dt)));
    root.matrix.copy(f.root);
    if (this.orientW > 0.002) {
      const pose = f.anim.pose;
      _m.makeTranslation(0, HIP_PIVOT, 0);
      _q.setFromEuler(_e.set(pose[P.HPITCH] * this.orientW, 0, pose[P.HROLL] * this.orientW, 'YXZ'));
      _m2.makeRotationFromQuaternion(_q);
      _m.multiply(_m2);
      _m2.makeTranslation(0, -HIP_PIVOT, 0);
      _m.multiply(_m2);
      root.matrix.multiply(_m);
    }
    root.matrixWorldNeedsUpdate = true;

    // --- Look: team colour, fade, gear ---------------------------------------------------------
    const look = f.look;
    this.uniforms.uAccent.value.copy(look.accent);
    this.uniforms.uFade.value = f.fade;
    this.bandMat?.color.copy(look.accent);
    const shadows = f.shadows && f.fade > 0.5;
    if (this.body) this.body.castShadow = shadows;
    this.gear.castShadow = shadows;
    const helmet = look.gear[0], vest = look.gear[1], pack = look.gear[2];
    for (let l = 1; l <= 3; l++) {
      this.proxies[G_HELMET1 + l - 1].matrix.copy(l === helmet ? this.variant.helmetLocal : ZERO);
      this.proxies[G_VEST1 + l - 1].matrix.copy(l === vest ? this.variant.torsoLocal : ZERO);
      this.proxies[G_PACK1 + l - 1].matrix.copy(l === pack ? this.variant.torsoLocal : ZERO);
    }

    // --- Animation -------------------------------------------------------------------------------
    const overlayKey = this.chooseOverlayKey(f);
    const baseKey = this.chooseBaseKey(f);
    const part = overlayKey ? 'lower' : 'full';
    const baseClip = this.clipFor(baseKey, part);
    if (baseClip && baseClip !== this.baseClip) {
      const key = this.resolvedKey;
      const next = this.action(baseClip);
      const prev = this.baseAction;
      this.crossfade(prev, next, key, prev && this.baseKey && CHARACTER_CLIPS[this.baseKey]?.cycles ? prev : null);
      this.baseClip = baseClip;
      this.baseAction = next;
      this.baseKey = key;
    }
    const ovClip = overlayKey ? this.clipFor(overlayKey, 'upper') : null;
    if (ovClip !== this.overlayClip) {
      const prev = this.overlayAction;
      if (ovClip) {
        const key = this.resolvedKey;
        const next = this.action(ovClip);
        this.crossfade(prev, next, key, null);
        if (!prev) next.fadeIn(CHARACTER_CLIPS[key]?.fade ?? 0.15);
        this.overlayAction = next;
        this.overlayKey = key;
      } else {
        prev?.fadeOut(0.18);
        this.overlayAction = null;
        this.overlayKey = null;
      }
      this.overlayClip = ovClip;
    }
    // Speed: locomotion matches the gait cadence; death is driven by the death timer.
    if (this.baseAction && this.baseKey) {
      const spec = CHARACTER_CLIPS[this.baseKey];
      if (f.logical.state === 'death') {
        this.baseAction.timeScale = 0;
        this.baseAction.time = Math.min(f.logical.deadFor, this.baseAction.getClip().duration - 1e-3);
      } else if (spec?.cycles && f.logical.cycleHz > 0) {
        this.baseAction.timeScale = clamp((f.logical.cycleHz * spec.duration) / spec.cycles, 0.35, 2.6);
      } else {
        this.baseAction.timeScale = 1;
      }
    }
    this.inst.mixer.update(Math.min(0.1, f.dt));

    // --- Weapon placement ------------------------------------------------------------------------
    const weapon = f.showWeapon ? look.weapon : null;
    const inHands = weapon !== null && this.overlayKey !== null && this.overlayKey !== 'parachuteHang';
    const slung = weapon !== null && !inHands && !WEAPON_HOLD[weapon].pistol;
    const wIdx = weapon !== null && (inHands || slung) ? WEAPON_IDS.indexOf(weapon) : -1;
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      this.proxies[G_WEAPON0 + i].matrix.copy(i === wIdx ? _identity : ZERO);
    }
    if (inHands) {
      if (this.holder.parent !== this.inst.weaponSocket) this.inst.weaponSocket.add(this.holder);
      this.holder.matrix.identity();
    } else if (slung) {
      if (this.holder.parent !== this.slungAnchor) this.slungAnchor.add(this.holder);
      if (this.slungLevel !== pack) {
        this.slungLevel = pack;
        this.slungAnchor.matrix.copy(this.variant.slungLocal[Math.max(0, Math.min(3, pack))]);
      }
      this.holder.matrix.identity();
    }

    // --- Procedural upper-body corrections (aim, lean, flinch, kick) ----------------------------
    let mode: AimMode = 'none';
    if (inHands) {
      const k = this.overlayKey;
      mode = k === 'aimRifle' || k === 'shootRifle' || k === 'aimPistol' || k === 'shootPistol' ? 'track'
        : k === 'holdRifle' || k === 'holdPistol' ? 'pitch' : 'none';
    }
    this.correctSpine(f, mode);
  }

  /** Rotate Abdomen + Chest so the gun follows the aim; add lean / flinch / kick. */
  private correctSpine(f: BodyFrame, mode: AimMode): void {
    const spine = this.spine, chest = this.chest;
    if (!spine || !chest || !spine.parent || !chest.parent) return;
    const a = f.anim;
    const root = this.inst.root;
    _qRoot.setFromRotationMatrix(_m.extractRotation(root.matrix));
    // Total world-space correction rotation.
    _q.identity();
    if (mode === 'track') {
      this.inst.weaponSocket.updateWorldMatrix(true, false);
      _cur.set(0, 0, -1).transformDirection(this.inst.weaponSocket.matrixWorld);
      dirFromAngles(f.aimYawRel, Math.max(-1.3, Math.min(1.3, f.aimPitch)), _dir);
      _des.set(_dir.x, _dir.y, _dir.z).applyQuaternion(_qRoot);
      _q.setFromUnitVectors(_cur, _des);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
      if (ang > 1.1) _q.slerp(_qId, 1 - 1.1 / ang);
    } else if (mode === 'pitch') {
      _axis.set(1, 0, 0).applyQuaternion(_qRoot);
      _q.setFromAxisAngle(_axis, 0.55 * Math.max(-1.2, Math.min(1.2, f.aimPitch)));
    }
    // Lean (roll about the facing axis), hit flinch and fire kick (pitch about the right axis).
    const lean = a.lean * 0.24;
    const pitchExtra = 0.22 * a.flinchBz * a.flinchX + 0.05 * a.kickX;
    if (lean !== 0) {
      _axis.set(0, 0, -1).applyQuaternion(_qRoot);
      _qa.setFromAxisAngle(_axis, -lean);
      _q.premultiply(_qa);
    }
    if (pitchExtra !== 0) {
      _axis.set(1, 0, 0).applyQuaternion(_qRoot);
      _qa.setFromAxisAngle(_axis, pitchExtra);
      _q.premultiply(_qa);
    }
    if (Math.abs(_q.w) > 0.99999) return;
    // Split 40 % lower spine, 60 % chest.
    spine.parent.updateWorldMatrix(true, false);
    chest.parent.updateWorldMatrix(true, false);
    _qa.copy(_qId).slerp(_q, 0.4);
    _qb.copy(_qId).slerp(_q, 0.6);
    // Abdomen: L' = P^-1 * Qa * P * L
    _qp.setFromRotationMatrix(_m.extractRotation(spine.parent.matrixWorld));
    applyWorldRotation(spine, _qp, _qa);
    // Chest: its parent moved with the abdomen rotation (Qa about the abdomen pivot).
    _qp.setFromRotationMatrix(_m.extractRotation(chest.parent.matrixWorld)).premultiply(_qa);
    applyWorldRotation(chest, _qp, _qb);
  }

  hide(): void {
    this.inst.root.visible = false;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.gear.skeleton.dispose();
    this.inst.dispose();
  }
}

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _identity = new THREE.Matrix4();
const _qt = new THREE.Quaternion();

/** bone.quaternion = P^-1 * Q * P * bone.quaternion (Q a world-space rotation, P = parent world). */
function applyWorldRotation(bone: THREE.Object3D, parentWorld: THREE.Quaternion, q: THREE.Quaternion): void {
  _qt.copy(parentWorld).invert().multiply(q).multiply(parentWorld);
  bone.quaternion.premultiply(_qt);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GltfNearProvider implements NearBodyProvider {
  readonly name = 'gltf';
  private readonly all: GltfNearBody[] = [];
  private readonly free = new Map<CharacterVariantId, GltfNearBody[]>();

  constructor(private readonly parent: THREE.Object3D, private readonly lib: CharacterLibrary, private capacity: number) {}

  setCapacity(n: number): void {
    this.capacity = n;
    // Trim idle bodies above the new capacity.
    while (this.all.length > this.capacity) {
      const victim = this.takeAnyFree();
      if (!victim) break;
      this.destroy(victim);
    }
  }

  private takeAnyFree(): GltfNearBody | null {
    for (const list of this.free.values()) {
      const b = list.pop();
      if (b) return b;
    }
    return null;
  }

  private destroy(b: GltfNearBody): void {
    const i = this.all.indexOf(b);
    if (i >= 0) this.all.splice(i, 1);
    b.dispose();
  }

  acquire(ownerId: number): NearBody | null {
    const v = this.lib.variantFor(ownerId);
    let body = this.free.get(v.id)?.pop() ?? null;
    if (!body) {
      if (this.all.length >= this.capacity) {
        // Recycle an idle body of another variant to stay within the budget.
        const idle = this.takeAnyFree();
        if (!idle) return null;
        this.destroy(idle);
      }
      body = new GltfNearBody(v, this.lib.gearGeometry);
      this.all.push(body);
      this.parent.add(body.inst.root);
    }
    body.ownerId = ownerId;
    return body;
  }

  release(body: NearBody): void {
    const b = body as GltfNearBody;
    b.ownerId = -1;
    b.hide();
    let list = this.free.get(b.variant.id);
    if (!list) {
      list = [];
      this.free.set(b.variant.id, list);
    }
    list.push(b);
  }

  outfitTint(playerId: number, upper: THREE.Color, lower: THREE.Color): boolean {
    const v = this.lib.variantFor(playerId);
    upper.copy(v.upper);
    lower.copy(v.lower);
    return true;
  }

  dispose(): void {
    for (const b of this.all) b.dispose();
    this.all.length = 0;
    this.free.clear();
  }
}
