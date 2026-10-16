#!/usr/bin/env node
// Loads every world asset (manifest-world.ts) with three.js 0.186 GLTFLoader in headless Chromium
// (SwiftShader WebGL), checks the nodes / attributes the manifest promises, prints triangle /
// texture stats and renders QA lineups (vehicles posed with steering + collision boxes, props,
// every tree variant and LOD, rocks / bushes / grass) into <outDir> (default $TMPDIR/world-assets-qa).
// Exit code 1 on any problem. Usage: node scripts/assets/world/verify.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { runInPage, MODELS_DIR } from '../harness.mjs';

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'world-assets-qa'));
fs.mkdirSync(outDir, { recursive: true });
const W = await tsImport('../../../src/client/assets/manifest-world.ts', import.meta.url);
const { VEHICLES } = await tsImport('../../../src/shared/vehicles/defs.ts', import.meta.url);

const files = [];
for (const c of ['vehicles', 'props', 'nature']) for (const f of W.worldAssetFilesFor(c)) files.push({ category: c, file: f });
const problems = [];
for (const { file } of files) if (!fs.existsSync(path.join(MODELS_DIR, file))) problems.push(`missing ${file}`);

const expectNodes = {};
for (const v of Object.values(W.VEHICLE_MODELS)) expectNodes[v.file] = [...v.bodyMeshes, ...(v.glassMesh ? [v.glassMesh] : []), ...v.wheels.map((w) => w.node), ...(v.fork ? ['Fork'] : [])];
for (const p of Object.values(W.PROP_MODELS)) expectNodes[p.file] = [...p.meshes];
for (const t of Object.values(W.NATURE_MODELS.trees)) expectNodes[t.file] = t.variants.flatMap((v) => [v.node, v.lod1Node, v.bark, v.lod1Bark, ...(v.leaves ? [v.leaves, v.lod1Leaves] : [])]);
for (const k of ['rocks', 'bushes', 'grass']) {
  const n = W.NATURE_MODELS[k];
  expectNodes[n.file] = n.variants.flatMap((v) => [v.node, ...(v.lod1Node ? [v.lod1Node] : [])]);
}

const page = `
import * as THREE from 'three';
import { loadGltf, sceneStats, makeStage, lineup, addLabels, enableShadows } from '/scripts/page-lib.js';
const files = ${JSON.stringify(files)};
const expectNodes = ${JSON.stringify(expectNodes)};
const vehicles = ${JSON.stringify(W.VEHICLE_MODELS)};
const defs = ${JSON.stringify(VEHICLES)};
const nature = ${JSON.stringify(W.NATURE_MODELS)};
const props = ${JSON.stringify(W.PROP_MODELS)};
const outDir = ${JSON.stringify(outDir)};
const loaded = {};
const out = { files: [], problems: [] };
for (const f of files) {
  let g;
  try { g = await loadGltf('/models/' + f.file); } catch (e) { out.problems.push(f.file + ': ' + (e && e.message || e)); continue; }
  loaded[f.file] = g;
  const st = sceneStats(g.scene);
  let maxTex = 0;
  const seen = new Set();
  g.scene.traverse((o) => { if (!o.isMesh) return; for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) { const t = o.material[k]; if (t && !seen.has(t)) { seen.add(t); maxTex = Math.max(maxTex, t.image.width, t.image.height); } } });
  for (const n of expectNodes[f.file] || []) if (!g.scene.getObjectByName(n)) out.problems.push(f.file + ': missing node ' + n);
  if (f.category === 'nature' && f.file !== nature.rocks.file) {
    g.scene.traverse((o) => { if (o.isMesh && !o.geometry.attributes._sway) out.problems.push(f.file + ': ' + o.name + ' has no _sway'); });
  }
  out.files.push({ ...f, tris: st.tris, meshes: st.meshes, materials: st.materials, textures: seen.size, maxTex, size: st.bbox.size });
}
const shot = async (name) => { await window.__shot(outDir + '/' + name); };
const clear = (stage) => { stage.renderer.domElement.remove(); document.querySelectorAll('.lbl').forEach((e) => e.remove()); };

// --- vehicles: rest pose + steering / spinning + physics collision box --------------------------
{
  const stage = makeStage({ width: 2000, height: 700 });
  const objs = [], names = [];
  for (const [type, v] of Object.entries(vehicles)) {
    for (const steer of [0, 0.5]) {
      const root = loaded[v.file].scene.clone(true);
      for (const w of v.wheels) {
        const n = root.getObjectByName(w.node);
        n.rotation.order = 'YXZ';
        n.rotation.x = steer * 2;
        if (w.steers && !w.parent) n.rotation.y = steer;
      }
      if (v.fork) root.getObjectByName('Fork').rotation.y = steer;
      const h = defs[type].halfExtents;
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2)), new THREE.LineBasicMaterial({ color: 0xff00ff }));
      root.add(box);
      enableShadows(root);
      const holder = new THREE.Group(); holder.add(root); holder.rotation.y = 0.9;
      objs.push(holder); names.push(type + (steer ? ' steer 0.5' : ''));
    }
  }
  const proj = [];
  lineup(stage, objs, { gap: 1, elevation: 0.3, labelsTo: proj });
  addLabels(names, proj, 2000, 700);
  stage.renderer.render(stage.scene, stage.camera);
  await shot('vehicles.png');
  clear(stage);
}
// --- props -------------------------------------------------------------------------------------
{
  const stage = makeStage({ width: 2000, height: 700 });
  const objs = [], names = [];
  for (const p of Object.values(props)) {
    const o = loaded[p.file].scene.clone(true); enableShadows(o);
    const holder = new THREE.Group(); holder.add(o); holder.rotation.y = 0.35;
    objs.push(holder); names.push(p.id);
  }
  const proj = [];
  lineup(stage, objs, { gap: 0.5, elevation: 0.25, labelsTo: proj });
  addLabels(names, proj, 2000, 700);
  stage.renderer.render(stage.scene, stage.camera);
  await shot('props.png');
  clear(stage);
}
// --- trees (every variant LOD0, then LOD1) at a common 10 m height -----------------------------
for (const lod of [0, 1]) {
  const stage = makeStage({ width: 2000, height: 700 });
  const objs = [], names = [];
  for (const t of Object.values(nature.trees)) {
    for (const v of t.variants) {
      const n = loaded[t.file].scene.getObjectByName(lod ? v.lod1Node : v.node).clone(true);
      n.position.set(0, 0, 0); n.scale.setScalar(10); enableShadows(n);
      objs.push(n); names.push(v.node);
    }
  }
  const proj = [];
  lineup(stage, objs, { gap: 0.5, elevation: 0.1, labelsTo: proj });
  addLabels(names, proj, 2000, 700);
  stage.renderer.render(stage.scene, stage.camera);
  await shot(lod ? 'trees-lod1.png' : 'trees.png');
  clear(stage);
}
// --- rocks (r = 1.2 m, h = 1 m), bushes, grass (0.5 m) -----------------------------------------
{
  const stage = makeStage({ width: 2000, height: 700 });
  const objs = [], names = [];
  const add = (file, node, s) => { const n = loaded[file].scene.getObjectByName(node).clone(true); n.position.set(0, 0, 0); n.scale.set(...s); enableShadows(n); objs.push(n); names.push(node); };
  for (const v of nature.rocks.variants) add(nature.rocks.file, v.node, [1.2, 1, 1.2]);
  for (const v of nature.bushes.variants) add(nature.bushes.file, v.node, [1, 1, 1]);
  for (const v of nature.grass.variants) add(nature.grass.file, v.node, [0.5, 0.5, 0.5]);
  const proj = [];
  lineup(stage, objs, { gap: 0.4, elevation: 0.25, labelsTo: proj });
  addLabels(names, proj, 2000, 700);
  stage.renderer.render(stage.scene, stage.camera);
  await shot('nature-misc.png');
  clear(stage);
}
window.__done(out);
`;

const { result } = await runInPage(page, { viewport: { width: 2000, height: 700 }, timeoutMs: 600_000 });
problems.push(...result.problems);
const B = W.WORLD_ASSET_BUDGETS;
console.log('file'.padEnd(30), 'cat'.padEnd(9), 'KB'.padStart(6), 'tris'.padStart(6), 'mesh', 'mat', 'tex', 'maxTex', 'size (m)');
let total = 0;
for (const r of result.files) {
  const kb = Math.round(fs.statSync(path.join(MODELS_DIR, r.file)).size / 1024);
  total += kb;
  if (r.maxTex > B.textureSize) problems.push(`${r.file}: texture ${r.maxTex}px`);
  if (r.category !== 'nature' && r.tris > B.tris[r.category]) problems.push(`${r.file}: ${r.tris} tris > ${B.tris[r.category]}`);
  console.log(r.file.padEnd(30), r.category.padEnd(9), String(kb).padStart(6), String(r.tris).padStart(6), String(r.meshes).padStart(4), String(r.materials).padStart(3), String(r.textures).padStart(3), String(r.maxTex).padStart(6), r.size.join(' x '));
}
for (const t of Object.values(W.NATURE_MODELS.trees)) for (const v of t.variants) if (v.tris > B.tris.nature) problems.push(`${v.node}: ${v.tris} tris`);
console.log(`world assets: ${(total / 1024).toFixed(2)} MB in ${result.files.length} GLBs; screenshots in ${outDir}`);
if (problems.length) {
  console.error('\nPROBLEMS:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('verify-world: OK');
