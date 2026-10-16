// Procedural four-engine cargo plane flying the drop path, with spinning propellers and soft
// engine haze / contrail ribbons trailing behind each engine.

import * as THREE from 'three';
import { yawTo } from '../../../shared/math';
import type { FrameState } from '../../game/types';
import { GeoBuilder, xform } from './geometry';
import { createEntityMaterial } from './materials';

const BODY = 0x5d6656;
const BODY_DARK = 0x4a5245;
const BELLY = 0x8b9286;
const GLASS = 0x1c2733;
const ENGINE = 0x3f453c;

/** Engine positions (x, y, z) in plane space (-Z forward). */
const ENGINES: readonly [number, number, number][] = [
  [-10.5, 1.45, -3.2], [-5.6, 1.6, -3.6], [5.6, 1.6, -3.6], [10.5, 1.45, -3.2],
];
const PROP_RADIUS = 2.05;

function buildAirframe(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const rx = Math.PI / 2;
  // Fuselage (cylinder along Z), nose, tail cone.
  b.cyl(2.25, 2.25, 19, 12, xform(0, 0, 0.5, rx), { color: BODY });
  b.sphere(2.25, 12, 6, xform(0, 0, -9.0, -Math.PI / 2, 0, 0, 1, 1.6, 0.95), { color: BODY }, 0, Math.PI / 2);
  b.cyl(0.7, 2.25, 9, 12, xform(0, 0.55, 14.5, rx - 0.12), { color: BODY });
  b.box(3.6, 0.6, 18, xform(0, -1.95, 0.5), { color: BELLY });
  // Cockpit glazing.
  b.box(2.6, 0.55, 1.4, xform(0, 1.15, -10.2, -0.45), { color: GLASS });
  b.box(0.06, 0.5, 1.3, xform(-1.35, 0.95, -9.9, -0.3, 0, 0.35), { color: GLASS });
  b.box(0.06, 0.5, 1.3, xform(1.35, 0.95, -9.9, -0.3, 0, -0.35), { color: GLASS });
  // High wing, tapered.
  b.taper(0.5, 4.6, 0.32, 2.6, 21, xform(-11.2, 2.4, -2.4, 0, 0, Math.PI / 2 - 0.03), { color: BODY_DARK });
  b.taper(0.5, 4.6, 0.32, 2.6, 21, xform(11.2, 2.4, -2.4, 0, 0, -Math.PI / 2 + 0.03), { color: BODY_DARK });
  b.box(4.8, 0.6, 4.8, xform(0, 2.3, -2.4), { color: BODY_DARK });
  // Engine nacelles.
  for (const [x, y, z] of ENGINES) {
    b.cyl(0.6, 0.75, 5.2, 8, xform(x, y, z + 1.6, rx), { color: ENGINE });
    b.sphere(0.5, 8, 4, xform(x, y, z - 1.0, -rx), { color: 0x2a2d29 }, 0, Math.PI / 2);
  }
  // Tail: fin + horizontal stabiliser.
  b.taper(0.4, 5.0, 0.3, 2.6, 7.2, xform(0, 5.0, 17.4, 0.32), { color: BODY_DARK });
  b.taper(0.3, 3.6, 0.24, 1.9, 7.5, xform(-4.2, 1.9, 18.0, 0, 0, Math.PI / 2), { color: BODY_DARK });
  b.taper(0.3, 3.6, 0.24, 1.9, 7.5, xform(4.2, 1.9, 18.0, 0, 0, -Math.PI / 2), { color: BODY_DARK });
  // Landing gear fairings and cargo ramp seam.
  b.box(1.0, 1.1, 5.2, xform(-2.3, -1.5, 0.6), { color: BODY_DARK });
  b.box(1.0, 1.1, 5.2, xform(2.3, -1.5, 0.6), { color: BODY_DARK });
  b.box(3.4, 0.05, 0.05, xform(0, -1.35, 11.0), { color: 0x2f342c });
  // Roundels / markings.
  b.cyl(0.7, 0.7, 0.04, 10, xform(-14.5, 2.62, -2.2), { color: 0xd8d2bd });
  b.cyl(0.7, 0.7, 0.04, 10, xform(14.5, 2.62, -2.2), { color: 0xd8d2bd });
  return b.build();
}

function buildProp(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    b.box(0.26, PROP_RADIUS, 0.05, xform(Math.sin(a) * PROP_RADIUS * 0.5, Math.cos(a) * PROP_RADIUS * 0.5, 0, 0, 0.25, -a), { color: 0x1d1f1c });
  }
  b.cyl(0.32, 0.32, 0.4, 8, xform(0, 0, 0, Math.PI / 2), { color: 0x2a2d29 });
  return b.build();
}

/** Soft trailing haze: a tapered open tube with vertex alpha fading backward. */
function buildContrail(): THREE.BufferGeometry {
  const len = 60;
  const g = new THREE.CylinderGeometry(0.45, 1.6, len, 10, 6, true);
  g.rotateX(-Math.PI / 2); // tube along Z, narrow end (top) toward the engine
  g.translate(0, 0, len / 2 + 2.5);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const alpha = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getZ(i) - 2.5) / len; // 0 at the engine .. 1 at the tail end
    alpha[i] = Math.pow(1 - t, 1.6) * Math.min(1, t * 6);
  }
  g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  return g;
}

export class PlaneRenderer {
  private readonly group = new THREE.Group();
  private readonly airframe: THREE.Mesh;
  private readonly props: THREE.InstancedMesh;
  private readonly trails: THREE.InstancedMesh;
  private readonly bodyMat = createEntityMaterial({ rim: true, fogScale: 0.45 });
  private readonly trailMat: THREE.ShaderMaterial;
  private propAngle = 0;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private time = 0;

  constructor(parent: THREE.Object3D) {
    this.group.name = 'plane';
    this.group.visible = false;
    this.airframe = new THREE.Mesh(buildAirframe(), this.bodyMat);
    this.airframe.castShadow = false;
    this.group.add(this.airframe);
    this.props = new THREE.InstancedMesh(buildProp(), this.bodyMat, ENGINES.length);
    this.props.frustumCulled = false;
    this.group.add(this.props);
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xf4f6f8) } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        varying float vAlpha;
        varying float vZ;
        void main() {
          vAlpha = alpha;
          vZ = position.z;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vZ;
        void main() {
          float shimmer = 0.75 + 0.25 * sin(vZ * 0.35 - uTime * 9.0);
          gl_FragColor = vec4(uColor, vAlpha * 0.22 * shimmer);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.trails = new THREE.InstancedMesh(buildContrail(), this.trailMat, ENGINES.length);
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 2;
    this.group.add(this.trails);
    for (let i = 0; i < ENGINES.length; i++) {
      const [x, y, z] = ENGINES[i];
      this._m.makeTranslation(x, y, z + 1.6);
      this.trails.setMatrixAt(i, this._m);
    }
    this.trails.instanceMatrix.needsUpdate = true;
    parent.add(this.group);
  }

  update(frame: FrameState, dt: number): void {
    const plane = frame.plane;
    const pos = frame.planePos;
    if (!plane || !pos || !plane.active) {
      this.group.visible = false;
      return;
    }
    this.time += dt;
    this.group.visible = true;
    const yaw = yawTo(plane.start, plane.end);
    // Gentle bob / roll so the plane feels airborne.
    const roll = Math.sin(this.time * 0.35) * 0.015;
    const pitch = Math.sin(this.time * 0.27) * 0.008;
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.rotation.set(pitch, yaw, roll, 'YXZ');
    this.propAngle = (this.propAngle + dt * 26) % (Math.PI * 2);
    for (let i = 0; i < ENGINES.length; i++) {
      const [x, y, z] = ENGINES[i];
      this._e.set(0, 0, (i < 2 ? 1 : -1) * this.propAngle + i * 0.4, 'YXZ');
      this._q.setFromEuler(this._e);
      this._p.set(x, y, z - 1.35);
      this._m.compose(this._p, this._q, this._s);
      this.props.setMatrixAt(i, this._m);
    }
    this.props.instanceMatrix.needsUpdate = true;
    (this.trailMat.uniforms.uTime as { value: number }).value = this.time;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.airframe.geometry.dispose();
    this.props.geometry.dispose();
    this.trails.geometry.dispose();
    this.props.dispose();
    this.trails.dispose();
    this.bodyMat.dispose();
    this.trailMat.dispose();
  }
}
