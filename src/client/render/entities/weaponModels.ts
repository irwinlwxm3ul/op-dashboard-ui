// Procedural third-person / loot gun models, one recognisable silhouette per WeaponId, plus the
// hand-hold data the character rig needs (where the right hand grips, where the support hand goes,
// where the stock butt sits). Weapon local frame: right-hand grip at the origin, barrel along -Z,
// up +Y, right +X (same frame the rig places in the character's aim space).

import * as THREE from 'three';
import type { WeaponId } from '../../../shared/types';
import { GeoBuilder, type PartStyle, xform } from './geometry';

export const WEAPON_IDS: readonly WeaponId[] = ['pistol', 'smg', 'ar', 'shotgun', 'dmr', 'sniper'];

export interface WeaponHold {
  /** Pistol-class: held out in front with both hands instead of shouldered. */
  pistol: boolean;
  /** Stock butt in weapon space (sits on the shoulder pocket). For pistols: grip offset reference. */
  butt: readonly [number, number, number];
  /** Support (left) hand position in weapon space. */
  fore: readonly [number, number, number];
  /** Muzzle position in weapon space. */
  muzzle: readonly [number, number, number];
  /** Overall length (m), used by the coarse LOD to scale a generic long gun. */
  length: number;
}

export const WEAPON_HOLD: Record<WeaponId, WeaponHold> = {
  pistol: { pistol: true, butt: [0, 0, 0], fore: [-0.028, -0.025, 0.012], muzzle: [0, 0.075, -0.17], length: 0.2 },
  smg: { pistol: false, butt: [0, 0.035, 0.25], fore: [0, -0.085, -0.17], muzzle: [0, 0.045, -0.4], length: 0.66 },
  ar: { pistol: false, butt: [0, 0.04, 0.28], fore: [0, 0.03, -0.3], muzzle: [0, 0.055, -0.6], length: 0.9 },
  shotgun: { pistol: false, butt: [0, 0.0, 0.34], fore: [0, 0.01, -0.4], muzzle: [0, 0.065, -0.72], length: 1.06 },
  dmr: { pistol: false, butt: [0, 0.01, 0.31], fore: [0, 0.015, -0.34], muzzle: [0, 0.06, -0.74], length: 1.06 },
  sniper: { pistol: false, butt: [0, 0.01, 0.35], fore: [0, 0.0, -0.38], muzzle: [0, 0.065, -0.9], length: 1.26 },
};

const C = {
  metal: 0x2b2e31,
  black: 0x1b1d1f,
  grey: 0x3d4145,
  steel: 0x5c6166,
  wood: 0x6e4a2b,
  woodDark: 0x553820,
  tan: 0x9a8762,
  olive: 0x4c5541,
  lens: 0x1b2a38,
  redLens: 0x7a1a14,
};

const _m = new THREE.Matrix4();
const _l = new THREE.Matrix4();

/** Add a weapon model to `b`, transformed by `base`, assigned to `bone`. */
export function buildWeapon(id: WeaponId, b: GeoBuilder, base: THREE.Matrix4, bone = 0): void {
  const st = (color: number): PartStyle => ({ color, bone });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx = 0, ry = 0, rz = 0): void => {
    b.box(w, h, d, _m.multiplyMatrices(base, xform(x, y, z, rx, ry, rz, 1, 1, 1, _l)), st(color));
  };
  // Cylinder along Z (barrels, scopes).
  const tubeZ = (r0: number, r1: number, len: number, x: number, y: number, z: number, color: number, seg = 8): void => {
    b.cyl(r0, r1, len, seg, _m.multiplyMatrices(base, xform(x, y, z, Math.PI / 2, 0, 0, 1, 1, 1, _l)), st(color));
  };
  switch (id) {
    case 'pistol': {
      box(0.03, 0.034, 0.19, 0, 0.074, -0.07, C.black); // slide
      box(0.026, 0.028, 0.15, 0, 0.046, -0.065, C.metal); // frame
      box(0.03, 0.105, 0.045, 0, -0.005, 0.004, C.black, -0.26); // grip
      box(0.008, 0.03, 0.04, 0, 0.022, -0.035, C.metal); // trigger guard
      box(0.008, 0.01, 0.012, 0, 0.096, -0.155, C.metal); // front sight
      box(0.02, 0.01, 0.012, 0, 0.096, 0.012, C.metal); // rear sight
      tubeZ(0.007, 0.007, 0.01, 0, 0.075, -0.168, C.grey, 6); // muzzle
      break;
    }
    case 'smg': {
      box(0.052, 0.1, 0.3, 0, 0.045, -0.1, C.black); // receiver
      box(0.044, 0.05, 0.12, 0, 0.065, -0.29, C.metal); // shroud
      tubeZ(0.02, 0.02, 0.07, 0, 0.045, -0.37, C.grey); // stubby muzzle
      box(0.03, 0.18, 0.045, 0, -0.1, -0.06, C.metal, 0.08); // long straight magazine
      box(0.03, 0.1, 0.04, 0, -0.03, 0.0, C.black, -0.3); // pistol grip
      box(0.03, 0.09, 0.035, 0, -0.04, -0.17, C.black, 0.1); // vertical fore grip
      box(0.012, 0.012, 0.22, 0.018, 0.06, 0.14, C.steel); // wire stock rails
      box(0.012, 0.012, 0.22, -0.018, 0.06, 0.14, C.steel);
      box(0.05, 0.08, 0.018, 0, 0.04, 0.25, C.black); // butt plate
      box(0.03, 0.035, 0.06, 0, 0.11, -0.12, C.metal); // red dot
      box(0.026, 0.028, 0.006, 0, 0.115, -0.152, C.redLens);
      break;
    }
    case 'ar': {
      box(0.058, 0.09, 0.36, 0, 0.05, -0.08, C.black); // upper/lower receiver
      box(0.056, 0.064, 0.28, 0, 0.056, -0.38, C.metal); // handguard
      tubeZ(0.011, 0.011, 0.14, 0, 0.055, -0.58, C.grey);
      tubeZ(0.017, 0.017, 0.05, 0, 0.055, -0.64, C.black); // flash hider
      box(0.032, 0.17, 0.068, 0, -0.07, -0.16, C.metal, 0.28); // curved magazine
      box(0.032, 0.1, 0.045, 0, -0.035, 0.005, C.black, -0.35); // pistol grip
      box(0.04, 0.075, 0.2, 0, 0.04, 0.18, C.black); // stock
      box(0.044, 0.1, 0.03, 0, 0.03, 0.285, C.grey); // butt pad
      box(0.04, 0.03, 0.08, 0, 0.11, -0.12, C.black); // red dot mount
      tubeZ(0.022, 0.022, 0.07, 0, 0.14, -0.12, C.metal);
      box(0.03, 0.03, 0.004, 0, 0.14, -0.158, C.redLens);
      box(0.012, 0.045, 0.012, 0, 0.095, -0.5, C.black); // front sight post
      break;
    }
    case 'shotgun': {
      box(0.052, 0.085, 0.24, 0, 0.045, -0.06, C.metal); // receiver
      tubeZ(0.017, 0.017, 0.56, 0, 0.065, -0.45, C.grey); // barrel
      tubeZ(0.015, 0.015, 0.44, 0, 0.028, -0.4, C.metal); // magazine tube
      box(0.056, 0.052, 0.17, 0, 0.022, -0.4, C.wood); // pump
      box(0.032, 0.1, 0.05, 0, -0.03, 0.03, C.woodDark, -0.45); // grip wrist
      b.taper(0.045, 0.06, 0.04, 0.1, 0.3, _m.multiplyMatrices(base, xform(0, 0.0, 0.2, Math.PI / 2 + 0.12, 0, 0, 1, 1, 1, _l)), st(C.wood));
      box(0.046, 0.12, 0.025, 0, -0.015, 0.345, C.black); // recoil pad
      box(0.01, 0.014, 0.01, 0, 0.088, -0.71, C.steel); // bead sight
      break;
    }
    case 'dmr': {
      box(0.05, 0.075, 0.3, 0, 0.045, -0.06, C.metal); // receiver
      tubeZ(0.014, 0.012, 0.46, 0, 0.06, -0.5, C.grey); // barrel
      box(0.055, 0.06, 0.34, 0, 0.03, -0.32, C.tan); // fore stock
      b.taper(0.045, 0.06, 0.04, 0.11, 0.3, _m.multiplyMatrices(base, xform(0, -0.005, 0.17, Math.PI / 2 + 0.08, 0, 0, 1, 1, 1, _l)), st(C.tan));
      box(0.03, 0.1, 0.045, 0, -0.03, 0.02, C.tan, -0.4); // grip
      box(0.03, 0.11, 0.07, 0, -0.05, -0.1, C.black, 0.12); // magazine
      tubeZ(0.024, 0.024, 0.22, 0, 0.125, -0.08, C.black); // 4x scope body
      tubeZ(0.034, 0.024, 0.07, 0, 0.125, -0.22, C.black); // objective bell
      tubeZ(0.027, 0.024, 0.05, 0, 0.125, 0.06, C.black); // eyepiece
      box(0.034, 0.004, 0.004, 0, 0.125, -0.257, C.lens);
      box(0.02, 0.05, 0.02, 0, 0.09, -0.15, C.metal); // mounts
      box(0.02, 0.05, 0.02, 0, 0.09, -0.01, C.metal);
      box(0.046, 0.11, 0.025, 0, 0.0, 0.32, C.black); // butt pad
      break;
    }
    case 'sniper': {
      box(0.06, 0.085, 0.36, 0, 0.045, -0.06, C.olive); // chassis
      tubeZ(0.018, 0.015, 0.62, 0, 0.065, -0.56, C.metal); // heavy barrel
      box(0.04, 0.034, 0.08, 0, 0.065, -0.9, C.black); // muzzle brake
      box(0.062, 0.07, 0.3, 0, 0.03, -0.32, C.olive); // fore end
      b.taper(0.05, 0.07, 0.046, 0.13, 0.32, _m.multiplyMatrices(base, xform(0, 0.0, 0.2, Math.PI / 2 + 0.06, 0, 0, 1, 1, 1, _l)), st(C.olive));
      box(0.034, 0.1, 0.05, 0, -0.035, 0.02, C.olive, -0.4); // grip
      box(0.036, 0.09, 0.08, 0, -0.035, -0.1, C.black); // magazine
      box(0.05, 0.015, 0.015, 0.045, 0.065, 0.02, C.steel); // bolt handle
      b.sphere(0.014, 6, 4, _m.multiplyMatrices(base, xform(0.072, 0.06, 0.02, 0, 0, 0, 1, 1, 1, _l)), st(C.steel));
      tubeZ(0.028, 0.028, 0.3, 0, 0.14, -0.08, C.black, 10); // 8x scope body
      tubeZ(0.044, 0.028, 0.09, 0, 0.14, -0.27, C.black, 10); // objective bell
      tubeZ(0.032, 0.028, 0.06, 0, 0.14, 0.1, C.black, 10); // eyepiece
      box(0.05, 0.004, 0.004, 0, 0.14, -0.318, C.lens);
      box(0.02, 0.06, 0.02, 0, 0.1, -0.17, C.metal);
      box(0.02, 0.06, 0.02, 0, 0.1, 0.0, C.metal);
      box(0.012, 0.03, 0.03, 0.03, 0.14, -0.08, C.black); // turret
      box(0.05, 0.13, 0.03, 0, -0.005, 0.355, C.black); // butt pad
      box(0.05, 0.03, 0.12, 0, 0.1, 0.25, C.olive); // cheek riser
      break;
    }
  }
}

/** Standalone weapon geometry (vertex colours only), e.g. for loot. */
export function weaponGeometry(id: WeaponId, base: THREE.Matrix4 = new THREE.Matrix4()): THREE.BufferGeometry {
  const b = new GeoBuilder();
  buildWeapon(id, b, base);
  return b.build();
}
