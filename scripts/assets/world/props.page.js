// Prop pipeline (browser side). Every prop is exported in metres, resting on y = 0, centred on
// X/Z, with its long horizontal axis along X (walls, barriers, fences, containers, long crates),
// textures resized to <= 512 px (normal / ORM maps smaller) and meshes decimated to the budget.
import {
  THREE, load, dl, parts, merge, simplify, bboxOf, bbox, tris, applyMatrix, retex, standard, mesh, only,
  exportGlb, sceneTris, ops, chain,
} from './world.page.js';

const r3 = (v) => v.toArray().map((x) => +x.toFixed(3));

/** Texture sizes per map kind. */
const TEX = { map: 512, normalMap: 512, orm: 256 };

/** Standard material from a loaded glTF material, with resized textures (shared via `cache`). */
function convertMaterial(src, name, cache, { tint = null, mapSize = TEX.map, normalSize = TEX.normalMap, ormSize = TEX.orm, overrides = {} } = {}) {
  const tex = (t, size, opt) => {
    if (!t) return null;
    const key = `${t.uuid}:${size}:${opt.key || ''}`;
    if (!cache.has(key)) cache.set(key, retex(t, size, opt));
    return cache.get(key);
  };
  const map = tex(src.map, mapSize, { mime: 'image/jpeg', op: tint, key: tint ? name : '' });
  const normalMap = tex(src.normalMap, normalSize, { mime: 'image/jpeg' });
  const orm = src.roughnessMap || src.metalnessMap;
  const ormMap = tex(orm, ormSize, { mime: 'image/jpeg' });
  const m = standard(name, {
    color: src.color.getHex(),
    map,
    normalMap,
    roughnessMap: ormMap,
    metalnessMap: src.metalnessMap ? ormMap : null,
    aoMap: src.aoMap ? tex(src.aoMap, ormSize, { mime: 'image/jpeg' }) : null,
    roughness: src.roughness,
    metalness: src.metalness,
    alphaTest: src.alphaTest,
    doubleSided: src.side === THREE.DoubleSide,
    ...overrides,
  });
  return m;
}

/** Rotates the geometries about Y so the longer horizontal extent is along X. */
function alongX(geos) {
  const b = bboxOf(geos);
  if (b.max.z - b.min.z > b.max.x - b.min.x) {
    const r = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    for (const g of geos) applyMatrix(g, r);
  }
}

/** Centre on X/Z and put the lowest point at y = 0. */
function ground(geos) {
  const b = bboxOf(geos);
  const c = b.getCenter(new THREE.Vector3());
  for (const g of geos) g.translate(-c.x, -b.min.y, -c.z);
}

/** Scales to exact extents [x, y, z] (metres; null = keep that axis proportional to the first given). */
function scaleTo(geos, size) {
  const b = bboxOf(geos);
  const s = b.getSize(new THREE.Vector3());
  const k = size.map((v, i) => (v == null ? null : v / s.getComponent(i)));
  const uniform = k.find((v) => v != null);
  const m = new THREE.Matrix4().makeScale(k[0] ?? uniform, k[1] ?? uniform, k[2] ?? uniform);
  for (const g of geos) applyMatrix(g, m);
}

/**
 * Generic single-file prop: loads `src`, optionally keeps only parts under nodes named in
 * `nodes`, merges per material, decimates to `target` triangles (split proportionally between
 * materials), orients / scales / grounds it and exports `${outDir}/${id}.glb`.
 */
async function prop(o) {
  const g = await load(dl(o.src));
  let ps;
  if (o.nodes) {
    const roots = o.nodes.map((n) => {
      const x = g.scene.getObjectByName(n);
      if (!x) throw new Error(`${o.id}: no node ${n}`);
      return x;
    });
    ps = roots.flatMap((r) => parts(g.scene, { under: r }));
  } else ps = parts(g.scene);
  const byMat = new Map();
  for (const p of ps) {
    if (!byMat.has(p.material)) byMat.set(p.material, []);
    byMat.get(p.material).push(only(p.geometry, ['position', 'normal', 'uv']));
  }
  let groups = [...byMat.entries()].map(([m, gs]) => ({ material: m, geometry: merge(gs) }));
  if (o.prepare) groups = await o.prepare(groups);
  const total = groups.reduce((a, x) => a + tris(x.geometry), 0);
  const target = o.target ?? Infinity;
  for (const x of groups) {
    const t = Math.max(12, Math.floor((tris(x.geometry) / total) * target));
    x.geometry = await simplify(x.geometry, t, o.simplify || {});
  }
  const geos = groups.map((x) => x.geometry);
  if (o.rotateY) for (const g2 of geos) applyMatrix(g2, new THREE.Matrix4().makeRotationY(o.rotateY));
  if (o.longX !== false) alongX(geos);
  if (o.size) scaleTo(geos, o.size);
  if (o.repeatX) {
    // Several copies end to end along X (e.g. a 3 m run of short jersey barriers).
    const w = bboxOf(geos).getSize(new THREE.Vector3()).x;
    for (const x of groups) {
      const copies = [];
      for (let i = 0; i < o.repeatX; i++) copies.push(x.geometry.clone().translate(i * (w + (o.repeatGap ?? 0)), 0, 0));
      x.geometry = merge(copies);
    }
  }
  ground(groups.map((x) => x.geometry));
  const cache = new Map();
  const root = new THREE.Group();
  root.name = o.id;
  groups.forEach((x, i) => {
    const opts = { ...(o.material || {}) };
    if (o.tint && (!o.tintMatch || o.tintMatch.test(x.material.name))) opts.tint = o.tint;
    const mat = convertMaterial(x.material, groups.length === 1 ? o.id : `${o.id}_${i}`, cache, opts);
    root.add(mesh(groups.length === 1 ? o.id : `${o.id}_${i}`, x.geometry, mat));
  });
  return finish(root, o);
}

async function finish(root, o) {
  const file = `${o.outDir}/${o.id}.glb`;
  const bytes = await exportGlb(root, file);
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root, true);
  return { id: o.id, file, bytes, tris: sceneTris(root), size: r3(b.getSize(new THREE.Vector3())), meshes: root.children.map((c) => c.name) };
}

// ------------------------------------------------------------------------------------------------
// Special builds
// ------------------------------------------------------------------------------------------------

/** Deterministic PRNG. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Sandbag wall: one CC BY sandbag scan-style model decimated to a lumpy low-poly bag, laid flat,
 * stacked in `courses` staggered courses two bags deep (running bond) with small random jitter.
 */
async function sandbagWall({ src, outDir, id, length, height, depth, courses, bagTris }) {
  const g = await load(dl(src));
  const ps = parts(g.scene);
  const srcMat = ps[0].material;
  let bag = merge(ps.map((p) => only(p.geometry, ['position', 'normal', 'uv'])));
  bag = await simplify(bag, bagTris, { uvWeight: 0.5, normalWeight: 0.3 });
  // Source bag stands on its thin edge: lay it down (thin axis -> Y), long axis -> X.
  const b0 = bbox(bag).getSize(new THREE.Vector3());
  const thin = ['x', 'y', 'z'].reduce((a, k) => (b0[k] < b0[a] ? k : a), 'x');
  if (thin === 'x') applyMatrix(bag, new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  if (thin === 'z') applyMatrix(bag, new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const b1 = bbox(bag).getSize(new THREE.Vector3());
  if (b1.z > b1.x) applyMatrix(bag, new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const perCourse = Math.round(length / 0.62);
  const bagL = length / perCourse, bagW = depth / 2, bagH = height / courses;
  // Bags overlap a little so the wall reads as squashed, filled bags (no gaps).
  scaleTo([bag], [bagL * 1.08, bagH * 1.25, bagW * 1.1]);
  const c = bbox(bag).getCenter(new THREE.Vector3());
  bag.translate(-c.x, -c.y, -c.z);
  const rnd = rng(0x5a9d);
  const pieces = [];
  for (let k = 0; k < courses; k++) {
    const offset = k % 2 ? bagL / 2 : 0;
    for (let row = 0; row < 2; row++) {
      for (let i = -1; i <= perCourse; i++) {
        const x0 = -length / 2 + offset + i * bagL;
        // Clip to the wall length: skip bags whose centre is outside, shorten end bags.
        const xa = Math.max(-length / 2, x0), xb = Math.min(length / 2, x0 + bagL);
        if (xb - xa < bagL * 0.45) continue;
        const piece = bag.clone();
        const sx = (xb - xa) / bagL;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3((xa + xb) / 2, bagH * (k + 0.5), (row - 0.5) * bagW),
          new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.05)),
          new THREE.Vector3(sx * (0.97 + rnd() * 0.06), 0.94 + rnd() * 0.1, 0.96 + rnd() * 0.08),
        );
        applyMatrix(piece, m);
        pieces.push(piece);
      }
    }
  }
  const geo = merge(pieces);
  ground([geo]);
  const root = new THREE.Group();
  root.name = id;
  const mat = standard(id, { map: retex(srcMat.map, 512, { mime: 'image/jpeg' }), roughness: 0.95, metalness: 0 });
  root.add(mesh(id, geo, mat));
  const r = await finish(root, { id, outDir });
  return { ...r, bags: pieces.length, bagTris: tris(bag) };
}

/**
 * Chain-link fence panel (Poly Haven): the mirrored wire texture lost its opacity channel (JPEG),
 * so the alpha is rebuilt from luminance (wire on black) for alpha testing.
 */
const wireAlpha = (d, w, h) => {
  const a = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    a[i] = Math.max(0, Math.min(255, (l - 14) * 9));
  }
  // Thicken the wires by one texel (3x3 max) so they survive mipmapping + alpha testing at range.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = ((y + dy + h) % h) * w + ((x + dx + w) % w);
          if (a[j] > m) m = a[j];
        }
      }
      d[y * w * 4 + x * 4 + 3] = m;
    }
  }
  // Flat wire colour (average of the opaque texels): the detail lives in the alpha pattern, and a
  // constant RGB plane keeps the PNG small.
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < w * h; i++) if (a[i] > 160) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; }
  r /= n; g /= n; b /= n;
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; }
};

async function chainlink({ src, outDir, id, target }) {
  const g = await load(dl(src));
  const panel = g.scene.getObjectByName('modular_chainlink_fence_double');
  const post = g.scene.getObjectByName('modular_chainlink_fence_post');
  if (!panel || !post) throw new Error('chain-link nodes missing');
  // The post is modelled elsewhere in the source scene: move it to the panel's +X end.
  const panelParts = parts(g.scene, { under: panel });
  const postParts = parts(g.scene, { under: post });
  const pb = bboxOf(panelParts.map((p) => p.geometry));
  const qb = bboxOf(postParts.map((p) => p.geometry));
  for (const p of postParts) p.geometry.translate(pb.max.x - (qb.min.x + qb.max.x) / 2, 0, (pb.min.z + pb.max.z) / 2 - (qb.min.z + qb.max.z) / 2);
  const wire = [], metal = [];
  let wireMat = null, metalMat = null;
  for (const p of [...panelParts, ...postParts]) {
    const geo = only(p.geometry, ['position', 'normal', 'uv']);
    if (p.material.name.includes('wire')) { wire.push(geo); wireMat = p.material; } else { metal.push(geo); metalMat = p.material; }
  }
  let metalGeo = merge(metal);
  metalGeo = await simplify(metalGeo, target - 60, { uvWeight: 0.5, normalWeight: 0.6 });
  const wireGeo = merge(wire);
  ground([metalGeo, wireGeo]);
  const cache = new Map();
  const m1 = convertMaterial(metalMat, `${id}_frame`, cache, {});
  const wmap = retex(wireMat.map, 1024, { mime: 'image/png', op: wireAlpha });
  wmap.offset.copy(wireMat.map.offset); wmap.repeat.copy(wireMat.map.repeat); wmap.rotation = wireMat.map.rotation; wmap.center.copy(wireMat.map.center);
  wmap.wrapS = wmap.wrapT = THREE.RepeatWrapping;
  const m2 = standard(`${id}_wire`, { map: wmap, roughness: 0.55, metalness: 0.6, alphaTest: 0.35, doubleSided: true });
  const root = new THREE.Group();
  root.name = id;
  root.add(mesh(`${id}_frame`, metalGeo, m1));
  root.add(mesh(`${id}_wire`, wireGeo, m2));
  return finish(root, { id, outDir });
}

// ------------------------------------------------------------------------------------------------

const olive = ops.tint([0.62, 0.68, 0.42], 0.85, 1.05);

export async function buildProps({ PHA, PHC, ZOMBIE, SANDBAG, FANTASY, MEDIEVAL, outDir }) {
  const res = [];
  // Wooden crate: Quaternius Medieval Village "Prop_Crate" (cube, plank + X-brace), 1.0 m.
  res.push(await prop({ id: 'crate_wood', src: `${MEDIEVAL}/Prop_Crate.gltf`, outDir, size: [1.0, null, null], longX: false }));
  // Military crate: Quaternius Fantasy Props "Crate_Wooden" (banded), wood re-tinted olive drab.
  res.push(await prop({
    id: 'crate_military', src: `${FANTASY}/Crate_Wooden.gltf`, outDir, size: [1.0, null, null], longX: false,
    tint: olive, tintMatch: /Furniture/,
  }));
  // Ammo crate: Poly Haven "Old Military Crate" (closed variant "a": crate, lid, latch, loop, strap).
  res.push(await prop({
    id: 'ammo_crate', src: `${PHC}/old_military_crate/old_military_crate.gltf`, outDir, target: 1500,
    nodes: ['old_military_crate_a', 'old_military_crate_lid_a', 'old_military_crate_latch_a', 'old_military_crate_loop_a', 'old_military_crate_cloth_a'],
  }));
  // Oil drum (Poly Haven barrel_03) and red fuel drum (Poly Haven Barrel_01).
  res.push(await prop({ id: 'barrel_oil', src: `${PHA}/barrel_03/barrel_03_1k.gltf`, outDir, target: 1100, longX: false }));
  res.push(await prop({ id: 'barrel_red', src: `${PHA}/Barrel_01/Barrel_01_1k.gltf`, outDir, target: 1100, longX: false }));
  // Jerry can (Poly Haven metal_jerrycan, 20k tris scan-quality mesh -> 900).
  res.push(await prop({ id: 'jerrycan', src: `${PHA}/metal_jerrycan/metal_jerrycan_1k.gltf`, outDir, target: 900 }));
  // Concrete jersey barrier (Poly Haven concrete_road_barrier, 61k -> 2 x 700, two in a 3.1 m run).
  res.push(await prop({ id: 'barrier_concrete', src: `${PHA}/concrete_road_barrier/concrete_road_barrier_1k.gltf`, outDir, target: 700, repeatX: 2, repeatGap: 0.01 }));
  // Shipping containers (Quaternius Zombie Apocalypse Kit), scaled to ISO 20 ft (6.06 x 2.59 x 2.44).
  res.push(await prop({ id: 'container_green', src: `${ZOMBIE}/Container_Green.gltf`, outDir, size: [6.06, 2.59, 2.44] }));
  res.push(await prop({ id: 'container_red', src: `${ZOMBIE}/Container_Red.gltf`, outDir, size: [6.06, 2.59, 2.44] }));
  // Fences: rural wooden rail fence (Quaternius Medieval Village) and chain-link panel (Poly Haven).
  res.push(await prop({ id: 'fence_wood', src: `${MEDIEVAL}/Prop_WoodenFence_Single.gltf`, outDir }));
  res.push(await chainlink({ src: `${PHA}/modular_chainlink_fence/modular_chainlink_fence_1k.gltf`, outDir, id: 'fence_chainlink', target: 1500 }));
  // Sandbag wall segment: 2.0 m long, 1.1 m high, 0.6 m thick (the world generator's sandbag box).
  res.push(await sandbagWall({ src: SANDBAG, outDir, id: 'sandbag_wall', length: 2.0, height: 1.1, depth: 0.6, courses: 6, bagTris: 44 }));
  return res;
}
