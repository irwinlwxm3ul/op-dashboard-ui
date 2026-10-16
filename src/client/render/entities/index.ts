// Entity renderer (players, vehicles, loot, plane, parachutes, training dummies, nameplates).
// Initial landing: a valid renderer that owns its scene group; the full implementation replaces
// this body as the sub-renderers land.

import * as THREE from 'three';
import type { CreateEntityRenderer, EntityRenderer } from '../contracts';

export const createEntityRenderer: CreateEntityRenderer = (core): EntityRenderer => {
  const root = new THREE.Group();
  root.name = 'entities';
  core.scene.add(root);
  return {
    update() {},
    dispose() {
      core.scene.remove(root);
    },
  };
};
