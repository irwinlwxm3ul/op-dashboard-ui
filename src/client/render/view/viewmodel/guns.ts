// First-person gun models per WeaponId with their animation anchors: procedural guns (fallback,
// with moving parts) and wrappers around the imported weapon models (buildModelGun).
//
// Gun-local space: origin at the firing hand's grip point, -Z towards the muzzle, +Y up. Static
// parts are merged per material; moving parts (magazine, slide, bolt, pump, charging handle) are
// separate child groups whose rest transform is identity so animations only add offsets.

import * as THREE from 'three';
import type { WeaponId } from '../../../../shared/types';
import { WEAPON_MODELS } from '../../../assets';
import type { CasingKind } from '../../fx/casings';
import { PartBuilder, type MatKey } from './parts';

export interface GunModel {
  id: WeaponId;
  root: THREE.Group;
  /** Moving parts (rest = identity local transform). */
  mag: THREE.Group | null;
  slide: THREE.Group | null;
  bolt: THREE.Group | null;
  pump: THREE.Group | null;
  charge: THREE.Group | null;
  /** Red-dot reticle (kept unlit and bright). */
  reticle: THREE.Mesh | null;
  /** Anchors in gun-local space. */
  muzzle: THREE.Vector3;
  eject: THREE.Vector3;
  /** Left hand rest position and orientation (euler, gun-local). */
  support: THREE.Vector3;
  supportRot: THREE.Euler;
  /** Right hand orientation at the grip (euler, gun-local). */
  gripRot: THREE.Euler;
  /** Where the left hand goes for the bolt / charging handle during empty reloads. */
  chargeAnchor: THREE.Vector3;
  /** Bottom of the magazine (left hand during mag swaps), gun-local at rest. */
  magBottom: THREE.Vector3;
  /** Direction the magazine drops out (gun-local, unit). */
  magDrop: THREE.Vector3;
  /** Loading port (shotgun shells). */
  port: THREE.Vector3;
  /** Height of the sight line above the origin and the z of the rear sight / eyepiece. */
  sightY: number;
  sightZ: number;
  /** Distance from the eye to sightZ when aiming. */
  eyeRelief: number;
  /** Hip pose: grip position in camera space and rotation. */
  hip: THREE.Vector3;
  hipRot: THREE.Euler;
  casing: CasingKind;
  flashScale: number;
  /** Magnified optic: the scope overlay replaces the viewmodel at full ADS. */
  scoped: boolean;
  /** Left hand shape at rest: wrapped around a grip, or palm-up under a handguard. */
  supportStyle: 'grip' | 'palm';
  /** Offset of the right hand group from the gun origin (models put the fist centre at the origin). */
  gripOffset: THREE.Vector3;
  /** Sight line x (normally 0). */
  sightX: number;
  /** The magazine is part of a single static mesh (imported model): reloads hand in a spare mag. */
  fixedMag: boolean;
  /** Spare magazine carried in by the support hand during reloads (fixed-mag guns), rest offset. */
  spareMag: THREE.Object3D | null;
  spareRest: THREE.Vector3;
  /** Bolt knob (gun-local) for guns without an animated bolt part (imported bolt-action model). */
  boltKnob: THREE.Vector3 | null;
  /** Geometry/materials are shared with the asset cache: never dispose them. */
  shared: boolean;
}

function base(id: WeaponId, root: THREE.Group): GunModel {
  return {
    id,
    root,
    mag: null, slide: null, bolt: null, pump: null, charge: null, reticle: null,
    muzzle: new THREE.Vector3(),
    eject: new THREE.Vector3(),
    support: new THREE.Vector3(),
    supportRot: new THREE.Euler(),
    gripRot: new THREE.Euler(-0.28, 0, 0),
    chargeAnchor: new THREE.Vector3(),
    magBottom: new THREE.Vector3(),
    magDrop: new THREE.Vector3(0, -1, 0),
    port: new THREE.Vector3(),
    sightY: 0.08,
    sightZ: 0,
    eyeRelief: 0.15,
    hip: new THREE.Vector3(0.12, -0.14, -0.27),
    hipRot: new THREE.Euler(0, 0.035, 0),
    casing: 'rifle',
    flashScale: 1,
    scoped: false,
    supportStyle: 'palm',
    gripOffset: new THREE.Vector3(),
    sightX: 0,
    fixedMag: false,
    spareMag: null,
    spareRest: new THREE.Vector3(),
    boltKnob: null,
    shared: false,
  };
}

/** Trigger + guard shared by most guns (around the origin). */
function trigger(b: PartBuilder, mat: MatKey, z = -0.03): void {
  b.box(mat, 0.005, 0.004, 0.05, 0, -0.03, z - 0.002);           // guard bottom
  b.box(mat, 0.005, 0.03, 0.005, 0, -0.016, z - 0.026);          // guard front
  b.box('darkMetal', 0.004, 0.02, 0.006, 0, -0.012, z + 0.002, 0.3);   // trigger blade
}

function addGroup(root: THREE.Group, b: PartBuilder, name: string): THREE.Group {
  const g = b.build(name);
  root.add(g);
  return g;
}

// ------------------------------------------------------------------------------------------------

function pistol(mats: Record<MatKey, THREE.Material>): GunModel {
  const root = new THREE.Group();
  root.name = 'vm-pistol';
  const m = base('pistol', root);
  const frame = new PartBuilder(mats);
  frame.box('polymer', 0.026, 0.02, 0.15, 0, 0.012, -0.065);                 // frame / dust cover
  frame.box('polymer', 0.028, 0.105, 0.046, 0, -0.045, 0.014, -0.28);        // grip
  frame.box('polymer', 0.03, 0.012, 0.02, 0, 0.004, 0.035);                 // beaver tail
  trigger(frame, 'polymer', -0.035);
  root.add(frame.build('pistol-frame'));

  const slide = new PartBuilder(mats);
  slide.box('metal', 0.028, 0.031, 0.188, 0, 0.037, -0.055);               // slide
  for (let i = 0; i < 6; i++) slide.box('darkMetal', 0.0295, 0.022, 0.003, 0, 0.036, 0.022 + i * 0.006 - 0.012); // serrations
  slide.cylZ('darkMetal', 0.0065, 0.0065, 0.012, 0, 0.037, -0.152);         // barrel crown
  slide.box('darkMetal', 0.004, 0.006, 0.005, 0, 0.0555, -0.138);           // front post
  slide.box('darkMetal', 0.0065, 0.007, 0.006, -0.0062, 0.0555, 0.026);     // rear notch L
  slide.box('darkMetal', 0.0065, 0.007, 0.006, 0.0062, 0.0555, 0.026);      // rear notch R
  slide.box('darkMetal', 0.002, 0.012, 0.03, 0.0145, 0.042, -0.025);        // ejection port
  m.slide = addGroup(root, slide, 'pistol-slide');

  const mag = new PartBuilder(mats);
  mag.box('darkMetal', 0.02, 0.1, 0.034, 0, -0.045, 0.012, -0.28);          // body (inside grip)
  mag.box('polymer', 0.03, 0.012, 0.05, 0, -0.098, 0.03, -0.28);            // base plate
  m.mag = addGroup(root, mag, 'pistol-mag');

  m.muzzle.set(0, 0.037, -0.16);
  m.eject.set(0.016, 0.045, -0.025);
  // Two-handed grip: the support hand wraps the firing hand from the left.
  m.support.set(-0.021, -0.034, -0.006);
  m.supportRot.set(-0.28, 0.3, 0.12);
  m.gripRot.set(-0.28, 0, 0);
  m.chargeAnchor.set(-0.02, 0.04, 0.02);
  m.magBottom.set(0, -0.1, 0.03);
  m.magDrop.set(0, -0.96, 0.27).normalize();
  m.sightY = 0.059;
  m.sightZ = 0.026;
  m.eyeRelief = 0.34;
  m.hip.set(0.11, -0.135, -0.37);
  m.hipRot.set(0.02, 0.06, 0);
  m.casing = 'pistol';
  m.flashScale = 0.7;
  m.supportStyle = 'grip';
  return m;
}

function smg(mats: Record<MatKey, THREE.Material>): GunModel {
  const root = new THREE.Group();
  root.name = 'vm-smg';
  const m = base('smg', root);
  const b = new PartBuilder(mats);
  b.box('polymer', 0.046, 0.066, 0.3, 0, 0.034, -0.1);                      // receiver
  b.box('darkMetal', 0.02, 0.008, 0.22, 0, 0.071, -0.1);                    // top rail
  for (let i = 0; i < 9; i++) b.box('darkMetal', 0.022, 0.004, 0.008, 0, 0.077, -0.2 + i * 0.024);
  b.cylZ('polymer', 0.019, 0.019, 0.06, 0, 0.038, -0.28);                   // stubby shroud
  b.cylZ('darkMetal', 0.009, 0.009, 0.04, 0, 0.04, -0.33);                  // barrel
  b.cylZ('darkMetal', 0.0115, 0.0115, 0.012, 0, 0.04, -0.352);              // thread cap
  b.box('polymer', 0.03, 0.085, 0.04, 0, -0.04, 0.02, -0.25);                // grip
  b.box('polymer', 0.026, 0.07, 0.03, 0, -0.03, -0.205, -0.08);             // vertical foregrip
  trigger(b, 'polymer', -0.03);
  b.box('darkMetal', 0.012, 0.012, 0.18, 0, 0.042, 0.13);                   // stock rod top
  b.box('darkMetal', 0.012, 0.012, 0.16, 0, 0.0, 0.12);                     // stock rod bottom
  b.box('polymer', 0.034, 0.075, 0.02, 0, 0.018, 0.225);                    // butt plate
  b.ringZ('darkMetal', 0.008, 0.0022, 0, 0.088, 0.02);                      // rear aperture
  b.box('darkMetal', 0.006, 0.01, 0.01, 0, 0.078, 0.02);                    // aperture post
  b.box('darkMetal', 0.003, 0.009, 0.004, 0, 0.0865, -0.205);               // front post
  b.box('darkMetal', 0.003, 0.014, 0.008, -0.009, 0.084, -0.205);           // hood L
  b.box('darkMetal', 0.003, 0.014, 0.008, 0.009, 0.084, -0.205);            // hood R
  b.box('darkMetal', 0.002, 0.016, 0.035, 0.0235, 0.045, -0.05);            // ejection port
  root.add(b.build('smg-body'));

  const ch = new PartBuilder(mats);
  ch.box('darkMetal', 0.016, 0.01, 0.022, -0.03, 0.055, -0.19);
  m.charge = addGroup(root, ch, 'smg-charge');

  const mag = new PartBuilder(mats);
  mag.box('darkMetal', 0.024, 0.14, 0.038, 0, -0.065, -0.085, 0.06);
  mag.box('polymer', 0.028, 0.01, 0.044, 0, -0.135, -0.09, 0.06);
  m.mag = addGroup(root, mag, 'smg-mag');

  m.muzzle.set(0, 0.04, -0.36);
  m.eject.set(0.024, 0.048, -0.05);
  m.support.set(0, -0.045, -0.205);
  m.supportRot.set(-0.08, 0, 0);
  m.chargeAnchor.set(-0.035, 0.055, -0.19);
  m.magBottom.set(0, -0.14, -0.078);
  m.magDrop.set(0, -0.998, -0.06).normalize();
  m.gripRot.set(-0.25, 0, 0);
  m.sightY = 0.088;
  m.sightZ = 0.02;
  m.eyeRelief = 0.2;
  m.hip.set(0.13, -0.155, -0.31);
  m.casing = 'pistol';
  m.flashScale = 0.8;
  m.supportStyle = 'grip';
  return m;
}

function ar(mats: Record<MatKey, THREE.Material>): GunModel {
  const root = new THREE.Group();
  root.name = 'vm-ar';
  const m = base('ar', root);
  const b = new PartBuilder(mats);
  b.box('metal', 0.04, 0.05, 0.21, 0, 0.04, -0.075);                        // upper receiver
  b.box('metal', 0.036, 0.032, 0.15, 0, 0.004, -0.035);                    // lower receiver
  b.box('polymer', 0.046, 0.052, 0.24, 0, 0.041, -0.3);                     // handguard
  for (let i = 0; i < 10; i++) b.box('darkMetal', 0.024, 0.005, 0.009, 0, 0.069, -0.39 + i * 0.022); // top rail teeth
  for (let i = 0; i < 4; i++) b.box('darkMetal', 0.0485, 0.006, 0.03, 0, 0.035, -0.4 + i * 0.06);   // side slots
  b.box('darkMetal', 0.02, 0.006, 0.18, 0, 0.068, -0.07);                   // receiver rail
  b.cylZ('darkMetal', 0.009, 0.009, 0.12, 0, 0.045, -0.48);                 // barrel
  b.cylZ('darkMetal', 0.012, 0.012, 0.055, 0, 0.045, -0.565);               // flash hider
  b.box('darkMetal', 0.006, 0.022, 0.012, 0, 0.062, -0.44);                 // gas block / folded front sight
  b.box('polymer', 0.028, 0.092, 0.036, 0, -0.045, 0.036, -0.3);            // grip
  trigger(b, 'metal', -0.03);
  b.box('metal', 0.034, 0.03, 0.04, 0, -0.012, -0.075);                     // mag well
  b.cylZ('darkMetal', 0.014, 0.014, 0.13, 0, 0.034, 0.125);                // buffer tube
  b.box('polymer', 0.04, 0.075, 0.11, 0, 0.02, 0.21);                       // stock
  b.box('polymer', 0.036, 0.022, 0.1, 0, -0.022, 0.205, -0.25);            // stock lower edge
  b.box('darkMetal', 0.002, 0.016, 0.04, 0.021, 0.045, -0.05);              // ejection port
  // Red dot: mount, housing tube (open), front/back rings.
  b.box('darkMetal', 0.024, 0.026, 0.04, 0, 0.083, -0.05);                  // riser mount
  b.cylZ('darkMetal', 0.0145, 0.0145, 0.032, 0, 0.107, -0.05, 18, true);
  b.ringZ('darkMetal', 0.0145, 0.0022, 0, 0.107, -0.066);
  b.ringZ('darkMetal', 0.0145, 0.0022, 0, 0.107, -0.034);
  b.box('darkMetal', 0.007, 0.007, 0.011, 0.0165, 0.107, -0.05);             // brightness knob
  b.discZ('glass', 0.0138, 0, 0.107, -0.06);
  root.add(b.build('ar-body'));

  // Reticle: tiny unlit dot on the sight axis, drawn above the glass.
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.0014, 12),
    new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  dot.position.set(0, 0.107, -0.0605);
  dot.renderOrder = 3;
  dot.frustumCulled = false;
  root.add(dot);
  m.reticle = dot;

  const ch = new PartBuilder(mats);
  ch.box('darkMetal', 0.034, 0.007, 0.012, 0, 0.068, 0.034);
  ch.box('darkMetal', 0.008, 0.006, 0.03, 0, 0.068, 0.018);
  m.charge = addGroup(root, ch, 'ar-charge');

  const mag = new PartBuilder(mats);
  mag.box('darkMetal', 0.024, 0.075, 0.05, 0, -0.06, -0.072);
  mag.box('darkMetal', 0.024, 0.075, 0.048, 0, -0.125, -0.082, 0.28);
  mag.box('polymer', 0.028, 0.012, 0.054, 0, -0.172, -0.095, 0.28);
  m.mag = addGroup(root, mag, 'ar-mag');

  m.muzzle.set(0, 0.045, -0.6);
  m.eject.set(0.022, 0.046, -0.05);
  m.support.set(0, 0.0, -0.3);
  m.supportRot.set(0, 0, 0);
  m.chargeAnchor.set(-0.012, 0.072, 0.045);
  m.magBottom.set(0, -0.176, -0.096);
  m.magDrop.set(0, -1, 0.04).normalize();
  m.gripRot.set(-0.3, 0, 0);
  m.sightY = 0.107;
  m.sightZ = -0.034;
  m.eyeRelief = 0.24;
  m.hip.set(0.135, -0.165, -0.3);
  m.casing = 'rifle';
  m.flashScale = 1;
  return m;
}

function shotgun(mats: Record<MatKey, THREE.Material>): GunModel {
  const root = new THREE.Group();
  root.name = 'vm-shotgun';
  const m = base('shotgun', root);
  const b = new PartBuilder(mats);
  b.box('metal', 0.04, 0.062, 0.17, 0, 0.032, -0.035);                     // receiver
  b.cylZ('metal', 0.011, 0.011, 0.47, 0, 0.052, -0.355);                    // barrel
  b.cylZ('darkMetal', 0.0125, 0.0125, 0.02, 0, 0.052, -0.58);               // muzzle ring
  b.cylZ('metal', 0.0095, 0.0095, 0.36, 0, 0.026, -0.3);                    // magazine tube
  b.cylZ('darkMetal', 0.0105, 0.0105, 0.015, 0, 0.026, -0.48);              // tube cap
  b.box('darkMetal', 0.006, 0.012, 0.03, 0, 0.032, -0.47);                  // barrel clamp
  b.sphere('brass', 0.0032, 0, 0.065, -0.565);                              // bead
  b.box('darkMetal', 0.012, 0.003, 0.13, 0, 0.0645, -0.03);                 // receiver groove rib
  b.box('wood', 0.034, 0.055, 0.11, 0, -0.004, 0.09, 0.32);                 // wrist / grip
  b.box('wood', 0.042, 0.1, 0.2, 0, -0.005, 0.225, 0.1);                    // butt stock
  b.box('polymer', 0.044, 0.104, 0.014, 0, -0.016, 0.33, 0.1);              // recoil pad
  trigger(b, 'metal', -0.025);
  b.box('darkMetal', 0.002, 0.02, 0.05, 0.0205, 0.04, -0.03);               // ejection port
  root.add(b.build('shotgun-body'));

  const pump = new PartBuilder(mats);
  pump.box('wood', 0.044, 0.04, 0.15, 0, 0.024, -0.265);
  for (let i = 0; i < 5; i++) pump.box('darkMetal', 0.045, 0.003, 0.006, 0, 0.012 + i * 0.005, -0.3 + i * 0.016);
  m.pump = addGroup(root, pump, 'shotgun-pump');

  m.muzzle.set(0, 0.052, -0.595);
  m.eject.set(0.022, 0.04, -0.03);
  m.support.set(0, -0.002, -0.265);
  m.supportRot.set(0, 0, 0);
  m.gripRot.set(-0.62, 0, 0);
  m.chargeAnchor.set(0, -0.002, -0.265);
  m.port.set(0, -0.004, -0.04);
  m.sightY = 0.066;
  m.sightZ = 0.05;
  m.eyeRelief = 0.24;
  m.hip.set(0.135, -0.17, -0.3);
  m.casing = 'shotgun';
  m.flashScale = 1.3;
  return m;
}

/** Telescopic sight along Z (rings, tube, bells, turrets, lenses). */
function scope(b: PartBuilder, y: number, zFront: number, zBack: number, tubeR: number, objR: number): void {
  const len = zBack - zFront;
  const tubeFront = zFront + 0.05;
  const tubeBack = zBack - 0.055;
  b.cylZ('darkMetal', tubeR, tubeR, tubeBack - tubeFront, 0, y, (tubeFront + tubeBack) / 2, 14);
  b.cylZ('darkMetal', objR, tubeR, 0.05, 0, y, zFront + 0.025, 16);                 // objective bell
  b.cylZ('darkMetal', tubeR * 1.15, tubeR * 1.25, 0.055, 0, y, zBack - 0.0275, 14); // ocular bell
  b.cylY('darkMetal', 0.008, 0.008, 0.018, 0, y + tubeR + 0.006, zFront + len * 0.48);      // elevation turret
  b.cylX('darkMetal', 0.008, 0.018, tubeR + 0.006, y, zFront + len * 0.48);                 // windage turret
  b.discZ('lens', objR * 0.92, 0, y, zFront - 0.0005, true);
  b.discZ('lens', tubeR * 1.15, 0, y, zBack + 0.0005);
  // Rings
  for (const z of [zFront + len * 0.32, zFront + len * 0.72]) {
    b.ringZ('darkMetal', tubeR + 0.002, 0.003, 0, y, z);
    b.box('darkMetal', 0.012, y - 0.06, 0.012, 0, (y + 0.06) / 2 + 0.002, z);
  }
}

function dmr(mats: Record<MatKey, THREE.Material>): GunModel {
  const root = new THREE.Group();
  root.name = 'vm-dmr';
  const m = base('dmr', root);
  const b = new PartBuilder(mats);
  b.box('metal', 0.038, 0.048, 0.24, 0, 0.036, -0.06);                      // receiver
  b.box('wood', 0.046, 0.046, 0.3, 0, 0.02, -0.31);                          // fore end
  b.box('metal', 0.03, 0.01, 0.24, 0, 0.05, -0.33);                          // upper handguard
  b.cylZ('metal', 0.0095, 0.0095, 0.26, 0, 0.045, -0.58);                    // barrel
  b.cylZ('darkMetal', 0.014, 0.014, 0.055, 0, 0.045, -0.735);               // muzzle brake
  for (let i = 0; i < 3; i++) b.box('polymer', 0.0285, 0.004, 0.008, 0, 0.047, -0.75 + i * 0.018);
  b.box('wood', 0.034, 0.1, 0.05, 0, -0.04, 0.03, -0.38);                     // pistol grip
  b.box('wood', 0.04, 0.05, 0.12, 0, 0.0, 0.11, 0.18);                       // wrist
  b.box('wood', 0.042, 0.105, 0.19, 0, 0.0, 0.24, 0.06);                     // butt
  b.box('polymer', 0.044, 0.11, 0.014, 0, -0.008, 0.34, 0.06);              // pad
  trigger(b, 'metal', -0.035);
  b.box('darkMetal', 0.002, 0.016, 0.04, 0.0195, 0.04, -0.07);               // ejection port
  b.box('darkMetal', 0.02, 0.006, 0.18, 0, 0.063, -0.06);                    // scope rail
  scope(b, 0.1, -0.2, 0.095, 0.0135, 0.022);
  root.add(b.build('dmr-body'));

  const ch = new PartBuilder(mats);
  ch.box('darkMetal', 0.018, 0.01, 0.012, 0.027, 0.04, -0.03);
  ch.sphere('darkMetal', 0.006, 0.038, 0.04, -0.03);
  m.charge = addGroup(root, ch, 'dmr-charge');

  const mag = new PartBuilder(mats);
  mag.box('darkMetal', 0.026, 0.07, 0.058, 0, -0.03, -0.075, 0.15);
  mag.box('polymer', 0.03, 0.01, 0.062, 0, -0.066, -0.08, 0.15);
  m.mag = addGroup(root, mag, 'dmr-mag');

  m.muzzle.set(0, 0.045, -0.765);
  m.eject.set(0.02, 0.048, -0.07);
  m.support.set(0, -0.004, -0.3);
  m.supportRot.set(0, 0, 0);
  m.gripRot.set(-0.38, 0, 0);
  m.chargeAnchor.set(0.042, 0.04, -0.03);
  m.magBottom.set(0, -0.07, -0.08);
  m.magDrop.set(0, -0.99, -0.15).normalize();
  m.sightY = 0.1;
  m.sightZ = 0.095;
  m.eyeRelief = 0.1;
  m.hip.set(0.135, -0.175, -0.31);
  m.casing = 'rifle';
  m.flashScale = 1.15;
  m.scoped = true;
  return m;
}

function sniper(mats: Record<MatKey, THREE.Material>): GunModel {
  const root = new THREE.Group();
  root.name = 'vm-sniper';
  const m = base('sniper', root);
  const b = new PartBuilder(mats);
  b.box('olive', 0.05, 0.05, 0.32, 0, 0.018, -0.3);                          // fore end chassis
  b.box('olive', 0.046, 0.04, 0.2, 0, 0.012, -0.04);                         // action bed
  b.cylZ('metal', 0.016, 0.016, 0.22, 0, 0.046, -0.06, 14);                  // receiver / action
  b.cylZ('darkMetal', 0.01, 0.011, 0.42, 0, 0.046, -0.55);                   // barrel
  b.cylZ('darkMetal', 0.016, 0.016, 0.065, 0, 0.046, -0.79);                 // muzzle brake
  for (let i = 0; i < 3; i++) b.box('polymer', 0.033, 0.005, 0.01, 0, 0.046, -0.81 + i * 0.022);
  b.box('olive', 0.034, 0.1, 0.045, 0, -0.045, 0.035, -0.32);                 // grip
  b.box('olive', 0.04, 0.03, 0.12, 0, -0.012, 0.1, 0.0);                     // thumbhole bridge
  b.box('olive', 0.046, 0.12, 0.2, 0, -0.02, 0.24, 0.04);                    // butt
  b.box('olive', 0.03, 0.03, 0.12, 0, 0.055, 0.2);                           // cheek riser
  b.box('polymer', 0.048, 0.124, 0.016, 0, -0.026, 0.345, 0.04);            // pad
  trigger(b, 'darkMetal', -0.025);
  b.box('darkMetal', 0.022, 0.006, 0.2, 0, 0.066, -0.07);                    // scope rail
  scope(b, 0.106, -0.26, 0.12, 0.015, 0.027);
  root.add(b.build('sniper-body'));

  // Bolt: pivots around the bore axis at the rear of the action.
  const bolt = new PartBuilder(mats);
  bolt.cylZ('metal', 0.0085, 0.0085, 0.06, 0, 0, 0.0, 10);
  bolt.cylY('metal', 0.0045, 0.0045, 0.05, 0.0215, -0.013, 0.02, 0, 0, -(Math.PI / 2 + 0.55));
  bolt.sphere('darkMetal', 0.0095, 0.043, -0.026, 0.02);
  const boltGroup = bolt.build('sniper-bolt');
  const boltPivot = new THREE.Group();
  boltPivot.name = 'sniper-bolt-pivot';
  boltPivot.position.set(0, 0.046, 0.06);
  boltPivot.add(boltGroup);
  root.add(boltPivot);
  m.bolt = boltPivot;

  const mag = new PartBuilder(mats);
  mag.box('darkMetal', 0.03, 0.06, 0.085, 0, -0.022, -0.085);
  mag.box('polymer', 0.034, 0.01, 0.09, 0, -0.054, -0.085);
  m.mag = addGroup(root, mag, 'sniper-mag');

  m.muzzle.set(0, 0.046, -0.83);
  m.eject.set(0.02, 0.055, 0.03);
  m.support.set(0, -0.008, -0.31);
  m.supportRot.set(0, 0, 0);
  m.gripRot.set(-0.32, 0, 0);
  m.chargeAnchor.set(0.043, 0.02, 0.08);
  m.magBottom.set(0, -0.058, -0.085);
  m.magDrop.set(0, -1, 0);
  m.sightY = 0.106;
  m.sightZ = 0.12;
  m.eyeRelief = 0.1;
  m.hip.set(0.135, -0.18, -0.34);
  m.casing = 'sniper';
  m.flashScale = 1.3;
  m.scoped = true;
  return m;
}

const BUILDERS: Record<WeaponId, (mats: Record<MatKey, THREE.Material>) => GunModel> = {
  pistol, smg, ar, shotgun, dmr, sniper,
};

export function buildGun(id: WeaponId, mats: Record<MatKey, THREE.Material>): GunModel {
  return BUILDERS[id](mats);
}

/** Bolt knob position in bolt-pivot space (right hand target during the bolt cycle). */
export const BOLT_KNOB = new THREE.Vector3(0.043, -0.026, 0.02);

// ------------------------------------------------------------------------------------------------
// Imported weapon models (Quaternius Ultimate Guns, see src/client/assets)
// ------------------------------------------------------------------------------------------------

type V3 = readonly [number, number, number];

/**
 * First-person hold data for the imported models, in the weapon frame of the asset manifest
 * (fist centre at the origin, barrel -Z). Measured from the meshes: `support` is the underside of
 * the handguard / fore-end (where a palm-up support hand sits), `magBottom` the lowest point of
 * the magazine, `eject` the ejection port, `charge` the charging handle / bolt knob, `port` the
 * shotgun loading port. Muzzle, sight line and nominal support come from WEAPON_MODELS.
 */
interface ModelHold {
  hip: V3;
  hipRot: V3;
  eyeRelief: number;
  gripRot: V3;
  supportStyle: 'grip' | 'palm';
  support: V3;
  supportRot: V3;
  magBottom: V3;
  magDrop: V3;
  eject: V3;
  charge: V3;
  port: V3;
  /** Right hand offset from the fist centre (the generic grip hand is slightly tall for low stocks). */
  grip?: V3;
  /**
   * Optical axis of a built-in scope at the eyepiece (measured from the mesh). The manifest sight
   * point of the DMR / sniper models sits ~1 cm right of / above the scope tube, which would show
   * the eyepiece off-centre while aiming in; the scope overlay takes over at full ADS anyway.
   */
  scopeAxis?: V3;
}

const MODEL_HOLD: Record<WeaponId, ModelHold> = {
  pistol: {
    hip: [0.11, -0.12, -0.37], hipRot: [0.02, 0.06, 0], eyeRelief: 0.36, gripRot: [-0.22, 0, 0],
    supportStyle: 'grip', support: [-0.024, 0.008, 0.004], supportRot: [-0.22, 0.3, 0.12],
    magBottom: [0, -0.05, 0.02], magDrop: [0, -0.96, 0.27], eject: [0.017, 0.068, -0.04],
    charge: [-0.012, 0.07, 0.03], port: [0, 0, 0],
  },
  smg: {
    hip: [0.13, -0.15, -0.31], hipRot: [0, 0.035, 0], eyeRelief: 0.2, gripRot: [-0.25, 0, 0],
    supportStyle: 'palm', support: [0, 0.035, -0.23], supportRot: [0, 0, 0],
    magBottom: [0, -0.105, -0.1], magDrop: [0, -1, 0], eject: [0.017, 0.08, -0.05],
    charge: [-0.018, 0.1, -0.02], port: [0, 0, 0],
  },
  ar: {
    hip: [0.135, -0.165, -0.3], hipRot: [0, 0.035, 0], eyeRelief: 0.24, gripRot: [-0.3, 0, 0],
    supportStyle: 'palm', support: [0, 0.045, -0.31], supportRot: [0, 0, 0],
    magBottom: [0, -0.16, -0.142], magDrop: [0, -0.99, 0.12], eject: [0.021, 0.085, -0.07],
    charge: [-0.012, 0.115, 0.06], port: [0, 0, 0],
  },
  shotgun: {
    hip: [0.135, -0.155, -0.3], hipRot: [0, 0.035, 0], eyeRelief: 0.25, gripRot: [-0.32, 0, 0], grip: [-0.004, 0.006, 0.012],
    supportStyle: 'palm', support: [0, -0.042, -0.36], supportRot: [0, 0, 0],
    magBottom: [0, -0.07, -0.1], magDrop: [0, -1, 0], eject: [0.021, 0.02, -0.05],
    charge: [0, -0.042, -0.36], port: [0, -0.07, -0.1],
  },
  dmr: {
    hip: [0.135, -0.17, -0.31], hipRot: [0, 0.035, 0], eyeRelief: 0.1, gripRot: [-0.35, 0, 0],
    supportStyle: 'palm', support: [0, 0.02, -0.34], supportRot: [0, 0, 0],
    magBottom: [0, -0.03, -0.06], magDrop: [0, -1, 0], eject: [0.024, 0.06, -0.03],
    charge: [0.036, 0.04, -0.028], port: [0, 0, 0], scopeAxis: [-0.0092, 0.0981, 0.01],
  },
  sniper: {
    hip: [0.135, -0.17, -0.33], hipRot: [0, 0.035, 0], eyeRelief: 0.1, gripRot: [-0.35, 0, 0],
    supportStyle: 'palm', support: [0, 0.01, -0.38], supportRot: [0, 0, 0],
    magBottom: [0, -0.066, -0.03], magDrop: [0, -1, 0], eject: [0.024, 0.065, -0.03],
    charge: [0.037, 0.042, -0.05], port: [0, 0, 0], scopeAxis: [-0.0135, 0.1055, -0.015],
  },
};

/** Offset that puts the procedural grip-hand mesh (wraps y ~ -0.04) on a model's fist centre. */
const MODEL_GRIP_OFFSET = new THREE.Vector3(-0.004, 0.038, 0);

/**
 * Wrap an imported weapon model (already cloned, weapon frame) as a GunModel. `proc` is the
 * procedural gun of the same id: its magazine is cloned as the spare mag handed in on reloads,
 * since the imported mesh has no separate magazine part.
 */
export function buildModelGun(id: WeaponId, model: THREE.Object3D, proc: GunModel): GunModel {
  const root = new THREE.Group();
  root.name = `vm-model-${id}`;
  model.traverse((o) => {
    o.frustumCulled = false;
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
  });
  root.add(model);
  const wm = WEAPON_MODELS[id];
  const h = MODEL_HOLD[id];
  const g = base(id, root);
  g.shared = true;
  g.fixedMag = true;
  g.muzzle.set(wm.muzzle[0], wm.muzzle[1], wm.muzzle[2]);
  g.eject.set(h.eject[0], h.eject[1], h.eject[2]);
  g.support.set(h.support[0], h.support[1], h.support[2]);
  g.supportRot.set(h.supportRot[0], h.supportRot[1], h.supportRot[2]);
  g.supportStyle = h.supportStyle;
  g.gripRot.set(h.gripRot[0], h.gripRot[1], h.gripRot[2]);
  if (h.grip) g.gripOffset.set(h.grip[0], h.grip[1], h.grip[2]);
  else g.gripOffset.copy(MODEL_GRIP_OFFSET);
  g.chargeAnchor.set(h.charge[0], h.charge[1], h.charge[2]);
  g.magBottom.set(h.magBottom[0], h.magBottom[1], h.magBottom[2]);
  g.magDrop.set(h.magDrop[0], h.magDrop[1], h.magDrop[2]).normalize();
  g.port.set(h.port[0], h.port[1], h.port[2]);
  // ADS: the manifest sight point lies on the line of sight (parallel to the bore); scoped models
  // use the measured scope axis (see ModelHold.scopeAxis).
  const sight = h.scopeAxis ?? wm.sight;
  g.sightX = sight[0];
  g.sightY = sight[1];
  g.sightZ = sight[2];
  g.eyeRelief = h.eyeRelief;
  g.hip.set(h.hip[0], h.hip[1], h.hip[2]);
  g.hipRot.set(h.hipRot[0], h.hipRot[1], h.hipRot[2]);
  g.casing = proc.casing;
  g.flashScale = proc.flashScale;
  g.scoped = wm.optic === 'scope';
  if (id === 'sniper') g.boltKnob = new THREE.Vector3(h.charge[0], h.charge[1], h.charge[2]);
  if (proc.mag) {
    // Align the procedural magazine's bottom with the model's magazine bottom.
    const spare = proc.mag.clone(true);
    spare.name = `vm-spare-mag-${id}`;
    spare.visible = false;
    g.spareRest.copy(g.magBottom).sub(proc.magBottom);
    spare.position.copy(g.spareRest);
    root.add(spare);
    g.spareMag = spare;
  }
  return g;
}
