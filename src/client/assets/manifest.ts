// Typed manifest of the curated third-party 3D assets under public/assets/models (all CC0, see
// docs/ASSETS.md). Pure data: no three.js / DOM imports, so Node tests can read it too.
//
// Conventions shared by every entry (all files are already normalised, so scale = 1 and no
// rotation fix is needed unless an entry says otherwise):
//  * units are metres, +Y up, three.js forward is -Z;
//  * characters: feet at the origin, facing -Z, exactly CHARACTER_HEIGHT tall in the bind pose;
//  * weapons: right-hand pistol grip at the origin, barrel along -Z, up +Y, right +X (the same
//    weapon frame as src/client/render/entities/weaponModels.ts);
//  * items / props / vehicles / nature: resting on y = 0, centred on X/Z, front facing -Z.
// Node names in this file are the names three.js gives the nodes after loading (GLTFLoader strips
// '.', so the source rig's "Wrist.R" is "WristR").

import type { AmmoId, ConsumableId, GearId, ThrowableId, WeaponId } from '../../shared/types';

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/**
 * Categories of this manifest. Vehicles, props and nature live in manifest-world.ts (separate
 * owner); load those with `preloadFiles` / `loadModel` from loader.ts using their own file lists.
 */
export type AssetCategory = 'characters' | 'weapons' | 'items';

/** Folder (relative to the site base URL) that holds every model. */
export const MODELS_PATH = 'assets/models/';

function baseUrl(): string {
  try {
    const b = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL;
    return typeof b === 'string' && b.length ? (b.endsWith('/') ? b : b + '/') : '/';
  } catch {
    return '/';
  }
}

/** Absolute URL of a model file given its path relative to public/assets/models/. */
export function modelUrl(file: string): string {
  return baseUrl() + MODELS_PATH + file;
}

// ================================================================================================
// Characters
// ================================================================================================

export const CHARACTER_HEIGHT = 1.8;

export type CharacterRigId = 'male' | 'female';
export type CharacterVariantId =
  | 'male_tactical' | 'male_casual' | 'male_hoodie'
  | 'female_tactical' | 'female_adventurer' | 'female_casual';

export interface CharacterVariant {
  id: CharacterVariantId;
  rig: CharacterRigId;
  /** Path relative to public/assets/models/. */
  file: string;
  /** Triangles of the merged body (+ 24 for the team armband). */
  tris: number;
  /**
   * The body is ONE skinned mesh named 'Body' (vertex colours, material 'outfit') plus one small
   * skinned mesh 'TeamBand' (material 'team', white) around the left upper arm: set its material
   * colour to the team hue. 2 draw calls per character.
   */
  bodyMesh: 'Body';
  teamMesh: 'TeamBand';
}

/** Logical attachment points -> bone names (identical on both rigs). */
export interface CharacterBones {
  root: 'Root';
  pelvis: 'Body';
  hips: 'Hips';
  spine: 'Abdomen';
  chest: 'Chest';
  neck: 'Neck';
  head: 'Head';
  rightHand: 'WristR';
  leftHand: 'WristL';
  rightUpperArm: 'UpperArmR';
  leftUpperArm: 'UpperArmL';
}

export const CHARACTER_BONES: CharacterBones = {
  root: 'Root',
  pelvis: 'Body',
  hips: 'Hips',
  spine: 'Abdomen',
  chest: 'Chest',
  neck: 'Neck',
  head: 'Head',
  rightHand: 'WristR',
  leftHand: 'WristL',
  rightUpperArm: 'UpperArmR',
  leftUpperArm: 'UpperArmL',
};

/**
 * Weapon socket in the right-hand bone's local space: place a weapon (weapon frame, see top of
 * file) with this local position / rotation under CHARACTER_BONES.rightHand and divide out the
 * bone's world scale (the rigs are uniformly scaled by their Root bone) - `loader.ts`
 * `createCharacterInstance()` does exactly that and exposes the socket object.
 */
export interface WeaponSocket {
  bone: 'WristR';
  position: Vec3;
  quaternion: Quat;
}

export interface CharacterRig {
  id: CharacterRigId;
  /** Animation library (skeleton + clips, no mesh) shared by every variant of the rig. */
  animations: string;
  socket: WeaponSocket;
}

export const CHARACTER_RIGS: Record<CharacterRigId, CharacterRig> = {
  male: {
    id: 'male',
    animations: 'animations/humanoid-male.glb',
    socket: { bone: 'WristR', position: [0.0302, 0.0209, -0.0694], quaternion: [-0.3315, 0.6696, -0.5258, -0.4066] },
  },
  female: {
    id: 'female',
    animations: 'animations/humanoid-female.glb',
    socket: { bone: 'WristR', position: [0.028, 0.0203, -0.0678], quaternion: [-0.3365, 0.6657, -0.5227, -0.4128] },
  },
};

export const CHARACTER_VARIANTS: Record<CharacterVariantId, CharacterVariant> = {
  male_tactical: { id: 'male_tactical', rig: 'male', file: 'characters/male_tactical.glb', tris: 7754, bodyMesh: 'Body', teamMesh: 'TeamBand' },
  male_casual: { id: 'male_casual', rig: 'male', file: 'characters/male_casual.glb', tris: 5776, bodyMesh: 'Body', teamMesh: 'TeamBand' },
  male_hoodie: { id: 'male_hoodie', rig: 'male', file: 'characters/male_hoodie.glb', tris: 6206, bodyMesh: 'Body', teamMesh: 'TeamBand' },
  female_tactical: { id: 'female_tactical', rig: 'female', file: 'characters/female_tactical.glb', tris: 7900, bodyMesh: 'Body', teamMesh: 'TeamBand' },
  female_adventurer: { id: 'female_adventurer', rig: 'female', file: 'characters/female_adventurer.glb', tris: 6812, bodyMesh: 'Body', teamMesh: 'TeamBand' },
  female_casual: { id: 'female_casual', rig: 'female', file: 'characters/female_casual.glb', tris: 6424, bodyMesh: 'Body', teamMesh: 'TeamBand' },
};

export const CHARACTER_VARIANT_IDS = Object.keys(CHARACTER_VARIANTS) as CharacterVariantId[];

/** Deterministic variant for a player id (stable across clients). */
export function characterVariantFor(playerId: number): CharacterVariantId {
  const h = Math.imul(playerId ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return CHARACTER_VARIANT_IDS[h % CHARACTER_VARIANT_IDS.length];
}

/**
 * Bones driven by upper-body overlay clips (weapon hold / aim / shoot / reload, parachute hang).
 * To layer an overlay over locomotion, play the locomotion clip WITHOUT these tracks
 * (loader `getCharacterClip(asset, key, 'lower')`) and the overlay clip at weight 1.
 */
export const UPPER_BODY_BONES: readonly string[] = (() => {
  const out = ['Abdomen', 'Torso', 'Chest', 'Neck', 'Head', 'ShoulderL', 'UpperArmL', 'LowerArmL', 'WristL', 'ShoulderR', 'UpperArmR', 'LowerArmR', 'WristR'];
  for (const side of ['L', 'R']) {
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 4; i++) out.push(`${f}${i}${side}`);
    for (let i = 1; i <= 3; i++) out.push(`Thumb${i}${side}`);
  }
  return out;
})();

/**
 * Logical animation keys. The first group mirrors render/entities LogicalAnimState one to one;
 * the rest are directional / variant locomotion, one-shots and upper-body overlays.
 */
export type CharacterAnimKey =
  // LogicalAnimState
  | 'idle' | 'walk' | 'run' | 'sprint' | 'jump'
  | 'crouchIdle' | 'crouchWalk' | 'prone' | 'crawl' | 'downed' | 'downedCrawl'
  | 'swimIdle' | 'swim' | 'freefall' | 'dive' | 'parachute'
  | 'drive' | 'ride' | 'sit' | 'revive' | 'heal' | 'death'
  // directional locomotion
  | 'walkBack' | 'walkLeft' | 'walkRight' | 'runBack' | 'runLeft' | 'runRight'
  | 'crouchBack' | 'crouchLeft' | 'crouchRight' | 'crawlBack' | 'crawlLeft' | 'crawlRight'
  // one-shots / extras
  | 'idleLookAround' | 'jumpStart' | 'jumpLand' | 'death2' | 'hit' | 'hitHead' | 'hitStomach' | 'hitLeft' | 'hitRight'
  | 'drink' | 'throw' | 'pickup' | 'interact' | 'vault' | 'climb' | 'roll' | 'victory' | 'dance'
  // upper-body overlays (layer 'upper')
  | 'holdRifle' | 'aimRifle' | 'shootRifle' | 'reloadRifle' | 'sprintRifle'
  | 'holdPistol' | 'aimPistol' | 'aimPistolUp' | 'aimPistolDown' | 'shootPistol' | 'reloadPistol'
  | 'parachuteHang';

export interface CharacterClipSpec {
  /** Clip name inside the rig's animation library. */
  clip: string;
  /** 'full' = whole body; 'upper' = play over a base clip (use the base's 'lower' part). */
  layer: 'full' | 'upper';
  loop: boolean;
  /** Clip length in seconds (both rigs). */
  duration: number;
  /**
   * For locomotion: gait cycles per loop (one cycle = two footfalls), so playback rate =
   * LogicalAnim.cycleHz * duration / cycles.
   */
  cycles?: number;
  /** Suggested crossfade into this clip (s). */
  fade: number;
}

const full = (clip: string, duration: number, loop: boolean, fade = 0.2, cycles?: number): CharacterClipSpec =>
  cycles === undefined ? { clip, layer: 'full', loop, duration, fade } : { clip, layer: 'full', loop, duration, fade, cycles };
const upper = (clip: string, duration: number, loop: boolean, fade = 0.12): CharacterClipSpec => ({ clip, layer: 'upper', loop, duration, fade });

/**
 * Every logical key mapped to the best available clip (null = no clip; keep the procedural pose).
 * Sources: Quaternius Universal Animation Library 1 + 2 retargeted onto the Ultimate Modular rigs;
 * Rifle_* and Parachute_Hang were authored for this project with IK (scripts/assets).
 */
export const CHARACTER_CLIPS: Record<CharacterAnimKey, CharacterClipSpec | null> = {
  idle: full('Idle_Loop', 2.5, true, 0.25),
  walk: full('Walk_Loop', 1.333, true, 0.2, 1),
  run: full('Jog_Fwd_Loop', 0.933, true, 0.2, 1),
  sprint: full('Sprint_Loop', 0.667, true, 0.2, 1),
  jump: full('Jump_Loop', 2.5, true, 0.12),
  crouchIdle: full('Crouch_Idle_Loop', 2.933, true, 0.25),
  crouchWalk: full('Crouch_Fwd_Loop', 2, true, 0.2, 1),
  prone: full('Crawl_Idle_Loop', 2.333, true, 0.35),
  crawl: full('Crawl_Fwd_Loop', 2.167, true, 0.3, 1),
  downed: full('Crawl_Idle_Loop', 2.333, true, 0.35),
  downedCrawl: full('Crawl_Fwd_Loop', 2.167, true, 0.3, 1),
  swimIdle: full('Swim_Idle_Loop', 3.333, true, 0.3),
  swim: full('Swim_Fwd_Loop', 1.333, true, 0.3, 1),
  freefall: full('Jump_Loop', 2.5, true, 0.3),
  dive: full('Jump_Loop', 2.5, true, 0.3),
  parachute: upper('Parachute_Hang', 1, true, 0.3),
  drive: full('Driving_Loop', 1.667, true, 0.25),
  ride: full('Sitting_Idle_Loop', 1.667, true, 0.25),
  sit: full('Sitting_Idle_Loop', 1.667, true, 0.25),
  revive: full('Fixing_Kneeling', 5.2, true, 0.3),
  heal: full('Bandage_Loop', 0.667, true, 0.25),
  death: full('Death01', 2.4, false, 0.15),

  walkBack: full('Walk_Bwd_Loop', 1.333, true, 0.2, 1),
  walkLeft: full('Walk_L_Loop', 1.333, true, 0.2, 1),
  walkRight: full('Walk_R_Loop', 1.333, true, 0.2, 1),
  runBack: full('Jog_Bwd_Loop', 0.933, true, 0.2, 1),
  runLeft: full('Jog_Left_Loop', 0.933, true, 0.2, 1),
  runRight: full('Jog_Right_Loop', 0.933, true, 0.2, 1),
  crouchBack: full('Crouch_Bwd_Loop', 2, true, 0.2, 1),
  crouchLeft: full('Crouch_Left_Loop', 2, true, 0.2, 1),
  crouchRight: full('Crouch_Right_Loop', 2, true, 0.2, 1),
  crawlBack: full('Crawl_Bwd_Loop', 2.5, true, 0.3, 1),
  crawlLeft: full('Crawl_Left_Loop', 1.267, true, 0.3, 1),
  crawlRight: full('Crawl_Right_Loop', 1.267, true, 0.3, 1),

  idleLookAround: full('Idle_LookAround_Loop', 4.6, true, 0.3),
  jumpStart: full('Jump_Start', 1.333, false, 0.1),
  jumpLand: full('Jump_Land', 1.267, false, 0.1),
  death2: full('Death02', 2.467, false, 0.15),
  hit: full('Hit_Chest', 0.333, false, 0.05),
  hitHead: full('Hit_Head', 0.433, false, 0.05),
  hitStomach: full('Hit_Stomach', 0.667, false, 0.05),
  hitLeft: full('Hit_Shoulder_L', 0.533, false, 0.05),
  hitRight: full('Hit_Shoulder_R', 0.5, false, 0.05),
  drink: full('Drink', 3, false, 0.2),
  throw: full('OverhandThrow', 1.333, false, 0.1),
  pickup: full('PickUp_Kneeling', 1.933, false, 0.15),
  interact: full('Interact', 2, false, 0.15),
  vault: full('SafetyVault', 0.733, false, 0.08),
  climb: full('ClimbUp_1m', 0.667, false, 0.08),
  roll: full('Roll', 1.467, false, 0.08),
  victory: full('Celebration', 4, false, 0.3),
  dance: full('Dance_Loop', 1, true, 0.3),

  holdRifle: upper('Rifle_Hold', 1, true),
  aimRifle: upper('Rifle_Aim', 1, true, 0.1),
  shootRifle: upper('Rifle_Shoot', 0.16, false, 0.03),
  reloadRifle: upper('Rifle_Reload', 2.1, false, 0.12),
  sprintRifle: upper('Rifle_Sprint', 1, true, 0.18),
  holdPistol: upper('Pistol_Idle_Loop', 1.667, true),
  aimPistol: upper('Pistol_Aim_Neutral', 0.167, true, 0.1),
  aimPistolUp: upper('Pistol_Aim_Up', 0.167, true, 0.1),
  aimPistolDown: upper('Pistol_Aim_Down', 0.167, true, 0.1),
  shootPistol: upper('Pistol_Shoot', 0.633, false, 0.03),
  reloadPistol: upper('Pistol_Reload', 1.667, false, 0.12),
  parachuteHang: upper('Parachute_Hang', 1, true, 0.3),
};

// ================================================================================================
// Weapons
// ================================================================================================

export interface WeaponModel {
  id: WeaponId;
  file: string;
  /** Source model (Quaternius Ultimate Guns Pack). */
  source: string;
  tris: number;
  /** Overall length (m). */
  length: number;
  /** Pistol-class (held out with both hands, not shouldered). */
  pistol: boolean;
  /**
   * Hold points in the weapon frame (grip = origin). Same meaning as render/entities WeaponHold:
   * butt sits on the shoulder pocket (pistols: [0,0,0]), support = left-hand position, muzzle =
   * bore exit (flash / tracer origin), sight = the point the eye aligns with for ADS (rear sight /
   * scope eyepiece axis; the line of sight runs from it along -Z, parallel to the bore).
   * Every GLB also carries these as empty nodes named Grip, Butt, Support, Muzzle, Sight.
   */
  butt: Vec3;
  support: Vec3;
  muzzle: Vec3;
  sight: Vec3;
  /** Built-in optic on the model ('iron' = open sights). */
  optic: 'iron' | 'scope';
}

const weapon = (id: WeaponId, source: string, tris: number, length: number, pistol: boolean, optic: 'iron' | 'scope', butt: Vec3, support: Vec3, muzzle: Vec3, sight: Vec3): WeaponModel =>
  ({ id, file: `weapons/${id}.glb`, source, tris, length, pistol, butt, support, muzzle, sight, optic });

/**
 * One GLB per WeaponId: a single vertex-coloured mesh with one material ('weapon'), so it can be
 * drawn as one InstancedMesh for loot and attached under CharacterInstance.weaponSocket in hand.
 */
export const WEAPON_MODELS: Record<WeaponId, WeaponModel> = {
  pistol: weapon('pistol', 'Pistol_1', 1040, 0.21, true, 'iron', [0, 0, 0], [-0.03, -0.02, 0.01], [0, 0.0633, -0.17], [0, 0.085, 0.01]),
  smg: weapon('smg', 'SubmachineGun_5', 1440, 0.66, false, 'iron', [0, 0.025, 0.235], [0, 0.035, -0.215], [0, 0.0674, -0.425], [0, 0.11, 0.005]),
  ar: weapon('ar', 'AssaultRifle2_1', 1930, 0.9, false, 'iron', [0, 0.04, 0.27], [0, 0.045, -0.3], [0, 0.0767, -0.63], [0, 0.13, -0.03]),
  shotgun: weapon('shotgun', 'Shotgun_3', 978, 1.02, false, 'iron', [0, -0.04, 0.27], [0, -0.015, -0.36], [0, 0.0224, -0.75], [0, 0.043, -0.06]),
  dmr: weapon('dmr', 'SniperRifle_2', 1732, 1.1, false, 'scope', [0, 0, 0.29], [0, 0.025, -0.33], [0, 0.0568, -0.81], [0, 0.105, 0.01]),
  sniper: weapon('sniper', 'SniperRifle_3', 1722, 1.2, false, 'scope', [0, 0.01, 0.325], [0, 0.025, -0.375], [0, 0.0598, -0.875], [0, 0.12, -0.015]),
};

// ================================================================================================
// Budgets (checked by tests/assets.test.ts and scripts/assets/verify.mjs)
// ================================================================================================

export const ASSET_BUDGETS = {
  /** Whole public/assets/models tree. */
  totalBytes: 30 * 1024 * 1024,
  /** One character file (mesh, materials, textures). */
  characterBytes: 4 * 1024 * 1024,
  /** Triangles per category (unique geometry per file). */
  tris: { characters: 8000 + 64, weapons: 3000, items: 2000 } as Record<AssetCategory, number>,
  /** Largest texture edge. */
  textureSize: 1024,
} as const;

// ================================================================================================
// Catalog
// ================================================================================================

/** Every file of a category (paths relative to public/assets/models/). */
export function assetFilesFor(category: AssetCategory): string[] {
  switch (category) {
    case 'characters':
      return [...Object.values(CHARACTER_VARIANTS).map((v) => v.file), ...Object.values(CHARACTER_RIGS).map((r) => r.animations)];
    case 'weapons':
      return Object.values(WEAPON_MODELS).map((w) => w.file);
    default:
      return [];
  }
}
