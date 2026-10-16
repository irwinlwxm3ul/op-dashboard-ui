#!/usr/bin/env node
// Builds public/assets/models/items/<ItemId>.glb (loot + wearable gear) from pinned CC0 / CC-BY
// sources (sources.mjs): Quaternius Survival Pack (bandage, first aid, med kit, energy drink,
// jerry can, backpacks), Quaternius Toon Shooter Game Kit (frag grenade; helmet + vest parts of
// Character_Soldier) and Zsky Low Poly Weapons Pack V.1 (ammo boxes, CC BY 4.0).
// Every item becomes ONE vertex-coloured mesh with one material ('item'), resting on y = 0,
// centred on X/Z, front facing -Z, real-world size. Gear additionally gets a per-rig "wear"
// transform (bone-local) fitted to the bind pose of the rig's bulkiest outfit.
// Usage: node scripts/assets/build-items.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInPage, MODELS_DIR } from './harness.mjs';
import { DL, ITEMS_SRC, UMM, UMW } from './sources.mjs';

const C = { olive: 0x4f5a3a, oliveDark: 0x3c4530, tan: 0x9a8762, black: 0x232527, grey: 0x55595e, khaki: 0x7d7a52, navy: 0x2b3442, sand: 0xa89670 };

/**
 * size: target extent (m) of the item's largest dimension (or its height with fit: 'height').
 * parts: optional filter on "<node>/<material>" for multi-part sources. recolor: material
 * name -> hex (applied before baking). rotate: Euler (deg) applied to the source first.
 */
const ITEMS = {
  bandage: { src: 'surv_Bandages.fbx', size: 0.11 },
  firstaid: { src: 'surv_FirstAidKit.fbx', size: 0.26 },
  medkit: { src: 'surv_FirstAidKit_Hard.fbx', size: 0.36 },
  energy: { src: 'surv_Can_Red.fbx', size: 0.125, fit: 'height' },
  fuel: { src: 'surv_GasCan.fbx', size: 0.47, fit: 'height', recolor: { Red: 0x4f5a3a, DarkRed: 0x3c4530 } },
  frag: { src: 'toon_Grenade.gltf', size: 0.11, fit: 'height', recolor: { Green: 0x4f5a3a } },
  ammo_9mm: { src: 'zsky_PistolAmmo_Box.fbx', size: 0.2 },
  ammo_556: { src: 'zsky_AssaultRifleAmmo_Box.fbx', size: 0.26 },
  ammo_762: { src: 'zsky_SniperAmmo_Box.fbx', size: 0.26 },
  ammo_12g: { src: 'zsky_ShotgunAmmo_Box.fbx', size: 0.22 },
  ammo_300: { src: 'zsky_SniperAmmo_Box.fbx', size: 0.28, recolor: { BlueSniper_AmmoBox: 0x4f5a3a, BlueScreenSniper_AmmoBox: 0x6b7650 } },
  helmet1: { src: 'toon_Character_Soldier.gltf', parts: '^Head_1/Character_Main$', size: 0.27, gear: 'helmet', recolor: { Character_Main: C.tan } },
  helmet2: { src: 'toon_Character_Soldier.gltf', parts: '^Head_1/(Character_Main|Grey)$', size: 0.28, gear: 'helmet', recolor: { Character_Main: C.olive, Grey: C.black } },
  helmet3: { src: 'toon_Character_Soldier.gltf', parts: '^Head_1/(Character_Main|Grey)$', size: 0.29, gear: 'helmet', recolor: { Character_Main: C.black, Grey: C.grey } },
  vest1: { src: 'toon_Character_Soldier.gltf', parts: '^Body/Character_Main$', size: 0.5, fit: 'height', gear: 'vest', recolor: { Character_Main: C.navy } },
  vest2: { src: 'toon_Character_Soldier.gltf', parts: '^Body/(Character_Main|DarkGrey)$', size: 0.52, fit: 'height', gear: 'vest', recolor: { Character_Main: C.olive, DarkGrey: C.oliveDark } },
  vest3: { src: 'toon_Character_Soldier.gltf', parts: '^Body/(Character_Main|DarkGrey)$', size: 0.54, fit: 'height', gear: 'vest', recolor: { Character_Main: C.black, DarkGrey: C.grey } },
  pack1: { src: 'surv_Backpack.fbx', size: 0.42, fit: 'height', gear: 'pack', recolor: { Brown: C.sand, LightGreen: C.khaki, Gold: C.grey, Green: C.oliveDark } },
  pack2: { src: 'surv_Backpack.fbx', size: 0.52, fit: 'height', gear: 'pack', recolor: { Brown: C.olive, LightGreen: C.oliveDark, Gold: C.grey, Green: C.black } },
  pack3: { src: 'surv_Backpack.fbx', size: 0.62, fit: 'height', gear: 'pack', recolor: { Brown: C.black, LightGreen: C.grey, Gold: C.olive, Green: C.oliveDark } },
};

/** Rigs to fit gear on: the bulkiest outfit of each (gear must clear the tactical kit too). */
const FIT_RIGS = { male: `${UMM}/Swat.gltf`, female: `${UMW}/Soldier.gltf` };

const outDir = path.join(MODELS_DIR, 'items');
fs.mkdirSync(outDir, { recursive: true });

const page = `
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { loadGltf, toBase64 } from '/scripts/page-lib.js';
import { bakeToSingleGeometry, geometryTris, weaponObject } from '/scripts/weapons.page.js';
import { exportGlb } from '/scripts/characters.page.js';
const ITEMS = ${JSON.stringify(ITEMS)};
const FIT_RIGS = ${JSON.stringify(FIT_RIGS)};
const OUT = ${JSON.stringify(outDir)};
const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
const fbx = new FBXLoader();
const cache = new Map();
async function source(name) {
  if (!cache.has(name)) {
    const url = '/dl/' + enc(${JSON.stringify(ITEMS_SRC)}) + '/' + name;
    cache.set(name, name.endsWith('.fbx') ? await fbx.loadAsync(url) : (await loadGltf(url)).scene);
  }
  return cache.get(name);
}
function bindPose(root) {
  root.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  root.updateMatrixWorld(true);
}
/** Bakes selected parts of a (possibly skinned) source in its bind pose. */
function bake(root, spec) {
  bindPose(root);
  const filter = spec.parts ? new RegExp(spec.parts) : null;
  const holder = new THREE.Group();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = [].concat(o.material);
    const key = o.parent.name + '/' + mats[0].name;
    if (filter && !filter.test(key) && !filter.test(o.name + '/' + mats[0].name)) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.isSkinnedMesh ? o.bindMatrix : o.matrixWorld);
    const m = new THREE.Mesh(g, o.material);
    holder.add(m);
  });
  const colorOf = (m) => {
    const base = (m.name || '').replace(/\\.\\d+$/, '');
    if (spec.recolor && spec.recolor[base] !== undefined) return new THREE.Color(spec.recolor[base]);
    return m.color ? m.color.clone() : new THREE.Color(0x808080);
  };
  return bakeToSingleGeometry(holder, colorOf);
}
const report = {};
const geos = {};
for (const [id, spec] of Object.entries(ITEMS)) {
  const geo = bake(await source(spec.src), spec);
  geo.computeBoundingBox();
  let b = geo.boundingBox;
  const s = b.getSize(new THREE.Vector3());
  const k = spec.size / (spec.fit === 'height' ? s.y : Math.max(s.x, s.y, s.z));
  geo.scale(k, k, k);
  geo.computeBoundingBox(); b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  geos[id] = geo;
  const obj = weaponObject('item_' + id, geo, {});
  obj.children[0].material.name = 'item';
  obj.children[0].material.metalness = 0.1;
  obj.children[0].material.roughness = 0.7;
  const buf = await exportGlb(obj, []);
  await window.__writeFile(OUT + '/' + id + '.glb', toBase64(buf));
  b = geo.boundingBox;
  report[id] = { tris: geometryTris(geo), bytes: buf.byteLength, size: b.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)) };
}

// ---- Gear fitting (bone-local "wear" transforms per rig) ----
function vertsByBones(skinned, boneNames, minW = 0.5) {
  const sk = skinned.skeleton, g = skinned.geometry;
  const idx = new Set(boneNames.map((n) => sk.bones.findIndex((b) => b.name === n)).filter((i) => i >= 0));
  const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const out = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let c = 0; c < 4; c++) if (idx.has(si.getComponent(i, c))) w += sw.getComponent(i, c);
    if (w >= minW) out.push(v.fromBufferAttribute(pos, i).applyMatrix4(skinned.bindMatrix).clone());
  }
  return out;
}
const boxOf = (pts) => pts.reduce((bb, p) => bb.expandByPoint(p), new THREE.Box3());
const wear = {};
for (const [rig, file] of Object.entries(FIT_RIGS)) {
  const g = await loadGltf('/dl/' + enc(file));
  bindPose(g.scene);
  const skinned = []; g.scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  const bones = {}; g.scene.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const all = (names, minW) => skinned.flatMap((m) => vertsByBones(m, names, minW));
  const head = boxOf(all(['Head'], 0.6));
  const torsoPts = all(['Abdomen', 'Torso', 'Chest'], 0.6);
  const torso = boxOf(torsoPts);
  const local = (bone, worldMatrix) => {
    const m = bone.matrixWorld.clone().invert().multiply(worldMatrix);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { bone: bone.name, position: p.toArray().map((v) => +v.toFixed(4)), quaternion: q.toArray().map((v) => +v.toFixed(4)), scale: s.toArray().map((v) => +v.toFixed(4)) };
  };
  const face = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // item -Z front -> +Z (rig faces +Z here)
  wear[rig] = {};
  const headW = head.max.x - head.min.x, headD = head.max.z - head.min.z;
  const torsoW = torso.max.x - torso.min.x, torsoD = torso.max.z - torso.min.z;
  for (const [id, spec] of Object.entries(ITEMS)) {
    if (!spec.gear) continue;
    const gb = geos[id].boundingBox; const gs = gb.getSize(new THREE.Vector3());
    let world;
    if (spec.gear === 'helmet') {
      // Uniform fit to the head width (+15 %), shell top 2.5 cm above the head top.
      const k = (Math.max(headW, headD * 0.92) * 1.15) / Math.max(gs.x, gs.z);
      const pos = new THREE.Vector3((head.min.x + head.max.x) / 2, head.max.y + 0.025 - gs.y * k, (head.min.z + head.max.z) / 2 - 0.005);
      world = new THREE.Matrix4().compose(pos, face, new THREE.Vector3(k, k, k));
      wear[rig][id] = local(bones.Head, world);
    } else if (spec.gear === 'vest') {
      // Non-uniform fit around the rib cage: width +10 %, depth +30 %, from waist to armpits.
      const top = torso.max.y - 0.05, bottom = torso.min.y + (torso.max.y - torso.min.y) * 0.22;
      const sc = new THREE.Vector3((torsoW * 0.62) / gs.x, (top - bottom) / gs.y, (torsoD * 1.3) / gs.z);
      const pos = new THREE.Vector3((torso.min.x + torso.max.x) / 2, bottom, (torso.min.z + torso.max.z) / 2);
      world = new THREE.Matrix4().compose(pos, face, sc);
      wear[rig][id] = local(bones.Torso, world);
    } else {
      // Backpack: flat against the back (rig back = -Z here), top below the neck.
      const k = 1;
      const top = torso.max.y - 0.04;
      const pos = new THREE.Vector3((torso.min.x + torso.max.x) / 2, top - gs.y * k, torso.min.z - (gs.z * k) / 2 + 0.03);
      world = new THREE.Matrix4().compose(pos, face, new THREE.Vector3(k, k, k));
      wear[rig][id] = local(bones.Chest, world);
    }
  }
  wear[rig].__fit = { head: [head.min.toArray(), head.max.toArray()], torso: [torso.min.toArray(), torso.max.toArray()] };
}
window.__done({ items: report, wear });
`;

const { result } = await runInPage(page, { mounts: { '/dl/': DL } });
const reports = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports');
fs.mkdirSync(reports, { recursive: true });
fs.writeFileSync(path.join(reports, 'items.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.items).replace(/\},"/g, '},\n"'));
console.log(JSON.stringify(result.wear, null, 0).slice(0, 3000));
