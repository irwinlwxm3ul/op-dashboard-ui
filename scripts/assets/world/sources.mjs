// Pinned upstream sources of the world assets (vehicles / props / nature). Every model is CC0 1.0
// or CC BY 4.0; docs/ASSETS-world.md quotes each licence with author, URL and modifications.
// `node scripts/assets/world/fetch-sources.mjs` clones each repository (blobless, sparse, at the
// pinned commit) into $ASSETS_DL/<dir>; build.mjs then reads the files from there.
import path from 'node:path';

export const DL = process.env.ASSETS_DL || '/tmp/claude-0/assets-dl';

export const SOURCES = {
  /** Quaternius packs (CC0) mirrored on GitHub. */
  quaternius: {
    repo: 'https://github.com/agentkaerf/FreeModels',
    commit: 'db3df04d1e4714298a09510b26fb6de6645138a2',
    dir: 'world-freemodels/repo',
    sparse: [
      '/Stylized Nature MegaKit[[]Standard]/glTF/*',
      '/Stylized Nature MegaKit[[]Standard]/License_Standard.txt',
      '/Ultimate Stylized Nature - May 2022/glTF/*',
      '/Ultimate Stylized Nature - May 2022/License.txt',
      '/Zombie Apocalypse Kit - March 2024/Environment/glTF/*',
      '/Zombie Apocalypse Kit - March 2024/License.txt',
      '/Zombie Apocalypse Kit - March 2024/Zombie_Atlas.png',
      '/Fantasy Props MegaKit[[]Standard]/License_Standard.txt',
      '/Fantasy Props MegaKit[[]Standard]/Exports/glTF/Crate_Wooden.*',
      '/Fantasy Props MegaKit[[]Standard]/Exports/glTF/T_Trim_Furniture_*',
      '/Fantasy Props MegaKit[[]Standard]/Exports/glTF/T_Trim_Metal_*',
      '/Medieval Village MegaKit[[]Standard]/License_Standard.txt',
      '/Medieval Village MegaKit[[]Standard]/glTF/Prop_Crate.*',
      '/Medieval Village MegaKit[[]Standard]/glTF/Prop_WoodenFence_Single.*',
      '/Medieval Village MegaKit[[]Standard]/glTF/T_WoodTrim_*',
    ],
  },
  /** Poly Haven models (CC0), 1k glTF exports as published on polyhaven.com, mirror #1. */
  polyhavenA: {
    repo: 'https://github.com/EliteGamer007/6dof-drone-sim',
    commit: '3b97077101bedb1326cf6483e04dc51ccf130fa3',
    dir: 'world-drone/repo',
    sparse: ['barrel_03', 'Barrel_01', 'metal_jerrycan', 'concrete_road_barrier', 'wooden_crate_01', 'modular_chainlink_fence', 'boulder_01']
      .map((m) => `/assets/polyhaven/models/${m}/*`),
  },
  /** Poly Haven models (CC0), mirror #2 (the CREDITS.md there lists them as Poly Haven CC0). */
  polyhavenB: {
    repo: 'https://github.com/ayoub5550/inside-copy-',
    commit: 'e93e405569477bd9e5e304f1a0763116888fb66f',
    dir: 'world-ayoub5550_inside-copy-/repo',
    sparse: ['/CREDITS.md', ...['rock_moss_set_01', 'wooden_crate_02'].map((m) => `/assets/ph/models/${m}/*`)],
  },
  /** Poly Haven "Old Military Crate" (CC0), mirror #3. */
  polyhavenC: {
    repo: 'https://github.com/AetherRadar/operation-steel-tide',
    commit: 'd6a33b932e00fb9016dea407eca3f909aeaf2dcb',
    dir: 'world-steeltide/repo',
    sparse: ['/assets/models/LICENSE.md', '/assets/models/old_military_crate/*'],
  },
  /** "LUAZ" by aaadragon on Sketchfab (CC BY 4.0), Sketchfab glTF export mirrored on GitHub. */
  luaz: {
    repo: 'https://github.com/profojak/Brumm-Brumm-Bau',
    commit: '473da224db5e2155de9d18de29e35542215523f4',
    dir: 'world-profojak_Brumm-Brumm-Bau/repo',
    sparse: ['/assets/models/vehicle/*'],
  },
  /** "DIRT BIKE OFF ROAD BIKE LOW POLY" by nabeelashrafphotography on Sketchfab (CC BY 4.0). */
  dirtbike: {
    repo: 'https://github.com/warathepj/Tentspace',
    commit: '4c755e03fd0fdfb08052662246a7324bf60e5e5a',
    dir: 'world-warathepj_Tentspace/repo',
    sparse: ['/public/models/dirt_bike_off_road_bike_low_poly/*'],
  },
  /** "Sandbag" by Jenna on Sketchfab (CC BY 4.0). */
  sandbag: {
    repo: 'https://github.com/greentis/comp4451-game',
    commit: 'dfc99fec9898c06e54bb105afcd7b185f13e6b45',
    dir: 'world-greentis_comp4451-game/repo',
    sparse: ['/assets/sandbag/*'],
  },
};

const Q = SOURCES.quaternius.dir;
export const MEGAKIT = `${Q}/Stylized Nature MegaKit[Standard]/glTF`;
export const ULTNAT = `${Q}/Ultimate Stylized Nature - May 2022/glTF`;
export const ZOMBIE = `${Q}/Zombie Apocalypse Kit - March 2024/Environment/glTF`;
export const FANTASY = `${Q}/Fantasy Props MegaKit[Standard]/Exports/glTF`;
export const MEDIEVAL = `${Q}/Medieval Village MegaKit[Standard]/glTF`;
export const PHA = `${SOURCES.polyhavenA.dir}/assets/polyhaven/models`;
export const PHB = `${SOURCES.polyhavenB.dir}/assets/ph/models`;
export const PHC = `${SOURCES.polyhavenC.dir}/assets/models`;
export const LUAZ = `${SOURCES.luaz.dir}/assets/models/vehicle/scene.gltf`;
export const DIRTBIKE = `${SOURCES.dirtbike.dir}/public/models/dirt_bike_off_road_bike_low_poly/scene.gltf`;
export const SANDBAG = `${SOURCES.sandbag.dir}/assets/sandbag/scene.gltf`;

export const abs = (rel) => path.join(DL, rel);
