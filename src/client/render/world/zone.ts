// Blue zone wall (open cylinder from below the terrain up to ~400 m, additive animated shader that
// glows where it meets the ground and fades with height, visible from both sides) and the next
// ("white") circle as a thin bright band hugging the terrain while a shrink is announced/running.

import * as THREE from 'three';
import type { ZoneState } from '../../../shared/types';
import { HEIGHT_SAMPLE_GLSL, NOISE_GLSL, type WorldUniforms } from './shaders';
import type { HeightTexture } from './heightTexture';

const WALL_BOTTOM = -40;
const WALL_TOP = 400;
const WALL_SEGMENTS = 256;
const RING_MAX_SEGMENTS = 1024;
const RING_HEIGHT = 0.9;
const RING_SINK = 0.35;
/** Visual circle values snap instead of smoothing when they jump more than this (m). */
const SNAP_DISTANCE = 40;

const wallVertex = /* glsl */ `
varying vec3 vWPos;
varying float vU;
varying float vViewDepth;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vU = uv.x;
  vec4 mv = viewMatrix * wp;
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const wallFragment = /* glsl */ `
uniform float uTime;
uniform float uRadius;
uniform vec3 uColor;
uniform vec3 uGlow;
uniform float uFogDensity;
varying vec3 vWPos;
varying float vU;
varying float vViewDepth;
${NOISE_GLSL}
${HEIGHT_SAMPLE_GLSL}
void main() {
  float ground = dzTerrainHeight(vWPos.xz);
  float above = vWPos.y - ground;
  if (above < -0.5) discard;
  float arc = vU * 6.2831853 * uRadius;
  float h = vWPos.y;
  // Vertical scan streaks scrolling upward (smooth noise stretched vertically, faded with
  // distance so they never alias), slow soft bands and flowing noise.
  float near = 1.0 - smoothstep(60.0, 320.0, vViewDepth);
  float streak = dzNoise(vec2(arc * 0.45, h * 0.02 - uTime * 0.35));
  streak = smoothstep(0.55, 0.95, streak) * near;
  float band = smoothstep(0.7, 1.0, fract(h * 0.03 - uTime * 0.08));
  float n = dzNoise(vec2(arc * 0.02, h * 0.025 - uTime * 0.12)) * 0.6 + dzNoise(vec2(arc * 0.07, h * 0.08 + uTime * 0.2)) * 0.4;
  float groundGlow = 1.0 - smoothstep(0.0, 3.5, above);
  float heightFade = 1.0 - smoothstep(30.0, ${WALL_TOP.toFixed(1)}, h);
  // Fog reduces the wall far less than terrain so it reads across the map.
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vViewDepth * vViewDepth);
  float vis = 1.0 - 0.55 * fogF;
  // Translucent blue tint (premultiplied) + additive glow on streaks, bands and the ground line.
  float tint = (0.27 + 0.1 * n + 0.04 * band) * heightFade * vis;
  float glow = ((0.12 * streak + 0.05 * band) * (0.6 + 0.4 * n) * heightFade + groundGlow * 0.9) * vis;
  gl_FragColor = vec4(uColor * tint + uGlow * glow, tint);
}
`;

const ringVertex = /* glsl */ `
attribute float aV;
varying float vV;
varying float vViewDepth;
void main() {
  vV = aV;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const ringFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uFogDensity;
varying float vV;
varying float vViewDepth;
void main() {
  // Bright line just above the ground (v ~ 0.4) with a soft glow fading upward.
  float core = 1.0 - smoothstep(0.0, 0.18, abs(vV - 0.4));
  float fade = (1.0 - smoothstep(0.4, 1.0, vV)) * step(0.3, vV);
  float pulse = 0.85 + 0.15 * sin(uTime * 2.4);
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vViewDepth * vViewDepth);
  float a = (core * 0.8 + fade * 0.25) * pulse * (1.0 - 0.6 * fogF);
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

export class ZoneRenderer {
  readonly group = new THREE.Group();
  private readonly wallGeometry: THREE.CylinderGeometry;
  private readonly wallMaterial: THREE.ShaderMaterial;
  private readonly wall: THREE.Mesh;
  private readonly ringGeometry: THREE.BufferGeometry;
  private readonly ringMaterial: THREE.ShaderMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringPos: Float32Array;
  private readonly heightAt: (x: number, z: number) => number;
  private visCx = 0;
  private visCz = 0;
  private visR = -1;
  private ringCx = NaN;
  private ringCz = NaN;
  private ringR = NaN;

  constructor(heightAt: (x: number, z: number) => number, heights: HeightTexture, shared: WorldUniforms, fogDensity: number) {
    this.heightAt = heightAt;
    this.group.name = 'zone';

    this.wallGeometry = new THREE.CylinderGeometry(1, 1, 1, WALL_SEGMENTS, 1, true);
    this.wallGeometry.translate(0, 0.5, 0);
    this.wallMaterial = new THREE.ShaderMaterial({
      name: 'dz-zone-wall',
      uniforms: {
        uTime: shared.uTime,
        uRadius: { value: 1 },
        uColor: { value: new THREE.Color(0x1e4fe0) },
        uGlow: { value: new THREE.Color(0x6aa8ff) },
        uFogDensity: { value: fogDensity },
        uHeightTex: { value: heights.texture },
        uHeightInfo: { value: heights.info },
      },
      vertexShader: wallVertex,
      fragmentShader: wallFragment,
      transparent: true,
      depthWrite: false,
      // Premultiplied "over" blending: rgb already carries tint*alpha plus additive glow.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.wall = new THREE.Mesh(this.wallGeometry, this.wallMaterial);
    this.wall.name = 'zone-wall';
    this.wall.frustumCulled = false;
    this.wall.visible = false;
    this.wall.renderOrder = 5;
    this.wall.matrixAutoUpdate = false;
    this.group.add(this.wall);

    // Ring: (segments + 1) columns x 2 rows (ground, top), world-space positions.
    this.ringPos = new Float32Array((RING_MAX_SEGMENTS + 1) * 2 * 3);
    const v = new Float32Array((RING_MAX_SEGMENTS + 1) * 2);
    const idx = new Uint16Array(RING_MAX_SEGMENTS * 6);
    for (let s = 0; s <= RING_MAX_SEGMENTS; s++) {
      v[s * 2] = 0;
      v[s * 2 + 1] = 1;
    }
    for (let s = 0; s < RING_MAX_SEGMENTS; s++) {
      const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.set([a, c, b, b, c, d], s * 6);
    }
    this.ringGeometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.ringPos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    this.ringGeometry.setAttribute('position', posAttr);
    this.ringGeometry.setAttribute('aV', new THREE.BufferAttribute(v, 1));
    this.ringGeometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.ringMaterial = new THREE.ShaderMaterial({
      name: 'dz-zone-ring',
      uniforms: {
        uTime: shared.uTime,
        uColor: { value: new THREE.Color(0xf4f8ff).multiplyScalar(1.1) },
        uFogDensity: { value: fogDensity },
      },
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.name = 'zone-next-ring';
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ring.renderOrder = 6;
    this.group.add(this.ring);
  }

  /** `enabled` is false in training mode (no zone). */
  update(zone: ZoneState, enabled: boolean, mapHalf: number, dt: number): void {
    const active = enabled && zone.stage !== 'pre' && zone.r > 0 && zone.r < mapHalf * 4;
    this.wall.visible = active;
    if (active) {
      const jump = Math.hypot(zone.cx - this.visCx, zone.cz - this.visCz) + Math.abs(zone.r - this.visR);
      if (this.visR < 0 || jump > SNAP_DISTANCE) {
        this.visCx = zone.cx;
        this.visCz = zone.cz;
        this.visR = zone.r;
      } else {
        // Interpolated values are already smooth; this only irons out snapshot jitter (~30 ms lag).
        const k = 1 - Math.exp(-30 * dt);
        this.visCx += (zone.cx - this.visCx) * k;
        this.visCz += (zone.cz - this.visCz) * k;
        this.visR += (zone.r - this.visR) * k;
      }
      this.wall.position.set(this.visCx, WALL_BOTTOM, this.visCz);
      this.wall.scale.set(this.visR, WALL_TOP - WALL_BOTTOM, this.visR);
      this.wall.updateMatrix();
      this.wallMaterial.uniforms.uRadius.value = this.visR;
    } else {
      this.visR = -1;
    }

    const showRing =
      enabled && (zone.stage === 'waiting' || zone.stage === 'shrinking') && zone.nr > 0 && zone.nr < mapHalf * 4 &&
      Math.abs(zone.nr - zone.r) + Math.hypot(zone.nx - zone.cx, zone.nz - zone.cz) > 0.5;
    this.ring.visible = showRing;
    if (showRing && (zone.nx !== this.ringCx || zone.nz !== this.ringCz || zone.nr !== this.ringR)) {
      this.rebuildRing(zone.nx, zone.nz, zone.nr);
    }
  }

  /** Re-drape the next-circle band over the terrain (only when the target circle changes). */
  private rebuildRing(cx: number, cz: number, r: number): void {
    this.ringCx = cx;
    this.ringCz = cz;
    this.ringR = r;
    const segs = Math.min(RING_MAX_SEGMENTS, Math.max(64, Math.ceil((Math.PI * 2 * r) / 3)));
    const p = this.ringPos;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const y = this.heightAt(x, z);
      const o = s * 6;
      p[o] = x;
      p[o + 1] = y - RING_SINK;
      p[o + 2] = z;
      p[o + 3] = x;
      p[o + 4] = y + RING_HEIGHT;
      p[o + 5] = z;
    }
    const attr = this.ringGeometry.getAttribute('position') as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, (segs + 1) * 6);
    attr.needsUpdate = true;
    this.ringGeometry.setDrawRange(0, segs * 6);
  }

  dispose(): void {
    this.wallGeometry.dispose();
    this.wallMaterial.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    this.group.removeFromParent();
  }
}
