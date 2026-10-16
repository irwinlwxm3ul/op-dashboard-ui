// Pinned upstream sources for the asset pipelines. Run `scripts/assets/fetch-sources.sh` first;
// it clones each repository (sparse / blobless) into $ASSETS_DL (default /tmp/claude-0/assets-dl).
// Everything here is CC0 1.0 (see docs/ASSETS.md for the licence quotes and exact commits).
import path from 'node:path';

export const DL = process.env.ASSETS_DL || '/tmp/claude-0/assets-dl';

export const FREEMODELS = 'repos/agentkaerf_FreeModels'; // github.com/agentkaerf/FreeModels @ db3df04d1e4714298a09510b26fb6de6645138a2
export const UMM = `${FREEMODELS}/Ultimate Modular Men- Feb 2022/Individual Characters/glTF`;
export const UMW = `${FREEMODELS}/Ultimate Modular Women - April 2022/Individual Characters/glTF`;
export const ZAK = `${FREEMODELS}/Zombie Apocalypse Kit - March 2024`;
export const UAL1 = 'ual/UAL1.glb'; // github.com/tilakpatell/tilakverse-assets @ 8506439 quaternius/universal-animation-library/Unreal-Godot/UAL1.glb
export const UAL2 = 'ual/UAL2.glb'; // ... quaternius/universal-animation-library-2/Unreal-Godot/UAL2.glb

export const abs = (rel) => path.join(DL, rel);
// github.com/regnaio/assets @ 336e580f990c2efd62f640957967e874efab1226
//   quaternius/ultimategun/Ultimate Gun Pack - July 2019/FBX/*.fbx (+ License.txt), copied flat.
//   (Identical blobs are also in github.com/WingNut17/ps1-style @ 42b446d.)
export const UGP = 'ugp';
// Items, copied flat with a prefix (see fetch-sources.sh):
//   surv_*  regnaio/assets quaternius/survival/Survival Pack - Sept 2020/FBX/*.fbx
//   zsky_*  regnaio/assets itch/zsky2000/low-poly-weapons-pack-v1/WeaponsPack_V.1/FBX/*Ammo_Box.fbx (CC BY 4.0)
//   toon_*  regnaio/assets quaternius/toonshootergamekit/Toon Shooter Game Kit - Dec 2022/{Guns,Characters}/glTF/*.gltf
export const ITEMS_SRC = 'items';
