// Vegetation model sets: what the instanced vegetation system draws per species, variant and LOD
// band. Two producers share one shape:
//  * proceduralVegetationSet() - the built-in low-poly models (always available, used while the
//    asset files load and whenever they fail);
//  * assetVegetationSet()      - the curated glTF trees / rocks / bushes (NATURE_MODELS) with
//    textured, alpha-tested materials, patched for wind sway and per-instance trunk radius.
// Each band is a list of parts (one InstancedMesh each, sharing instance buffers), e.g. bark +
// leaves for a tree variant.

import * as THREE from 'three';
import type { TreeKind } from '../../../shared/types';
import type { GLTF } from '../../assets';
import { NATURE_MODELS } from '../../assets';
import { IMPOSTOR_CELLS, BUSH_IMPOSTOR_H, BUSH_IMPOSTOR_W, IMPOSTOR_WIDTH, TREE_KINDS, UNIT_TRUNK_RADIUS, buildBushModels, buildRockModel, buildTreeModels, createImpostorAtlas } from './vegetationModels';
import { patchShader, type WorldUniforms } from './shaders';

export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Shadow depth material (wind / trunk / alpha aware), null = three's default. */
  depth: THREE.Material | null;
  /** Part casts shadows when its band does (alpha cards on bushes may opt out). */
  castShadow: boolean;
}

export interface BandModel {
  parts: ModelPart[];
}

export interface SpeciesVariant {
  near: BandModel;
  mid: BandModel;
  /** Trunk base radius in unit model space (trees; aTrunk = r / (trunkRadius * horizontal scale)). */
  trunkRadius: number;
  /** Colour multiplier applied to every instance of this variant (palette matching). */
  tint?: readonly [number, number, number];
}

export type SpeciesGroup = 'tree' | 'bush' | 'rock';

export interface VegetationModelSet {
  readonly kind: 'procedural' | 'assets';
  /** Multipliers on the quality profile's near / mid band distances per species group. */
  bandScale: Record<SpeciesGroup, readonly [number, number]>;
  /**
   * Instance budgets per group at budgetScale 1: at most [near, mid] instances use the near / mid
   * models (the nearest ones), the rest drop to the next band - bounds triangles in dense forests.
   */
  budget: Record<SpeciesGroup, readonly [number, number]>;
  trees: Record<TreeKind, SpeciesVariant[]>;
  bushes: SpeciesVariant[];
  rocks: SpeciesVariant[];
  impostorMaterial: THREE.MeshStandardMaterial;
  /** Impostor quad width / tree height per kind, and the bush impostor size at scale 1 (m). */
  impostorWidth: Record<TreeKind, number>;
  bushImpostor: { w: number; h: number };
  /** Materials whose alpha-to-coverage / anisotropy follow the quality preset. */
  alphaTested: THREE.Material[];
  textures: THREE.Texture[];
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Shader patches
// ---------------------------------------------------------------------------------------------

export interface FoliageOptions {
  /** Scale trunk vertices (attribute `trunk`) by the per-instance `aTrunk`. */
  trunk: boolean;
  /** Constant wrap-ambient term (foliage translucency stand-in), 0 = off. */
  wrap: number;
}

/** Wind sway (+ optional trunk scaling, wrap lighting) on a material using attributes `sway` / `trunk`. */
export function patchFoliage(mat: THREE.Material, shared: WorldUniforms, opts: FoliageOptions, depth: boolean): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    const head =
      'attribute float sway;\nuniform float uTime;\nuniform float uWind;\n' +
      (opts.trunk ? 'attribute float trunk;\nattribute float aTrunk;\n' : '');
    shader.vertexShader =
      head +
      patchShader(
        shader.vertexShader,
        'begin_vertex',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 dzInst = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 dzInst = vec3(0.0);
#endif
${opts.trunk ? 'transformed.xz *= mix(1.0, aTrunk, trunk);' : ''}
float dzPh = uTime * 1.6 + dzInst.x * 0.051 + dzInst.z * 0.073;
float dzS = sway * sway * uWind;
transformed.x += (sin(dzPh) + 0.45 * sin(dzPh * 2.3 + 1.7)) * dzS * 0.016;
transformed.z += (cos(dzPh * 0.83 + 0.4) + 0.35 * sin(dzPh * 3.1)) * dzS * 0.011;
transformed += normal * (sin(uTime * 5.5 + (position.x + position.z) * 37.0 + dzInst.x) * 0.004 * dzS);`,
      );
    if (!depth && opts.wrap > 0) {
      shader.fragmentShader = patchShader(
        shader.fragmentShader,
        'lights_fragment_end',
        `#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * ${opts.wrap.toFixed(3)};`,
      );
    }
  };
  mat.customProgramCacheKey = () => `dz-foliage-${opts.trunk ? 1 : 0}-${opts.wrap.toFixed(2)}-${depth ? 1 : 0}-v3`;
}

/** Depth material for shadows that runs the same vertex animation (and alpha test for cards). */
export function foliageDepthMaterial(shared: WorldUniforms, opts: FoliageOptions, alphaFrom: THREE.Material | null): THREE.MeshDepthMaterial {
  const src = alphaFrom as THREE.MeshStandardMaterial | null;
  const m = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: src?.map ?? null,
    alphaTest: src?.alphaTest ?? 0,
  });
  m.name = 'dz-foliage-depth';
  patchFoliage(m, shared, { trunk: opts.trunk, wrap: 0 }, true);
  return m;
}

/** Far impostor material: atlas cell per instance (`aCell`), alpha tested. */
export function createImpostorMaterial(atlas: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'dz-impostor',
    map: atlas,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    alphaTest: 0.42,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float aCell;\n' +
      patchShader(
        shader.vertexShader,
        'uv_vertex',
        `#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv.x = (vMapUv.x + aCell) * ${(1 / IMPOSTOR_CELLS).toFixed(6)};\n#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'dz-impostor-v1';
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Procedural set
// ---------------------------------------------------------------------------------------------

export function proceduralVegetationSet(shared: WorldUniforms): VegetationModelSet {
  const geometries: THREE.BufferGeometry[] = [];
  const treeMat = new THREE.MeshStandardMaterial({ name: 'dz-tree', vertexColors: true, roughness: 0.88, metalness: 0 });
  patchFoliage(treeMat, shared, { trunk: true, wrap: 0.3 }, false);
  const treeDepth = foliageDepthMaterial(shared, { trunk: true, wrap: 0 }, null);
  const bushMat = new THREE.MeshStandardMaterial({ name: 'dz-bush', vertexColors: true, roughness: 0.88, metalness: 0 });
  patchFoliage(bushMat, shared, { trunk: false, wrap: 0.3 }, false);
  const bushDepth = foliageDepthMaterial(shared, { trunk: false, wrap: 0 }, null);
  const rockMat = new THREE.MeshStandardMaterial({ name: 'dz-rock', vertexColors: true, roughness: 0.94, metalness: 0 });
  const atlas = createImpostorAtlas();
  const impostorMaterial = createImpostorMaterial(atlas);
  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, depth: THREE.Material | null): BandModel => {
    geometries.push(geometry);
    return { parts: [{ geometry, material, depth, castShadow: true }] };
  };
  const trees = {} as Record<TreeKind, SpeciesVariant[]>;
  for (const kind of TREE_KINDS) {
    const m = buildTreeModels(kind);
    trees[kind] = [{ near: part(m.near, treeMat, treeDepth), mid: part(m.mid, treeMat, treeDepth), trunkRadius: UNIT_TRUNK_RADIUS }];
  }
  const b = buildBushModels();
  const bushes: SpeciesVariant[] = [{ near: part(b.near, bushMat, bushDepth), mid: part(b.mid, bushMat, bushDepth), trunkRadius: 1 }];
  const rocks: SpeciesVariant[] = [];
  for (let v = 0; v < 4; v++) {
    rocks.push({ near: part(buildRockModel(v, 1), rockMat, null), mid: part(buildRockModel(v, 0), rockMat, null), trunkRadius: 1 });
  }
  const materials: THREE.Material[] = [treeMat, treeDepth, bushMat, bushDepth, rockMat, impostorMaterial];
  return {
    kind: 'procedural',
    // Cheap models: distances from the profile, effectively unlimited budgets.
    bandScale: { tree: [1, 1], bush: [1, 1], rock: [1, 1] },
    budget: { tree: [1e6, 1e6], bush: [1e6, 1e6], rock: [1e6, 1e6] },
    trees,
    bushes,
    rocks,
    impostorMaterial,
    impostorWidth: { ...IMPOSTOR_WIDTH },
    bushImpostor: { w: BUSH_IMPOSTOR_W, h: BUSH_IMPOSTOR_H },
    alphaTested: [impostorMaterial],
    textures: atlas ? [atlas] : [],
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      atlas?.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Asset set (glTF)
// ---------------------------------------------------------------------------------------------

export interface NatureGltfs {
  trees: Record<TreeKind, GLTF>;
  rocks: GLTF;
  bushes: GLTF;
  impostorAtlas: THREE.Texture | null;
}

/** Meshes under a named node (the node itself may be the mesh). */
export function meshesOf(root: THREE.Object3D, name: string): THREE.Mesh[] {
  const node = root.getObjectByName(name);
  const out: THREE.Mesh[] = [];
  node?.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

/**
 * A new geometry referencing the template's attribute buffers (no copy) with renamed attributes
 * (`_sway` -> `sway`, `_trunk` -> `trunk`), so per-slot instanced attributes can be added
 * without touching the shared glTF template.
 */
export function wrapGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const { sway, trunk } = NATURE_MODELS.attributes;
  for (const [name, attr] of Object.entries(src.attributes)) {
    const target = name === sway ? 'sway' : name === trunk ? 'trunk' : name;
    g.setAttribute(target, attr);
  }
  if (src.index) g.setIndex(src.index);
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.boundingBox = src.boundingBox?.clone() ?? null;
  g.boundingSphere = src.boundingSphere?.clone() ?? null;
  return g;
}

function firstMaterial(m: THREE.Mesh): THREE.Material {
  return Array.isArray(m.material) ? m.material[0] : m.material;
}

/**
 * Builds the glTF vegetation set. Returns null when a required node is missing (the caller then
 * keeps the procedural set).
 */
export function assetVegetationSet(src: NatureGltfs, shared: WorldUniforms): VegetationModelSet | null {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const alphaTested: THREE.Material[] = [];
  let ownAtlas: THREE.CanvasTexture | null = null;
  // One patched clone per source material (all variants / LODs of a kind share them).
  const patched = new Map<THREE.Material, { mat: THREE.Material; depth: THREE.Material | null }>();
  const patch = (srcMat: THREE.Material, opts: FoliageOptions, foliage: boolean): { mat: THREE.Material; depth: THREE.Material | null } => {
    let hit = patched.get(srcMat);
    if (hit) return hit;
    const mat = srcMat.clone();
    const alpha = (mat as THREE.MeshStandardMaterial).alphaTest > 0;
    let depth: THREE.Material | null = null;
    if (foliage) {
      patchFoliage(mat, shared, opts, false);
      depth = foliageDepthMaterial(shared, opts, alpha ? mat : null);
      materials.push(depth);
    }
    if (alpha) alphaTested.push(mat);
    materials.push(mat);
    hit = { mat, depth };
    patched.set(srcMat, hit);
    return hit;
  };
  const band = (root: THREE.Object3D, node: string, opts: FoliageOptions | null, castLeaves: boolean): BandModel | null => {
    const meshes = meshesOf(root, node);
    if (meshes.length === 0) return null;
    const parts: ModelPart[] = meshes.map((m) => {
      const { mat, depth } = opts ? patch(firstMaterial(m), opts, true) : patch(firstMaterial(m), { trunk: false, wrap: 0 }, false);
      const geometry = wrapGeometry(m.geometry);
      geometries.push(geometry);
      const isCard = (mat as THREE.MeshStandardMaterial).alphaTest > 0;
      return { geometry, material: mat, depth, castShadow: castLeaves || !isCard };
    });
    return { parts };
  };

  const trees = {} as Record<TreeKind, SpeciesVariant[]>;
  for (const kind of TREE_KINDS) {
    const def = NATURE_MODELS.trees[kind];
    const root = src.trees[kind].scene;
    const variants: SpeciesVariant[] = [];
    for (const v of def.variants) {
      const near = band(root, v.node, { trunk: true, wrap: 0.25 }, true);
      const mid = band(root, v.lod1Node, { trunk: true, wrap: 0.25 }, true);
      if (near && mid) variants.push({ near, mid, trunkRadius: v.trunkRadius });
    }
    if (variants.length === 0) {
      disposeAll();
      return null;
    }
    trees[kind] = variants;
  }
  const bushes: SpeciesVariant[] = [];
  for (const v of NATURE_MODELS.bushes.variants) {
    const near = band(src.bushes.scene, v.node, { trunk: false, wrap: 0.3 }, true);
    const mid = band(src.bushes.scene, v.lod1Node ?? v.node, { trunk: false, wrap: 0.3 }, true);
    // The Ultimate Stylized Nature bushes are a saturated lime: pull them toward the muted palette.
    const lime = v.material !== NATURE_MODELS.bushes.variants[0].material;
    if (near && mid) bushes.push({ near, mid, trunkRadius: 1, tint: lime ? [0.62, 0.66, 0.5] : undefined });
  }
  const rocks: SpeciesVariant[] = [];
  for (const v of NATURE_MODELS.rocks.variants) {
    const near = band(src.rocks.scene, v.node, null, true);
    const mid = band(src.rocks.scene, v.lod1Node ?? v.node, null, true);
    if (near && mid) rocks.push({ near, mid, trunkRadius: 1 });
  }
  if (bushes.length === 0 || rocks.length === 0) {
    disposeAll();
    return null;
  }
  // The PNG atlas is shared app-wide (never disposed here); without it use an owned canvas atlas.
  ownAtlas = src.impostorAtlas ? null : createImpostorAtlas();
  const atlas = src.impostorAtlas ?? ownAtlas;
  const impostorMaterial = createImpostorMaterial(atlas);
  materials.push(impostorMaterial);
  alphaTested.push(impostorMaterial);
  const wr = NATURE_MODELS.impostors.widthRatio;
  return {
    kind: 'assets',
    // LOD0 trees are ~2 000 tris, LOD1 ~650: full models only close up, impostors take over early;
    // budgets keep dense forests bounded (~300 k tris for trees at medium).
    bandScale: { tree: [0.5, 0.5], bush: [0.25, 0.25], rock: [0.4, 1] },
    budget: { tree: [80, 300], bush: [40, 150], rock: [60, 260] },
    trees,
    bushes,
    rocks,
    impostorMaterial,
    impostorWidth: { pine: wr.pine, oak: wr.oak, birch: wr.birch, dead: wr.dead },
    bushImpostor: { w: wr.bush, h: NATURE_MODELS.impostors.bushHeight },
    alphaTested,
    textures: collectTextures(materials),
    dispose: disposeAll,
  };

  function disposeAll(): void {
    // Wrapper geometries only reference the shared template buffers; disposing them just frees
    // GPU copies, which are re-uploaded if the templates are used again.
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    ownAtlas?.dispose();
  }
}

function collectTextures(materials: readonly THREE.Material[]): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  for (const m of materials) {
    const sm = m as THREE.MeshStandardMaterial;
    for (const t of [sm.map, sm.normalMap, sm.roughnessMap, sm.metalnessMap, sm.alphaMap]) if (t) out.add(t);
  }
  return [...out];
}
