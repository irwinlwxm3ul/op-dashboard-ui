// Camera rig + first-person viewmodel (render-view-fx module).
//
// createViewRig positions core.camera every frame (TPP shoulder cam with collision, FPP, TPP-ADS
// sight view, scope, plane / freefall / parachute / vehicle chase cams, spectate and death orbit)
// and animates the procedural first-person arms and guns, which render after the world in their
// own scene (see viewmodel/viewmodel.ts for the rendering approach).

import type { CreateViewRig } from '../contracts';
import { createRig } from './rig';

export const createViewRig: CreateViewRig = (core, world, events) => createRig(core, world, events);

export {
  verticalFovFromSetting, zoomFov, adsZoomMul, solveTwoBone, springStep,
} from './cameraMath';
export { DEATH_ORBIT_SECONDS } from './cameraRig';
