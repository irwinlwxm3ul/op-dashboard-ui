#!/usr/bin/env node
// Builds public/assets/models/{vehicles,props,nature}/*.glb from the pinned sources (sources.mjs;
// run fetch-sources.mjs first). All processing happens in headless Chromium with three.js
// (GLTFLoader -> transform / simplify / retexture -> GLTFExporter), see *.page.js.
// Usage: node scripts/assets/world/build.mjs [vehicles] [props] [nature]   (default: all)
// Writes a measurement report to scripts/assets/world/reports/<category>.json; the numbers in
// src/client/assets/manifest-world.ts (wheel centres / radii, fork axis, trunk radii, ...) are
// copied from there.
import fs from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { runInPage, MODELS_DIR, REPO_ROOT } from '../harness.mjs';
import { DL, MEGAKIT, ULTNAT, ZOMBIE, PHA, PHB, LUAZ, DIRTBIKE, SANDBAG } from './sources.mjs';

const { VEHICLES } = await tsImport('../../../src/shared/vehicles/defs.ts', import.meta.url);
const rideHeight = (t) => VEHICLES[t].groundClearance + VEHICLES[t].halfExtents.y;

const cats = process.argv.slice(2).length ? process.argv.slice(2) : ['vehicles', 'props', 'nature'];
const REPORTS = path.join(REPO_ROOT, 'scripts', 'assets', 'world', 'reports');
fs.mkdirSync(REPORTS, { recursive: true });
const out = (rel) => {
  const p = path.join(MODELS_DIR, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

const JOBS = {
  vehicles: {
    module: '/scripts/world/vehicles.page.js',
    calls: [
      ['buildLuaz', { src: LUAZ, out: out('vehicles/uaz.glb'), length: VEHICLES.uaz.halfExtents.z * 2, rideHeight: rideHeight('uaz') }],
      ['buildBike', {
        src: DIRTBIKE, out: out('vehicles/bike.glb'), length: VEHICLES.bike.halfExtents.z * 2, rideHeight: rideHeight('bike'),
        targets: { body: 2100, fork: 560, wheel: 900 },
      }],
    ],
  },
  props: {
    module: '/scripts/world/props.page.js',
    calls: [['buildProps', { PHA, PHB, ZOMBIE, SANDBAG, outDir: path.join(MODELS_DIR, 'props') }]],
  },
  nature: {
    module: '/scripts/world/nature.page.js',
    calls: [['buildNature', { MEGAKIT, ULTNAT, PHA, PHB, outDir: path.join(MODELS_DIR, 'nature') }]],
  },
};

for (const cat of cats) {
  const job = JOBS[cat];
  if (!job) throw new Error(`unknown category ${cat}`);
  const page = `
import * as M from '${job.module}';
const calls = ${JSON.stringify(job.calls)};
const results = [];
for (const [fn, args] of calls) results.push(await M[fn](args));
window.__done(results);
`;
  const t0 = Date.now();
  const { result, logs } = await runInPage(page, {
    mounts: { '/dl/': DL, '/meshopt/': path.join(REPO_ROOT, 'node_modules', 'meshoptimizer') },
    timeoutMs: 900_000,
  });
  const warnings = logs.filter((l) => /warn|error/i.test(l));
  if (warnings.length) console.log(warnings.join('\n'));
  fs.writeFileSync(path.join(REPORTS, `${cat}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`${cat}: built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(JSON.stringify(result, null, 1).slice(0, 6000));
}
