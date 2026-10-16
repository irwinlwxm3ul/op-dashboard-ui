#!/usr/bin/env node
// Renders review screenshots of the curated models with three.js in headless Chromium:
//   characters.png  every variant (idle) + one variant in key poses
//   weapons.png     all guns side by side (weapon frame, grip at origin marked)
//   held.png        a character aiming / holding every gun via the weapon socket
//   items.png       loot items and gear (when present in the manifest)
// Usage: node scripts/assets/preview.mjs [outDir]   (default: ./test-results/assets-preview)
import path from 'node:path';
import fs from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { runInPage, REPO_ROOT } from './harness.mjs';

const outDir = path.resolve(process.argv[2] || path.join(REPO_ROOT, 'test-results', 'assets-preview'));
fs.mkdirSync(outDir, { recursive: true });
const M = await tsImport('../../src/client/assets/manifest.ts', import.meta.url);
const W = 1600, H = 720;

const data = {
  variants: Object.values(M.CHARACTER_VARIANTS),
  rigs: M.CHARACTER_RIGS,
  clips: M.CHARACTER_CLIPS,
  weapons: M.WEAPON_MODELS ?? {},
  items: M.ITEM_MODELS ?? {},
  upper: M.UPPER_BODY_BONES,
};

const page = `
import * as THREE from 'three';
import { SkeletonUtils, loadGltf, makeStage, enableShadows, addLabels } from '/scripts/page-lib.js';
const D = ${JSON.stringify(data)};
const OUT = ${JSON.stringify(outDir)};
const W = ${W}, H = ${H};
const upper = new Set(D.upper);
const lower = (c) => new THREE.AnimationClip(c.name + '#lower', c.duration, c.tracks.filter((t) => !upper.has(t.name.slice(0, t.name.lastIndexOf('.')))));
const upperOnly = (c) => new THREE.AnimationClip(c.name + '#upper', c.duration, c.tracks.filter((t) => upper.has(t.name.slice(0, t.name.lastIndexOf('.')))));
const libs = {};
for (const [id, r] of Object.entries(D.rigs)) libs[id] = new Map((await loadGltf('/models/' + r.animations)).animations.map((c) => [c.name, c]));
const chars = {};
for (const v of D.variants) chars[v.id] = await loadGltf('/models/' + v.file);
const weapons = {};
for (const [id, w] of Object.entries(D.weapons)) weapons[id] = await loadGltf('/models/' + w.file);

function frame(stage, objs, labels, { y = 0.9, dist = 0.95, rotY = 0 } = {}) {
  let x = 0; const proj = [];
  for (const o of objs) { const g = new THREE.Group(); g.add(o); g.rotation.y = rotY; g.position.x = x; enableShadows(g); stage.scene.add(g); proj.push(new THREE.Vector3(x, 0, 0)); x += 1.2; }
  const cx = (x - 1.2) / 2;
  stage.camera.position.set(cx, y + 0.35, x * dist + 0.8); stage.camera.lookAt(cx, y, 0);
  stage.sun.target.position.set(cx, 0, 0); stage.scene.add(stage.sun.target); stage.sun.position.set(cx + 4, 10, 8);
  const sh = stage.sun.shadow.camera; sh.left = sh.bottom = -x; sh.right = sh.top = x; sh.updateProjectionMatrix();
  stage.renderer.render(stage.scene, stage.camera);
  addLabels(labels, proj.map((p) => p.project(stage.camera)), W, H);
}

function pose(variantId, baseKey, overlayKey, t, weaponId) {
  const v = D.variants.find((x) => x.id === variantId);
  const clips = libs[v.rig];
  const o = SkeletonUtils.clone(chars[variantId].scene);
  const mixer = new THREE.AnimationMixer(o);
  const base = clips.get(D.clips[baseKey].clip);
  mixer.clipAction(overlayKey ? lower(base) : base).play();
  if (overlayKey) mixer.clipAction(upperOnly(clips.get(D.clips[overlayKey].clip))).play();
  mixer.update(t);
  o.updateMatrixWorld(true);
  if (weaponId && weapons[weaponId]) {
    let hand; o.traverse((b) => { if (b.name === 'WristR') hand = b; });
    const s = D.rigs[v.rig].socket;
    const socket = new THREE.Object3D(); socket.position.fromArray(s.position); socket.quaternion.fromArray(s.quaternion);
    hand.add(socket); o.updateMatrixWorld(true);
    const ws = hand.getWorldScale(new THREE.Vector3()); socket.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
    socket.add(weapons[weaponId].scene.clone(true));
  }
  o.traverse((m) => { if (m.name === 'TeamBand') { m.material = m.material.clone(); m.material.color.set(0xe0a020); } });
  return o;
}

// 1. characters
{
  const stage = makeStage({ width: W, height: H });
  const objs = D.variants.map((v) => pose(v.id, 'idle', null, 0.4));
  frame(stage, objs, D.variants.map((v) => v.id), { rotY: 0.35 });
  await window.__shot(OUT + '/characters.png');
  stage.renderer.domElement.remove();
}
{
  const stage = makeStage({ width: W, height: H });
  const keys = [['run', 'holdRifle', 'ar'], ['crouchWalk', 'aimRifle', 'ar'], ['sprint', 'sprintRifle', 'ar'], ['idle', 'reloadRifle', 'ar'], ['idle', 'aimPistol', 'pistol'], ['prone', null, null], ['swim', null, null], ['death', null, null]];
  const objs = keys.map(([b, o, w], i) => pose(D.variants[i % D.variants.length].id, b, o, (D.clips[o || b].duration) * 0.45, w));
  frame(stage, objs, keys.map(([b, o]) => b + (o ? '+' + o : '')), { rotY: Math.PI * 0.62 });
  await window.__shot(OUT + '/poses.png');
  stage.renderer.domElement.remove();
}
// 2. weapons (side view, sorted by length)
if (Object.keys(weapons).length) {
  const stage = makeStage({ width: W, height: H, ground: false, background: 0xc9d1d6 });
  stage.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const ids = Object.keys(weapons);
  let y = 0; const proj = [];
  for (const id of ids) {
    const g = weapons[id].scene.clone(true);
    g.rotation.y = -Math.PI / 2; // barrel to +X (screen right)
    g.position.set(0, y, 0); stage.scene.add(g);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008), new THREE.MeshBasicMaterial({ color: 0xff0000 })); dot.position.set(0, y, 0.05); stage.scene.add(dot);
    proj.push(new THREE.Vector3(-0.45, y - 0.08, 0)); y -= 0.3;
  }
  stage.camera.position.set(0.15, y / 2 + 0.15, 2.1); stage.camera.lookAt(0.15, y / 2 + 0.15, 0);
  stage.renderer.render(stage.scene, stage.camera);
  addLabels(ids, proj.map((p) => p.project(stage.camera)), W, H);
  document.querySelectorAll('.lbl').forEach((e, i) => { e.style.top = ((1 - proj[i].clone().project(stage.camera).y) / 2 * H) + 'px'; e.style.left = '120px'; e.style.transform = 'none'; });
  await window.__shot(OUT + '/weapons.png');
  stage.renderer.domElement.remove();
}
// 3. held
if (Object.keys(weapons).length) {
  const stage = makeStage({ width: W, height: H });
  const ids = Object.keys(weapons);
  const objs = ids.map((id, i) => pose(D.variants[i % D.variants.length].id, 'idle', id === 'pistol' ? 'aimPistol' : 'aimRifle', 0.3, id));
  frame(stage, objs, ids.map((id) => 'aim ' + id), { rotY: Math.PI * 0.6, y: 1.25, dist: 0.6 });
  await window.__shot(OUT + '/held.png');
  stage.renderer.domElement.remove();
}
// 4. items
if (Object.keys(D.items).length) {
  const stage = makeStage({ width: W, height: H });
  const ids = Object.keys(D.items);
  const objs = [];
  for (const id of ids) { const g = await loadGltf('/models/' + D.items[id].file); const o = g ? g.scene.clone(true) : new THREE.Group(); o.scale.setScalar(2.2); objs.push(o); }
  let x = 0; const proj = [];
  for (const o of objs) { o.position.x = x; enableShadows(o); stage.scene.add(o); proj.push(new THREE.Vector3(x, 0, 0)); x += 0.75; }
  const cx = (x - 0.75) / 2;
  stage.camera.position.set(cx, 1.6, x * 0.75 + 0.6); stage.camera.lookAt(cx, 0.2, 0);
  stage.renderer.render(stage.scene, stage.camera);
  addLabels(ids, proj.map((p) => p.project(stage.camera)), W, H);
  await window.__shot(OUT + '/items.png');
}
window.__done(true);
`;

await runInPage(page, { viewport: { width: W, height: H }, timeoutMs: 600_000 });
console.log('screenshots written to', outDir);
