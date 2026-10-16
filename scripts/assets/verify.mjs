#!/usr/bin/env node
// Loads every curated model with three.js GLTFLoader in headless Chromium (SwiftShader WebGL) and
// prints mesh / triangle / skin / clip counts and bounding boxes. Characters are additionally
// animated with every clip of CHARACTER_CLIPS to catch broken retargets (NaNs, exploding bounds).
// Fails (exit 1) on a missing/unloadable file, a manifest clip that does not exist, or a budget
// overrun. Usage: node scripts/assets/verify.mjs [--quiet]
import fs from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { runInPage, MODELS_DIR } from './harness.mjs';

const quiet = process.argv.includes('--quiet');
const M = await tsImport('../../src/client/assets/manifest.ts', import.meta.url);
const categories = ['characters', 'weapons', 'items'];
// Folders owned by manifest.ts (vehicles / props / nature belong to manifest-world.ts).
const OWN_DIRS = ['characters', 'animations', 'weapons', 'items'];
const files = [];
for (const c of categories) for (const f of M.assetFilesFor(c)) files.push({ category: c, file: f });

const problems = [];
for (const { file } of files) if (!fs.existsSync(path.join(MODELS_DIR, file))) problems.push(`missing file ${file}`);

// Orphans: files on disk the manifest does not reference.
const onDisk = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else onDisk.push(path.relative(MODELS_DIR, p)); } };
walk(MODELS_DIR);
const referenced = new Set(files.map((f) => f.file));
const orphans = onDisk.filter((f) => f.endsWith('.glb') && OWN_DIRS.includes(f.split('/')[0]) && !referenced.has(f));
const totalBytes = onDisk.reduce((a, f) => a + fs.statSync(path.join(MODELS_DIR, f)).size, 0);
if (totalBytes > M.ASSET_BUDGETS.totalBytes) problems.push(`models total ${totalBytes} B > budget ${M.ASSET_BUDGETS.totalBytes}`);

const characters = Object.values(M.CHARACTER_VARIANTS).map((v) => ({ id: v.id, file: v.file, anims: M.CHARACTER_RIGS[v.rig].animations }));
const clipSpecs = Object.entries(M.CHARACTER_CLIPS).filter(([, s]) => s).map(([k, s]) => [k, s.clip, s.layer]);

const page = `
import * as THREE from 'three';
import { loadGltf, sceneStats } from '/scripts/page-lib.js';
const files = ${JSON.stringify(files.filter(({ file }) => fs.existsSync(path.join(MODELS_DIR, file))))};
const characters = ${JSON.stringify(characters)};
const clipSpecs = ${JSON.stringify(clipSpecs)};
const out = { files: [], characters: [] };
const textureInfo = (root) => {
  const seen = new Set(); let max = 0;
  root.traverse((o) => { if (!o.isMesh) return; for (const m of [].concat(o.material)) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) { const t = m[k]; if (t && !seen.has(t)) { seen.add(t); max = Math.max(max, t.image?.width || 0, t.image?.height || 0); } } });
  return { textures: seen.size, maxTexture: max };
};
for (const f of files) {
  let g = null, error = null;
  try { g = await loadGltf('/models/' + f.file); } catch (e) { error = String(e && e.message || e); }
  if (!g) { out.files.push({ ...f, error: error || 'load failed' }); continue; }
  const st = sceneStats(g.scene);
  out.files.push({ ...f, ...st, ...textureInfo(g.scene), clips: g.animations.length, nodes: (() => { let n = 0; g.scene.traverse(() => n++); return n; })() });
}
// Character animation smoke test.
for (const c of characters) {
  const g = await loadGltf('/models/' + c.file);
  const a = await loadGltf('/models/' + c.anims);
  const res = { id: c.id, missing: [], bad: [], heights: {} };
  const clips = new Map(a.animations.map((x) => [x.name, x]));
  for (const [key, name, layer] of clipSpecs) {
    const clip = clips.get(name);
    if (!clip) { res.missing.push(key + ':' + name); continue; }
    const root = g.scene;
    const mixer = new THREE.AnimationMixer(root);
    const act = mixer.clipAction(clip); act.play();
    mixer.update(clip.duration * 0.5);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let nan = false;
    root.traverse((o) => { if (o.isBone) { const e = o.matrixWorld.elements; for (const v of e) if (!Number.isFinite(v)) nan = true; } });
    root.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingBox(); box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    const size = box.getSize(new THREE.Vector3());
    res.heights[key] = +size.y.toFixed(2);
    if (nan || size.length() > 4.5 || size.length() < 0.3) res.bad.push(key + ':' + name + (nan ? ' NaN' : ' size ' + size.toArray().map((v) => v.toFixed(2))));
    mixer.stopAllAction(); mixer.uncacheRoot(root);
  }
  out.characters.push(res);
}
window.__done(out);
`;

const { result } = await runInPage(page, { timeoutMs: 600_000 });
const budgets = M.ASSET_BUDGETS;
console.log('file'.padEnd(44), 'cat'.padEnd(10), 'KB'.padStart(6), 'tris'.padStart(6), 'mesh', 'skin', 'bone', 'clip', 'tex', 'size (m)');
for (const r of result.files) {
  const kb = Math.round(fs.statSync(path.join(MODELS_DIR, r.file)).size / 1024);
  if (r.error) { problems.push(`load error ${r.file}: ${r.error}`); console.log(r.file.padEnd(44), 'ERROR', r.error); continue; }
  const triBudget = r.file.startsWith('animations/') ? Infinity : budgets.tris[r.category];
  if (r.tris > triBudget) problems.push(`${r.file}: ${r.tris} tris > ${triBudget}`);
  if (r.maxTexture > budgets.textureSize) problems.push(`${r.file}: texture ${r.maxTexture}px > ${budgets.textureSize}`);
  if (r.category === 'characters' && !r.file.startsWith('animations/') && kb * 1024 > budgets.characterBytes) problems.push(`${r.file}: ${kb} KB > character budget`);
  if (!quiet) console.log(r.file.padEnd(44), r.category.padEnd(10), String(kb).padStart(6), String(r.tris).padStart(6), String(r.meshes).padStart(4), String(r.skinned).padStart(4), String(r.bones).padStart(4), String(r.clips).padStart(4), String(r.textures).padStart(3), r.bbox.size.join(' x '));
}
for (const c of result.characters) {
  for (const m of c.missing) problems.push(`${c.id}: missing clip ${m}`);
  for (const b of c.bad) problems.push(`${c.id}: suspicious pose ${b}`);
  if (!quiet) console.log(`${c.id}: ${clipSpecs.length - c.missing.length}/${clipSpecs.length} clips play; heights idle ${c.heights.idle} crouch ${c.heights.crouchIdle} prone ${c.heights.prone} swim ${c.heights.swim}`);
}
console.log(`total models size ${(totalBytes / 1024 / 1024).toFixed(2)} MB in ${onDisk.length} files; manifest references ${files.length}`);
if (orphans.length) console.log('unreferenced GLBs (not loaded by the game):', orphans.join(', '));
if (problems.length) {
  console.error('\nPROBLEMS:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('verify: OK');
