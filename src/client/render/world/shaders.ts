// Shared GLSL snippets and uniforms for the world materials.

import * as THREE from 'three';

/** Uniforms shared (by reference) between every animated world material. */
export interface WorldUniforms {
  uTime: THREE.IUniform<number>;
  /** Wind strength multiplier (gusts). */
  uWind: THREE.IUniform<number>;
}

export function createWorldUniforms(): WorldUniforms {
  return { uTime: { value: 0 }, uWind: { value: 1 } };
}

/** Hash + 2D value noise (sin-free, stable for world-space coordinates up to a few km). */
export const NOISE_GLSL = /* glsl */ `
float dzHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float dzNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dzHash12(i), dzHash12(i + vec2(1.0, 0.0)), u.x),
             mix(dzHash12(i + vec2(0.0, 1.0)), dzHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/**
 * Terrain heightfield sampling for custom shaders. Requires uniforms
 * uHeightTex (sampler2D, R = height in m), uHeightInfo (vec4: half, cell, res, outsideHeight).
 */
export const HEIGHT_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec4 uHeightInfo;
float dzTerrainHeight(vec2 xz) {
  float mapHalf = uHeightInfo.x;
  if (abs(xz.x) > mapHalf || abs(xz.y) > mapHalf) return uHeightInfo.w;
  vec2 uv = ((xz + mapHalf) / uHeightInfo.y + 0.5) / uHeightInfo.z;
  return texture2D(uHeightTex, uv).r;
}
`;

/** Replace an `#include <chunk>` in a shader, failing loudly during development if it is missing. */
export function patchShader(src: string, include: string, replacement: string): string {
  const token = `#include <${include}>`;
  if (!src.includes(token)) {
    throw new Error(`world shader patch: missing ${token}`);
  }
  return src.replace(token, replacement);
}
