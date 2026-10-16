// Procedural low-poly soldier geometry.
//
// * Near LOD: one skinned geometry (rigid skinning, one bone per vertex) holding the body plus every
//   gear variant (helmet 0-3, vest 1-3, backpack 1-3) and every weapon on its own "variant" bone.
//   Variants that are not worn are collapsed by giving their bone a zero scale, so one geometry and
//   one draw call serve every loadout. ~1.5-2k visible triangles.
// * Mid LOD: a handful of coarse parts (~330 triangles per soldier in total) drawn with one
//   InstancedMesh per part, animated by the same rig (instance matrix = bone matrix).
// * Far LOD: a capsule + head sphere silhouette impostor (one InstancedMesh).
//
// Every part is built in its bone's local space (joint at the origin, limbs extending along -Y),
// so the bone matrices from rig.ts place parts directly. Mask: x accent (team colour), y skin,
// z cloth (per-player fatigue tint).

import * as THREE from 'three';
import { GeoBuilder, M_ACCENT, M_CLOTH, M_SKIN, type PartStyle, xform } from './geometry';
import { B, BONE_COUNT, DIM } from './rig';
import { WEAPON_IDS, buildWeapon } from './weaponModels';

// ---------------------------------------------------------------------------
// Near skeleton layout
// ---------------------------------------------------------------------------

export const NB_HELMET0 = BONE_COUNT; // 13..16 helmet level 0..3
export const NB_VEST1 = NB_HELMET0 + 4; // 17..19 vest level 1..3
export const NB_PACK1 = NB_VEST1 + 3; // 20..22 pack level 1..3
export const NB_WEAPON0 = NB_PACK1 + 3; // 23..28 weapons in WEAPON_IDS order
export const NEAR_BONE_COUNT = NB_WEAPON0 + WEAPON_IDS.length;

/** Base rig bone every near bone follows. */
export const NEAR_BONE_BASE: readonly number[] = (() => {
  const a: number[] = [];
  for (let i = 0; i < BONE_COUNT; i++) a.push(i);
  for (let i = 0; i < 4; i++) a.push(B.HEAD);
  for (let i = 0; i < 3; i++) a.push(B.CHEST);
  for (let i = 0; i < 3; i++) a.push(B.CHEST);
  for (let i = 0; i < WEAPON_IDS.length; i++) a.push(B.WEAPON);
  return a;
})();

/** Chest-space z of the back surface per backpack level (slung rifles rest there). */
export const SLUNG_DEPTH: readonly number[] = [0.17, 0.33, 0.37, 0.42];

// ---------------------------------------------------------------------------
// Colours (sRGB). Cloth parts are light greys multiplied by the per-player fatigue tint.
// ---------------------------------------------------------------------------

const COL = {
  jacket: 0xf2f2f2,
  trousers: 0xd2d2d2,
  collar: 0xbdbdbd,
  belt: 0x2a2620,
  pouch: 0x3d4232,
  glove: 0x2a2a27,
  boot: 0x2b241c,
  sole: 0x171512,
  eye: 0x161616,
  hair: 0x3a2a1d,
  kneePad: 0x2e3029,
  strap: 0x2c2f25,
};

const cloth = (color: number, bone: number): PartStyle => ({ color, mask: M_CLOTH, bone });
const solid = (color: number, bone: number): PartStyle => ({ color, bone });
const accent = (bone: number): PartStyle => ({ color: 0xffffff, mask: M_ACCENT, bone });
const skin = (bone: number): PartStyle => ({ color: 0xffffff, mask: M_SKIN, bone });

const _m = new THREE.Matrix4();
const _l = new THREE.Matrix4();
const at = (base: THREE.Matrix4, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 =>
  _m.multiplyMatrices(base, xform(x, y, z, rx, ry, rz, sx, sy, sz, _l));

// ---------------------------------------------------------------------------
// Gear builders (also used for loot models). Head-bone space: neck joint at origin, head centre y 0.14.
// ---------------------------------------------------------------------------

export function buildHelmet(level: number, b: GeoBuilder, base: THREE.Matrix4, bone: number): void {
  switch (level) {
    case 0: {
      // Soft patrol cap in fatigue colour + hair at the back.
      b.cyl(0.104, 0.112, 0.06, 10, at(base, 0, 0.222, 0.004), cloth(COL.jacket, bone));
      b.box(0.13, 0.012, 0.075, at(base, 0, 0.198, -0.11, 0.12), cloth(COL.collar, bone));
      b.box(0.17, 0.07, 0.05, at(base, 0, 0.16, 0.085), solid(COL.hair, bone));
      break;
    }
    case 1: {
      // Soft padded cap-like helmet.
      const c = 0x3a3f47;
      b.sphere(0.122, 10, 4, at(base, 0, 0.158, 0.004, 0, 0, 0, 1, 0.82, 1.06), solid(c, bone), 0, Math.PI / 2);
      b.cyl(0.124, 0.124, 0.03, 10, at(base, 0, 0.17, 0.004, 0, 0, 0, 1, 1, 1.06), accent(bone));
      b.box(0.03, 0.08, 0.08, at(base, -0.112, 0.125, 0.0), solid(c, bone));
      b.box(0.03, 0.08, 0.08, at(base, 0.112, 0.125, 0.0), solid(c, bone));
      break;
    }
    case 2: {
      // Rounded steel helmet with brim and chin strap.
      const c = 0x57613f;
      b.sphere(0.134, 10, 5, at(base, 0, 0.15, 0.004, 0, 0, 0, 1, 0.92, 1.08), solid(c, bone), 0, Math.PI / 2);
      b.cyl(0.142, 0.146, 0.02, 12, at(base, 0, 0.152, 0.004, 0, 0, 0, 1, 1, 1.08), solid(0x4b5437, bone));
      b.cyl(0.137, 0.139, 0.032, 12, at(base, 0, 0.18, 0.004, 0, 0, 0, 1, 1, 1.08), accent(bone));
      b.box(0.012, 0.09, 0.02, at(base, -0.098, 0.1, -0.03, 0.2), solid(COL.strap, bone));
      b.box(0.012, 0.09, 0.02, at(base, 0.098, 0.1, -0.03, 0.2), solid(COL.strap, bone));
      break;
    }
    default: {
      // Full combat helmet: ear protection, NVG mount, dark visor.
      const c = 0x8a7d59;
      b.sphere(0.146, 12, 5, at(base, 0, 0.148, 0.01, 0, 0, 0, 1, 0.98, 1.1), solid(c, bone), 0, Math.PI / 2);
      b.cyl(0.15, 0.152, 0.05, 12, at(base, 0, 0.135, 0.012, 0, 0, 0, 1, 1, 1.08), solid(c, bone), true);
      b.cyl(0.149, 0.15, 0.03, 12, at(base, 0, 0.2, 0.01, 0, 0, 0, 1, 1, 1.09), accent(bone));
      b.box(0.045, 0.085, 0.095, at(base, -0.138, 0.11, 0.0), solid(0x34342f, bone));
      b.box(0.045, 0.085, 0.095, at(base, 0.138, 0.11, 0.0), solid(0x34342f, bone));
      b.box(0.05, 0.035, 0.04, at(base, 0, 0.255, -0.13, 0.4), solid(0x2a2a27, bone));
      b.taper(0.25, 0.04, 0.27, 0.03, 0.075, at(base, 0, 0.128, -0.138, 0.18), solid(0x141c24, bone));
      b.box(0.02, 0.012, 0.18, at(base, -0.14, 0.17, 0.0), solid(0x2a2a27, bone));
      b.box(0.02, 0.012, 0.18, at(base, 0.14, 0.17, 0.0), solid(0x2a2a27, bone));
      break;
    }
  }
}

/** Chest-bone space (chest joint at origin, torso centre y 0.13). */
export function buildVest(level: number, b: GeoBuilder, base: THREE.Matrix4, bone: number): void {
  if (level <= 1) {
    const c = 0x2f3439;
    b.taper(0.37, 0.255, 0.4, 0.265, 0.28, at(base, 0, 0.11, 0), solid(c, bone));
    b.box(0.07, 0.02, 0.24, at(base, -0.12, 0.27, 0), solid(c, bone));
    b.box(0.07, 0.02, 0.24, at(base, 0.12, 0.27, 0), solid(c, bone));
    b.box(0.2, 0.05, 0.02, at(base, 0, 0.0, -0.135), solid(0x23272b, bone));
    return;
  }
  if (level === 2) {
    const c = 0x4e5638;
    b.taper(0.375, 0.27, 0.41, 0.28, 0.27, at(base, 0, 0.12, 0), solid(c, bone));
    b.box(0.3, 0.24, 0.03, at(base, 0, 0.13, -0.148), solid(0x464e32, bone));
    b.box(0.3, 0.24, 0.03, at(base, 0, 0.13, 0.148), solid(0x464e32, bone));
    for (const x of [-0.075, 0.075]) b.box(0.07, 0.1, 0.05, at(base, x, 0.04, -0.18), solid(0x3f462d, bone));
    b.box(0.07, 0.02, 0.26, at(base, -0.13, 0.272, 0), solid(c, bone));
    b.box(0.07, 0.02, 0.26, at(base, 0.13, 0.272, 0), solid(c, bone));
    b.box(0.06, 0.08, 0.05, at(base, -0.2, 0.05, 0.02), solid(0x3f462d, bone));
    return;
  }
  // Level 3: heavy plate carrier with collar and shoulder pads.
  const c = 0x7c7050;
  b.taper(0.395, 0.29, 0.44, 0.3, 0.3, at(base, 0, 0.12, 0), solid(c, bone));
  b.box(0.32, 0.26, 0.04, at(base, 0, 0.13, -0.165), solid(0x706548, bone));
  b.box(0.32, 0.26, 0.04, at(base, 0, 0.13, 0.165), solid(0x706548, bone));
  for (const x of [-0.095, 0, 0.095]) b.box(0.078, 0.11, 0.06, at(base, x, 0.03, -0.205), solid(0x62583e, bone));
  b.box(0.3, 0.07, 0.07, at(base, 0, 0.3, 0.11), solid(c, bone));
  b.box(0.07, 0.07, 0.17, at(base, -0.12, 0.3, 0.0, 0, 0.35), solid(c, bone));
  b.box(0.07, 0.07, 0.17, at(base, 0.12, 0.3, 0.0, 0, -0.35), solid(c, bone));
  b.box(0.13, 0.04, 0.15, at(base, -0.23, 0.25, 0, 0, 0, 0.4), solid(0x706548, bone));
  b.box(0.13, 0.04, 0.15, at(base, 0.23, 0.25, 0, 0, 0, -0.4), solid(0x706548, bone));
  b.box(0.06, 0.12, 0.06, at(base, 0.22, 0.06, 0.03), solid(0x2a2a27, bone)); // radio
  b.box(0.012, 0.16, 0.012, at(base, 0.22, 0.18, 0.06), solid(0x1d1d1b, bone)); // antenna
}

/** Chest-bone space. Packs sit behind the torso with a vertical team-colour stripe. */
export function buildPack(level: number, b: GeoBuilder, base: THREE.Matrix4, bone: number): void {
  const strapZ = -0.135;
  const straps = (y: number, h: number): void => {
    b.box(0.045, h, 0.02, at(base, -0.1, y, strapZ, -0.08), solid(COL.strap, bone));
    b.box(0.045, h, 0.02, at(base, 0.1, y, strapZ, -0.08), solid(COL.strap, bone));
  };
  if (level <= 1) {
    const z = 0.24, d = 0.13;
    b.box(0.27, 0.3, d, at(base, 0, 0.1, z), solid(0x4a4f3a, bone));
    b.box(0.05, 0.29, 0.012, at(base, 0, 0.1, z + d / 2 + 0.004), accent(bone));
    b.box(0.2, 0.1, 0.03, at(base, 0, 0.02, z + d / 2 + 0.012), solid(0x41452f, bone));
    straps(0.13, 0.3);
    return;
  }
  if (level === 2) {
    const z = 0.26, d = 0.17;
    b.box(0.32, 0.42, d, at(base, 0, 0.08, z), solid(0x50563c, bone));
    b.box(0.3, 0.06, 0.18, at(base, 0, 0.3, z, -0.08), solid(0x464b33, bone));
    b.box(0.05, 0.18, 0.12, at(base, -0.185, 0.0, z), solid(0x464b33, bone));
    b.box(0.05, 0.18, 0.12, at(base, 0.185, 0.0, z), solid(0x464b33, bone));
    b.box(0.06, 0.4, 0.012, at(base, 0, 0.08, z + d / 2 + 0.004), accent(bone));
    straps(0.13, 0.32);
    return;
  }
  const z = 0.285, d = 0.22;
  b.box(0.36, 0.56, d, at(base, 0, 0.06, z), solid(0x5b5b41, bone));
  b.cyl(0.065, 0.065, 0.4, 8, at(base, 0, 0.4, z, 0, 0, Math.PI / 2), solid(0x6d6651, bone));
  b.box(0.06, 0.24, 0.16, at(base, -0.21, -0.02, z), solid(0x4f4f37, bone));
  b.box(0.06, 0.24, 0.16, at(base, 0.21, -0.02, z), solid(0x4f4f37, bone));
  b.box(0.26, 0.14, 0.05, at(base, 0, -0.08, z + d / 2 + 0.02), solid(0x4f4f37, bone));
  b.box(0.065, 0.54, 0.012, at(base, 0, 0.07, z + d / 2 + 0.004), accent(bone));
  b.box(0.02, 0.62, 0.02, at(base, -0.17, 0.06, z - d / 2 - 0.01), solid(0x2f2f2c, bone));
  b.box(0.02, 0.62, 0.02, at(base, 0.17, 0.06, z - d / 2 - 0.01), solid(0x2f2f2c, bone));
  straps(0.13, 0.34);
}

// ---------------------------------------------------------------------------
// Body parts (bone local)
// ---------------------------------------------------------------------------

const I = new THREE.Matrix4();

function buildPelvis(b: GeoBuilder, bone: number): void {
  b.taper(0.3, 0.2, 0.33, 0.215, 0.2, at(I, 0, -0.02, 0), cloth(COL.trousers, bone));
  b.box(0.345, 0.045, 0.228, at(I, 0, 0.07, 0), solid(COL.belt, bone));
  b.box(0.05, 0.07, 0.07, at(I, -0.17, 0.03, 0.03), solid(COL.pouch, bone));
  b.box(0.05, 0.07, 0.07, at(I, 0.17, 0.03, 0.03), solid(COL.pouch, bone));
  b.box(0.08, 0.06, 0.03, at(I, 0.07, 0.04, 0.12), solid(COL.pouch, bone));
}

function buildAbdomen(b: GeoBuilder, bone: number): void {
  b.taper(0.31, 0.2, 0.33, 0.21, 0.2, at(I, 0, 0.09, 0), cloth(COL.jacket, bone));
}

function buildChest(b: GeoBuilder, bone: number): void {
  b.taper(0.34, 0.215, 0.42, 0.235, 0.32, at(I, 0, 0.12, 0), cloth(COL.jacket, bone));
  b.sphere(0.078, 8, 5, at(I, -DIM.shoulderX, DIM.shoulderY - 0.01, 0), cloth(COL.jacket, bone));
  b.sphere(0.078, 8, 5, at(I, DIM.shoulderX, DIM.shoulderY - 0.01, 0), cloth(COL.jacket, bone));
  b.box(0.17, 0.04, 0.15, at(I, 0, 0.285, 0.01), cloth(COL.collar, bone));
  b.box(0.06, 0.08, 0.02, at(I, -0.1, 0.17, -0.12), cloth(COL.collar, bone)); // chest pockets
  b.box(0.06, 0.08, 0.02, at(I, 0.1, 0.17, -0.12), cloth(COL.collar, bone));
}

function buildHead(b: GeoBuilder, bone: number): void {
  b.cyl(0.054, 0.06, 0.1, 8, at(I, 0, 0.02, 0.005), skin(bone));
  b.sphere(0.103, 10, 7, at(I, 0, DIM.headCenter, -0.006, 0, 0, 0, 0.95, 1.12, 1.0), { ...skin(bone), smooth: true });
  b.box(0.026, 0.038, 0.03, at(I, 0, 0.13, -0.106), skin(bone)); // nose
  b.box(0.02, 0.045, 0.035, at(I, -0.1, 0.14, 0.0), skin(bone)); // ears
  b.box(0.02, 0.045, 0.035, at(I, 0.1, 0.14, 0.0), skin(bone));
  b.box(0.022, 0.012, 0.01, at(I, -0.036, 0.158, -0.097), solid(COL.eye, bone));
  b.box(0.022, 0.012, 0.01, at(I, 0.036, 0.158, -0.097), solid(COL.eye, bone));
  b.box(0.05, 0.008, 0.01, at(I, 0, 0.098, -0.098), solid(0x7a4a3c, bone)); // mouth
}

function buildUpperArm(b: GeoBuilder, bone: number): void {
  b.cyl(0.068, 0.057, DIM.upperArm, 8, at(I, 0, -DIM.upperArm / 2, 0), cloth(COL.jacket, bone));
  b.cyl(0.072, 0.07, 0.055, 8, at(I, 0, -0.09, 0), accent(bone));
}

function buildForeArm(b: GeoBuilder, bone: number): void {
  b.cyl(0.056, 0.046, 0.22, 8, at(I, 0, -0.11, 0), cloth(COL.jacket, bone));
  b.cyl(0.05, 0.05, 0.03, 8, at(I, 0, -0.215, 0), cloth(COL.collar, bone));
  b.box(0.058, 0.1, 0.085, at(I, 0, -DIM.foreArm + 0.02, -0.005), solid(COL.glove, bone));
  b.box(0.022, 0.05, 0.022, at(I, 0, -0.27, -0.05, 0.4), solid(COL.glove, bone));
}

function buildThigh(b: GeoBuilder, bone: number): void {
  b.cyl(0.086, 0.07, DIM.thigh, 8, at(I, 0, -DIM.thigh / 2, 0), cloth(COL.trousers, bone));
  b.box(0.1, 0.1, 0.03, at(I, 0, -DIM.thigh + 0.01, -0.07), solid(COL.kneePad, bone));
}

function buildShin(b: GeoBuilder, bone: number): void {
  const total = DIM.shin + DIM.foot;
  b.cyl(0.067, 0.057, 0.33, 8, at(I, 0, -0.165, 0), cloth(COL.trousers, bone));
  b.cyl(0.063, 0.065, 0.1, 8, at(I, 0, -0.37, 0), solid(COL.boot, bone));
  b.box(0.1, 0.08, 0.25, at(I, 0, -total + 0.05, -0.06), solid(COL.boot, bone));
  b.box(0.106, 0.02, 0.262, at(I, 0, -total + 0.01, -0.062), solid(COL.sole, bone));
}

// ---------------------------------------------------------------------------
// Near LOD skinned geometry
// ---------------------------------------------------------------------------

export function buildNearSoldierGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  buildPelvis(b, B.HIPS);
  buildAbdomen(b, B.SPINE);
  buildChest(b, B.CHEST);
  buildHead(b, B.HEAD);
  buildUpperArm(b, B.UARM_L);
  buildUpperArm(b, B.UARM_R);
  buildForeArm(b, B.FARM_L);
  buildForeArm(b, B.FARM_R);
  buildThigh(b, B.THIGH_L);
  buildThigh(b, B.THIGH_R);
  buildShin(b, B.SHIN_L);
  buildShin(b, B.SHIN_R);
  for (let l = 0; l < 4; l++) buildHelmet(l, b, I, NB_HELMET0 + l);
  for (let l = 1; l <= 3; l++) buildVest(l, b, I, NB_VEST1 + l - 1);
  for (let l = 1; l <= 3; l++) buildPack(l, b, I, NB_PACK1 + l - 1);
  WEAPON_IDS.forEach((id, i) => buildWeapon(id, b, I, NB_WEAPON0 + i));
  return b.build({ mask: true, skin: true });
}

// ---------------------------------------------------------------------------
// Mid LOD parts
// ---------------------------------------------------------------------------

export interface MidPartGeometries {
  pelvis: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  vest: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  helmet: THREE.BufferGeometry;
  pack: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  foreArm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  longGun: THREE.BufferGeometry;
  pistol: THREE.BufferGeometry;
}

/** Mid-LOD base colours for vests / helmets per level (applied through the per-instance cloth tint). */
export const MID_VEST_TINT: readonly number[] = [0xffffff, 0x3a3f45, 0x5a6342, 0x8a7d59];
export const MID_HELMET_TINT: readonly number[] = [0xffffff, 0x434852, 0x5d6844, 0x95875f];

export function buildMidParts(): MidPartGeometries {
  const one = (fn: (b: GeoBuilder) => void): THREE.BufferGeometry => {
    const b = new GeoBuilder();
    fn(b);
    return b.build({ mask: true });
  };
  return {
    pelvis: one((b) => {
      b.box(0.32, 0.22, 0.21, at(I, 0, -0.02, 0), cloth(COL.trousers, 0));
    }),
    torso: one((b) => {
      // Abdomen + chest as one tapered block hanging below the chest joint.
      b.taper(0.32, 0.2, 0.43, 0.235, 0.52, at(I, 0, 0.05, 0), cloth(COL.jacket, 0));
    }),
    vest: one((b) => {
      b.taper(0.38, 0.27, 0.42, 0.285, 0.28, at(I, 0, 0.12, 0), cloth(0xffffff, 0));
    }),
    head: one((b) => {
      b.sphere(0.11, 6, 4, at(I, 0, DIM.headCenter - 0.01, 0, 0, 0, 0, 0.95, 1.1, 1), solid(0xb98a68, 0));
      b.cyl(0.055, 0.055, 0.1, 5, at(I, 0, 0.02, 0), solid(0xb98a68, 0));
    }),
    helmet: one((b) => {
      b.sphere(0.138, 6, 2, at(I, 0, 0.16, 0.005, 0, 0, 0, 1, 0.95, 1.08), cloth(0xffffff, 0), 0, Math.PI / 2);
      b.cyl(0.14, 0.14, 0.04, 6, at(I, 0, 0.165, 0.005, 0, 0, 0, 1, 1, 1.08), accent(0));
    }),
    pack: one((b) => {
      b.box(0.32, 0.42, 0.17, at(I, 0, 0.08, 0.26), solid(0x50563c, 0));
      b.box(0.07, 0.4, 0.012, at(I, 0, 0.08, 0.35), accent(0));
    }),
    upperArm: one((b) => {
      b.box(0.12, DIM.upperArm, 0.12, at(I, 0, -DIM.upperArm / 2, 0), cloth(COL.jacket, 0));
      b.box(0.13, 0.06, 0.13, at(I, 0, -0.09, 0), accent(0));
    }),
    foreArm: one((b) => {
      b.box(0.1, 0.24, 0.1, at(I, 0, -0.12, 0), cloth(COL.jacket, 0));
      b.box(0.06, 0.1, 0.085, at(I, 0, -DIM.foreArm + 0.02, 0), solid(COL.glove, 0));
    }),
    thigh: one((b) => {
      b.box(0.15, DIM.thigh, 0.15, at(I, 0, -DIM.thigh / 2, 0), cloth(COL.trousers, 0));
    }),
    shin: one((b) => {
      b.box(0.12, 0.36, 0.12, at(I, 0, -0.18, 0), cloth(COL.trousers, 0));
      b.box(0.1, 0.12, 0.25, at(I, 0, -DIM.shin - DIM.foot + 0.06, -0.06), solid(COL.boot, 0));
    }),
    longGun: one((b) => {
      // Generic 0.9 m long gun (scaled along z per weapon length).
      b.box(0.055, 0.1, 0.4, at(I, 0, 0.04, -0.08), solid(0x232527, 0));
      b.box(0.04, 0.04, 0.34, at(I, 0, 0.055, -0.45), solid(0x2b2e31, 0));
      b.box(0.04, 0.09, 0.18, at(I, 0, 0.03, 0.18), solid(0x232527, 0));
      b.box(0.03, 0.14, 0.06, at(I, 0, -0.06, -0.15, 0.25), solid(0x2b2e31, 0));
    }),
    pistol: one((b) => {
      b.box(0.03, 0.04, 0.19, at(I, 0, 0.065, -0.07), solid(0x1b1d1f, 0));
      b.box(0.03, 0.1, 0.045, at(I, 0, 0.0, 0.0, -0.26), solid(0x1b1d1f, 0));
    }),
  };
}

// ---------------------------------------------------------------------------
// Far impostor
// ---------------------------------------------------------------------------

/** Capsule body + head sphere in model space (feet at origin, standing). Mostly team tinted. */
export function buildFarImpostor(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const body: PartStyle = { color: 0x30342a, mask: [0.5, 0, 0] };
  const head: PartStyle = { color: 0x2a2c26, mask: [0.25, 0, 0] };
  const g = new THREE.CapsuleGeometry(0.23, 1.0, 2, 6);
  b.add(g, xform(0, 0.76, 0), body);
  g.dispose();
  b.sphere(0.135, 6, 4, xform(0, 1.6, -0.01), head);
  return b.build({ mask: true });
}
