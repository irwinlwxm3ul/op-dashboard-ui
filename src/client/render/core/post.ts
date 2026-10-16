// Final output pass: reads the linear HDR scene target, applies the renderer's tone mapping (ACES)
// and sRGB output conversion (three injects both into ShaderMaterial programs that render to the
// screen), optionally with FXAA computed on the display-referred colours. One full-screen triangle.

import * as THREE from 'three';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uInvRes;
varying vec2 vUv;

vec3 toDisplay(vec3 c) {
  #ifdef TONE_MAPPING
  c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
vec3 tapLdr(vec2 uv) { return toDisplay(texture2D(tDiffuse, uv).rgb); }

#ifdef USE_FXAA
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
vec3 fxaa(vec2 uv) {
  vec3 rgbM = tapLdr(uv);
  vec3 rgbNW = tapLdr(uv + vec2(-1.0, -1.0) * uInvRes);
  vec3 rgbNE = tapLdr(uv + vec2(1.0, -1.0) * uInvRes);
  vec3 rgbSW = tapLdr(uv + vec2(-1.0, 1.0) * uInvRes);
  vec3 rgbSE = tapLdr(uv + vec2(1.0, 1.0) * uInvRes);
  float lM = dot(rgbM, LUMA);
  float lNW = dot(rgbNW, LUMA);
  float lNE = dot(rgbNE, LUMA);
  float lSW = dot(rgbSW, LUMA);
  float lSE = dot(rgbSE, LUMA);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) return rgbM;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float dirReduce = max((lNW + lNE + lSW + lSE) * (0.25 / 8.0), 1.0 / 128.0);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uInvRes;
  vec3 rgbA = 0.5 * (tapLdr(uv + dir * (1.0 / 3.0 - 0.5)) + tapLdr(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 rgbB = rgbA * 0.5 + 0.25 * (tapLdr(uv - dir * 0.5) + tapLdr(uv + dir * 0.5));
  float lB = dot(rgbB, LUMA);
  return (lB < lMin || lB > lMax) ? rgbA : rgbB;
}
#endif

void main() {
  #ifdef USE_FXAA
  gl_FragColor = vec4(fxaa(vUv), 1.0);
  #else
  gl_FragColor = vec4(tapLdr(vUv), 1.0);
  #endif
}
`;

export class OutputPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private fxaa = false;

  constructor() {
    // Single oversized triangle covering the viewport.
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.material = new THREE.ShaderMaterial({
      name: 'dz-output',
      uniforms: {
        tDiffuse: { value: null },
        uInvRes: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });
    const quad = new THREE.Mesh(this.geometry, this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setFxaa(on: boolean): void {
    if (on === this.fxaa) return;
    this.fxaa = on;
    this.material.defines = on ? { USE_FXAA: '' } : {};
    this.material.needsUpdate = true;
  }

  setResolution(width: number, height: number): void {
    this.material.uniforms.uInvRes.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  /** Renders `source` to the canvas (render target must be null when called). */
  render(renderer: THREE.WebGLRenderer, source: THREE.Texture): void {
    this.material.uniforms.tDiffuse.value = source;
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
