// Parachute canopies: one InstancedMesh for every open canopy (team-coloured stripes + suspension
// lines in a single geometry). Canopies unfurl when opened and collapse to the ground after landing.

import * as THREE from 'three';
import { MAX_PLAYERS } from '../../../shared/constants';
import { GeoBuilder, M_ACCENT, xform } from './geometry';
import { type InstanceAttributes, addInstanceAttributes, createEntityMaterial } from './materials';
import { easeOutBack, sat, smooth } from './pose';

/** Canopy origin = harness point (between the shoulders) in the character's model space. */
export const HARNESS_HEIGHT = 1.45;
const CELLS = 9;
const SPAN = 7.2;
const CHORD = 2.7;
const HEIGHT = 4.9;
const ARC_R = 6.2;
const UNFURL_TIME = 0.8;
const COLLAPSE_TIME = 1.6;

function buildCanopy(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const half = (CELLS - 1) / 2;
  const cellW = SPAN / CELLS;
  const arcSpan = SPAN / ARC_R; // radians covered by the canopy arc
  const edgePts: THREE.Vector3[] = [];
  for (let i = 0; i < CELLS; i++) {
    const a = ((i - half) / CELLS) * arcSpan;
    const x = Math.sin(a) * ARC_R;
    const y = HEIGHT - (ARC_R - Math.cos(a) * ARC_R);
    const style = i % 2 === 0 ? { color: 0xffffff, mask: M_ACCENT } : { color: 0xe9e4d6 };
    // Each cell: a slightly tapered airfoil block, rolled to follow the arc.
    b.taper(cellW * 1.02, CHORD * 0.98, cellW * 1.02, CHORD, 0.34, xform(x, y, 0, 0, 0, -a), style);
    // Leading-edge cell opening (dark).
    b.box(cellW * 0.9, 0.2, 0.02, xform(x, y - 0.03, -CHORD / 2 - 0.005, 0, 0, -a), { color: 0x3a3a36 });
  }
  // Line attachment points along the bottom surface at cell boundaries (front and rear rows).
  for (let i = 0; i <= CELLS; i += 1) {
    const a = ((i - half - 0.5) / CELLS) * arcSpan;
    const x = Math.sin(a) * (ARC_R - 0.17);
    const y = HEIGHT - 0.17 - (ARC_R - Math.cos(a) * ARC_R);
    if (i % 2 === 0 || i === CELLS) {
      edgePts.push(new THREE.Vector3(x, y, -CHORD * 0.35));
      edgePts.push(new THREE.Vector3(x, y, CHORD * 0.3));
    }
  }
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  for (const p of edgePts) {
    const riser = new THREE.Vector3(p.x < 0 ? -0.2 : 0.2, 0.25, p.z * 0.04);
    dir.subVectors(p, riser);
    const len = dir.length();
    dir.normalize();
    q.setFromUnitVectors(up, dir);
    mid.addVectors(p, riser).multiplyScalar(0.5);
    m.compose(mid, q, new THREE.Vector3(1, 1, 1));
    b.box(0.014, len, 0.014, m, { color: 0x2b2b29 });
  }
  // Risers (straps) from the shoulders.
  b.box(0.04, 0.3, 0.02, xform(-0.2, 0.12, 0), { color: 0x2b2b29 });
  b.box(0.04, 0.3, 0.02, xform(0.2, 0.12, 0), { color: 0x2b2b29 });
  return b.build({ mask: true });
}

interface Collapsing {
  active: boolean;
  t: number;
  matrix: THREE.Matrix4;
  accent: THREE.Color;
  groundY: number;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _white = new THREE.Color(1, 1, 1);

export class Parachutes {
  private readonly material = createEntityMaterial({ mask: true, instanced: true, dither: true, rim: true, fogScale: 0.3, side: THREE.DoubleSide });
  private readonly mesh: THREE.InstancedMesh;
  private readonly attrs: InstanceAttributes;
  private readonly capacity: number;
  private count = 0;
  private readonly collapsing: Collapsing[] = [];

  constructor(parent: THREE.Object3D) {
    this.capacity = MAX_PLAYERS + 16;
    const geo = buildCanopy();
    this.attrs = addInstanceAttributes(geo, this.capacity);
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.name = 'parachutes';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    parent.add(this.mesh);
    for (let i = 0; i < 16; i++) {
      this.collapsing.push({ active: false, t: 0, matrix: new THREE.Matrix4(), accent: new THREE.Color(), groundY: 0 });
    }
  }

  begin(): void {
    this.count = 0;
  }

  /**
   * Open canopy above a character. `root` = character model->world, `openFor` = seconds since the
   * chute opened, `bank` = roll (rad) from steering.
   */
  addOpen(root: THREE.Matrix4, openFor: number, bank: number, accent: THREE.Color, fade: number): void {
    const e = easeOutBack(openFor / UNFURL_TIME, 1.2);
    const sx = 0.15 + 0.85 * e, sy = 0.3 + 0.7 * e, sz = 0.35 + 0.65 * sat(openFor / (UNFURL_TIME * 0.7));
    _t.makeRotationZ(bank);
    _t.setPosition(0, HARNESS_HEIGHT, 0);
    _s.makeScale(sx, sy, sz);
    _m.multiplyMatrices(root, _t).multiply(_s);
    this.push(_m, accent, fade);
  }

  /** Start the collapse animation of a canopy whose wearer just landed. */
  drop(root: THREE.Matrix4, bank: number, accent: THREE.Color, groundY: number): void {
    let slot = this.collapsing.find((c) => !c.active);
    if (!slot) {
      // Recycle the oldest.
      slot = this.collapsing.reduce((a, b) => (a.t > b.t ? a : b));
    }
    _t.makeRotationZ(bank);
    _t.setPosition(0, HARNESS_HEIGHT, 0);
    slot.matrix.multiplyMatrices(root, _t);
    slot.accent.copy(accent);
    slot.groundY = groundY;
    slot.t = 0;
    slot.active = true;
  }

  /** Advance collapsing canopies and emit them. */
  updateCollapsing(dt: number): void {
    for (const c of this.collapsing) {
      if (!c.active) continue;
      c.t += dt;
      const k = c.t / COLLAPSE_TIME;
      if (k >= 1) {
        c.active = false;
        continue;
      }
      const e = smooth(k);
      // Deflate: flatten, spread a little, and sink toward the ground behind the wearer.
      const y0 = c.matrix.elements[13];
      const drop = (y0 - (c.groundY + 0.15)) * e;
      _s.makeScale(1 + 0.15 * e, Math.max(0.04, 1 - 0.96 * e), 1 - 0.2 * e);
      _t.makeTranslation(0, -drop, 0);
      _m.multiplyMatrices(_t, c.matrix).multiply(_s);
      this.push(_m, c.accent, k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
    }
  }

  private push(m: THREE.Matrix4, accent: THREE.Color, fade: number): void {
    if (this.count >= this.capacity || fade <= 0) return;
    const i = this.count++;
    m.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16);
    const a = this.attrs.accent.array as Float32Array;
    a[i * 3] = accent.r; a[i * 3 + 1] = accent.g; a[i * 3 + 2] = accent.b;
    const c = this.attrs.cloth.array as Float32Array;
    c[i * 3] = _white.r; c[i * 3 + 1] = _white.g; c[i * 3 + 2] = _white.b;
    (this.attrs.fade.array as Float32Array)[i] = fade;
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.attrs.accent.needsUpdate = true;
      this.attrs.cloth.needsUpdate = true;
      this.attrs.fade.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }
}
