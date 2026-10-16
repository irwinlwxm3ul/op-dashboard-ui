// Bridge to the curated model library (src/client/assets): loads the real weapon and item meshes
// and registers them with the procedural model builders, so every geometry built afterwards (near
// soldiers' guns, character gear, ground loot) uses them. Never throws; missing files keep the
// procedural guns.

import * as THREE from 'three';
import { ITEM_MODELS, WEAPON_MODELS, loadMeshParts } from '../../assets';
import type { WeaponId } from '../../../shared/types';
import { type ItemAssetId, setItemAsset } from './lootModels';
import { WEAPON_IDS, setWeaponAsset } from './weaponModels';

function tintOf(material: THREE.Material): number {
  const c = (material as THREE.MeshStandardMaterial).color;
  return c instanceof THREE.Color ? c.getHex() : 0xffffff;
}

/** Load every weapon model; returns the ids that are now using their real model. */
export async function loadWeaponAssets(): Promise<WeaponId[]> {
  const parts = await Promise.all(WEAPON_IDS.map((id) => loadMeshParts(WEAPON_MODELS[id].file).catch(() => null)));
  const loaded: WeaponId[] = [];
  WEAPON_IDS.forEach((id, i) => {
    const p = parts[i];
    if (!p || !p.geometry.getAttribute('position')) return;
    const m = WEAPON_MODELS[id];
    setWeaponAsset(id, p.geometry, tintOf(p.material), {
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

/** Load every item model (loot + wearable gear); returns the ids now using their real model. */
export async function loadItemAssets(): Promise<ItemAssetId[]> {
  const ids = Object.keys(ITEM_MODELS) as ItemAssetId[];
  const parts = await Promise.all(ids.map((id) => loadMeshParts(ITEM_MODELS[id].file).catch(() => null)));
  const loaded: ItemAssetId[] = [];
  ids.forEach((id, i) => {
    const p = parts[i];
    if (!p || !p.geometry.getAttribute('position')) return;
    setItemAsset(id, p.geometry, tintOf(p.material));
    loaded.push(id);
  });
  return loaded;
}
