// Frag grenades in flight: one instanced mesh, each grenade tumbling around an axis derived from
// its velocity, plus a faint smoke trail so the thrown arc reads. Spin state is kept per
// projectile id in a pooled map.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ProjectileView } from '../../game/types';
import type { EffectRecipes } from './effects';

interface SpinState {
  angle: number;
  ax: number; ay: number; az: number;
  trail: number;
  seen: number;
}

const MAX_FRAGS = 48;

/** Build the frag grenade geometry (body + fuse + lever), origin at the centre. */
export function createGrenadeGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(0.034, 12, 9);
  body.scale(1, 1.22, 1);
  const neck = new THREE.CylinderGeometry(0.012, 0.014, 0.022, 8);
  neck.translate(0, 0.045, 0);
  const cap = new THREE.CylinderGeometry(0.016, 0.016, 0.012, 8);
  cap.translate(0, 0.058, 0);
  const lever = new THREE.BoxGeometry(0.009, 0.075, 0.006);
  lever.translate(0.026, 0.02, 0);
  lever.rotateZ(-0.12);
  const ring = new THREE.TorusGeometry(0.01, 0.0025, 4, 10);
  ring.translate(-0.022, 0.06, 0);
  const merged = mergeGeometries([
    body.toNonIndexed(), neck.toNonIndexed(), cap.toNonIndexed(), lever.toNonIndexed(), ring.toNonIndexed(),
  ], false);
  for (const g of [body, neck, cap, lever, ring]) g.dispose();
  return merged ?? new THREE.SphereGeometry(0.035, 10, 8);
}

export class FragRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly spins = new Map<number, SpinState>();
  private readonly pool: SpinState[] = [];
  private frame = 0;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor() {
    const geom = createGrenadeGeometry();
    const mat = new THREE.MeshStandardMaterial({ color: 0x4d5631, roughness: 0.62, metalness: 0.25 });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_FRAGS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.name = 'fx-frags';
  }

  update(projectiles: ReadonlyMap<number, ProjectileView>, dt: number, effects: EffectRecipes, trails: boolean): void {
    this.frame++;
    let n = 0;
    for (const pr of projectiles.values()) {
      if (pr.kind !== 'frag' || n >= MAX_FRAGS) continue;
      let st = this.spins.get(pr.id);
      if (!st) {
        st = this.pool.pop() ?? { angle: 0, ax: 1, ay: 0, az: 0, trail: 0, seen: 0 };
        st.angle = Math.random() * Math.PI * 2;
        st.trail = 0;
        this.spins.set(pr.id, st);
      }
      st.seen = this.frame;
      const vx = pr.vel.x, vy = pr.vel.y, vz = pr.vel.z;
      const speed = Math.hypot(vx, vy, vz);
      // Tumble axis: horizontal, perpendicular to travel (end-over-end throw).
      const hx = -vz, hz = vx;
      const hl = Math.hypot(hx, hz);
      if (hl > 0.05) {
        // Smoothly steer the axis so bounces do not snap it.
        const k = Math.min(1, dt * 8);
        st.ax += (hx / hl - st.ax) * k;
        st.ay += (0 - st.ay) * k;
        st.az += (hz / hl - st.az) * k;
      }
      st.angle += speed * dt * 2.2;
      this.axis.set(st.ax, st.ay, st.az);
      if (this.axis.lengthSq() < 1e-6) this.axis.set(1, 0, 0);
      this.axis.normalize();
      this.q.setFromAxisAngle(this.axis, st.angle);
      this.p.set(pr.pos.x, pr.pos.y, pr.pos.z);
      this.m4.compose(this.p, this.q, this.one);
      this.mesh.setMatrixAt(n++, this.m4);
      if (trails && speed > 2) {
        st.trail -= dt;
        if (st.trail <= 0) {
          st.trail = 0.035;
          effects.fragTrail(pr.pos.x, pr.pos.y, pr.pos.z);
        }
      }
    }
    // Recycle spin states of grenades that are gone.
    if (this.spins.size > n) this.spins.forEach(this.sweep);
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Recycle spin states of grenades that are gone (bound once, no garbage). */
  private readonly sweep = (st: SpinState, id: number): void => {
    if (st.seen !== this.frame) {
      this.spins.delete(id);
      this.pool.push(st);
    }
  };

  clear(): void {
    for (const st of this.spins.values()) this.pool.push(st);
    this.spins.clear();
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
