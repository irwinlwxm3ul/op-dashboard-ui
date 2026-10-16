// FX renderer (render-view-fx module). Interim implementation while the full renderer lands.
import type { CreateFxRenderer, FxRenderer } from '../contracts';

export const createFxRenderer: CreateFxRenderer = () => {
  const fx: FxRenderer = {
    update() { /* full renderer pending */ },
    dispose() { /* nothing allocated */ },
  };
  return fx;
};
