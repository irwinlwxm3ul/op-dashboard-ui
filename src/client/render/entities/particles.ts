// Pooled point-sprite particle systems for vehicle damage: soft smoke (alpha blended, fogged) and
// fire (additive). Fixed capacity ring buffers, CPU integration, one draw call per system, no
// per-frame allocations.

import * as THREE from 'three';

export type ParticleKind = 'smoke' | 'fire';

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aShade;
uniform float uScale;
varying float vAlpha;
varying float vShade;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha;
  vShade = aShade;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(0.1, -mvPosition.z) : 0.0;
  #include <fog_vertex>
}`;

const FRAG_SMOKE = /* glsl */ `
varying float vAlpha;
varying float vShade;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float puff = 0.85 + 0.15 * sin(c.x * 11.0 + c.y * 7.0 + vShade * 20.0);
  float a = smoothstep(1.0, 0.15, d) * vAlpha * puff;
  vec3 col = mix(vec3(0.07, 0.07, 0.075), vec3(0.62, 0.62, 0.6), vShade);
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;

const FRAG_FIRE = /* glsl */ `
varying float vAlpha;
varying float vShade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float a = smoothstep(1.0, 0.0, d) * vAlpha;
  vec3 col = mix(vec3(1.0, 0.28, 0.04), vec3(1.0, 0.85, 0.35), vShade * (1.0 - d * 0.6));
  gl_FragColor = vec4(col * a * 1.6, a);
}`;

export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly geo = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly shade: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly shade0: Float32Array;
  private readonly attrs: THREE.BufferAttribute[] = [];
  private next = 0;
  private alive = 0;

  constructor(parent: THREE.Object3D, private readonly capacity: number, private readonly kind: ParticleKind) {
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.shade = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.shade0 = new Float32Array(capacity);
    const mk = (a: Float32Array, n: number): THREE.BufferAttribute => {
      const at = new THREE.BufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      this.attrs.push(at);
      return at;
    };
    this.geo.setAttribute('position', mk(this.pos, 3));
    this.geo.setAttribute('aSize', mk(this.size, 1));
    this.geo.setAttribute('aAlpha', mk(this.alpha, 1));
    this.geo.setAttribute('aShade', mk(this.shade, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const smoke = kind === 'smoke';
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 500 } }]),
      vertexShader: VERT,
      fragmentShader: smoke ? FRAG_SMOKE : FRAG_FIRE,
      transparent: true,
      depthWrite: false,
      blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending,
      fog: smoke,
    });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.name = 'particles-' + kind;
    this.points.frustumCulled = false;
    this.points.renderOrder = smoke ? 3 : 4;
    parent.add(this.points);
  }

  /** Spawn one particle. size in metres (start, end), shade 0..1 (smoke: dark..light, fire: heat). */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, shade: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (this.life[i] <= 0 || this.age[i] >= this.life[i]) this.alive++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = s0;
    this.size1[i] = s1;
    this.shade0[i] = shade;
    this.shade[i] = shade;
    this.size[i] = s0;
    this.alpha[i] = 0;
  }

  /** Integrate. `scale` = viewport height / (2 tan(fov/2)) for size attenuation. */
  update(dt: number, windX: number, windZ: number, scale: number): void {
    (this.material.uniforms.uScale as { value: number }).value = scale;
    if (this.alive <= 0) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    let alive = 0;
    const smoke = this.kind === 'smoke';
    const drag = Math.exp(-(smoke ? 0.6 : 1.8) * dt);
    for (let i = 0; i < this.capacity; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const a = this.age[i] + dt;
      if (a >= life) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      alive++;
      this.age[i] = a;
      const k = a / life;
      const j = i * 3;
      this.vel[j] = this.vel[j] * drag + windX * (1 - drag);
      this.vel[j + 2] = this.vel[j + 2] * drag + windZ * (1 - drag);
      this.vel[j + 1] = this.vel[j + 1] * (smoke ? 0.995 : drag) + (smoke ? 0.25 : 0.6) * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(k);
      if (smoke) {
        this.alpha[i] = Math.min(1, k * 8) * (1 - k) * (1 - k) * 0.75;
        this.shade[i] = this.shade0[i] + (0.75 - this.shade0[i]) * k * 0.6;
      } else {
        this.alpha[i] = Math.min(1, k * 10) * (1 - k);
        this.shade[i] = this.shade0[i] * (1 - k);
      }
    }
    this.alive = alive;
    for (let i = 0; i < this.attrs.length; i++) this.attrs[i].needsUpdate = true;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }
}
