#!/usr/bin/env node
// Clones every pinned world-asset source (sources.mjs) into $ASSETS_DL: blobless, sparse, at the
// exact commit. Existing checkouts are reused. Downloads are data only: nothing from them is run.
// Usage: node scripts/assets/world/fetch-sources.mjs [sourceKey...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DL, SOURCES } from './sources.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SOURCES);
for (const key of keys) {
  const s = SOURCES[key];
  if (!s) throw new Error(`unknown source ${key}`);
  const dir = path.join(DL, s.dir);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', s.repo + '.git');
  }
  git(dir, 'config', 'core.sparseCheckout', 'true');
  fs.writeFileSync(path.join(dir, '.git', 'info', 'sparse-checkout'), s.sparse.join('\n') + '\n');
  // A fresh repository has no HEAD yet (rev-parse fails quietly).
  const head = (() => {
    try { return execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
  })();
  if (head !== s.commit) {
    git(dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', s.commit);
    git(dir, 'checkout', '-q', '--detach', s.commit);
  } else {
    git(dir, 'read-tree', '-mu', 'HEAD');
  }
  console.log(`${key}: ${s.repo} @ ${s.commit} -> ${dir}`);
}
