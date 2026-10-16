#!/usr/bin/env node
// Rewrites the generated regions of src/client/assets/manifest.ts from the build reports
// (scripts/assets/reports/{weapons,items}.json) so measured values never get hand-copied:
//   // <generated:weapons> ... // </generated:weapons>
//   // <generated:items> ... // </generated:items>
//   // <generated:wear> ... // </generated:wear>
// Usage: node scripts/assets/sync-manifest.mjs   (run after build-weapons / build-items)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './harness.mjs';
import { WEAPONS } from './build-weapons.config.mjs';
import { ITEM_SOURCES } from './build-items.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(REPO_ROOT, 'src', 'client', 'assets', 'manifest.ts');
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, 'reports', f), 'utf8'));
const v = (a) => `[${a.map((x) => +(+x).toFixed(4)).join(', ')}]`;

function region(src, name, body) {
  const re = new RegExp(`(// <generated:${name}>[^\\n]*\\n)[\\s\\S]*?(\\n\\s*// </generated:${name}>)`);
  if (!re.test(src)) throw new Error(`manifest.ts has no generated region '${name}'`);
  return src.replace(re, `$1${body}$2`);
}

let src = fs.readFileSync(manifestPath, 'utf8');
const weapons = read('weapons.json');
src = region(src, 'weapons', Object.entries(weapons).map(([id, w]) => {
  const c = WEAPONS[id];
  const length = c.length;
  return `  ${id}: weapon('${id}', '${c.src}', ${w.tris}, ${length}, ${!!c.pistol}, '${c.optic}', ${v(w.Butt)}, ${v(w.Support)}, ${v(w.Muzzle)}, ${v(w.Sight)}),`;
}).join('\n'));
const items = read('items.json');
src = region(src, 'items', Object.entries(items.items).map(([id, it]) => {
  const s = ITEM_SOURCES[id];
  return `  ${id}: item('${id}', '${s.category}', '${s.label}', ${it.tris}, ${v(it.size)}),`;
}).join('\n'));
src = region(src, 'wear', Object.entries(items.wear).map(([rig, entries]) => {
  const lines = Object.entries(entries).filter(([k]) => !k.startsWith('__'))
    .map(([id, w]) => `    ${id}: { bone: '${w.bone}', position: ${v(w.position)}, quaternion: ${v(w.quaternion)}, scale: ${v(w.scale)} },`);
  return `  ${rig}: {\n${lines.join('\n')}\n  },`;
}).join('\n'));
fs.writeFileSync(manifestPath, src);
console.log('manifest.ts generated regions updated');
