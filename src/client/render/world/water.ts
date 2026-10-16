// Sea: one large plane at the water level that follows the camera so it always reaches the horizon.
// Cheap analytic shading: summed directional waves + scrolling noise for the normal, Schlick
// fresnel against a sky gradient, sharp sun glint, depth tint and transparency from the terrain
// height texture (clear shallows, dark open sea), animated foam along the shoreline.

import * as THREE from 'three';
import { ENV } from '../core/environment';
import { HEIGHT_SAMPLE_GLSL, NOISE_GLSL, type WorldUniforms } from './shaders';
import type { HeightTexture } from './heightTexture';

const WATER_SIZE = 4800;

const vertexShader = /* glsl */ `
varying vec3 vWPos;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uWaterLevel;
varying vec3 vWPos;
#include <fog_pars_fragment>
${NOISE_GLSL}
${HEIGHT_SAMPLE_GLSL}

vec2 waveSlope(vec2 p, float t) {
  vec2 s = vec2(0.0);
  vec2 d;
  d = vec2(0.80, 0.60);   s += 0.033 * d * cos(dot(d, p) * 0.55 + t * 1.05);
  d = vec2(-0.50, 0.866); s += 0.040 * d * cos(dot(d, p) * 0.93 + t * 1.45);
  d = vec2(0.97, -0.24);  s += 0.051 * d * cos(dot(d, p) * 1.70 + t * 2.05);
  d = vec2(-0.31, -0.95); s += 0.056 * d * cos(dot(d, p) * 3.10 + t * 2.85);
  return s;
}

void main() {
  vec3 toCam = cameraPosition - vWPos;
  float dist = max(length(toCam), 0.001);
  vec3 V = toCam / dist;
  float detail = 1.0 / (1.0 + dist * 0.011);

  vec2 slope = waveSlope(vWPos.xz, uTime) * detail;
  float n1 = dzNoise(vWPos.xz * 0.42 + vec2(uTime * 0.13, uTime * 0.05));
  float n2 = dzNoise(vWPos.xz * 0.42 + vec2(5.37, 2.71) - vec2(uTime * 0.07, uTime * 0.12));
  slope += (vec2(n1, n2) - 0.5) * 0.16 * detail * detail;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.55));

  float depth = max(uWaterLevel - dzTerrainHeight(vWPos.xz), 0.0);
  float depthK = 1.0 - exp(-depth * 0.2);
  vec3 body = mix(uShallow, uDeep, depthK) * (0.6 + 0.4 * clamp(uSunDir.y, 0.0, 1.0));
  vec3 col = mix(body, sky, fres);

  float sunDot = max(dot(R, uSunDir), 0.0);
  float spec = pow(sunDot, 700.0) * 9.0 + pow(sunDot, 70.0) * 0.22;
  col += uSunColor * spec;

  float foamBand = 1.0 - smoothstep(0.0, 0.8, depth);
  float foamNoise = dzNoise(vWPos.xz * 1.25 + vec2(uTime * 0.31, -uTime * 0.22));
  float foam = foamBand * smoothstep(0.45, 0.85, foamNoise + 0.28 * sin(depth * 8.0 - uTime * 1.7));
  col = mix(col, vec3(0.86, 0.9, 0.92), foam * 0.75);

  float alpha = mix(0.28, 0.95, smoothstep(0.0, 4.5, depth));
  alpha = max(alpha, fres);
  alpha = max(alpha, foam * 0.85);
  alpha *= smoothstep(0.0, 0.06, depth);
  alpha = clamp(alpha + spec * 0.4, 0.0, 1.0);
  if (alpha < 0.015) discard;

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class WaterRenderer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;

  constructor(waterLevel: number, sunDir: THREE.Vector3, heights: HeightTexture, shared: WorldUniforms) {
    this.geometry = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 16, 16);
    this.geometry.rotateX(-Math.PI / 2);
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: sunDir.clone() },
        uSunColor: { value: new THREE.Color(ENV.sunColor).multiplyScalar(ENV.sunIntensity) },
        uZenith: { value: new THREE.Color(ENV.skyZenith) },
        uHorizon: { value: new THREE.Color(ENV.skyHorizon) },
        uDeep: { value: new THREE.Color(ENV.waterDeep) },
        uShallow: { value: new THREE.Color(ENV.waterShallow) },
        uWaterLevel: { value: waterLevel },
        uHeightInfo: { value: heights.info },
      },
    ]);
    // Shared by reference (UniformsUtils.merge clones textures/values).
    uniforms.uTime = shared.uTime;
    uniforms.uHeightTex = { value: heights.texture };
    this.material = new THREE.ShaderMaterial({
      name: 'dz-water',
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: true,
      fog: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'water';
    this.mesh.position.y = waterLevel;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  update(camX: number, camZ: number): void {
    // Snap so the large triangles do not swim (shading is in world space anyway).
    this.mesh.position.x = Math.round(camX / 64) * 64;
    this.mesh.position.z = Math.round(camZ / 64) * 64;
    this.mesh.updateMatrix();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
