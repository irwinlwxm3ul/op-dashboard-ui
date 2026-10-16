// Training-ground target dummies for moving and popup targets (static targets are WorldBoxes drawn
// by the world renderer). Plywood soldier silhouettes on a stand, facing the firing line. Hits
// (`targetHit` events) make them wobble and flash; popup targets fall back and pop up again.

import * as THREE from 'three';
import { yawTo } from '../../../shared/math';
import type { World } from '../../../shared/types';
import type { TrainingTargetView } from '../../game/types';
import { GeoBuilder, xform } from './geometry';
import { casterDepthMaterial, createEntityMaterial } from './materials';

const BOARD = 0xb79868;
const RING = 0x3b2f22;
const ZONE = 0x8c6f48;
const METAL = 0x4a4d50;

function buildDummy(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const t = 0.05;
  // Silhouette board: legs block, torso, shoulders, neck, head.
  b.box(0.36, 0.86, t, xform(0, 0.5, 0), { color: BOARD });
  b.taper(0.42, t, 0.5, t, 0.52, xform(0, 1.2, 0), { color: BOARD });
  b.box(0.12, 0.08, t, xform(0, 1.5, 0), { color: BOARD });
  b.sphere(0.13, 8, 6, xform(0, 1.66, 0, 0, 0, 0, 1, 1.15, t / 0.26), { color: BOARD });
  // Scoring zones on the front face (-Z side).
  b.box(0.2, 0.26, 0.01, xform(0, 1.22, -t / 2 - 0.004), { color: ZONE });
  b.ring(0.07, 0.008, 4, 16, xform(0, 1.22, -t / 2 - 0.01, Math.PI / 2), { color: RING });
  b.ring(0.13, 0.008, 4, 16, xform(0, 1.22, -t / 2 - 0.01, Math.PI / 2), { color: RING });
  b.ring(0.06, 0.007, 4, 14, xform(0, 1.67, -t / 2 - 0.01, Math.PI / 2), { color: RING });
  // Stand: post + base skid.
  b.box(0.05, 0.4, 0.05, xform(0, 0.12, 0.06), { color: METAL });
  b.box(0.6, 0.06, 0.32, xform(0, 0.03, 0.06), { color: METAL });
  return b.build();
}

interface DummyState {
  /** Fall angle (0 upright .. ~PI/2 down) for popups. */
  fall: number;
  downTimer: number;
  wobble: number;
  wobbleV: number;
  flash: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _red = new THREE.Color(1, 0.45, 0.35);

export class DummyRenderer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material = createEntityMaterial({ rim: true, fogScale: 0.6 });
  private readonly states = new Map<number, DummyState>();
  private readonly capacity: number;

  constructor(parent: THREE.Object3D, private readonly world: World) {
    this.capacity = Math.max(4, (world.training?.targets.length ?? 0) + 4);
    this.mesh = new THREE.InstancedMesh(buildDummy(), this.material, this.capacity);
    this.mesh.name = 'training-dummies';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _white);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.customDepthMaterial = casterDepthMaterial('instanced');
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    parent.add(this.mesh);
  }

  private state(id: number): DummyState {
    let s = this.states.get(id);
    if (!s) {
      s = { fall: 0, downTimer: 0, wobble: 0, wobbleV: 0, flash: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  /** A target was hit (event from the bus). */
  onHit(targetId: number, damage: number, head: boolean): void {
    const s = this.state(targetId);
    s.wobbleV += Math.min(6, 1.5 + damage * 0.05) * (head ? 1.3 : 1);
    s.flash = 1;
    s.downTimer = 1.6;
  }

  update(targets: readonly TrainingTargetView[], dt: number): void {
    let n = 0;
    const fl = this.world.training?.firingLine;
    for (const t of targets) {
      if (t.kind === 'static') continue;
      if (n >= this.capacity) break;
      const s = this.state(t.id);
      // Popups: drop back when hit, rise again after the timer.
      if (t.kind === 'popup') {
        if (s.downTimer > 0) {
          s.downTimer -= dt;
          s.fall += (Math.PI / 2 - 0.08 - s.fall) * (1 - Math.exp(-18 * dt));
        } else {
          s.fall += (0 - s.fall) * (1 - Math.exp(-7 * dt));
        }
      } else {
        s.downTimer = 0;
        s.fall = 0;
      }
      // Wobble spring.
      const a = -140 * s.wobble - 7 * s.wobbleV;
      s.wobbleV += a * dt;
      s.wobble += s.wobbleV * dt;
      s.flash = Math.max(0, s.flash - dt * 5);
      const yaw = fl ? yawTo(t.pos, fl) : 0;
      // Facing the firing line: the board's front (-Z) points at it.
      _e.set(s.fall + s.wobble * 0.12, yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(t.pos.x, t.pos.y, t.pos.z);
      _m.compose(_p, _q, _one);
      this.mesh.setMatrixAt(n, _m);
      _c.copy(_white).lerp(_red, s.flash);
      this.mesh.setColorAt(n, _c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }
}
