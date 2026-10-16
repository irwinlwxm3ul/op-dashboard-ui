// Pooled surface decals (bullet holes, dirt marks, scorch marks): oriented instanced quads in a
// ring buffer (oldest replaced first) that fade out at the end of their life. One draw call.

import * as THREE from 'three';
import { upload } from './particles';
import { DECAL_COLS, DECAL_ROWS, getDecalAtlas } from './textures';

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iNormal;
attribute vec4 iParams; // size, rotation, cell, alpha
uniform vec2 uAtlas;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vec3 n = normalize(iNormal);
  vec3 ref = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(ref, n));
  vec3 b = cross(n, t);
  float c = cos(iParams.y), s = sin(iParams.y);
  vec3 tt = t * c + b * s;
  vec3 bb = b * c - t * s;
  vec2 corner = position.xy;
  float size = iParams.w > 0.0 ? iParams.x : 0.0;
  vec3 world = iPos + n * 0.012 + (tt * corner.x + bb * corner.y) * size;
  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
  float cell = iParams.z;
  float col = mod(cell, uAtlas.x);
  float row = floor(cell / uAtlas.x);
  vec2 uv = corner + 0.5;
  vUv = vec2((col + uv.x) / uAtlas.x, 1.0 - (row + 1.0 - uv.y) / uAtlas.y);
  vAlpha = iParams.w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a < 0.01) discard;
  vec3 rgb = tex.rgb;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    rgb = mix(rgb, fogColor, fogFactor);
  #endif
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
}
`;

export class DecalSystem {
  readonly mesh: THREE.Mesh;
  private readonly capacity: number;
  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aNormal: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly peak: Float32Array;
  private next = 0;
  private used = 0;
  /** Effective ring size (quality dependent, <= capacity). */
  private ring: number;

  constructor(capacity = 220) {
    this.capacity = capacity;
    this.ring = capacity;
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.peak = new Float32Array(capacity);
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aNormal = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iPos', this.aPos);
    geom.setAttribute('iNormal', this.aNormal);
    geom.setAttribute('iParams', this.aParams);
    geom.instanceCount = 0;
    this.geom = geom;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uMap: { value: null }, uAtlas: { value: new THREE.Vector2(DECAL_COLS, DECAL_ROWS) } },
      ]),
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.material.uniforms.uMap.value = getDecalAtlas();
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'fx-decals';
  }

  setRing(n: number): void {
    this.ring = Math.max(16, Math.min(this.capacity, n | 0));
    if (this.next >= this.ring) this.next = 0;
  }

  add(x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number, cell: number, life: number, alpha = 1): void {
    const i = this.next;
    this.next = (this.next + 1) % this.ring;
    if (i + 1 > this.used) this.used = i + 1;
    const P = this.aPos.array as Float32Array, N = this.aNormal.array as Float32Array, Q = this.aParams.array as Float32Array;
    P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
    N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz;
    Q[i * 4] = size;
    Q[i * 4 + 1] = Math.random() * Math.PI * 2;
    Q[i * 4 + 2] = cell;
    Q[i * 4 + 3] = alpha;
    this.age[i] = 0;
    this.life[i] = life;
    this.peak[i] = alpha;
    upload(this.aPos, this.used * 3);
    upload(this.aNormal, this.used * 3);
  }

  update(dt: number): void {
    const Q = this.aParams.array as Float32Array;
    const n = this.used;
    for (let i = 0; i < n; i++) {
      if (this.peak[i] <= 0) continue;
      const age = (this.age[i] += dt);
      const life = this.life[i];
      const fade = Math.min(3, life * 0.25);
      let a = this.peak[i];
      if (age >= life) {
        a = 0;
        this.peak[i] = 0;
      } else if (age > life - fade) {
        a *= (life - age) / fade;
      }
      Q[i * 4 + 3] = a;
    }
    this.geom.instanceCount = n;
    if (n > 0) upload(this.aParams, n * 4);
  }

  clear(): void {
    this.used = 0;
    this.next = 0;
    this.peak.fill(0);
    this.geom.instanceCount = 0;
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}
