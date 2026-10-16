// Ground-loot meshes, one geometry per ItemId: the curated real models once loaded (weapons lying on
// their side, ammo boxes, med items, gear ...), procedural stand-ins until then or if a model is
// missing (colour-coded ammo boxes, white/red med items, energy can, red jerry can, frag grenade and
// the same vest / helmet / backpack shapes the soldiers wear). All baked to vertex colours with the
// base resting on y = 0 and centred on x/z so items spin in place.

import * as THREE from 'three';
import type { AmmoId, ConsumableId, GearId, ItemCategory, ItemId, ThrowableId } from '../../../shared/types';
import { GeoBuilder, xform } from './geometry';
import { buildHelmet, buildPack, buildVest } from './soldierModel';
import { buildWeapon } from './weaponModels';

const AMMO_COLOR: Record<AmmoId, number> = {
  ammo_9mm: 0xc9a227,
  ammo_556: 0x4f8a3a,
  ammo_762: 0xb5502a,
  ammo_12g: 0xa82424,
  ammo_300: 0x4b3c8f,
};

/** Non-weapon item ids that can have a real model. */
export type ItemAssetId = AmmoId | ConsumableId | ThrowableId | GearId;

export interface ItemAsset {
  /** Vertex-coloured geometry standing on y = 0, centred on x / z, front -Z, real size. */
  geometry: THREE.BufferGeometry;
  /** Material colour (sRGB hex) multiplied onto the vertex colours. */
  tint: number;
}

/**
 * Real item models (curated glTF) registered once loaded; while an item has none the procedural
 * shape is used. Also read by the character gear builder (worn helmets / vests / backpacks).
 */
const itemAssets = new Map<ItemAssetId, ItemAsset>();

export function setItemAsset(id: ItemAssetId, geometry: THREE.BufferGeometry, tint: number): void {
  itemAssets.set(id, { geometry, tint });
}

export function itemAsset(id: ItemAssetId): ItemAsset | null {
  return itemAssets.get(id) ?? null;
}

/** Add a registered item model to `b` (vertex colours preserved). */
export function addItemAsset(asset: ItemAsset, b: GeoBuilder, base: THREE.Matrix4, bone = 0): void {
  const vc = asset.geometry.getAttribute('color') !== undefined;
  b.add(asset.geometry, base, { color: asset.tint, bone, vertexColors: vc, smooth: true });
}

/** Neutral colours used to bake the gear masks (no team colour on the ground). */
const BAKE = { accent: 0x8a8a7a, skin: 0xc99a74, cloth: 0x6b7347 };


function redCross(b: GeoBuilder, x: number, y: number, z: number, s: number): void {
  b.box(0.06 * s, 0.006, 0.018 * s, xform(x, y, z), { color: 0xc81e1e });
  b.box(0.018 * s, 0.006, 0.06 * s, xform(x, y, z), { color: 0xc81e1e });
}

function buildItem(id: ItemId, b: GeoBuilder): void {
  switch (id) {
    case 'pistol': case 'smg': case 'ar': case 'shotgun': case 'dmr': case 'sniper':
      // Lying on its left side.
      buildWeapon(id, b, xform(0, 0, 0, 0, 0, Math.PI / 2));
      return;
    case 'ammo_9mm': case 'ammo_556': case 'ammo_762': case 'ammo_12g': case 'ammo_300': {
      const c = AMMO_COLOR[id];
      b.box(0.2, 0.11, 0.13, xform(0, 0.055, 0), { color: c });
      b.box(0.204, 0.035, 0.134, xform(0, 0.06, 0), { color: 0xe8e2c8 });
      b.box(0.06, 0.012, 0.02, xform(0, 0.112, 0), { color: 0x222222 });
      const brass = id === 'ammo_12g' ? 0xb52a22 : 0xc8a050;
      for (let i = 0; i < 4; i++) b.cyl(0.008, 0.008, 0.03, 5, xform(-0.06 + i * 0.04, 0.125, 0.03), { color: brass });
      return;
    }
    case 'bandage':
      b.cyl(0.045, 0.045, 0.1, 10, xform(0, 0.045, 0, 0, 0, Math.PI / 2), { color: 0xefeee8 });
      b.cyl(0.047, 0.047, 0.025, 10, xform(0, 0.045, 0, 0, 0, Math.PI / 2), { color: 0xc8b48c });
      return;
    case 'firstaid':
      b.box(0.22, 0.07, 0.16, xform(0, 0.035, 0), { color: 0xf1f1ee });
      redCross(b, 0, 0.072, 0, 1.4);
      return;
    case 'medkit':
      b.box(0.36, 0.13, 0.24, xform(0, 0.065, 0), { color: 0xf1f1ee });
      b.box(0.362, 0.03, 0.242, xform(0, 0.065, 0), { color: 0xc81e1e });
      redCross(b, 0, 0.132, 0, 2.2);
      b.box(0.12, 0.025, 0.025, xform(0, 0.15, 0), { color: 0x333333 });
      return;
    case 'energy':
      b.cyl(0.034, 0.034, 0.12, 10, xform(0, 0.06, 0), { color: 0xd9e021 });
      b.cyl(0.0345, 0.0345, 0.04, 10, xform(0, 0.06, 0), { color: 0x1d6b2f });
      b.cyl(0.028, 0.034, 0.012, 10, xform(0, 0.126, 0), { color: 0xb8b8b8 });
      return;
    case 'fuel':
      b.box(0.3, 0.34, 0.14, xform(0, 0.17, 0), { color: 0xb3221c });
      b.box(0.16, 0.035, 0.035, xform(-0.04, 0.36, 0), { color: 0x8e1b16 });
      b.cyl(0.02, 0.025, 0.07, 6, xform(0.11, 0.37, 0, 0, 0, -0.5), { color: 0x2a2a2a });
      b.box(0.22, 0.2, 0.01, xform(0, 0.17, -0.072), { color: 0x9c1d18 });
      return;
    case 'frag':
      b.sphere(0.045, 8, 6, xform(0, 0.05, 0, 0, 0, 0, 1, 1.2, 1), { color: 0x47502f });
      b.cyl(0.018, 0.018, 0.03, 6, xform(0, 0.11, 0), { color: 0x5a5a52 });
      b.box(0.014, 0.08, 0.012, xform(0.03, 0.08, 0, 0, 0, -0.25), { color: 0x6a6a62 });
      b.ring(0.016, 0.003, 3, 8, xform(-0.025, 0.12, 0, Math.PI / 2), { color: 0x9a9a92 });
      return;
    case 'helmet1': case 'helmet2': case 'helmet3': {
      const lvl = Number(id.charAt(6));
      // Head space: helmet rim sits around y 0.13..0.15; drop it onto the ground.
      buildHelmet(lvl, b, xform(0, -0.12, 0));
      return;
    }
    case 'vest1': case 'vest2': case 'vest3': {
      const lvl = Number(id.charAt(4));
      // Lying face up.
      buildVest(lvl, b, xform(0, 0.16, 0.12, -Math.PI / 2));
      return;
    }
    case 'pack1': case 'pack2': case 'pack3': {
      const lvl = Number(id.charAt(4));
      const z = lvl === 1 ? 0.24 : lvl === 2 ? 0.26 : 0.285;
      const h = lvl === 1 ? 0.3 : lvl === 2 ? 0.42 : 0.56;
      // Standing upright, straps facing -Z.
      buildPack(lvl, b, xform(0, h / 2 - 0.08 + 0.02, -z), 0, false);
      return;
    }
  }
}

/** Build the geometry for an item: resting on y=0, centred on x/z. */
export function buildLootGeometry(id: ItemId): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const asset = itemAssets.get(id as ItemAssetId);
  if (asset) addItemAsset(asset, b, new THREE.Matrix4());
  else buildItem(id, b);
  const g = b.build({ bake: BAKE });
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  g.translate(-cx, 0.012 - bb.min.y, -cz);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Ground ring colour per item category. */
export const RING_COLOR: Record<ItemCategory, number> = {
  weapon: 0xffcf6e,
  ammo: 0xfff0a0,
  consumable: 0x9cffb4,
  throwable: 0xffa860,
  gear: 0x9fd2ff,
};
