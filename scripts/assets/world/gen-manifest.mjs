#!/usr/bin/env node
// Writes src/client/assets/manifest-world.ts from the build reports (reports/*.json written by
// build.mjs) plus the static source / licence table below. Usage:
//   node scripts/assets/world/build.mjs && node scripts/assets/world/gen-manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, MODELS_DIR } from '../harness.mjs';
import { SOURCES } from './sources.mjs';

const REPORTS = path.join(REPO_ROOT, 'scripts', 'assets', 'world', 'reports');
const read = (n) => JSON.parse(fs.readFileSync(path.join(REPORTS, `${n}.json`), 'utf8'));
const rel = (abs) => path.relative(MODELS_DIR, abs).split(path.sep).join('/');
const tree = (key, sub) => `${SOURCES[key].repo}/tree/${SOURCES[key].commit}/${sub}`;

// ------------------------------------------------------------------------------------------------
// Sources (quoted with full licence text in docs/ASSETS-world.md)
// ------------------------------------------------------------------------------------------------

const SRC = {
  luaz: { title: 'LUAZ', author: 'aaadragon', license: 'CC-BY-4.0', url: 'https://sketchfab.com/3d-models/luaz-172d9676de3541808f422eee16f47e72', mirror: tree('luaz', 'assets/models/vehicle') },
  dirtbike: { title: 'DIRT BIKE OFF ROAD BIKE LOW POLY', author: 'nabeelashrafphotography', license: 'CC-BY-4.0', url: 'https://sketchfab.com/3d-models/dirt-bike-off-road-bike-low-poly-dbcca404b21348c69938207d265b6035', mirror: tree('dirtbike', 'public/models/dirt_bike_off_road_bike_low_poly') },
  sandbag: { title: 'Sandbag', author: 'Jenna (jennakay)', license: 'CC-BY-4.0', url: 'https://sketchfab.com/3d-models/sandbag-2efc2a324abc4d0087f1d7c3cbba665a', mirror: tree('sandbag', 'assets/sandbag') },
  medievalVillage: { title: 'Medieval Village MegaKit (Standard)', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com', mirror: tree('quaternius', 'Medieval Village MegaKit[Standard]') },
  fantasyProps: { title: 'Fantasy Props MegaKit (Standard)', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com', mirror: tree('quaternius', 'Fantasy Props MegaKit[Standard]') },
  zombieKit: { title: 'Zombie Apocalypse Kit', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com', mirror: tree('quaternius', 'Zombie Apocalypse Kit - March 2024') },
  natureMegaKit: { title: 'Stylized Nature MegaKit (Standard)', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com', mirror: tree('quaternius', 'Stylized Nature MegaKit[Standard]') },
  ultimateNature: { title: 'Ultimate Stylized Nature', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com', mirror: tree('quaternius', 'Ultimate Stylized Nature - May 2022') },
  phOldMilitaryCrate: { title: 'Old Military Crate', author: 'Jack Mava', license: 'CC0-1.0', url: 'https://polyhaven.com/a/old_military_crate', mirror: tree('polyhavenC', 'assets/models/old_military_crate') },
  phBarrel03: { title: 'Barrel 03', author: 'Serhii Khromov', license: 'CC0-1.0', url: 'https://polyhaven.com/a/barrel_03', mirror: tree('polyhavenA', 'assets/polyhaven/models/barrel_03') },
  phBarrel01: { title: 'Barrel 01', author: 'Jorge Camacho', license: 'CC0-1.0', url: 'https://polyhaven.com/a/Barrel_01', mirror: tree('polyhavenA', 'assets/polyhaven/models/Barrel_01') },
  phJerrycan: { title: 'Metal Jerrycan', author: 'Sean Buckley', license: 'CC0-1.0', url: 'https://polyhaven.com/a/metal_jerrycan', mirror: tree('polyhavenA', 'assets/polyhaven/models/metal_jerrycan') },
  phBarrier: { title: 'Concrete Road Barrier', author: 'Amal Kumar', license: 'CC0-1.0', url: 'https://polyhaven.com/a/concrete_road_barrier', mirror: tree('polyhavenA', 'assets/polyhaven/models/concrete_road_barrier') },
  phChainlink: { title: 'Modular Chainlink Fence', author: 'James Ray Cock (fence wire material: Amal Kumar)', license: 'CC0-1.0', url: 'https://polyhaven.com/a/modular_chainlink_fence', mirror: tree('polyhavenA', 'assets/polyhaven/models/modular_chainlink_fence') },
  phRockMoss: { title: 'Rock Moss Set 01', author: 'Kless Gyzen', license: 'CC0-1.0', url: 'https://polyhaven.com/a/rock_moss_set_01', mirror: tree('polyhavenB', 'assets/ph/models/rock_moss_set_01') },
};

/** Prop id -> source key, world box mapping and fit notes. */
const PROPS = {
  crate_wood: { src: 'medievalVillage', boxes: [['crate', 'wood']], fit: 'scale to the WorldBox (cube crate, ~1 m native)' },
  crate_military: { src: 'fantasyProps', boxes: [['crate', 'wood']], fit: 'scale to the WorldBox; use for PropInfo.military / PAL.crateMilitary crates' },
  ammo_crate: { src: 'phOldMilitaryCrate', boxes: [], fit: 'native size (loot / dressing prop, not a WorldBox)' },
  barrel_oil: { src: 'phBarrel03', boxes: [], fit: 'native size (dressing prop)' },
  barrel_red: { src: 'phBarrel01', boxes: [], fit: 'native size (dressing prop)' },
  jerrycan: { src: 'phJerrycan', boxes: [], fit: 'native size (fuel pickup / dressing)' },
  barrier_concrete: { src: 'phBarrier', boxes: [['barrier', 'concrete']], fit: 'scale to the 3 x 0.9 x 0.6 m jersey-barrier box (two 1.55 m barriers end to end)' },
  sandbag_wall: { src: 'sandbag', boxes: [['barrier', 'sand']], fit: 'tile along the wall: one 2.0 m segment per 2 m of box length, scale Y to the box height (1.1 m native)' },
  container_green: { src: 'zombieKit', boxes: [['container', 'metal']], fit: 'closed containers only (native ISO 20 ft size = CONTAINER_L x CONTAINER_H x CONTAINER_W); open containers keep the box walls' },
  container_red: { src: 'zombieKit', boxes: [['container', 'metal']], fit: 'as container_green' },
  fence_wood: { src: 'medievalVillage', boxes: [['fence', 'wood']], fit: 'scale X to the panel length (2.06 m native), Y to 0.75 m' },
  fence_chainlink: { src: 'phChainlink', boxes: [['fence', 'metal']], fit: 'scale X to the panel length (1.99 m native: 1.91 m mesh panel + post), Y to 2.4 m' },
};

// ------------------------------------------------------------------------------------------------

const vehicles = read('vehicles');
const props = read('props')[0];
const nature = read('nature')[0];

const v3 = (a) => `[${a.map((x) => +(+x).toFixed(3)).join(', ')}]`;
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const src = (k) => `WORLD_SOURCES.${k}`;

function vehicleEntry(type, r, extra) {
  // Same order as WHEELS in src/shared/vehicles/defs.ts: front-left, front-right, rear-left, rear-right (bike: front, rear).
  const rank = (n) => ['Wheel_FL', 'Wheel_FR', 'Wheel_F', 'Wheel_RL', 'Wheel_RR', 'Wheel_R'].indexOf(n);
  const wheels = Object.entries(r.wheels).sort((a, b) => rank(a[0]) - rank(b[0])).map(([node, w]) => {
    const m = node.match(/^Wheel_([FR])([LR])?$/);
    if (!m) throw new Error(`unexpected wheel node ${node}`);
    const axle = m[1] === 'F' ? 'front' : 'rear';
    const side = m[2] === 'L' ? 'left' : m[2] === 'R' ? 'right' : 'center';
    return `      { node: ${q(node)}, axle: ${q(axle)}, side: ${q(side)}, center: ${v3(w.center)}, radius: ${w.radius}, width: ${w.width}, steers: ${axle === 'front'}${w.local ? `, parent: 'Fork', localCenter: ${v3(w.local)}` : ''} },`;
  });
  return `  ${type}: {
    type: ${q(type)},
    file: ${q(rel(r.file))},
    scale: 1,
    rotation: [0, 0, 0, 1],
    tris: ${r.tris},
    bodyMeshes: ${extra.body},
    glassMesh: ${extra.glass},
    paintTinted: ${extra.paintTinted},
    wheels: [
${wheels.join('\n')}
    ],
    fork: ${r.fork ? `{ node: 'Fork', pivot: ${v3(r.fork.pivot)}, axis: ${v3(r.fork.axis)}, rake: ${r.fork.rake} }` : 'null'},
    bounds: { min: ${v3(r.bbox.min)}, max: ${v3(r.bbox.max)} },
    seatSurfaceY: [${r.seatSurfaces.map((x) => (x == null ? 'null' : x)).join(', ')}],
    source: ${src(extra.source)},
  },`;
}

const uaz = vehicles.find((r) => r.file.endsWith('uaz.glb'));
const bike = vehicles.find((r) => r.file.endsWith('bike.glb'));

const propIds = Object.keys(PROPS);
for (const id of propIds) if (!props.find((p) => p.id === id)) throw new Error(`prop ${id} missing from report`);

const propEntries = propIds.map((id) => {
  const r = props.find((p) => p.id === id);
  const m = PROPS[id];
  return `  ${id}: {
    id: ${q(id)},
    file: ${q(rel(r.file))},
    size: ${v3(r.size)},
    tris: ${r.tris},
    meshes: [${r.meshes.map(q).join(', ')}],
    boxes: [${m.boxes.map(([k, mat]) => `{ kind: ${q(k)}, material: ${q(mat)} }`).join(', ')}],
    fit: ${q(m.fit)},
    source: ${src(m.src)},
  },`;
});

const TREE_SRC = { pine: 'natureMegaKit', oak: 'natureMegaKit', birch: 'ultimateNature', dead: 'natureMegaKit' };
const treeEntries = nature.trees.map((t) => `    ${t.kind}: {
      kind: ${q(t.kind)},
      file: ${q(rel(t.file))},
      barkMaterial: ${q(`${t.kind}_bark`)},
      leavesMaterial: ${t.kind === 'dead' ? 'null' : q(`${t.kind}_leaves`)},
      variants: [
${t.variants.map((v) => `        { node: ${q(v.id)}, lod1Node: ${q(`${v.id}_lod1`)}, bark: ${q(`${v.id}_bark`)}, leaves: ${t.kind === 'dead' ? 'null' : q(`${v.id}_leaves`)}, lod1Bark: ${q(`${v.id}_lod1_bark`)}, lod1Leaves: ${t.kind === 'dead' ? 'null' : q(`${v.id}_lod1_leaves`)}, tris: ${v.tris}, lod1Tris: ${v.lod1Tris}, trunkRadius: ${v.trunkRadius}, crownWidth: ${v.crownWidth}, rootDepth: ${v.rootDepth}, sourceHeight: ${v.sourceHeight} },`).join('\n')}
      ],
      source: ${src(TREE_SRC[t.kind])},
    },`);

const imp = nature.impostors;
const impWidth = Object.fromEntries(imp.cells.map((c) => [c.name, c.widthRatio]));
const bushImp = imp.cells.find((c) => c.name === 'bush');

const BUSH_SRC = ['natureMegaKit', 'ultimateNature', 'ultimateNature'];
const GRASS_SRC = ['ultimateNature', 'ultimateNature', 'natureMegaKit'];

const credits = Object.keys(SRC);

const out = `// World asset manifest (vehicles / props / nature) - GENERATED by
// scripts/assets/world/gen-manifest.mjs from the build reports; do not edit by hand (re-run
// \`node scripts/assets/world/build.mjs && node scripts/assets/world/gen-manifest.mjs\`).
// Sources, licences (CC0 1.0 / CC BY 4.0) and modifications: docs/ASSETS-world.md.
// Pure data (no three.js / DOM), like ./manifest.ts; file paths are relative to
// public/assets/models/ - resolve them with modelUrl() and load with loader.ts' loadModel().
//
// Frames (all files are pre-scaled and pre-rotated: scale 1, identity rotation fix):
//  * metres, +Y up, +X right, three.js forward -Z.
//  * vehicles: origin = physics OBB centre (VehicleState.pos, see src/shared/vehicles/defs.ts), the
//    wheels touch the ground at y = -(groundClearance + halfExtents.y) at rest and the length is
//    exactly 2 * halfExtents.z. Wheel nodes pivot at their centres: spin = rotation.x, steer =
//    rotation.y with rotation.order = 'YXZ'; suspension = y offset from the rest centre. The bike's
//    front wheel is a child of 'Fork' (pivot on the steering axis, local +Y = steering axis):
//    steer with Fork.rotation.y while keeping the loaded rotation.x (rake), order 'XYZ'.
//  * props: resting on y = 0, centred on X/Z, long axis along X.
//  * trees: unit height (ground y = 0, top y = 1, roots down to -rootDepth), trunk base centred on
//    the origin -> instance scale (h, h, h) with h = TreeDef.h. Vertex attributes '_sway' (0 at
//    the base -> 1 at the top) and '_trunk' (1 on the trunk core -> 0 on branches / leaves).
//    trunkRadius is the trunk base radius in unit space (the procedural trees use 0.03).
//  * rocks: base y = 0, top y = 1, horizontal radius 1 -> instance scale (r, h, r) equals the
//    physics cylinder of RockDef; about 20 % of the height (y < 0) is buried.
//  * bushes: metres, ~1.6 m wide at scale 1 (like the procedural bush), '_sway' = max(0, y) * 2.2.
//  * grass: unit height tufts, '_sway' = y.

import type { BoxKind, SurfaceMaterial, TreeKind, VehicleType } from '../../shared/types';
import type { Quat, Vec3 } from './manifest';

export type WorldAssetCategory = 'vehicles' | 'props' | 'nature';

export interface WorldAssetSource {
  title: string;
  author: string;
  license: 'CC0-1.0' | 'CC-BY-4.0';
  /** Original page of the asset. */
  url: string;
  /** Pinned GitHub copy the file was downloaded from. */
  mirror: string;
}

export const WORLD_SOURCES = {
${credits.map((k) => `  ${k}: { title: ${q(SRC[k].title)}, author: ${q(SRC[k].author)}, license: ${q(SRC[k].license)}, url: ${q(SRC[k].url)}, mirror: ${q(SRC[k].mirror)} },`).join('\n')}
} as const satisfies Record<string, WorldAssetSource>;

/** Every source used by the world assets (CC BY 4.0 ones must be credited in the game's credits). */
export const WORLD_ASSET_CREDITS: readonly WorldAssetSource[] = Object.values(WORLD_SOURCES);

// ================================================================================================
// Vehicles
// ================================================================================================

export interface VehicleWheelModel {
  /** Group node pivoting at the wheel centre (spin = rotation.x). */
  node: string;
  axle: 'front' | 'rear';
  side: 'left' | 'right' | 'center';
  /** Rest centre in model space (= vehicle local space). */
  center: Vec3;
  radius: number;
  width: number;
  steers: boolean;
  /** Set when the wheel node is a child of another node (bike front wheel under 'Fork'). */
  parent?: 'Fork';
  /** Rest position relative to the parent node. */
  localCenter?: Vec3;
}

export interface VehicleForkModel {
  node: 'Fork';
  /** Point on the steering axis (model space), level with the front axle. */
  pivot: Vec3;
  /** Steering axis direction (unit, pointing up; leans back toward +Z). */
  axis: Vec3;
  /** Loaded Fork.rotation.x (rad). */
  rake: number;
}

export interface VehicleModel {
  type: VehicleType;
  file: string;
  /** Already applied: kept for the uniform manifest shape. */
  scale: 1;
  rotation: Quat;
  tris: number;
  /** Static meshes (move with the chassis). */
  bodyMeshes: readonly string[];
  /** Transparent window mesh (own material), null when the model has none. */
  glassMesh: string | null;
  /** True when the body colour comes from a neutral material that can be tinted per vehicle. */
  paintTinted: boolean;
  wheels: readonly VehicleWheelModel[];
  fork: VehicleForkModel | null;
  bounds: { min: Vec3; max: Vec3 };
  /**
   * Model surface height under each VEHICLES[type].seatOffsets entry (same order; null = no
   * surface). Physics hips sit at seat.y + SEAT_HIP_HEIGHT: raise a seated rider by the difference
   * when it is positive (bike: ~0.1 m).
   */
  seatSurfaceY: readonly (number | null)[];
  source: WorldAssetSource;
}

/**
 * Real vehicle models. 'buggy' has no CC0 / CC BY source that was reachable (see
 * docs/ASSETS-world.md) and keeps the procedural model.
 */
export const VEHICLE_MODELS: Partial<Record<VehicleType, VehicleModel>> = {
${vehicleEntry('uaz', uaz, { body: "['Body']", glass: "'Glass'", paintTinted: false, source: 'luaz' })}
${vehicleEntry('bike', bike, { body: "['Body']", glass: 'null', paintTinted: false, source: 'dirtbike' })}
};

// ================================================================================================
// Props
// ================================================================================================

export type WorldPropId = ${propIds.map(q).join(' | ')};

export interface PropModel {
  id: WorldPropId;
  file: string;
  /** Native extents (x, y, z) in metres. */
  size: Vec3;
  tris: number;
  meshes: readonly string[];
  /** World boxes (WorldBox.kind + material) this model can dress; empty = free dressing prop. */
  boxes: readonly { kind: BoxKind; material: SurfaceMaterial }[];
  /** How to fit the model to the world geometry. */
  fit: string;
  source: WorldAssetSource;
}

export const PROP_MODELS: Record<WorldPropId, PropModel> = {
${propEntries.join('\n')}
};

/** Prop models that can dress a WorldBox of this kind + material (first = default). */
export function propModelsForBox(kind: BoxKind, material: SurfaceMaterial): WorldPropId[] {
  const out: WorldPropId[] = [];
  for (const p of Object.values(PROP_MODELS)) if (p.boxes.some((b) => b.kind === kind && b.material === material)) out.push(p.id);
  return out;
}

// ================================================================================================
// Nature
// ================================================================================================

export interface TreeVariantModel {
  /** Group with the LOD0 meshes. */
  node: string;
  /** Group with the LOD1 (mid band) meshes. */
  lod1Node: string;
  bark: string;
  leaves: string | null;
  lod1Bark: string;
  lod1Leaves: string | null;
  tris: number;
  lod1Tris: number;
  /** Trunk base radius in unit space (instance aTrunk = TreeDef.r / (trunkRadius * h)). */
  trunkRadius: number;
  /** Crown width / height. */
  crownWidth: number;
  /** Roots below the ground plane (unit space). */
  rootDepth: number;
  /** Height of the source model in metres (informative). */
  sourceHeight: number;
}

export interface TreeKindModel {
  kind: TreeKind;
  file: string;
  /** Shared by every variant / LOD of the kind (one texture each). */
  barkMaterial: string;
  leavesMaterial: string | null;
  variants: readonly TreeVariantModel[];
  source: WorldAssetSource;
}

export interface NatureVariantModel {
  node: string;
  lod1Node: string | null;
  tris: number;
  lod1Tris: number | null;
}

export const NATURE_MODELS = {
  /** Custom vertex attribute names as three.js exposes them after GLTFLoader. */
  attributes: { sway: '_sway', trunk: '_trunk' },
  trees: {
${treeEntries.join('\n')}
  } satisfies Record<TreeKind, TreeKindModel>,
  rocks: {
    file: ${q(rel(nature.rocks.file))},
    material: 'rock',
    variants: [
${nature.rocks.variants.map((v) => `      { node: ${q(v.id)}, lod1Node: ${q(`${v.id}_lod1`)}, tris: ${v.tris}, lod1Tris: ${v.lod1Tris} },`).join('\n')}
    ] satisfies NatureVariantModel[],
    source: WORLD_SOURCES.phRockMoss,
  },
  bushes: {
    file: ${q(rel(nature.bushes.file))},
    variants: [
${nature.bushes.variants.map((v, i) => `      { node: ${q(v.id)}, lod1Node: ${q(`${v.id}_lod1`)}, tris: ${v.tris}, lod1Tris: ${v.lod1Tris}, height: ${v.height}, material: ${q(v.material)}, source: WORLD_SOURCES.${BUSH_SRC[i]} },`).join('\n')}
    ] satisfies (NatureVariantModel & { height: number; material: string; source: WorldAssetSource })[],
  },
  grass: {
    file: ${q(rel(nature.grass.file))},
    variants: [
${nature.grass.variants.map((v, i) => `      { node: ${q(v.id)}, lod1Node: null, tris: ${v.tris}, lod1Tris: null, width: ${v.width}, source: WORLD_SOURCES.${GRASS_SRC[i]} },`).join('\n')}
    ] satisfies (NatureVariantModel & { width: number; source: WorldAssetSource })[],
  },
  /**
   * Far-band impostor atlas (PNG, RGBA): one cell per kind in this order, base at the bottom of
   * the cell, unlit albedo. Quad width = height * widthRatio[kind] (bush: BUSH_IMPOSTOR_W x
   * bushHeight m at scale 1).
   */
  impostors: {
    file: ${q(rel(imp.file))},
    size: ${v3(imp.size)},
    cells: [${imp.cells.map((c) => q(c.name)).join(', ')}] as const,
    widthRatio: { ${Object.entries(impWidth).map(([k, w]) => `${k}: ${w}`).join(', ')} },
    bushHeight: ${bushImp.height},
  },
} as const;

// ================================================================================================
// Budgets / catalog
// ================================================================================================

export const WORLD_ASSET_BUDGETS = {
  /** vehicles + props + nature folders. */
  totalBytes: 15 * 1024 * 1024,
  /** Triangles per vehicle file, per prop file, per nature variant (LOD0). */
  tris: { vehicles: 5000, props: 2000, nature: 2000 } as Record<WorldAssetCategory, number>,
  /** Largest texture edge. */
  textureSize: 1024,
} as const;

/** Every GLB of a category (paths relative to public/assets/models/). */
export function worldAssetFilesFor(category: WorldAssetCategory): string[] {
  switch (category) {
    case 'vehicles':
      return Object.values(VEHICLE_MODELS).map((v) => v.file);
    case 'props':
      return Object.values(PROP_MODELS).map((p) => p.file);
    case 'nature':
      return [...Object.values(NATURE_MODELS.trees).map((t) => t.file), NATURE_MODELS.rocks.file, NATURE_MODELS.bushes.file, NATURE_MODELS.grass.file];
  }
}
`;

const dest = path.join(REPO_ROOT, 'src', 'client', 'assets', 'manifest-world.ts');
fs.writeFileSync(dest, out);
console.log('wrote', path.relative(REPO_ROOT, dest));
