// Bullet tracers and ballistic streaks: bright camera-facing ribbons between two points drawn as
// one instanced batch with additive blending. A minimum on-screen width keeps distant tracers
// readable (you should see where shots come from). Moving tracers are simulated here; callers
// may also push one-frame segments (projectile streaks) every frame.

import * as THREE from 'three';
import { upload } from './particles';

const VERT = /* glsl */ `
attribute vec3 iA;
attribute vec3 iB;
attribute vec4 iColor;  // rgb (HDR), alpha
attribute vec2 iWidth;  // world width (m), min width (px)
uniform float uPixelAngle;
varying vec2 vUv;
varying vec4 vColor;
varying float vDepth;
void main() {
  vec3 a = (modelViewMatrix * vec4(iA, 1.0)).xyz;
  vec3 b = (modelViewMatrix * vec4(iB, 1.0)).xyz;
  // Keep both ends in front of the near plane so the ribbon never flips through the camera.
  float nearZ = -0.06;
  if (a.z > nearZ && b.z > nearZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (a.z > nearZ) a = mix(a, b, (a.z - nearZ) / (a.z - b.z));
  if (b.z > nearZ) b = mix(b, a, (b.z - nearZ) / (b.z - a.z));
  float t = position.y;           // 0 tail .. 1 head
  vec3 p = mix(a, b, t);
  vec3 axis = b - a;
  vec3 side = cross(axis, p);
  float sl = length(side);
  side = sl > 1e-7 ? side / sl : vec3(1.0, 0.0, 0.0);
  float depth = max(-p.z, 0.06);
  float w = max(iWidth.x, iWidth.y * uPixelAngle * depth);
  p += side * position.x * w * 0.5;
  vUv = vec2(position.x, t);
  vColor = iColor;
  vDepth = depth;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
varying float vDepth;
void main() {
  float across = 1.0 - vUv.x * vUv.x;
  float core = across * across;
  float along = smoothstep(0.0, 0.7, vUv.y);
  float a = core * along * vColor.a;
  if (a < 0.003) discard;
  // Hot white core, coloured edges.
  vec3 rgb = mix(vColor.rgb, vec3(1.6, 1.5, 1.3), core * core * 0.6);
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface TracerStyle {
  /** Linear RGB (HDR allowed) */
  r: number; g: number; b: number;
  alpha: number;
  /** World width (m) */
  width: number;
  /** Minimum on-screen width (px) */
  minPx: number;
  /** Streak length (m) */
  length: number;
}

export class TracerSystem {
  readonly mesh: THREE.Mesh;
  private readonly capacity: number;
  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aA: THREE.InstancedBufferAttribute;
  private readonly aB: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aWidth: THREE.InstancedBufferAttribute;
  // Moving tracers (simulation)
  private readonly maxMoving: number;
  private moving = 0;
  private readonly start: Float32Array;   // origin x,y,z
  private readonly dir: Float32Array;     // unit dir
  private readonly offs: Float32Array;    // visual start offset (converges to the true line)
  private readonly mv: Float32Array;      // speed, travelled, maxDist, length, converge, minTail
  private readonly style: Float32Array;   // r,g,b,alpha,width,minPx
  /** Segments written this frame (moving tracers + pushed streaks). */
  private count = 0;
  /** Between begin() and end(): newly fired tracers are drawn immediately. */
  private inFrame = false;

  constructor(capacity = 768, maxMoving = 384) {
    this.capacity = capacity;
    this.maxMoving = maxMoving;
    this.start = new Float32Array(maxMoving * 3);
    this.dir = new Float32Array(maxMoving * 3);
    this.offs = new Float32Array(maxMoving * 3);
    this.mv = new Float32Array(maxMoving * 6);
    this.style = new Float32Array(maxMoving * 6);

    const geom = new THREE.InstancedBufferGeometry();
    // x: -1/1 across, y: 0 tail / 1 head
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aWidth = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iA', this.aA);
    geom.setAttribute('iB', this.aB);
    geom.setAttribute('iColor', this.aColor);
    geom.setAttribute('iWidth', this.aWidth);
    geom.instanceCount = 0;
    this.geom = geom;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPixelAngle: { value: 0.001 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'fx-tracers';
  }

  /**
   * Fire a moving tracer from (ox,oy,oz) along unit (dx,dy,dz) that stops at maxDist.
   * (vx,vy,vz) is a visual offset of the start point (e.g. muzzle vs eye) that converges to the
   * true line over `converge` meters so the streak leaves the gun but ends where the bullet went.
   */
  fire(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    speed: number, maxDist: number, st: TracerStyle,
    vx = 0, vy = 0, vz = 0, converge = 1, startDist = 0,
  ): void {
    if (!(maxDist > 0.5)) return;
    let i = this.moving;
    if (i >= this.maxMoving) {
      // Replace the most travelled tracer.
      let best = 0, bestT = -1;
      for (let k = 0; k < this.moving; k++) {
        const prog = this.mv[k * 6 + 1] / Math.max(1, this.mv[k * 6 + 2]);
        if (prog > bestT) { bestT = prog; best = k; }
      }
      i = best;
    } else {
      this.moving++;
    }
    const i3 = i * 3, i5 = i * 6, i6 = i * 6;
    this.start[i3] = ox; this.start[i3 + 1] = oy; this.start[i3 + 2] = oz;
    this.dir[i3] = dx; this.dir[i3 + 1] = dy; this.dir[i3 + 2] = dz;
    this.offs[i3] = vx; this.offs[i3 + 1] = vy; this.offs[i3 + 2] = vz;
    this.mv[i5] = speed;
    // First visible frame: a streak just leaving the muzzle.
    this.mv[i5 + 1] = Math.min(maxDist, startDist + Math.min(st.length, speed / 60) * 0.6);
    this.mv[i5 + 2] = maxDist;
    this.mv[i5 + 3] = st.length;
    this.mv[i5 + 4] = Math.max(0.1, converge);
    this.mv[i5 + 5] = startDist;
    this.style[i6] = st.r; this.style[i6 + 1] = st.g; this.style[i6 + 2] = st.b;
    this.style[i6 + 3] = st.alpha; this.style[i6 + 4] = st.width; this.style[i6 + 5] = st.minPx;
    if (this.inFrame) this.emitMoving(i);
  }

  /** Begin a frame: advance moving tracers and write them; streaks may be pushed afterwards. */
  begin(dt: number, pixelAngle: number): void {
    this.material.uniforms.uPixelAngle.value = pixelAngle;
    this.count = 0;
    this.inFrame = true;
    let i = 0;
    while (i < this.moving) {
      const i5 = i * 6;
      const travelled = this.mv[i5 + 1] + this.mv[i5] * dt;
      if (travelled - this.mv[i5 + 3] >= this.mv[i5 + 2]) {
        this.removeMoving(i);
        continue;
      }
      this.mv[i5 + 1] = travelled;
      this.emitMoving(i);
      i++;
    }
  }

  /** Write the current segment of moving tracer i. */
  private emitMoving(i: number): void {
    const i3 = i * 3, i5 = i * 6, i6 = i * 6;
    const travelled = this.mv[i5 + 1];
    const maxDist = this.mv[i5 + 2];
    const length = this.mv[i5 + 3];
    const head = Math.min(travelled, maxDist);
    const t0 = Math.min(head, Math.max(this.mv[i5 + 5], travelled - length));
    const conv = this.mv[i5 + 4];
    const k0 = Math.max(0, 1 - t0 / conv), k1 = Math.max(0, 1 - head / conv);
    const sx = this.start[i3], sy = this.start[i3 + 1], sz = this.start[i3 + 2];
    const dx = this.dir[i3], dy = this.dir[i3 + 1], dz = this.dir[i3 + 2];
    const ox = this.offs[i3], oy = this.offs[i3 + 1], oz = this.offs[i3 + 2];
    // Fade the last part of the flight once the head has stopped.
    let alpha = this.style[i6 + 3];
    if (travelled > maxDist) alpha *= Math.max(0, 1 - (travelled - maxDist) / Math.max(1, length));
    this.write(
      sx + dx * t0 + ox * k0, sy + dy * t0 + oy * k0, sz + dz * t0 + oz * k0,
      sx + dx * head + ox * k1, sy + dy * head + oy * k1, sz + dz * head + oz * k1,
      this.style[i6], this.style[i6 + 1], this.style[i6 + 2], alpha, this.style[i6 + 4], this.style[i6 + 5],
    );
  }

  /** Add a one-frame segment (tail -> head). */
  push(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    r: number, g: number, b: number, alpha: number, width: number, minPx: number,
  ): void {
    this.write(ax, ay, az, bx, by, bz, r, g, b, alpha, width, minPx);
  }

  /** Upload this frame's segments. */
  end(): void {
    this.inFrame = false;
    const n = this.count;
    this.geom.instanceCount = n;
    if (n > 0) {
      upload(this.aA, n * 3);
      upload(this.aB, n * 3);
      upload(this.aColor, n * 4);
      upload(this.aWidth, n * 2);
    }
  }

  get activeMoving(): number {
    return this.moving;
  }

  clear(): void {
    this.moving = 0;
    this.count = 0;
    this.geom.instanceCount = 0;
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }

  private write(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    r: number, g: number, b: number, alpha: number, width: number, minPx: number,
  ): void {
    if (this.count >= this.capacity || alpha <= 0) return;
    const i = this.count++;
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array;
    const C = this.aColor.array as Float32Array, W = this.aWidth.array as Float32Array;
    const i3 = i * 3, i4 = i * 4, i2 = i * 2;
    A[i3] = ax; A[i3 + 1] = ay; A[i3 + 2] = az;
    B[i3] = bx; B[i3 + 1] = by; B[i3 + 2] = bz;
    C[i4] = r; C[i4 + 1] = g; C[i4 + 2] = b; C[i4 + 3] = alpha;
    W[i2] = width; W[i2 + 1] = minPx;
  }

  private removeMoving(i: number): void {
    const last = --this.moving;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3, i5 = i * 6, l5 = last * 6, i6 = i * 6, l6 = last * 6;
    for (let k = 0; k < 3; k++) {
      this.start[i3 + k] = this.start[l3 + k];
      this.dir[i3 + k] = this.dir[l3 + k];
      this.offs[i3 + k] = this.offs[l3 + k];
    }
    for (let k = 0; k < 6; k++) this.mv[i5 + k] = this.mv[l5 + k];
    for (let k = 0; k < 6; k++) this.style[i6 + k] = this.style[l6 + k];
  }
}
