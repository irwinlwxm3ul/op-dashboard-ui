// Bridge to the curated model library (src/client/assets): loads the real weapon meshes and
// registers them with the procedural model builders, so every geometry built afterwards (near
// soldiers, character gear, ground loot) uses them. Never throws; missing files keep the
// procedural guns.

import * as THREE from 'three';
import { WEAPON_MODELS, loadMeshParts } from '../../assets';
import type { WeaponId } from '../../../shared/types';
import { WEAPON_IDS, setWeaponAsset } from './weaponModels';

/** Load every weapon model; returns the ids that are now using their real model. */
export async function loadWeaponAssets(): Promise<WeaponId[]> {
  const parts = await Promise.all(WEAPON_IDS.map((id) => loadMeshParts(WEAPON_MODELS[id].file).catch(() => null)));
  const loaded: WeaponId[] = [];
  WEAPON_IDS.forEach((id, i) => {
    const p = parts[i];
    if (!p || !p.geometry.getAttribute('position')) return;
    const m = WEAPON_MODELS[id];
    const color = (p.material as THREE.MeshStandardMaterial).color;
    const tint = color instanceof THREE.Color ? color.getHex() : 0xffffff;
    setWeaponAsset(id, p.geometry, tint, {
      pistol: m.pistol,
      butt: m.butt,
      fore: m.support,
      muzzle: m.muzzle,
      length: m.length,
    });
    loaded.push(id);
  });
  return loaded;
}
