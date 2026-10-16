// Static checks of the world asset library (vehicles / props / nature) against
// src/client/assets/manifest-world.ts: every file exists and is a plain glTF 2.0 binary (no Draco,
// embedded textures <= 1024 px), triangle and size budgets hold, every node the manifest names
// exists with the documented transforms / frames (vehicle wheels and fork, unit-height trees with
// _SWAY / _TRUNK attributes, unit rocks), and every source is CC0 or CC BY with a credit in
// docs/ASSETS-world.md. Runtime loading in three.js + screenshots: scripts/assets/world/verify.mjs.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { HANDLING, VEHICLES, rideHeight } from '../src/shared/vehicles/defs';
import {
  NATURE_MODELS,
  PROP_MODELS,
  VEHICLE_MODELS,
  WORLD_ASSET_BUDGETS,
  WORLD_ASSET_CREDITS,
  propModelsForBox,
  worldAssetFilesFor,
  type WorldAssetCategory,
} from '../src/client/assets/manifest-world';

const ROOT = path.resolve(__dirname, '..');
const MODELS = path.join(ROOT, 'public', 'assets', 'models');
const CATEGORIES: WorldAssetCategory[] = ['vehicles', 'props', 'nature'];

interface Node { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }
interface Primitive { indices?: number; attributes: Record<string, number>; material?: number; mode?: number }
interface GltfJson {
  asset: { version: string };
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes?: Node[];
  meshes?: { primitives: Primitive[] }[];
  accessors?: { count: number; min?: number[]; max?: number[] }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  images?: { bufferView?: number; uri?: string; mimeType?: string }[];
  materials?: { name?: string; alphaMode?: string }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

interface Glb { json: GltfJson; bin: Buffer; bytes: number }

const cache = new Map<string, Glb>();
function glb(file: string): Glb {
  let g = cache.get(file);
  if (g) return g;
  const buf = fs.readFileSync(path.join(MODELS, file));
  expect(buf.readUInt32LE(0), `${file}: magic`).toBe(0x46546c67);
  expect(buf.readUInt32LE(4), `${file}: version`).toBe(2);
  expect(buf.readUInt32LE(8), `${file}: length`).toBe(buf.length);
  const jsonLen = buf.readUInt32LE(12);
  expect(buf.readUInt32LE(16), `${file}: JSON chunk`).toBe(0x4e4f534a);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as GltfJson;
  const binStart = 20 + jsonLen;
  const bin = binStart + 8 <= buf.length ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : Buffer.alloc(0);
  g = { json, bin, bytes: buf.length };
  cache.set(file, g);
  return g;
}

function nodeByName(g: Glb, name: string): { index: number; node: Node } {
  const index = (g.json.nodes ?? []).findIndex((n) => n.name === name);
  expect(index, `node ${name}`).toBeGreaterThanOrEqual(0);
  return { index, node: g.json.nodes![index] };
}

function localMatrix(n: Node): THREE.Matrix4 {
  if (n.matrix) return new THREE.Matrix4().fromArray(n.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(n.translation ?? [0, 0, 0]),
    new THREE.Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]),
    new THREE.Vector3().fromArray(n.scale ?? [1, 1, 1]),
  );
}

/** World matrix of every node (scene roots at identity). */
function worldMatrices(g: Glb): THREE.Matrix4[] {
  const nodes = g.json.nodes ?? [];
  const out: THREE.Matrix4[] = new Array(nodes.length);
  const visit = (i: number, parent: THREE.Matrix4) => {
    out[i] = parent.clone().multiply(localMatrix(nodes[i]));
    for (const c of nodes[i].children ?? []) visit(c, out[i]);
  };
  const roots = g.json.scenes?.[g.json.scene ?? 0]?.nodes ?? [];
  for (const r of roots) visit(r, new THREE.Matrix4());
  return out;
}

function trisOfMesh(g: Glb, mesh: number): number {
  let t = 0;
  for (const p of g.json.meshes![mesh].primitives) {
    const acc = g.json.accessors![p.indices ?? p.attributes.POSITION];
    t += acc.count / 3;
  }
  return t;
}

/** Float VEC3 accessor data (tightly packed or strided). */
function vec3s(g: Glb, accessor: number): Float32Array {
  const acc = g.json.accessors![accessor] as { count: number; bufferView: number; byteOffset?: number; componentType: number; type: string };
  expect(acc.componentType).toBe(5126);
  expect(acc.type).toBe('VEC3');
  const bv = g.json.bufferViews![acc.bufferView] as { byteOffset?: number; byteStride?: number };
  const stride = bv.byteStride ?? 12;
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new Float32Array(acc.count * 3);
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = g.bin.readFloatLE(base + i * stride + k * 4);
  return out;
}

/** Triangles and exact world bounds (transformed vertices) of the subtree below `rootIndex` (or the whole scene). */
function subtree(g: Glb, rootIndex?: number): { tris: number; box: THREE.Box3; attributes: Set<string>[] } {
  const nodes = g.json.nodes ?? [];
  const world = worldMatrices(g);
  const box = new THREE.Box3();
  const attributes: Set<string>[] = [];
  const v = new THREE.Vector3();
  let tris = 0;
  const visit = (i: number) => {
    const n = nodes[i];
    if (n.mesh !== undefined) {
      tris += trisOfMesh(g, n.mesh);
      for (const p of g.json.meshes![n.mesh].primitives) {
        attributes.push(new Set(Object.keys(p.attributes)));
        const pos = vec3s(g, p.attributes.POSITION);
        for (let k = 0; k < pos.length; k += 3) box.expandByPoint(v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(world[i]));
      }
    }
    for (const c of n.children ?? []) visit(c);
  };
  if (rootIndex === undefined) for (const r of g.json.scenes?.[g.json.scene ?? 0]?.nodes ?? []) visit(r);
  else visit(rootIndex);
  return { tris, box, attributes };
}

/** Pixel size of an embedded PNG / JPEG. */
function imageSize(data: Buffer): [number, number] {
  if (data.readUInt32BE(0) === 0x89504e47) return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (data[0] === 0xff && data[1] === 0xd8) {
    let o = 2;
    while (o < data.length) {
      if (data[o] !== 0xff) { o++; continue; }
      const marker = data[o + 1];
      const len = data.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [data.readUInt16BE(o + 7), data.readUInt16BE(o + 5)];
      o += 2 + len;
    }
  }
  throw new Error('unknown image format');
}

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

describe('world asset files', () => {
  const all = CATEGORIES.flatMap((c) => worldAssetFilesFor(c).map((f) => ({ c, f })));

  it('lists every GLB on disk in the world folders (no orphans) and the files exist', () => {
    const onDisk: string[] = [];
    for (const dir of CATEGORIES) {
      const abs = path.join(MODELS, dir);
      if (!fs.existsSync(abs)) continue;
      for (const f of fs.readdirSync(abs)) if (f.endsWith('.glb')) onDisk.push(`${dir}/${f}`);
    }
    expect(new Set(all.map((x) => x.f))).toEqual(new Set(onDisk));
    expect(fs.existsSync(path.join(MODELS, NATURE_MODELS.impostors.file))).toBe(true);
  });

  it('stays within the 15 MB budget', () => {
    let bytes = 0;
    for (const dir of CATEGORIES) for (const f of fs.readdirSync(path.join(MODELS, dir))) bytes += fs.statSync(path.join(MODELS, dir, f)).size;
    expect(bytes).toBeLessThanOrEqual(WORLD_ASSET_BUDGETS.totalBytes);
  });

  it.each(all)('$f is plain glTF 2.0 with embedded textures <= 1024 px', ({ f }) => {
    const g = glb(f);
    expect(g.json.asset.version).toBe('2.0');
    expect(g.json.extensionsRequired ?? []).toEqual([]);
    expect(g.json.extensionsUsed ?? []).not.toContain('KHR_draco_mesh_compression');
    expect(g.json.extensionsUsed ?? []).not.toContain('EXT_meshopt_compression');
    for (const img of g.json.images ?? []) {
      expect(img.uri, 'images must be embedded').toBeUndefined();
      const bv = g.json.bufferViews![img.bufferView!];
      const [w, h] = imageSize(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
      expect(Math.max(w, h)).toBeLessThanOrEqual(WORLD_ASSET_BUDGETS.textureSize);
    }
    for (const m of g.json.meshes ?? []) for (const p of m.primitives) expect(p.mode ?? 4).toBe(4);
  });

  it('credits only CC0 / CC BY sources, all documented in docs/ASSETS-world.md', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'ASSETS-world.md'), 'utf8');
    for (const s of WORLD_ASSET_CREDITS) {
      expect(['CC0-1.0', 'CC-BY-4.0']).toContain(s.license);
      expect(doc).toContain(s.url);
      expect(doc).toContain(s.mirror);
    }
  });
});

describe('vehicles', () => {
  const entries = Object.values(VEHICLE_MODELS);

  it('provides the UAZ and the bike (buggy stays procedural)', () => {
    expect(Object.keys(VEHICLE_MODELS).sort()).toEqual(['bike', 'uaz']);
  });

  it.each(entries)('$type matches the collision box, wheels and budget', (v) => {
    const g = glb(v.file);
    const def = VEHICLES[v.type];
    const all = subtree(g);
    expect(all.tris).toBe(v.tris);
    expect(all.tris).toBeLessThanOrEqual(WORLD_ASSET_BUDGETS.tris.vehicles);
    // Origin = OBB centre: length = 2 * halfExtents.z, wheels on the ground at -rideHeight.
    expect(near(all.box.max.z - all.box.min.z, def.halfExtents.z * 2, 0.02)).toBe(true);
    expect(near(all.box.min.y, -rideHeight(def), 0.02)).toBe(true);
    expect(near(all.box.min.x + all.box.max.x, 0, 0.05)).toBe(true);
    for (const m of v.bodyMeshes) nodeByName(g, m);
    if (v.glassMesh) nodeByName(g, v.glassMesh);
    const world = worldMatrices(g);
    expect(v.wheels.length).toBe(v.type === 'bike' ? 2 : 4);
    for (const w of v.wheels) {
      const { index, node } = nodeByName(g, w.node);
      const c = new THREE.Vector3().setFromMatrixPosition(world[index]);
      expect(c.distanceTo(new THREE.Vector3().fromArray(w.center))).toBeLessThan(0.01);
      if (w.localCenter) expect(new THREE.Vector3().setFromMatrixPosition(localMatrix(node)).distanceTo(new THREE.Vector3().fromArray(w.localCenter))).toBeLessThan(0.01);
      // Wheel geometry is centred on its pivot and its rest bottom touches the ground.
      const sub = subtree(g, index);
      const size = sub.box.getSize(new THREE.Vector3());
      expect(near(Math.max(size.y, size.z) / 2, w.radius, 0.03)).toBe(true);
      expect(near(sub.box.min.y, -rideHeight(def), 0.03)).toBe(true);
      expect(w.axle === 'front' ? w.center[2] < 0 : w.center[2] > 0).toBe(true);
      if (w.side !== 'center') expect(w.side === 'left' ? w.center[0] < 0 : w.center[0] > 0).toBe(true);
      // Visual radius close to the physics wheel radius (spin rate / suspension travel).
      expect(near(w.radius, HANDLING[v.type].wheelRadius, 0.05)).toBe(true);
    }
    expect(v.seatSurfaceY.length).toBe(def.seatOffsets.length);
  });

  it('bike fork pivots on a raked steering axis with the front wheel as its child', () => {
    const v = VEHICLE_MODELS.bike!;
    const g = glb(v.file);
    const { node: fork, index } = nodeByName(g, 'Fork');
    expect(v.fork).not.toBeNull();
    const q = new THREE.Quaternion().setFromRotationMatrix(localMatrix(fork));
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    expect(near(e.x, v.fork!.rake, 1e-3)).toBe(true);
    expect(v.fork!.rake).toBeGreaterThan(0.3);
    expect(v.fork!.rake).toBeLessThan(0.6);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.distanceTo(new THREE.Vector3().fromArray(v.fork!.axis))).toBeLessThan(0.01);
    const front = nodeByName(g, 'Wheel_F').index;
    expect(fork.children).toContain(front);
    expect(new THREE.Vector3().setFromMatrixPosition(localMatrix(fork)).distanceTo(new THREE.Vector3().fromArray(v.fork!.pivot))).toBeLessThan(0.01);
    expect(index).toBeGreaterThanOrEqual(0);
  });
});

describe('props', () => {
  it.each(Object.values(PROP_MODELS))('$id rests on y = 0, is centred, matches its size and budget', (p) => {
    const g = glb(p.file);
    const s = subtree(g);
    expect(s.tris).toBe(p.tris);
    expect(s.tris).toBeLessThanOrEqual(WORLD_ASSET_BUDGETS.tris.props);
    expect(near(s.box.min.y, 0, 0.01)).toBe(true);
    expect(near(s.box.min.x + s.box.max.x, 0, 0.02)).toBe(true);
    expect(near(s.box.min.z + s.box.max.z, 0, 0.02)).toBe(true);
    const size = s.box.getSize(new THREE.Vector3());
    expect(size.distanceTo(new THREE.Vector3().fromArray(p.size))).toBeLessThan(0.02);
    expect(size.x).toBeGreaterThanOrEqual(size.z - 0.1);
    for (const m of p.meshes) nodeByName(g, m);
  });

  it('maps world boxes to models', () => {
    expect(propModelsForBox('crate', 'wood')).toEqual(['crate_wood', 'crate_military']);
    expect(propModelsForBox('barrier', 'concrete')).toEqual(['barrier_concrete']);
    expect(propModelsForBox('barrier', 'sand')).toEqual(['sandbag_wall']);
    expect(propModelsForBox('fence', 'wood')).toEqual(['fence_wood']);
    expect(propModelsForBox('fence', 'metal')).toEqual(['fence_chainlink']);
    expect(propModelsForBox('container', 'metal')).toEqual(['container_green', 'container_red']);
    expect(propModelsForBox('wall', 'concrete')).toEqual([]);
    expect(PROP_MODELS.container_green.size[0]).toBeCloseTo(6.06, 2);
  });
});

describe('nature', () => {
  const trees = Object.values(NATURE_MODELS.trees);

  it('has 5 variants per tree kind with LOD1', () => {
    expect(Object.keys(NATURE_MODELS.trees).sort()).toEqual(['birch', 'dead', 'oak', 'pine']);
    for (const t of trees) expect(t.variants.length).toBe(5);
  });

  it.each(trees)('$kind trees are unit height, centred, within budget, with sway / trunk attributes', (t) => {
    const g = glb(t.file);
    for (const v of t.variants) {
      // Decimation / grown LOD1 leaf cards move the crown top by a few percent at most.
      for (const [node, bark, leaves, tris, budget, topTol] of [
        [v.node, v.bark, v.leaves, v.tris, WORLD_ASSET_BUDGETS.tris.nature, 0.05],
        [v.lod1Node, v.lod1Bark, v.lod1Leaves, v.lod1Tris, 900, 0.1],
      ] as const) {
        const s = subtree(g, nodeByName(g, node).index);
        expect(s.tris).toBe(tris);
        expect(s.tris).toBeLessThanOrEqual(budget);
        expect(s.box.max.y).toBeGreaterThan(1 - topTol);
        expect(s.box.max.y).toBeLessThan(1 + topTol);
        expect(s.box.min.y).toBeGreaterThan(-0.08);
        const c = s.box.getCenter(new THREE.Vector3());
        expect(Math.hypot(c.x, c.z)).toBeLessThan(0.2);
        for (const a of s.attributes) {
          expect(a.has('_SWAY')).toBe(true);
          expect(a.has('_TRUNK')).toBe(true);
          expect(a.has('TEXCOORD_0')).toBe(true);
        }
        nodeByName(g, bark);
        if (leaves) nodeByName(g, leaves);
      }
      expect(v.lod1Tris).toBeLessThan(v.tris);
      expect(v.trunkRadius).toBeGreaterThan(0.01);
      expect(v.trunkRadius).toBeLessThan(0.1);
    }
    const mats = (g.json.materials ?? []).map((m) => m.name);
    expect(mats).toContain(t.barkMaterial);
    if (t.leavesMaterial) expect(g.json.materials!.find((m) => m.name === t.leavesMaterial)?.alphaMode).toBe('MASK');
  });

  it('rocks are unit cylinders: base 0, top 1, radius 1', () => {
    const g = glb(NATURE_MODELS.rocks.file);
    expect(NATURE_MODELS.rocks.variants.length).toBeGreaterThanOrEqual(4);
    for (const v of NATURE_MODELS.rocks.variants) {
      for (const node of [v.node, v.lod1Node!]) {
        const s = subtree(g, nodeByName(g, node).index);
        expect(s.tris).toBeLessThanOrEqual(WORLD_ASSET_BUDGETS.tris.nature);
        expect(s.box.max.y).toBeGreaterThan(0.94);
        expect(s.box.max.y).toBeLessThanOrEqual(1.001);
        expect(near(s.box.min.y, -0.2, 0.02)).toBe(true);
        expect(Math.max(-s.box.min.x, s.box.max.x, -s.box.min.z, s.box.max.z)).toBeLessThanOrEqual(1.001);
      }
    }
  });

  it('bushes are ~1.6 m wide and grass tufts are unit height, all with sway', () => {
    const b = glb(NATURE_MODELS.bushes.file);
    expect(NATURE_MODELS.bushes.variants.length).toBeGreaterThanOrEqual(2);
    for (const v of NATURE_MODELS.bushes.variants) {
      const s = subtree(b, nodeByName(b, v.node).index);
      const size = s.box.getSize(new THREE.Vector3());
      expect(near(Math.max(size.x, size.z), 1.6, 0.05)).toBe(true);
      expect(s.tris).toBe(v.tris);
      for (const a of s.attributes) expect(a.has('_SWAY')).toBe(true);
    }
    const g = glb(NATURE_MODELS.grass.file);
    for (const v of NATURE_MODELS.grass.variants) {
      const s = subtree(g, nodeByName(g, v.node).index);
      expect(near(s.box.max.y, 1, 0.02)).toBe(true);
      expect(s.tris).toBeLessThanOrEqual(150);
      for (const a of s.attributes) expect(a.has('_SWAY')).toBe(true);
    }
  });

  it('impostor atlas has one cell per kind', () => {
    const png = fs.readFileSync(path.join(MODELS, NATURE_MODELS.impostors.file));
    const [w, h] = imageSize(png);
    expect([w, h]).toEqual([...NATURE_MODELS.impostors.size]);
    expect(w / NATURE_MODELS.impostors.cells.length).toBe(h / 2);
    expect(NATURE_MODELS.impostors.cells).toEqual(['pine', 'oak', 'birch', 'dead', 'bush']);
  });
});
