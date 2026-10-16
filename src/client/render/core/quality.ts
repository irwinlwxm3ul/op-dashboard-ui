// Quality presets shared by the render core (resolution, AA, shadows) and the world renderer
// (LOD distances, vegetation density, grass). Medium is the PLAN.md performance reference
// (60 FPS on an Iris Xe class integrated GPU at 1080p).

import type { Quality } from '../../game/types';

export interface VegetationProfile {
  /** Near band (full low-poly models) ends here (m). */
  near: number;
  /** Mid band (simplified models) ends here (m). */
  mid: number;
  /** Far band (cross-quad impostors) ends here (m); beyond it vegetation is culled. */
  far: number;
  /** 0..1 fraction of small far-band objects (bushes, small rocks) that are kept. */
  density: number;
  /** Model variants used per tree kind / for rocks / for bushes (each costs draw calls per band). */
  treeVariants: number;
  rockVariants: number;
  bushVariants: number;
  /** Bushes cast sun shadows (near band). */
  bushShadows: boolean;
}

export interface GrassProfile {
  enabled: boolean;
  /** Radius around the camera covered by grass tufts (m). */
  radius: number;
  /** Tufts per square meter on grass surfaces. */
  density: number;
}

export interface QualityProfile {
  readonly name: Quality;
  /** Upper bound applied to window.devicePixelRatio before the user's render scale. */
  readonly maxDevicePixelRatio: number;
  /** Preset resolution multiplier (combined with the user's renderScale). */
  readonly resolutionScale: number;
  /** MSAA samples of the HDR scene target (0 = off). */
  readonly msaaSamples: number;
  /** FXAA in the output pass (used where MSAA is off but some AA is affordable). */
  readonly fxaa: boolean;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  /** Side length (m) of the square area around the camera covered by the sun shadow map. */
  readonly shadowExtent: number;
  readonly anisotropy: number;
  /** Terrain chunk LOD switch distances (LOD0 -> LOD1, LOD1 -> LOD2). */
  readonly terrainLod: readonly [number, number];
  readonly vegetation: Readonly<VegetationProfile>;
  readonly grass: Readonly<GrassProfile>;
  /** Buildings closer than this use the full merged mesh, beyond it the exterior shell. */
  readonly buildingDetailDistance: number;
  /** Props (crates, barriers, fences, containers) closer than this use their 3D models, beyond it boxes. */
  readonly propModelDistance: number;
}

export const QUALITY_PROFILES: Readonly<Record<Quality, QualityProfile>> = {
  low: {
    name: 'low',
    maxDevicePixelRatio: 1,
    resolutionScale: 0.85,
    msaaSamples: 0,
    fxaa: false,
    shadows: false,
    shadowMapSize: 0,
    shadowExtent: 0,
    anisotropy: 1,
    terrainLod: [150, 330],
    vegetation: { near: 95, mid: 320, far: 700, density: 0.45, treeVariants: 1, rockVariants: 2, bushVariants: 1, bushShadows: false },
    grass: { enabled: false, radius: 0, density: 0 },
    buildingDetailDistance: 150,
    propModelDistance: 90,
  },
  medium: {
    name: 'medium',
    maxDevicePixelRatio: 1.25,
    resolutionScale: 1,
    msaaSamples: 0,
    fxaa: true,
    shadows: true,
    shadowMapSize: 1024,
    shadowExtent: 100,
    anisotropy: 4,
    terrainLod: [200, 430],
    vegetation: { near: 150, mid: 450, far: 900, density: 0.8, treeVariants: 2, rockVariants: 2, bushVariants: 2, bushShadows: false },
    grass: { enabled: false, radius: 0, density: 0 },
    buildingDetailDistance: 220,
    propModelDistance: 140,
  },
  high: {
    name: 'high',
    maxDevicePixelRatio: 1.5,
    resolutionScale: 1,
    msaaSamples: 4,
    fxaa: false,
    shadows: true,
    shadowMapSize: 2048,
    shadowExtent: 140,
    anisotropy: 8,
    terrainLod: [260, 540],
    vegetation: { near: 175, mid: 500, far: 950, density: 1, treeVariants: 3, rockVariants: 4, bushVariants: 3, bushShadows: true },
    grass: { enabled: true, radius: 45, density: 1.8 },
    buildingDetailDistance: 270,
    propModelDistance: 190,
  },
  ultra: {
    name: 'ultra',
    maxDevicePixelRatio: 2,
    resolutionScale: 1,
    msaaSamples: 4,
    fxaa: false,
    shadows: true,
    shadowMapSize: 4096,
    shadowExtent: 190,
    anisotropy: 16,
    terrainLod: [340, 680],
    vegetation: { near: 210, mid: 580, far: 1000, density: 1, treeVariants: 5, rockVariants: 6, bushVariants: 3, bushShadows: true },
    grass: { enabled: true, radius: 55, density: 2.6 },
    buildingDetailDistance: 340,
    propModelDistance: 250,
  },
};

/** Hard cap on the final pixel ratio (spec: devicePixelRatio x renderScale capped at 2). */
export const MAX_PIXEL_RATIO = 2;

export function qualityProfile(q: Quality): QualityProfile {
  return QUALITY_PROFILES[q] ?? QUALITY_PROFILES.medium;
}

/** Final renderer pixel ratio for a preset, the device pixel ratio and the user's render scale. */
export function computePixelRatio(profile: QualityProfile, devicePixelRatio: number, renderScale: number): number {
  const dpr = Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, profile.maxDevicePixelRatio);
  const scale = Number.isFinite(renderScale) && renderScale > 0 ? renderScale : 1;
  return Math.min(MAX_PIXEL_RATIO, Math.max(0.25, dpr * profile.resolutionScale * scale));
}
