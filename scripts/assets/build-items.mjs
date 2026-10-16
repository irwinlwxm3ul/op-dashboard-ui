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

import { ITEMS } from './build-items.config.mjs';

/** Rigs to fit gear on: the bulkiest outfit of each (gear must clear the tactical kit too). */
const FIT_RIGS = { male: `${UMM}/Swat.gltf`, female: `${UMW}/Soldier.gltf` };

const outDir = path.join(MODELS_DIR, 'items');
fs.mkdirSync(outDir, { recursive: true });

const page = `
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { loadGltf, toBase64 } from '/scripts/page-lib.js';
import { bakeToSingleGeometry, geometryTris, weaponObject } from '/scripts/weapons.page.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
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
/** Low-poly plate carrier (item space: centred, y up, front -Z) built from bevelled plates. */
function proceduralVest(level, [main, dark]) {
  const parts = [];
  const colorize = (g, color) => {
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const box = (w, h, d, x, y, z, color, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    colorize(g, color);
  };
  // Rounded, bevelled plate (w x h, thickness d) centred at (x, y, z), facing -Z.
  const plate = (w, h, d, x, y, z, color, r = 0.035) => {
    const s = new THREE.Shape();
    const hw = w / 2 - r, hh = h / 2 - r;
    s.moveTo(-hw, -h / 2); s.lineTo(hw, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -hh);
    s.lineTo(w / 2, hh); s.quadraticCurveTo(w / 2, h / 2, hw, h / 2); s.lineTo(-hw, h / 2);
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, hh); s.lineTo(-w / 2, -hh); s.quadraticCurveTo(-w / 2, -h / 2, -hw, -h / 2);
    const bevel = Math.min(0.008, d * 0.3);
    const g = new THREE.ExtrudeGeometry(s, { depth: d - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 2 });
    g.translate(x, y, z - (d - bevel * 2) / 2);
    colorize(g, color);
  };
  const W = 0.32, D = 0.24, H = 0.36, t = level === 1 ? 0.035 : 0.05;
  plate(W, H, t, 0, H / 2, -D / 2, main);                   // front plate
  plate(W, H * 1.05, t, 0, H * 0.525, D / 2, main);         // back plate
  for (const sx of [-1, 1]) {
    box(t * 0.8, H * 0.4, D, sx * (W / 2 - t / 2), H * 0.23, 0, dark);   // side cummerbund
    box(0.07, t * 0.7, D + t * 0.6, sx * 0.095, H - t * 0.35, 0, dark);  // shoulder strap
  }
  if (level === 1) {
    for (const y of [0.12, 0.22]) box(W * 0.86, 0.035, 0.012, 0, y, -D / 2 - t / 2 - 0.004, dark); // velcro straps
  }
  if (level >= 2) {
    for (const px of [-0.09, 0, 0.09]) plate(0.075, 0.1, 0.045, px, 0.09, -D / 2 - t / 2 - 0.02, dark, 0.012);   // mag pouches
    plate(0.2, 0.06, 0.035, 0, 0.2, -D / 2 - t / 2 - 0.015, dark, 0.012);                                       // admin pouch
  }
  if (level >= 3) {
    box(0.26, 0.06, 0.05, 0, H + 0.02, -D / 2 + 0.04, main, -0.5);       // collar front
    box(0.3, 0.07, 0.05, 0, H + 0.03, D / 2 - 0.02, main, 0.4);          // collar back
    plate(0.14, 0.1, t, 0, -0.05, -D / 2 - 0.005, main, 0.02);           // groin plate
    for (const sx of [-1, 1]) plate(0.06, 0.12, 0.05, sx * 0.13, 0.22, -D / 2 - t / 2 - 0.02, dark, 0.012);
  }
  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return mergeVertices(merged, 1e-5);
}
const report = {};
const geos = {};
for (const [id, spec] of Object.entries(ITEMS)) {
  const geo = spec.procedural ? proceduralVest(spec.level, spec.colors) : bake(await source(spec.src), spec);
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
      // Uniform fit to the head width (+12 %); the shell top sits just above the scalp / hair.
      const k = (Math.max(headW, headD * 0.92) * 1.12) / Math.max(gs.x, gs.z);
      const pos = new THREE.Vector3((head.min.x + head.max.x) / 2, head.max.y + 0.012 - gs.y * k, (head.min.z + head.max.z) / 2 - 0.005);
      world = new THREE.Matrix4().compose(pos, face, new THREE.Vector3(k, k, k));
      wear[rig][id] = local(bones.Head, world);
    } else if (spec.gear === 'vest') {
      // Non-uniform fit around the rib cage: width +18 %, depth +22 %, from the waist to the
      // shoulders (collar of the level-3 carrier above that).
      const top = torso.max.y - 0.02, bottom = torso.min.y + (torso.max.y - torso.min.y) * 0.18;
      const sc = new THREE.Vector3((torsoW * 1.18) / gs.x, (top - bottom) / gs.y, (torsoD * 1.22) / gs.z);
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
console.log('next: node scripts/assets/sync-manifest.mjs');
