// Gradient sky dome with sun disc/glow and slow drifting procedural clouds. Drawn first each frame
// (no depth test / write) centred on the camera. Its horizon blends into the scene fog colour through
// the same fog uniform three.js feeds the regular materials, so terrain fading into haze meets the
// sky seamlessly in every render path.

import * as THREE from 'three';
import { ENV } from './environment';

const SKY_RADIUS = 1500;

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(position, 1.0));
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uTime;
uniform vec3 fogColor;
varying vec3 vDir;

float skyHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float skyNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), u.x),
             mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float skyFbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * skyNoise(p);
    p = p * 2.07 + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float up = clamp(y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.55));

  float mu = clamp(dot(d, uSunDir), 0.0, 1.0);
  col += uSunColor * (0.10 * pow(mu, 5.0) + 0.30 * pow(mu, 42.0));

  if (y > 0.0) {
    vec2 cp = d.xz / (y + 0.09) * 1.35 + vec2(uTime * 0.0045, uTime * 0.0018);
    float c = skyFbm(cp);
    float cover = smoothstep(0.50, 0.80, c) * smoothstep(0.02, 0.16, y);
    float lit = 0.80 + 0.30 * mu + 0.30 * (c - 0.5);
    vec3 cloud = mix(uHorizon, vec3(1.0), 0.65) * lit;
    col = mix(col, cloud, cover * 0.85);
  }

  float disc = smoothstep(0.99955, 0.99978, mu);
  col += uSunColor * disc * 22.0;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  float haze = 1.0 - smoothstep(-0.02, 0.2, y);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, haze);
}
`;

export interface SkyDome {
  readonly mesh: THREE.Mesh;
  update(cameraWorldPos: THREE.Vector3, time: number): void;
  dispose(): void;
}

export function createSkyDome(sunDir: THREE.Vector3): SkyDome {
  const geometry = new THREE.SphereGeometry(1, 48, 24);
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uSunDir: { value: sunDir.clone() },
      uZenith: { value: new THREE.Color(ENV.skyZenith) },
      uHorizon: { value: new THREE.Color(ENV.skyHorizon) },
      uSunColor: { value: new THREE.Color(ENV.sunColor) },
      uTime: { value: 0 },
    },
  ]);
  const material = new THREE.ShaderMaterial({
    name: 'dz-sky',
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.scale.setScalar(SKY_RADIUS);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1_000_000;
  mesh.matrixAutoUpdate = false;

  return {
    mesh,
    update(cameraWorldPos, time) {
      mesh.position.copy(cameraWorldPos);
      mesh.updateMatrix();
      uniforms.uTime.value = time;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
