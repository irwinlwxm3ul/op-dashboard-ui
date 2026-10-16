// Pooled spent shell casings: small instanced cylinders in world space with gravity, spin and a
// couple of bounces on the floor height sampled at spawn, then they shrink away. Used by the
// viewmodel (local player) and by the FX renderer (nearby third-person shooters).

import * as THREE from 'three';
import type { World } from '../../../shared/types';

export type CasingKind = 'pistol' | 'rifle' | 'shotgun' | 'sniper';

const KIND_DIMS: Record<CasingKind, { len: number; r: number; color: number }> = {
  pistol: { len: 0.019, r: 0.0047, color: 0xc9a14a },
  rifle: { len: 0.045, r: 0.0052, color: 0xd1a948 },
  shotgun: { len: 0.068, r: 0.0098, color: 0xa3261e },
  sniper: { len: 0.066, r: 0.0064, color: 0xcfa344 },
};

const LIFE = 2.6;
const SHRINK = 0.4;
const GRAVITY = 9.81;

export class CasingPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly world: World;
  private alive = 0;
  // Per casing state (struct of arrays)
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;     // euler x,y,z
  private readonly spin: Float32Array;    // angular velocity x,y,z
  private readonly scale: Float32Array;   // len, radius
  private readonly age: Float32Array;
  private readonly delay: Float32Array;
  private readonly floor: Float32Array;
  private readonly colorIdx: Uint8Array;
  private readonly palette: THREE.Color[];
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly kinds: CasingKind[] = ['pistol', 'rifle', 'shotgun', 'sniper'];

  constructor(world: World, capacity = 48) {
    this.world = world;
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.spin = new Float32Array(capacity * 3);
    this.scale = new Float32Array(capacity * 2);
    this.age = new Float32Array(capacity);
    this.delay = new Float32Array(capacity);
    this.floor = new Float32Array(capacity);
    this.colorIdx = new Uint8Array(capacity);
    this.palette = this.kinds.map((k) => new THREE.Color(KIND_DIMS[k].color));
    // Unit cylinder along X (length 1, radius 1); instances scale it.
    const geom = new THREE.CylinderGeometry(1, 1, 1, 7, 1);
    geom.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.7, roughness: 0.35 });
    this.mesh = new THREE.InstancedMesh(geom, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'fx-casings';
    // Initialise the colour buffer so setColorAt works without allocation later.
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, this.palette[0]);
  }

  /**
   * Eject a casing at (x,y,z) with velocity (vx,vy,vz). `delay` postpones the ejection (bolt / pump
   * cycles); a delayed casing stays hidden until then.
   */
  eject(kind: CasingKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, delay = 0): void {
    let i: number;
    if (this.alive < this.capacity) i = this.alive++;
    else {
      // Replace the oldest.
      let oldest = 0;
      for (let k = 1; k < this.alive; k++) if (this.age[k] > this.age[oldest]) oldest = k;
      i = oldest;
    }
    const d = KIND_DIMS[kind];
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.rot[i * 3] = Math.random() * Math.PI; this.rot[i * 3 + 1] = Math.random() * Math.PI * 2; this.rot[i * 3 + 2] = 0;
    this.spin[i * 3] = (Math.random() - 0.5) * 30;
    this.spin[i * 3 + 1] = (Math.random() - 0.5) * 20;
    this.spin[i * 3 + 2] = 18 + Math.random() * 20;
    this.scale[i * 2] = d.len;
    this.scale[i * 2 + 1] = d.r;
    this.age[i] = 0;
    this.delay[i] = delay;
    this.floor[i] = this.world.groundAt(x, z, y);
    this.colorIdx[i] = this.kinds.indexOf(kind);
  }

  update(dt: number): void {
    let i = 0;
    let visible = 0;
    while (i < this.alive) {
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        i++;
        continue;
      }
      const age = (this.age[i] += dt);
      if (age >= LIFE) {
        this.removeAt(i);
        continue;
      }
      const i3 = i * 3;
      let vy = this.vel[i3 + 1] - GRAVITY * dt;
      let px = this.pos[i3] + this.vel[i3] * dt;
      let py = this.pos[i3 + 1] + vy * dt;
      let pz = this.pos[i3 + 2] + this.vel[i3 + 2] * dt;
      const fl = this.floor[i] + this.scale[i * 2 + 1];
      if (py < fl) {
        py = fl;
        if (vy < -0.6) {
          vy = -vy * 0.35;
          this.vel[i3] *= 0.5;
          this.vel[i3 + 2] *= 0.5;
          this.spin[i3] *= 0.5; this.spin[i3 + 1] *= 0.6; this.spin[i3 + 2] *= 0.3;
        } else {
          vy = 0;
          this.vel[i3] *= Math.exp(-6 * dt);
          this.vel[i3 + 2] *= Math.exp(-6 * dt);
          this.spin[i3] *= Math.exp(-8 * dt);
          this.spin[i3 + 2] *= Math.exp(-8 * dt);
          // Lie flat on the ground.
          this.rot[i3] *= Math.exp(-10 * dt);
        }
      }
      if (px !== px || py !== py || pz !== pz) { this.removeAt(i); continue; }
      this.vel[i3 + 1] = vy;
      this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
      this.rot[i3] += this.spin[i3] * dt;
      this.rot[i3 + 1] += this.spin[i3 + 1] * dt;
      this.rot[i3 + 2] += this.spin[i3 + 2] * dt;
      const shrink = age > LIFE - SHRINK ? (LIFE - age) / SHRINK : 1;
      this.p.set(px, py, pz);
      this.e.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]);
      this.q.setFromEuler(this.e);
      const r = this.scale[i * 2 + 1] * shrink;
      this.s.set(this.scale[i * 2] * shrink, r, r);
      this.m4.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(visible, this.m4);
      this.mesh.setColorAt(visible, this.palette[this.colorIdx[i]]);
      visible++;
      i++;
    }
    this.mesh.count = visible;
    if (visible > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, visible * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.clearUpdateRanges();
        this.mesh.instanceColor.addUpdateRange(0, visible * 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  clear(): void {
    this.alive = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }

  private removeAt(i: number): void {
    const last = --this.alive;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = this.pos[last * 3 + k];
      this.vel[i * 3 + k] = this.vel[last * 3 + k];
      this.rot[i * 3 + k] = this.rot[last * 3 + k];
      this.spin[i * 3 + k] = this.spin[last * 3 + k];
    }
    this.scale[i * 2] = this.scale[last * 2];
    this.scale[i * 2 + 1] = this.scale[last * 2 + 1];
    this.age[i] = this.age[last];
    this.delay[i] = this.delay[last];
    this.floor[i] = this.floor[last];
    this.colorIdx[i] = this.colorIdx[last];
  }
}
