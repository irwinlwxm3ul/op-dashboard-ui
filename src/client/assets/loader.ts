// Cached glTF loading for the curated model library (see manifest.ts). Every function resolves to
// null instead of throwing when a file is missing or broken, so renderers can always fall back to
// their procedural models. Templates are loaded once and shared; `instantiate` / `cloneSkinned` /
// `createCharacterInstance` produce per-entity copies that share geometry, materials and clips.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  CHARACTER_BONES,
  CHARACTER_CLIPS,
  CHARACTER_RIGS,
  CHARACTER_VARIANTS,
  UPPER_BODY_BONES,
  modelUrl,
  type AssetCategory,
  type CharacterAnimKey,
  type CharacterRig,
  type CharacterVariant,
  type CharacterVariantId,
  WEAPON_MODELS,
  ITEM_MODELS,
  GEAR_WEAR,
  assetFilesFor,
  type ItemModelId,
} from './manifest';
import type { GearId, WeaponId } from '../../shared/types';

export type { GLTF };

let loader: GLTFLoader | null = null;
const cache = new Map<string, Promise<GLTF | null>>();
const warned = new Set<string>();

function warnOnce(url: string, err: unknown): void {
  if (warned.has(url)) return;
  warned.add(url);
  console.warn(`[assets] failed to load ${url}:`, err);
}

/** Loads (once) and caches a glTF by absolute URL. Never rejects: resolves to null on failure. */
export function loadGltf(url: string): Promise<GLTF | null> {
  let p = cache.get(url);
  if (!p) {
    loader ??= new GLTFLoader();
    const l = loader;
    p = new Promise<GLTF | null>((resolve) => {
      try {
        l.load(url, (g) => resolve(g), undefined, (e) => { warnOnce(url, e); resolve(null); });
      } catch (e) {
        warnOnce(url, e);
        resolve(null);
      }
    });
    cache.set(url, p);
  }
  return p;
}

/** Loads a model by its path relative to public/assets/models/ (as stored in the manifest). */
export function loadModel(file: string): Promise<GLTF | null> {
  return loadGltf(modelUrl(file));
}

/** The already-loaded glTF for `file`, if its promise has settled successfully (sync access). */
const settled = new Map<string, GLTF>();
export function peekModel(file: string): GLTF | null {
  return settled.get(modelUrl(file)) ?? null;
}

async function track(file: string): Promise<GLTF | null> {
  const g = await loadModel(file);
  if (g) settled.set(modelUrl(file), g);
  return g;
}

/**
 * Preloads files (paths relative to public/assets/models/). `onProgress(done, total)` is called
 * after each file (failures count as done). Resolves when all are settled; never rejects.
 */
export async function preloadFiles(files: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const unique = [...new Set(files)];
  let done = 0;
  onProgress?.(0, unique.length);
  await Promise.all(unique.map(async (f) => {
    await track(f);
    done++;
    onProgress?.(done, unique.length);
  }));
}

/** Preloads every file of the given categories of this manifest (see preloadFiles). */
export function preloadAssets(categories: readonly AssetCategory[], onProgress?: (done: number, total: number) => void): Promise<void> {
  return preloadFiles(categories.flatMap((c) => assetFilesFor(c)), onProgress);
}

/** Deep clone that rebinds skinned meshes to the cloned bones (geometry/materials shared). */
export function cloneSkinned<T extends THREE.Object3D>(scene: T): T {
  return SkeletonUtils.clone(scene) as T;
}

/** A fresh copy of the model's scene (skinned-safe), or null when it failed to load. */
export async function instantiate(file: string): Promise<THREE.Object3D | null> {
  const g = await track(file);
  if (!g) return null;
  let skinned = false;
  g.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
  return skinned ? cloneSkinned(g.scene) : g.scene.clone(true);
}

// ------------------------------------------------------------------------------------------------
// Characters
// ------------------------------------------------------------------------------------------------

export interface CharacterAsset {
  variant: CharacterVariant;
  rig: CharacterRig;
  /** Template scene (do not add to the scene graph; use createCharacterInstance). */
  template: THREE.Object3D;
  /** Every clip of the rig's animation library by clip name. */
  clips: ReadonlyMap<string, THREE.AnimationClip>;
}

const characterCache = new Map<CharacterVariantId, Promise<CharacterAsset | null>>();
const rigClipCache = new Map<string, Promise<Map<string, THREE.AnimationClip> | null>>();

function rigClips(rig: CharacterRig): Promise<Map<string, THREE.AnimationClip> | null> {
  let p = rigClipCache.get(rig.id);
  if (!p) {
    p = track(rig.animations).then((g) => (g ? new Map(g.animations.map((c) => [c.name, c])) : null));
    rigClipCache.set(rig.id, p);
  }
  return p;
}

/** Loads a character variant + its rig's animation library. Null when either fails. */
export function loadCharacter(id: CharacterVariantId): Promise<CharacterAsset | null> {
  let p = characterCache.get(id);
  if (!p) {
    const variant = CHARACTER_VARIANTS[id];
    const rig = CHARACTER_RIGS[variant.rig];
    p = Promise.all([track(variant.file), rigClips(rig)]).then(([g, clips]) => {
      if (!g || !clips) return null;
      return { variant, rig, template: g.scene, clips };
    });
    characterCache.set(id, p);
  }
  return p;
}

const derivedClips = new WeakMap<THREE.AnimationClip, { upper?: THREE.AnimationClip; lower?: THREE.AnimationClip }>();
const upperSet = new Set(UPPER_BODY_BONES);

function splitClip(clip: THREE.AnimationClip, part: 'upper' | 'lower'): THREE.AnimationClip {
  let d = derivedClips.get(clip);
  if (!d) { d = {}; derivedClips.set(clip, d); }
  const hit = d[part];
  if (hit) return hit;
  const tracks = clip.tracks.filter((t) => upperSet.has(t.name.slice(0, t.name.lastIndexOf('.'))) === (part === 'upper'));
  const out = new THREE.AnimationClip(`${clip.name}#${part}`, clip.duration, tracks);
  d[part] = out;
  return out;
}

/**
 * The clip for a logical key. part: 'full' (whole clip as stored), 'upper' (only
 * UPPER_BODY_BONES tracks), 'lower' (everything except UPPER_BODY_BONES, the base under an
 * overlay). Default: 'upper' for overlay keys (layer 'upper'), 'full' otherwise. Derived clips are
 * cached, so the same object is returned every time (mixer-friendly).
 */
export function getCharacterClip(asset: CharacterAsset, key: CharacterAnimKey, part?: 'full' | 'upper' | 'lower'): THREE.AnimationClip | null {
  const spec = CHARACTER_CLIPS[key];
  if (!spec) return null;
  const clip = asset.clips.get(spec.clip);
  if (!clip) return null;
  const p = part ?? (spec.layer === 'upper' ? 'upper' : 'full');
  return p === 'full' ? clip : splitClip(clip, p);
}

export interface CharacterInstance {
  asset: CharacterAsset;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** Bones by logical name (CHARACTER_BONES). */
  bones: Record<keyof typeof CHARACTER_BONES, THREE.Bone | null>;
  /** Child of the right hand with unit world scale: add the weapon model here (weapon frame). */
  weaponSocket: THREE.Object3D;
  body: THREE.SkinnedMesh | null;
  /** Team armband mesh; its material is cloned per instance so it can be tinted freely. */
  teamBand: THREE.SkinnedMesh | null;
  setTeamColor(color: THREE.ColorRepresentation): void;
  dispose(): void;
}

/** Creates an animated copy of a loaded character (skinned clone + mixer + weapon socket). */
export function createCharacterInstance(asset: CharacterAsset): CharacterInstance {
  const root = cloneSkinned(asset.template);
  root.name = `character:${asset.variant.id}`;
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (!byName.has(o.name)) byName.set(o.name, o);
    if ((o as THREE.Mesh).isMesh) o.frustumCulled = false; // skinned bounds are bind-pose only
  });
  const bones = {} as Record<keyof typeof CHARACTER_BONES, THREE.Bone | null>;
  for (const [k, n] of Object.entries(CHARACTER_BONES) as [keyof typeof CHARACTER_BONES, string][]) {
    const b = byName.get(n);
    bones[k] = b && (b as THREE.Bone).isBone ? (b as THREE.Bone) : null;
  }
  const socket = new THREE.Object3D();
  socket.name = 'WeaponSocket';
  const s = asset.rig.socket;
  socket.position.fromArray(s.position);
  socket.quaternion.fromArray(s.quaternion);
  const hand = bones.rightHand;
  if (hand) {
    hand.add(socket);
    root.updateMatrixWorld(true);
    const ws = hand.getWorldScale(new THREE.Vector3());
    socket.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
  } else {
    root.add(socket);
  }
  const teamBand = (byName.get(asset.variant.teamMesh) as THREE.SkinnedMesh | undefined) ?? null;
  // The body mesh shares its glTF name with the pelvis bone ("Body"), so GLTFLoader renames the mesh
  // (e.g. "Body_1") and a name lookup finds the bone. Pick the largest skinned mesh that isn't the band.
  let body: THREE.SkinnedMesh | null = null;
  let bodyVerts = -1;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || m === teamBand) return;
    const n = m.geometry.getAttribute('position')?.count ?? 0;
    if (n > bodyVerts) { bodyVerts = n; body = m; }
  });
  let ownMaterial: THREE.MeshStandardMaterial | null = null;
  const mixer = new THREE.AnimationMixer(root);
  return {
    asset,
    root,
    mixer,
    bones,
    weaponSocket: socket,
    body,
    teamBand: teamBand && teamBand.isSkinnedMesh ? teamBand : null,
    setTeamColor(color) {
      if (!teamBand) return;
      if (!ownMaterial) {
        ownMaterial = (teamBand.material as THREE.MeshStandardMaterial).clone();
        teamBand.material = ownMaterial;
      }
      ownMaterial.color.set(color);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      ownMaterial?.dispose();
      root.removeFromParent();
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Single-mesh models (weapons, items): instancing helpers
// ------------------------------------------------------------------------------------------------

export interface MeshParts {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/**
 * Geometry + material of a single-mesh model (every weapon / item GLB is one vertex-coloured mesh
 * in its own frame), for THREE.InstancedMesh or merging. Shared: do not dispose or mutate.
 */
export async function loadMeshParts(file: string): Promise<MeshParts | null> {
  const g = await track(file);
  if (!g) return null;
  let found: THREE.Mesh | null = null;
  g.scene.traverse((o) => { if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh; });
  const mesh = found as THREE.Mesh | null;
  if (!mesh) return null;
  return { geometry: mesh.geometry, material: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material };
}

/** A copy of the weapon model (weapon frame: grip at origin, barrel -Z), or null. */
export function instantiateWeapon(id: WeaponId): Promise<THREE.Object3D | null> {
  return instantiate(WEAPON_MODELS[id].file);
}

/** A copy of an item model (standing on y = 0, front -Z), or null. */
export function instantiateItem(id: ItemModelId): Promise<THREE.Object3D | null> {
  return instantiate(ITEM_MODELS[id].file);
}

/**
 * Puts a gear item (helmet / vest / backpack) on a character instance using GEAR_WEAR. Returns the
 * attached object (remove it with `removeFromParent()`), or null when the model failed to load.
 */
export async function attachGear(instance: CharacterInstance, gear: GearId): Promise<THREE.Object3D | null> {
  const w = GEAR_WEAR[instance.asset.rig.id][gear];
  const bone = instance.root.getObjectByName(w.bone);
  if (!bone) return null;
  const obj = await instantiateItem(gear);
  if (!obj) return null;
  obj.name = `gear:${gear}`;
  obj.position.fromArray(w.position);
  obj.quaternion.fromArray(w.quaternion);
  obj.scale.fromArray(w.scale);
  bone.add(obj);
  return obj;
}
