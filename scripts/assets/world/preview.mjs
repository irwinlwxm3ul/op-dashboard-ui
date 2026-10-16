#!/usr/bin/env node
// Lineup screenshot of arbitrary glTF/GLB files (candidate review and final QA).
// Usage: node scripts/assets/world/preview.mjs <out.png> [--size WxH] [--elev rad] [--norm] <label=path>...
// Paths are absolute (under $ASSETS_DL or the repo) or relative to public/assets/models.
// --norm scales every object to the same height so very differently sized files can be compared.
import path from 'node:path';
import { runInPage, MODELS_DIR, REPO_ROOT } from '../harness.mjs';

const DL = process.env.ASSETS_DL || '/tmp/claude-0/assets-dl';
const args = process.argv.slice(2);
const out = path.resolve(args.shift());
let width = 1600, height = 700, elevation = 0.3, norm = false, yaw = 0.6;
const items = [];
while (args.length) {
  const a = args.shift();
  if (a === '--size') { const [w, h] = args.shift().split('x').map(Number); width = w; height = h; continue; }
  if (a === '--elev') { elevation = Number(args.shift()); continue; }
  if (a === '--yaw') { yaw = Number(args.shift()); continue; }
  if (a === '--norm') { norm = true; continue; }
  const eq = a.indexOf('=');
  const label = eq > 0 ? a.slice(0, eq) : path.basename(a);
  const p = eq > 0 ? a.slice(eq + 1) : a;
  let url;
  const abs = path.resolve(p.startsWith('/') ? p : path.join(MODELS_DIR, p));
  if (abs.startsWith(DL + '/')) url = '/dl/' + abs.slice(DL.length + 1);
  else if (abs.startsWith(REPO_ROOT + '/')) url = '/repo/' + abs.slice(REPO_ROOT.length + 1);
  else throw new Error('unsupported path ' + abs);
  // A '#Node' suffix shows only that node of the file (multi-variant files).
  items.push({ label, url: url.split('/').map(encodeURIComponent).join('/').replace(/%23/g, '#') });
}

const page = `
import { THREE, makeStage, lineup, addLabels, enableShadows, sceneStats, loadGltf } from '/scripts/page-lib.js';
const items = ${JSON.stringify(items)};
const stage = makeStage({ width: ${width}, height: ${height} });
const objs = [], names = [], stats = [];
for (const it of items) {
  const [u, node] = it.url.split('#');
  const g = await loadGltf(decodeURI(u).split('/').map(encodeURIComponent).join('/'));
  let o = g.scene;
  if (node) { const n = g.scene.getObjectByName(node); if (!n) throw new Error('no node ' + node + ' in ' + u); n.parent.remove(n); n.position.set(0, 0, 0); o = new THREE.Group(); o.add(n); }
  enableShadows(o);
  const holder = new THREE.Group(); holder.add(o); holder.rotation.y = ${yaw};
  if (${norm}) { const b = new THREE.Box3().setFromObject(holder, true); const s = b.getSize(new THREE.Vector3()); holder.scale.setScalar(2 / Math.max(s.y, 1e-3)); }
  stats.push({ label: it.label, ...sceneStats(o) });
  objs.push(holder); names.push(it.label);
}
const proj = [];
lineup(stage, objs, { gap: 0.6, elevation: ${elevation}, labelsTo: proj });
addLabels(names, proj, ${width}, ${height});
stage.renderer.render(stage.scene, stage.camera);
await window.__shot(${JSON.stringify(out)});
window.__done(stats);
`;
const { result } = await runInPage(page, { viewport: { width, height }, mounts: { '/dl/': DL, '/repo/': REPO_ROOT } });
for (const s of result) console.log(s.label.padEnd(28), 'tris', String(s.tris).padStart(6), 'meshes', s.meshes, 'mats', s.materials, 'size', s.bbox.size.join(' x '));
console.log('wrote', out);
