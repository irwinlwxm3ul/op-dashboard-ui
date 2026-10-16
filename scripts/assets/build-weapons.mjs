#!/usr/bin/env node
// Builds public/assets/models/weapons/<WeaponId>.glb from the Quaternius Ultimate Guns Pack (CC0,
// FBX; pinned in sources.mjs). Each gun is re-coloured with the shared palette, merged to one
// vertex-coloured mesh, oriented barrel -Z, scaled to a real-world length and translated so the
// right-hand grip (fist centre) is the origin. Hold points were measured on orthographic side
// views with a 1 cm / 5 cm grid (d = distance from the rear of the stock, y = height above the
// lowest point, both in metres after scaling) and are exported as empty marker nodes too.
// Usage: node scripts/assets/build-weapons.mjs  (prints the manifest values)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInPage, MODELS_DIR } from './harness.mjs';
import { DL, UGP } from './sources.mjs';

import { WEAPONS } from './build-weapons.config.mjs';

const outDir = path.join(MODELS_DIR, 'weapons');
fs.mkdirSync(outDir, { recursive: true });

const page = `
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { toBase64 } from '/scripts/page-lib.js';
import { bakeToSingleGeometry, paletteColor, orientLongAxis, meanYAt, weaponObject, geometryTris } from '/scripts/weapons.page.js';
import { exportGlb } from '/scripts/characters.page.js';
const WEAPONS = ${JSON.stringify(WEAPONS)};
const OUT = ${JSON.stringify(outDir)};
const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
const loader = new FBXLoader();
const report = {};
for (const [id, w] of Object.entries(WEAPONS)) {
  const src = await loader.loadAsync('/dl/' + enc(${JSON.stringify(UGP)}) + '/' + w.src + '.fbx');
  const geo = orientLongAxis(bakeToSingleGeometry(src, paletteColor), '+x');
  geo.computeBoundingBox();
  let b = geo.boundingBox;
  const s = w.length / (b.max.z - b.min.z);
  geo.scale(s, s, s);
  geo.computeBoundingBox(); b = geo.boundingBox;
  // Measurement frame: x centred, rear at z = 0 (muzzle toward -z), lowest point at y = 0.
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -b.max.z);
  const P = ([d, y]) => [0, y, -d];
  const grip = P(w.grip);
  geo.translate(-grip[0], -grip[1], -grip[2]);
  const rel = (p) => p ? [+(p[0] - grip[0]).toFixed(4), +(p[1] - grip[1]).toFixed(4), +(p[2] - grip[2]).toFixed(4)] : null;
  geo.computeBoundingBox(); b = geo.boundingBox;
  const muzzleZ = b.min.z;
  const muzzle = [0, +meanYAt(geo, muzzleZ + 0.004, 0.006).toFixed(4), +muzzleZ.toFixed(4)];
  const markers = {
    Grip: [0, 0, 0],
    Muzzle: muzzle,
    Sight: rel(P(w.sight)),
  };
  if (w.support) markers.Support = rel(P(w.support));
  else markers.Support = [-0.03, -0.02, 0.01];
  markers.Butt = w.butt ? rel(P(w.butt)) : [0, 0, 0];
  geo.computeBoundingSphere();
  const obj = weaponObject('weapon_' + id, geo, markers);
  const buf = await exportGlb(obj, []);
  await window.__writeFile(OUT + '/' + id + '.glb', toBase64(buf));
  report[id] = { ...markers, tris: geometryTris(geo), bytes: buf.byteLength, bbox: { min: b.min.toArray().map((v) => +v.toFixed(3)), max: b.max.toArray().map((v) => +v.toFixed(3)) } };
}
window.__done(report);
`;

const { result } = await runInPage(page, { mounts: { '/dl/': DL } });
const reports = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports');
fs.mkdirSync(reports, { recursive: true });
fs.writeFileSync(path.join(reports, 'weapons.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 0).replace(/\},"/g, '},\n"'));
console.log('next: node scripts/assets/sync-manifest.mjs');
