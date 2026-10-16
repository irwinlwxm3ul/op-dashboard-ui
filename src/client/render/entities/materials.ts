// Character / entity materials: MeshLambertMaterial with vertex colours, patched via
// onBeforeCompile with
//   * per-part masks (team accent / skin / fatigue tint) driven by uniforms or per-instance attributes,
//   * a fresnel rim light that gets stronger with distance (silhouettes pop against foliage),
//   * a screen-door dither fade (LOD crossfades and death fade-out without transparency sorting),
//   * the local team's outline: a strong team-colour fresnel edge (uniform `uOutline` or the
//     per-instance `iOutline`), optionally also pushing accent-masked parts toward the team colour
//     (far impostors),
//   * a reduced fog factor so players and vehicles stay readable beyond the terrain haze.
//
// Dither code convention (see lod.ts): code > 0 keeps pixels whose noise < code; code < 0 keeps
// pixels whose noise >= 1 + code; 0 hides everything.

import * as THREE from 'three';

export interface EntityMaterialOptions {
  /** Use per-part masks (`aMask` attribute). */
  mask?: boolean;
  /** Per-instance attributes `iAccent` (vec3) and `iFade` (float) instead of uniforms. */
  instanced?: boolean;
  /** Dither fade support (uniform `uFade` or attribute `iFade`). */
  dither?: boolean;
  /** Fresnel rim light. */
  rim?: boolean;
  /** Fog multiplier; 0 disables fog entirely (far impostors). */
  fogScale?: number;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  /**
   * Outlined (local-team) bodies: accent mask weight of masked parts raised to at least this
   * (0..1; far impostors render mostly in the team colour). Omitted = edge outline only.
   */
  outlineMask?: number;
}

export interface EntityUniforms {
  uAccent: { value: THREE.Color };
  uSkin: { value: THREE.Color };
  uCloth: { value: THREE.Color };
  uFade: { value: number };
  uFogScale: { value: number };
  /** Local-team outline weight (0..1) for non-instanced drawables. */
  uOutline: { value: number };
}

/** Team outline: edge strength, edge exponent (lower = wider), minimum edge brightness. */
export const OUTLINE = {
  params: { value: new THREE.Vector4(1.3, 2.4, 0.12, 0) },
};

/** Rim parameters shared by every entity material (tunable in one place). */
export const RIM = {
  color: { value: new THREE.Color(0xdfe8ff) },
  /** near strength, far strength, near distance (m), far distance (m) */
  params: { value: new THREE.Vector4(0.22, 0.6, 20, 320) },
};

const VERT_PARS = /* glsl */ `
#ifdef ENT_MASK
attribute vec3 aMask;
varying vec3 vMask;
#endif
#ifdef ENT_INSTANCED
attribute vec3 iAccent;
attribute vec3 iCloth;
attribute float iFade;
attribute float iOutline;
varying vec3 vAccent;
varying vec3 vCloth;
varying float vFade;
varying float vOutline;
#endif
`;

const VERT_MAIN = /* glsl */ `
#ifdef ENT_MASK
vMask = aMask;
#endif
#ifdef ENT_INSTANCED
vAccent = iAccent;
vCloth = iCloth;
vFade = iFade;
vOutline = iOutline;
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uSkin;
uniform vec3 uCloth;
uniform float uFade;
uniform float uFogScale;
uniform vec3 uRimColor;
uniform vec4 uRimParams;
uniform float uOutline;
uniform vec4 uOutlineParams;
#ifdef ENT_MASK
varying vec3 vMask;
#endif
#ifdef ENT_INSTANCED
varying vec3 vAccent;
varying vec3 vCloth;
varying float vFade;
varying float vOutline;
#endif
float entIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

const FRAG_DITHER = /* glsl */ `
#ifdef ENT_DITHER
{
#ifdef ENT_INSTANCED
  float entFade = vFade;
#else
  float entFade = uFade;
#endif
  if (entFade < 0.999 && entFade > -0.999) {
    float n = entIgn(gl_FragCoord.xy);
    if (entFade >= 0.0) { if (n >= entFade) discard; }
    else { if (n < 1.0 + entFade) discard; }
  }
}
#endif
`;

const FRAG_MASK = /* glsl */ `
#ifdef ENT_MASK
{
#ifdef ENT_INSTANCED
  vec3 entAccent = vAccent;
  vec3 entCloth = vCloth;
#else
  vec3 entAccent = uAccent;
  vec3 entCloth = uCloth;
#endif
  float entAccentW = vMask.x;
#ifdef ENT_OUTLINE_MASK
#ifdef ENT_INSTANCED
  float entOutlineM = vOutline;
#else
  float entOutlineM = uOutline;
#endif
  if (vMask.x > 0.0) entAccentW = mix(vMask.x, max(vMask.x, ENT_OUTLINE_MASK), entOutlineM);
#endif
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * entCloth, vMask.z);
  diffuseColor.rgb = mix(diffuseColor.rgb, uSkin, vMask.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, entAccent, entAccentW);
}
#endif
`;

const FRAG_RIM = /* glsl */ `
#ifdef ENT_RIM
{
  vec3 entView = normalize(vViewPosition);
  float entNdv = clamp(abs(dot(normal, entView)), 0.0, 1.0);
  float entDist = smoothstep(uRimParams.z, uRimParams.w, length(vViewPosition));
  float entRim = pow(1.0 - entNdv, 2.6) * mix(uRimParams.x, uRimParams.y, entDist);
  outgoingLight += uRimColor * entRim * (0.5 + 0.5 * diffuseColor.rgb);
#ifdef ENT_INSTANCED
  float entOutline = vOutline;
  vec3 entOutlineColor = vAccent;
#else
  float entOutline = uOutline;
  vec3 entOutlineColor = uAccent;
#endif
  if (entOutline > 0.0) {
    // Local team: a bright team-colour edge around the silhouette.
    float entEdge = pow(1.0 - entNdv, uOutlineParams.y);
    outgoingLight = mix(outgoingLight, entOutlineColor * (uOutlineParams.z + uOutlineParams.x * entEdge), entOutline * min(1.0, entEdge * 1.4));
  }
}
#endif
`;

const FRAG_FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * uFogScale );
#endif
`;

/** Fresh uniform set (one per drawable that needs its own colours / fade). */
export function createEntityUniforms(fogScale = 0.35): EntityUniforms {
  return {
    uAccent: { value: new THREE.Color(0xffffff) },
    uSkin: { value: new THREE.Color(0xc99a74) },
    uCloth: { value: new THREE.Color(0x6b7347) },
    uFade: { value: 1 },
    uFogScale: { value: fogScale },
    uOutline: { value: 0 },
  };
}

/**
 * Patch any built-in lit material (Lambert / Standard / Physical, e.g. materials loaded from glTF)
 * with the entity shader features. Several materials may share one `uniforms` object (one fade /
 * accent for every mesh of a character). Existing material defines are preserved.
 */
export function applyEntityShader(mat: THREE.Material, opts: EntityMaterialOptions, uniforms: EntityUniforms): void {
  const defines: Record<string, unknown> = { ...(mat.defines ?? {}) };
  if (opts.mask) defines.ENT_MASK = '';
  if (opts.instanced) defines.ENT_INSTANCED = '';
  if (opts.dither) defines.ENT_DITHER = '';
  if (opts.rim) defines.ENT_RIM = '';
  if (opts.outlineMask !== undefined) defines.ENT_OUTLINE_MASK = opts.outlineMask.toFixed(3);
  mat.defines = defines;
  mat.userData.uniforms = uniforms;
  const key = 'dz-ent:' + mat.type + ':' + Object.keys(defines).sort().map((k) => k + '=' + String(defines[k])).join(',');
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAccent = uniforms.uAccent;
    shader.uniforms.uSkin = uniforms.uSkin;
    shader.uniforms.uCloth = uniforms.uCloth;
    shader.uniforms.uFade = uniforms.uFade;
    shader.uniforms.uFogScale = uniforms.uFogScale;
    shader.uniforms.uRimColor = RIM.color;
    shader.uniforms.uRimParams = RIM.params;
    shader.uniforms.uOutline = uniforms.uOutline;
    shader.uniforms.uOutlineParams = OUTLINE.params;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <color_vertex>', `#include <color_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', `${FRAG_DITHER}\n#include <clipping_planes_fragment>`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_MASK}`)
      .replace('#include <opaque_fragment>', `${FRAG_RIM}\n#include <opaque_fragment>`)
      .replace('#include <fog_fragment>', FRAG_FOG);
  };
  mat.needsUpdate = true;
}

/** Create an entity material. Each call returns an independent material with its own uniforms. */
export function createEntityMaterial(opts: EntityMaterialOptions = {}): THREE.MeshLambertMaterial & { userData: { uniforms: EntityUniforms } } {
  const fogScale = opts.fogScale ?? 0.35;
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: opts.side ?? THREE.FrontSide,
    fog: fogScale > 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
  const uniforms = createEntityUniforms(fogScale);
  applyEntityShader(mat, opts, uniforms);
  return mat as THREE.MeshLambertMaterial & { userData: { uniforms: EntityUniforms } };
}

export interface InstanceAttributes {
  accent: THREE.InstancedBufferAttribute;
  cloth: THREE.InstancedBufferAttribute;
  fade: THREE.InstancedBufferAttribute;
  outline: THREE.InstancedBufferAttribute;
}

/** Add per-instance `iAccent` / `iCloth` / `iFade` / `iOutline` attributes to an instanced geometry. */
export function addInstanceAttributes(geo: THREE.BufferGeometry, capacity: number): InstanceAttributes {
  const accent = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  const cloth = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  const fade = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
  const outline = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  accent.setUsage(THREE.DynamicDrawUsage);
  cloth.setUsage(THREE.DynamicDrawUsage);
  fade.setUsage(THREE.DynamicDrawUsage);
  outline.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iAccent', accent);
  geo.setAttribute('iCloth', cloth);
  geo.setAttribute('iFade', fade);
  geo.setAttribute('iOutline', outline);
  return { accent, cloth, fade, outline };
}

// ---------------------------------------------------------------------------
// Shadow-pass depth materials (one per caster kind, so three's shared default depth material is
// not re-resolved between skinned / batched / instanced programs every frame)
// ---------------------------------------------------------------------------

export type DepthCasterKind = 'skinned' | 'batched' | 'instanced';

const depthMaterials = new Map<DepthCasterKind, THREE.MeshDepthMaterial>();

/** Shared depth material for one kind of shadow caster (assign as `customDepthMaterial`). */
export function casterDepthMaterial(kind: DepthCasterKind): THREE.MeshDepthMaterial {
  let m = depthMaterials.get(kind);
  if (!m) {
    m = new THREE.MeshDepthMaterial();
    m.name = 'dz-depth-' + kind;
    depthMaterials.set(kind, m);
  }
  return m;
}

/** Dispose the shared caster depth materials (renderer teardown). */
export function disposeCasterDepthMaterials(): void {
  for (const m of depthMaterials.values()) m.dispose();
  depthMaterials.clear();
}
