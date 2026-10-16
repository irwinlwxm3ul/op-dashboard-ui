// Game-feel module entry point. Exports the `createFeel` factory (contract: src/client/render/contracts.ts).
import type { CreateFeel, Feel, FeelState } from '../render/contracts';

/** Temporary bootstrap implementation (replaced by the full feel pipeline). */
export const createFeel: CreateFeel = (_events, _overlay): Feel => {
  const state: FeelState = {
    shake: { pitch: 0, yaw: 0, roll: 0 },
    kick: { pitch: 0, yaw: 0, roll: 0 },
    fovPunch: 0,
    vm: { back: 0, up: 0, rot: 0, side: 0 },
    landDip: 0,
    bob: { phase: 0, amount: 0 },
    lowHealth: 0,
  };
  return {
    state,
    update() {},
    dispose() {},
  };
};
