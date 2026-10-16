// Terrain heights as a half-float texture for shaders that need the ground height at arbitrary
// world positions (water depth tint / shore foam, blue-zone wall ground glow).

import * as THREE from 'three';
import type { HeightFieldData } from './terrainData';

export interface HeightTexture {
  texture: THREE.DataTexture;
  /** (half, cell, res, height used outside the map) -> `uHeightInfo` uniform. */
  info: THREE.Vector4;
  dispose(): void;
}

/** Height reported outside the heightmap (open sea floor). */
export const OUTSIDE_HEIGHT = -40;

export function createHeightTexture(f: HeightFieldData): HeightTexture {
  const n = f.res * f.res;
  const data = new Uint16Array(n);
  for (let k = 0; k < n; k++) data[k] = THREE.DataUtils.toHalfFloat(f.heights[k]);
  const texture = new THREE.DataTexture(data, f.res, f.res, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return {
    texture,
    info: new THREE.Vector4(f.half, f.cell, f.res, OUTSIDE_HEIGHT),
    dispose: () => texture.dispose(),
  };
}
