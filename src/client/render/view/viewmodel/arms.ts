// Procedural first-person arms: gloved hands (grip / palm-up support / fist variants) plus sleeve
// forearms and upper arms that follow the hands with two-bone IK from off-screen shoulders.

import * as THREE from 'three';
import { solveTwoBone } from '../cameraMath';
import { PartBuilder, type MatKey } from './parts';

export type HandStyle = 'grip' | 'palm' | 'fist' | 'hold';

/** Wrist attachment point per hand style (hand-local). */
const WRIST: Record<HandStyle, THREE.Vector3> = {
  grip: new THREE.Vector3(0.016, -0.07, 0.045),
  palm: new THREE.Vector3(0.0, -0.022, 0.06),
  fist: new THREE.Vector3(0.0, -0.03, 0.05),
  hold: new THREE.Vector3(0.0, -0.035, 0.05),
};

function buildHandStyle(mats: Record<MatKey, THREE.Material>, style: HandStyle, mirror: boolean): THREE.Group {
  const b = new PartBuilder(mats);
  const s = mirror ? -1 : 1;
  switch (style) {
    case 'grip':
      // Wraps a vertical grip centred at the origin (grip ~3 cm wide, 4 cm deep).
      b.box('glove', 0.05, 0.085, 0.05, 0.012 * s, -0.04, 0.014);               // back of hand / palm heel
      b.box('glove', 0.046, 0.07, 0.022, 0.002 * s, -0.048, -0.031);            // curled fingers
      b.box('glove', 0.013, 0.013, 0.036, 0.005 * s, -0.006, -0.042);           // index finger
      b.box('glove', 0.016, 0.017, 0.048, -0.02 * s, -0.004, -0.004, 0, 0.25 * s, 0); // thumb over the top
      b.box('glove', 0.03, 0.02, 0.04, 0.03 * s, -0.035, 0.0);                  // knuckle bulk
      break;
    case 'palm':
      // Palm up under a handguard centred above the origin.
      b.box('glove', 0.052, 0.024, 0.088, 0.004 * s, -0.004, 0.006);           // palm
      b.box('glove', 0.014, 0.05, 0.076, -0.03 * s, 0.022, -0.004);             // fingers up the far side
      b.box('glove', 0.012, 0.032, 0.046, 0.031 * s, 0.014, 0.018, 0, 0, -0.2 * s); // thumb near side
      break;
    case 'fist':
      b.box('glove', 0.05, 0.055, 0.075, 0, 0, 0);
      b.box('glove', 0.046, 0.024, 0.03, 0, -0.024, -0.03);                     // curled fingers
      b.box('glove', 0.016, 0.018, 0.04, -0.026 * s, -0.004, -0.008);           // thumb
      break;
    case 'hold':
      // Open hand holding an item (bandage, can, grenade): palm facing the item at +X (right hand).
      b.box('glove', 0.022, 0.07, 0.085, -0.03 * s, -0.01, 0.0);               // palm
      b.box('glove', 0.04, 0.016, 0.07, -0.008 * s, 0.02, -0.01);               // fingers over the top
      b.box('glove', 0.04, 0.016, 0.04, -0.01 * s, -0.04, 0.015);               // thumb under
      break;
  }
  return b.build(`hand-${style}${mirror ? '-l' : '-r'}`);
}

/** One arm: hand (switchable styles) + IK sleeve. */
export class Arm {
  /** Place this group (position + quaternion, in the parent's space) at the hand target each frame. */
  readonly hand = new THREE.Group();
  private readonly styles: Record<HandStyle, THREE.Group>;
  private style: HandStyle = 'grip';
  private readonly upper: THREE.Mesh;
  private readonly fore: THREE.Mesh;
  private readonly cuff: THREE.Mesh;
  private readonly elbowBall: THREE.Mesh;
  private readonly elbow = { x: 0, y: 0, z: 0 };
  private readonly shoulderOut = { x: 0, y: 0, z: 0 };
  private readonly wrist = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly geoms: THREE.BufferGeometry[] = [];

  constructor(
    parent: THREE.Object3D,
    mats: Record<MatKey, THREE.Material>,
    private readonly mirror: boolean,
    /** Shoulder position in camera space. */
    private readonly shoulder: THREE.Vector3,
    /** IK pole (elbow bend direction) in camera space. */
    private readonly pole: THREE.Vector3,
    private readonly upperLen = 0.31,
    private readonly foreLen = 0.29,
  ) {
    this.hand.name = mirror ? 'vm-hand-left' : 'vm-hand-right';
    this.styles = {
      grip: buildHandStyle(mats, 'grip', mirror),
      palm: buildHandStyle(mats, 'palm', mirror),
      fist: buildHandStyle(mats, 'fist', mirror),
      hold: buildHandStyle(mats, 'hold', mirror),
    };
    for (const k of Object.keys(this.styles) as HandStyle[]) {
      this.styles[k].visible = k === this.style;
      this.hand.add(this.styles[k]);
    }
    const unit = (rTop: number, rBot: number) => {
      const g = new THREE.CylinderGeometry(rTop, rBot, 1, 10, 1, false);
      g.translate(0, 0.5, 0);
      this.geoms.push(g);
      return g;
    };
    this.upper = new THREE.Mesh(unit(0.05, 0.056), mats.sleeve);
    this.fore = new THREE.Mesh(unit(0.036, 0.047), mats.sleeve);
    this.cuff = new THREE.Mesh(unit(0.034, 0.037), mats.cuff);
    const ballGeom = new THREE.SphereGeometry(0.05, 10, 8);
    this.geoms.push(ballGeom);
    this.elbowBall = new THREE.Mesh(ballGeom, mats.sleeve);
    for (const m of [this.upper, this.fore, this.cuff, this.elbowBall]) {
      m.frustumCulled = false;
      parent.add(m);
    }
    parent.add(this.hand);
  }

  setStyle(style: HandStyle): void {
    if (style === this.style) return;
    this.styles[this.style].visible = false;
    this.styles[style].visible = true;
    this.style = style;
  }

  set visible(v: boolean) {
    this.hand.visible = v;
    this.upper.visible = v;
    this.fore.visible = v;
    this.cuff.visible = v;
    this.elbowBall.visible = v;
  }

  /** Solve the arm after the hand group has been posed (hand matrices must be current). */
  solve(): void {
    if (!this.hand.visible) return;
    // Everything is solved in the parent's space (hand, shoulder and sleeves share the parent).
    this.hand.updateMatrix();
    this.wrist.copy(WRIST[this.style]);
    if (this.mirror) this.wrist.x = -this.wrist.x;
    this.wrist.applyMatrix4(this.hand.matrix);
    const s = this.shoulder, p = this.pole, w = this.wrist;
    solveTwoBone(s.x, s.y, s.z, w.x, w.y, w.z, this.upperLen, this.foreLen, p.x, p.y, p.z, this.elbow, this.shoulderOut);
    const e = this.elbow, so = this.shoulderOut;
    this.place(this.upper, so.x, so.y, so.z, e.x, e.y, e.z, 1);
    this.elbowBall.position.set(e.x, e.y, e.z);
    // Forearm stops a little short of the wrist; the cuff covers the joint.
    this.place(this.fore, e.x, e.y, e.z, w.x, w.y, w.z, 0.86);
    const fx = w.x - e.x, fy = w.y - e.y, fz = w.z - e.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    const cuffLen = 0.055;
    this.place(this.cuff, w.x - (fx / fl) * (cuffLen + 0.012), w.y - (fy / fl) * (cuffLen + 0.012), w.z - (fz / fl) * (cuffLen + 0.012), w.x, w.y, w.z, 1);
  }

  private place(m: THREE.Mesh, ax: number, ay: number, az: number, bx: number, by: number, bz: number, frac: number): void {
    this.tmp.set(bx - ax, by - ay, bz - az);
    const len = this.tmp.length();
    if (len < 1e-5) {
      m.scale.set(1, 1e-4, 1);
      return;
    }
    this.tmp.multiplyScalar(1 / len);
    m.position.set(ax, ay, az);
    m.quaternion.setFromUnitVectors(this.up, this.tmp);
    m.scale.set(1, len * frac, 1);
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    for (const k of Object.keys(this.styles) as HandStyle[]) {
      this.styles[k].traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }
    this.upper.removeFromParent();
    this.fore.removeFromParent();
    this.cuff.removeFromParent();
    this.elbowBall.removeFromParent();
    this.hand.removeFromParent();
  }
}
