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
