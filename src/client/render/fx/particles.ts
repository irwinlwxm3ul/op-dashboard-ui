// Pooled GPU particle system: CPU-simulated particles drawn as one instanced, camera-facing quad
// batch (one draw call per system). Particles may be velocity-stretched (sparks, droplets) or
// rotated billboards (smoke, debris). Dead particles are removed by swap-with-last so the live
// range is contiguous and only that range is uploaded each frame. No per-frame allocations.

import * as THREE from 'three';
import { ATLAS_COLS, ATLAS_ROWS, getSpriteAtlas } from './textures';

/** Mutable description of one particle; callers fill a reused instance and pass it to emit(). */
export interface ParticleSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds */
  life: number;
  /** World size (diameter, m) at birth / death (eased out). */
  size0: number;
  size1: number;
  /** Linear RGB at birth and death (may exceed 1 for additive glow). */
  r0: number; g0: number; b0: number;
  r1: number; g1: number; b1: number;
  /** Peak opacity */
  alpha: number;
  /** Fraction of life spent fading in. */
  fadeIn: number;
  /** Exponent of the fade-out curve (1 linear, >1 lingers then drops). */
  fadePow: number;
  /** Linear drag (1/s) */
  drag: number;
  /** Downward acceleration (m/s^2); negative values rise (buoyant smoke / fire). */
  gravity: number;
  rot: number;
  rotSpeed: number;
  /** Atlas cell index (see textures.ts CELL) */
  cell: number;
  /** Velocity stretch (seconds of travel shown as streak length); 0 = round billboard. */
  stretch: number;
  /** Restitution when hitting floorY (0 = no collision). */
  bounce: number;
  floorY: number;
}

export function createSpec(): ParticleSpec {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 1, size1: 1,
    r0: 1, g0: 1, b0: 1, r1: 1, g1: 1, b1: 1, alpha: 1, fadeIn: 0, fadePow: 1,
    drag: 0, gravity: 0, rot: 0, rotSpeed: 0, cell: 0, stretch: 0, bounce: 0, floorY: -1e9,
  };
}

/** Reset a spec to neutral defaults (so recipes only set what they need). */
export function resetSpec(s: ParticleSpec): ParticleSpec {
  s.vx = s.vy = s.vz = 0;
  s.life = 1; s.size0 = 1; s.size1 = 1;
  s.r0 = s.g0 = s.b0 = 1; s.r1 = s.g1 = s.b1 = 1;
  s.alpha = 1; s.fadeIn = 0; s.fadePow = 1; s.drag = 0; s.gravity = 0;
  s.rot = 0; s.rotSpeed = 0; s.cell = 0; s.stretch = 0; s.bounce = 0; s.floorY = -1e9;
  return s;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iColor;
attribute vec4 iParams; // size, rotation, cell, unused
uniform vec2 uAtlas;   // cols, rows
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  vec2 corner = position.xy; // -0.5 .. 0.5
  float size = iParams.x;
  vec3 v = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
  float vl = length(v);
  if (vl > 1e-4) {
    // Ribbon from tail (pos - vel) to head (pos), perpendicular to the view ray.
    vec3 head = mvPosition.xyz;
    vec3 side = cross(v, head);
    float sl = length(side);
    side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
    vec3 p = head - v * (0.5 - corner.y) + side * corner.x * size;
    // Extend the head a little so the streak has a rounded cap.
    p += normalize(v) * corner.y * size * 0.5;
    mvPosition = vec4(p, 1.0);
  } else {
    float c = cos(iParams.y), s = sin(iParams.y);
    vec2 r = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c) * size;
    mvPosition.xy += r;
  }
  float cell = iParams.z;
  float col = mod(cell, uAtlas.x);
  float row = floor(cell / uAtlas.x);
  vec2 uv = corner + 0.5;
  vUv = vec2((col + uv.x) / uAtlas.x, 1.0 - (row + 1.0 - uv.y) / uAtlas.y);
  vColor = iColor;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uAdditive;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.003) discard;
  vec3 rgb = tex.rgb * vColor.rgb;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    // Additive light fades out in haze; alpha-blended matter takes the fog colour.
    rgb = mix(mix(rgb, fogColor, fogFactor), rgb * (1.0 - fogFactor * 0.85), uAdditive);
  #endif
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  /** Live particle count. */
  alive = 0;
  /** Soft cap (<= capacity), changed with quality. */
  cap: number;
  private readonly capacity: number;
  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  // Simulation state
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly col0: Float32Array;
  private readonly col1: Float32Array;
  private readonly alpha: Float32Array;
  private readonly fadeIn: Float32Array;
  private readonly fadePow: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private readonly rot: Float32Array;
  private readonly rotSpeed: Float32Array;
  private readonly cell: Float32Array;
  private readonly stretch: Float32Array;
  private readonly bounce: Float32Array;
  private readonly floor: Float32Array;
  // GPU attributes
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  /** Round-robin victim when the system is full. */
  private victim = 0;

  constructor(capacity: number, additive: boolean, renderOrder: number) {
    this.capacity = capacity;
    this.cap = capacity;
    const n = capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.col0 = new Float32Array(n * 3);
    this.col1 = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    this.fadeIn = new Float32Array(n);
    this.fadePow = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.rotSpeed = new Float32Array(n);
    this.cell = new Float32Array(n);
    this.stretch = new Float32Array(n);
    this.bounce = new Float32Array(n);
    this.floor = new Float32Array(n);

    const geom = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    geom.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iPos', this.aPos);
    geom.setAttribute('iVel', this.aVel);
    geom.setAttribute('iColor', this.aColor);
    geom.setAttribute('iParams', this.aParams);
    geom.instanceCount = 0;
    this.geom = geom;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uMap: { value: null },
          uAtlas: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
          uAdditive: { value: additive ? 1 : 0 },
        },
      ]),
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      // Velocity-stretched ribbons can face either way depending on the travel direction.
      side: THREE.DoubleSide,
    });
    // Uniform merge clones values; assign the shared texture afterwards.
    this.material.uniforms.uMap.value = getSpriteAtlas();

    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = additive ? 'fx-particles-add' : 'fx-particles-alpha';
  }

  /** Spawn one particle (overwrites a live one round-robin when at the cap). */
  emit(s: ParticleSpec): void {
    let i: number;
    if (this.alive < this.cap) {
      i = this.alive++;
    } else {
      if (this.alive === 0) return;
      this.victim = (this.victim + 1) % this.alive;
      i = this.victim;
    }
    const i3 = i * 3;
    this.pos[i3] = s.x; this.pos[i3 + 1] = s.y; this.pos[i3 + 2] = s.z;
    this.vel[i3] = s.vx; this.vel[i3 + 1] = s.vy; this.vel[i3 + 2] = s.vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, s.life);
    this.size0[i] = s.size0;
    this.size1[i] = s.size1;
    this.col0[i3] = s.r0; this.col0[i3 + 1] = s.g0; this.col0[i3 + 2] = s.b0;
    this.col1[i3] = s.r1; this.col1[i3 + 1] = s.g1; this.col1[i3 + 2] = s.b1;
    this.alpha[i] = s.alpha;
    this.fadeIn[i] = s.fadeIn;
    this.fadePow[i] = s.fadePow;
    this.drag[i] = s.drag;
    this.grav[i] = s.gravity;
    this.rot[i] = s.rot;
    this.rotSpeed[i] = s.rotSpeed;
    this.cell[i] = s.cell;
    this.stretch[i] = s.stretch;
    this.bounce[i] = s.bounce;
    this.floor[i] = s.floorY;
  }

  private copy(dst: number, src: number): void {
    const d3 = dst * 3, s3 = src * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[d3 + k] = this.pos[s3 + k];
      this.vel[d3 + k] = this.vel[s3 + k];
      this.col0[d3 + k] = this.col0[s3 + k];
      this.col1[d3 + k] = this.col1[s3 + k];
    }
    this.age[dst] = this.age[src];
    this.life[dst] = this.life[src];
    this.size0[dst] = this.size0[src];
    this.size1[dst] = this.size1[src];
    this.alpha[dst] = this.alpha[src];
    this.fadeIn[dst] = this.fadeIn[src];
    this.fadePow[dst] = this.fadePow[src];
    this.drag[dst] = this.drag[src];
    this.grav[dst] = this.grav[src];
    this.rot[dst] = this.rot[src];
    this.rotSpeed[dst] = this.rotSpeed[src];
    this.cell[dst] = this.cell[src];
    this.stretch[dst] = this.stretch[src];
    this.bounce[dst] = this.bounce[src];
    this.floor[dst] = this.floor[src];
  }

  /** Integrate and upload. */
  update(dt: number): void {
    const P = this.pos, V = this.vel;
    const gp = this.aPos.array as Float32Array;
    const gv = this.aVel.array as Float32Array;
    const gc = this.aColor.array as Float32Array;
    const gq = this.aParams.array as Float32Array;
    let i = 0;
    while (i < this.alive) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        const last = --this.alive;
        if (i !== last) this.copy(i, last);
        continue;
      }
      this.age[i] = age;
      const i3 = i * 3;
      const dragF = Math.exp(-this.drag[i] * dt);
      let vx = V[i3] * dragF, vy = V[i3 + 1] * dragF - this.grav[i] * dt, vz = V[i3 + 2] * dragF;
      let px = P[i3] + vx * dt, py = P[i3 + 1] + vy * dt, pz = P[i3 + 2] + vz * dt;
      const b = this.bounce[i];
      if (b > 0 && py < this.floor[i]) {
        py = this.floor[i];
        if (vy < 0) vy = -vy * b;
        vx *= 0.55; vz *= 0.55;
        if (vy < 0.4) vy = 0;
        this.rotSpeed[i] *= 0.5;
      }
      V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
      P[i3] = px; P[i3 + 1] = py; P[i3 + 2] = pz;
      this.rot[i] += this.rotSpeed[i] * dt;

      const t = age / this.life[i];
      const fi = this.fadeIn[i];
      let a = this.alpha[i] * Math.pow(1 - t, this.fadePow[i]);
      if (fi > 0 && t < fi) a *= t / fi;
      const e = 1 - (1 - t) * (1 - t);
      const size = this.size0[i] + (this.size1[i] - this.size0[i]) * e;
      gp[i3] = px; gp[i3 + 1] = py; gp[i3 + 2] = pz;
      const st = this.stretch[i];
      gv[i3] = vx * st; gv[i3 + 1] = vy * st; gv[i3 + 2] = vz * st;
      const i4 = i * 4;
      const c0 = this.col0, c1 = this.col1;
      gc[i4] = c0[i3] + (c1[i3] - c0[i3]) * t;
      gc[i4 + 1] = c0[i3 + 1] + (c1[i3 + 1] - c0[i3 + 1]) * t;
      gc[i4 + 2] = c0[i3 + 2] + (c1[i3 + 2] - c0[i3 + 2]) * t;
      gc[i4 + 3] = a;
      gq[i4] = size;
      gq[i4 + 1] = this.rot[i];
      gq[i4 + 2] = this.cell[i];
      gq[i4 + 3] = 0;
      i++;
    }
    const n = this.alive;
    this.geom.instanceCount = n;
    if (n > 0) {
      upload(this.aPos, n * 3);
      upload(this.aVel, n * 3);
      upload(this.aColor, n * 4);
      upload(this.aParams, n * 4);
    }
  }

  clear(): void {
    this.alive = 0;
    this.geom.instanceCount = 0;
  }

  setCap(cap: number): void {
    this.cap = Math.max(16, Math.min(this.capacity, cap | 0));
    if (this.alive > this.cap) this.alive = this.cap;
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}

/** Mark the first `count` floats of an attribute for upload. */
export function upload(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}
