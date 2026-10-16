// Loading of the curated world assets used by the world renderer: nature glTFs (trees, rocks,
// bushes, grass), the far-impostor atlas and the prop models. Everything resolves (never rejects):
// missing pieces come back null / absent and the renderer keeps its procedural fallback for them.
// Templates are cached by the shared asset loader; the atlas is cached here (one per app).

import * as THREE from 'three';
import type { TreeKind } from '../../../shared/types';
import { NATURE_MODELS, PROP_MODELS, loadModel, modelUrl, type GLTF, type WorldPropId } from '../../assets';
import { patchGrassMaterial, type GrassModelSet, type GrassVariant } from './grass';
import type { PropModelPart } from './props';
import type { WorldUniforms } from './shaders';
import { TREE_KINDS } from './vegetationModels';
import { meshesOf, wrapGeometry, type NatureGltfs } from './vegetationSets';

export interface LoadedWorldAssets {
  /** Null when any tree / rock / bush file failed (vegetation stays procedural). */
  nature: NatureGltfs | null;
  grass: GLTF | null;
  props: Map<WorldPropId, PropModelPart[]>;
}

let atlasPromise: Promise<THREE.Texture | null> | null = null;

function loadImpostorAtlas(): Promise<THREE.Texture | null> {
  atlasPromise ??= new Promise<THREE.Texture | null>((resolve) => {
    try {
      new THREE.TextureLoader().load(
        modelUrl(NATURE_MODELS.impostors.file),
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.wrapS = THREE.ClampToEdgeWrapping;
          t.wrapT = THREE.ClampToEdgeWrapping;
          t.anisotropy = 4;
          resolve(t);
        },
        undefined,
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
  return atlasPromise;
}

function partsOf(g: GLTF): PropModelPart[] {
  const out: PropModelPart[] = [];
  g.scene.updateMatrixWorld(true);
  g.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let geometry = m.geometry;
    // Props are authored in their file frame; bake any node transform so instances use it as is.
    if (!m.matrixWorld.equals(IDENTITY)) {
      geometry = m.geometry.clone();
      geometry.applyMatrix4(m.matrixWorld);
    }
    out.push({ geometry, material: Array.isArray(m.material) ? m.material[0] : m.material });
  });
  return out;
}
const IDENTITY = new THREE.Matrix4();

/** Loads every world asset (in parallel). */
export async function loadWorldAssets(): Promise<LoadedWorldAssets> {
  const treeFiles = TREE_KINDS.map((k) => NATURE_MODELS.trees[k].file);
  const propIds = Object.keys(PROP_MODELS) as WorldPropId[];
  const [trees, rocks, bushes, grass, atlas, props] = await Promise.all([
    Promise.all(treeFiles.map((f) => loadModel(f))),
    loadModel(NATURE_MODELS.rocks.file),
    loadModel(NATURE_MODELS.bushes.file),
    loadModel(NATURE_MODELS.grass.file),
    loadImpostorAtlas(),
    Promise.all(propIds.map((id) => loadModel(PROP_MODELS[id].file))),
  ]);
  let nature: NatureGltfs | null = null;
  if (trees.every((t) => t) && rocks && bushes) {
    const byKind = {} as Record<TreeKind, GLTF>;
    TREE_KINDS.forEach((k, i) => {
      byKind[k] = trees[i]!;
    });
    nature = { trees: byKind, rocks, bushes, impostorAtlas: atlas };
  }
  const propParts = new Map<WorldPropId, PropModelPart[]>();
  propIds.forEach((id, i) => {
    const g = props[i];
    if (!g) return;
    const parts = partsOf(g);
    if (parts.length) propParts.set(id, parts);
  });
  return { nature, grass, props: propParts };
}

/** Grass tufts from grass.glb (null when its nodes are missing). */
export function assetGrassSet(g: GLTF, shared: WorldUniforms, fade: { value: THREE.Vector2 }): GrassModelSet | null {
  const geometries: THREE.BufferGeometry[] = [];
  const materials = new Map<THREE.Material, THREE.Material>();
  const variants: GrassVariant[] = [];
  for (const v of NATURE_MODELS.grass.variants) {
    const mesh = meshesOf(g.scene, v.node)[0];
    if (!mesh) continue;
    const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    let mat = materials.get(src);
    if (!mat) {
      mat = src.clone();
      patchGrassMaterial(mat, shared, fade, `asset-${materials.size}`);
      materials.set(src, mat);
    }
    const geometry = wrapGeometry(mesh.geometry);
    geometries.push(geometry);
    // Wide clumps (1.2-1.5 m at unit height) stay low; the narrow tuft can be a bit taller.
    const narrow = v.width < 1;
    // The narrow MegaKit tuft is a brighter lime than the Ultimate Nature clumps.
    variants.push({
      geometry, material: mat, scaleMin: narrow ? 0.4 : 0.32, scaleMax: narrow ? 0.72 : 0.58, tint: 'relative',
      multiply: narrow ? [0.66, 0.72, 0.55] : [1.05, 1.08, 1.0],
    });
  }
  if (variants.length === 0) return null;
  return {
    variants,
    densityScale: 0.45,
    alphaTested: [...materials.values()],
    dispose() {
      for (const geo of geometries) geo.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}
