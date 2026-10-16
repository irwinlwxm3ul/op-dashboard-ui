// Static checks of the curated model library against src/client/assets/manifest.ts: every file
// exists and is a valid glTF 2.0 binary, triangle / size budgets hold, characters are skinned with
// the bones the manifest names, and every clip the manifest maps exists in the rig's animation
// library. (Runtime loading in three.js is covered by scripts/assets/verify.mjs.)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_BUDGETS,
  CHARACTER_BONES,
  CHARACTER_CLIPS,
  CHARACTER_RIGS,
  CHARACTER_VARIANTS,
  UPPER_BODY_BONES,
  WEAPON_MODELS,
  assetFilesFor,
  characterVariantFor,
  modelUrl,
  type AssetCategory,
} from '../src/client/assets/manifest';

const MODELS = path.resolve(__dirname, '..', 'public', 'assets', 'models');
const CATEGORIES: AssetCategory[] = ['characters', 'weapons', 'items'];
/** Folders owned by this manifest (vehicles / props / nature belong to manifest-world.ts). */
const OWN_DIRS = ['characters', 'animations', 'weapons', 'items'];

interface GltfJson {
  asset: { version: string };
  nodes?: { name?: string; mesh?: number; skin?: number; children?: number[]; translation?: number[]; matrix?: number[] }[];
  meshes?: { primitives: { indices?: number; attributes: Record<string, number>; mode?: number; material?: number }[] }[];
  skins?: { joints: number[] }[];
  animations?: { name?: string; channels: { target: { node?: number; path: string } }[] }[];
  accessors?: { count: number }[];
  materials?: { name?: string }[];
  images?: unknown[];
}

const parsed = new Map<string, { json: GltfJson; bytes: number }>();

function readGlb(file: string): { json: GltfJson; bytes: number } {
  const hit = parsed.get(file);
  if (hit) return hit;
  const buf = fs.readFileSync(path.join(MODELS, file));
  expect(buf.readUInt32LE(0), `${file}: glTF magic`).toBe(0x46546c67);
  expect(buf.readUInt32LE(4), `${file}: glTF version`).toBe(2);
  expect(buf.readUInt32LE(8), `${file}: declared length`).toBe(buf.length);
  const jsonLen = buf.readUInt32LE(12);
  expect(buf.readUInt32LE(16), `${file}: JSON chunk type`).toBe(0x4e4f534a);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as GltfJson;
  const binOff = 20 + jsonLen;
  if (binOff < buf.length) expect(buf.readUInt32LE(binOff + 4), `${file}: BIN chunk type`).toBe(0x004e4942);
  const out = { json, bytes: buf.length };
  parsed.set(file, out);
  return out;
}

/** Triangles of every mesh instance in the scene graph. */
function triangles(json: GltfJson): number {
  let tris = 0;
  for (const n of json.nodes ?? []) {
    if (n.mesh === undefined) continue;
    for (const p of json.meshes![n.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const count = p.indices !== undefined ? json.accessors![p.indices].count : json.accessors![p.attributes.POSITION].count;
      tris += count / 3;
    }
  }
  return tris;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('asset library', () => {
  it('every manifest file exists and is a valid GLB within budget', () => {
    for (const cat of CATEGORIES) {
      for (const file of assetFilesFor(cat)) {
        expect(fs.existsSync(path.join(MODELS, file)), `${file} exists`).toBe(true);
        const { json, bytes } = readGlb(file);
        expect(json.asset.version).toBe('2.0');
        if (!file.startsWith('animations/')) {
          expect(triangles(json), `${file} triangles`).toBeLessThanOrEqual(ASSET_BUDGETS.tris[cat]);
          expect(triangles(json), `${file} has geometry`).toBeGreaterThan(0);
        }
        if (cat === 'characters' && !file.startsWith('animations/')) expect(bytes).toBeLessThanOrEqual(ASSET_BUDGETS.characterBytes);
      }
    }
  });

  it('the model tree stays within the total size budget and our folders hold only referenced files', () => {
    const all = walk(MODELS);
    const total = all.reduce((a, f) => a + fs.statSync(f).size, 0);
    expect(total).toBeLessThanOrEqual(ASSET_BUDGETS.totalBytes);
    const referenced = new Set(CATEGORIES.flatMap((c) => assetFilesFor(c)));
    const unreferenced = all
      .map((f) => path.relative(MODELS, f).split(path.sep).join('/'))
      .filter((f) => OWN_DIRS.includes(f.split('/')[0]) && !referenced.has(f));
    expect(unreferenced).toEqual([]);
  });

  it('model URLs are rooted at the site base', () => {
    expect(modelUrl('characters/male_casual.glb')).toBe('/assets/models/characters/male_casual.glb');
  });

  describe('characters', () => {
    for (const v of Object.values(CHARACTER_VARIANTS)) {
      it(`${v.id}: skinned body + team band on the full rig`, () => {
        const { json } = readGlb(v.file);
        expect(json.skins?.length).toBeGreaterThanOrEqual(1);
        const names = new Set((json.nodes ?? []).map((n) => n.name));
        for (const bone of Object.values(CHARACTER_BONES)) expect(names.has(bone), `bone ${bone}`).toBe(true);
        for (const bone of UPPER_BODY_BONES) expect(names.has(bone), `upper-body bone ${bone}`).toBe(true);
        const meshNodes = (json.nodes ?? []).filter((n) => n.mesh !== undefined);
        expect(meshNodes.map((n) => n.name).sort()).toEqual([v.bodyMesh, v.teamMesh].sort());
        expect(meshNodes.every((n) => n.skin !== undefined)).toBe(true);
        expect((json.materials ?? []).map((m) => m.name).sort()).toEqual(['outfit', 'team']);
        expect(json.images ?? []).toEqual([]);
        expect(Math.abs(triangles(json) - v.tris)).toBeLessThanOrEqual(64);
        // Every joint of the skin is a node the animation library can address by name.
        const joints = json.skins![0].joints.map((j) => json.nodes![j].name);
        const lib = readGlb(CHARACTER_RIGS[v.rig].animations).json;
        const libNames = new Set((lib.nodes ?? []).map((n) => n.name));
        for (const j of joints) expect(libNames.has(j), `animation skeleton has ${j}`).toBe(true);
      });
    }

    for (const rig of Object.values(CHARACTER_RIGS)) {
      it(`${rig.id} rig: every mapped clip exists and only targets known bones`, () => {
        const { json } = readGlb(rig.animations);
        const clipNames = new Set((json.animations ?? []).map((a) => a.name));
        for (const [key, spec] of Object.entries(CHARACTER_CLIPS)) {
          if (!spec) continue;
          expect(clipNames.has(spec.clip), `${key} -> ${spec.clip}`).toBe(true);
        }
        const upper = new Set(UPPER_BODY_BONES);
        for (const a of json.animations ?? []) {
          expect(a.channels.length, `${a.name} has channels`).toBeGreaterThan(0);
          const targets = a.channels.map((c) => json.nodes![c.target.node!].name ?? '');
          expect(targets.includes('Root'), `${a.name} must not animate Root`).toBe(false);
          const spec = Object.values(CHARACTER_CLIPS).find((s) => s?.clip === a.name);
          // Overlays must drive the upper body; the authored ones drive nothing else (the
          // retargeted pistol clips are full-body and get split by the loader).
          if (spec?.layer === 'upper') expect(targets.some((t) => upper.has(t)), `${a.name} drives the upper body`).toBe(true);
          if ((a.name ?? '').startsWith('Rifle_') || a.name === 'Parachute_Hang') for (const t of targets) expect(upper.has(t), `${a.name} overlay touches ${t}`).toBe(true);
        }
        // Weapon socket is a unit quaternion.
        const q = rig.socket.quaternion;
        expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 3);
      });
    }

    it('assigns variants deterministically and covers all of them', () => {
      const seen = new Set<string>();
      for (let id = 1; id <= 200; id++) {
        expect(characterVariantFor(id)).toBe(characterVariantFor(id));
        seen.add(characterVariantFor(id));
      }
      expect(seen.size).toBe(Object.keys(CHARACTER_VARIANTS).length);
    });
  });

  describe('weapons', () => {
    for (const w of Object.values(WEAPON_MODELS)) {
      it(`${w.id}: one vertex-coloured mesh in the weapon frame with matching hold markers`, () => {
        const { json } = readGlb(w.file);
        const meshNodes = (json.nodes ?? []).filter((n) => n.mesh !== undefined);
        expect(meshNodes.length).toBe(1);
        expect(json.meshes![meshNodes[0].mesh!].primitives.length).toBe(1);
        expect(json.meshes![meshNodes[0].mesh!].primitives[0].attributes.COLOR_0).toBeDefined();
        expect((json.materials ?? []).map((m) => m.name)).toEqual(['weapon']);
        expect(triangles(json)).toBe(w.tris);
        const marker = (name: string): number[] => {
          const n = (json.nodes ?? []).find((x) => x.name === name);
          return n?.translation ?? (n?.matrix ? n.matrix.slice(12, 15) : [0, 0, 0]);
        };
        const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 3));
        expect((json.nodes ?? []).some((n) => n.name === 'Grip')).toBe(true);
        close(marker('Muzzle'), w.muzzle);
        close(marker('Sight'), w.sight);
        close(marker('Support'), w.support);
        close(marker('Butt'), w.butt);
        // Barrel along -Z: the muzzle is in front of the grip and the stock (if any) behind it.
        expect(w.muzzle[2]).toBeLessThan(-0.1);
        expect(w.butt[2]).toBeGreaterThanOrEqual(0);
        expect(Math.abs(w.muzzle[2] - (w.pistol ? 0 : w.butt[2]))).toBeLessThanOrEqual(w.length + 1e-3);
      });
    }
  });
});
