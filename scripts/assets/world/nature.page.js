// Nature pipeline (browser side), matched to the world renderer's instancing
// (src/client/render/world/vegetation*.ts):
//  * trees: unit height (ground y = 0, crown top y = 1, roots slightly below 0), trunk base centred
//    on the origin; instance scale = TreeDef.h. Vertex attributes `_sway` (0 at the base -> 1 at the
//    top, as the procedural trees) and `_trunk` (1 on the main trunk, 0 elsewhere) so the existing
//    wind + trunk-radius shader works unchanged. One file per kind, every variant + its LOD1 inside,
//    sharing one bark and one leaves material.
//  * rocks: base plane y = 0, top y = 1, horizontal radius 1 -> instance scale (r, h, r) is exactly
//    the physics cylinder of RockDef (y .. y + h, radius r); ~20 % of the height is buried (y < 0).
//  * bushes: metres, ~1.6 m wide at scale 1 (like the procedural bush), `_sway` = max(0, y) * 2.2.
//  * grass: unit height tufts, `_sway` = y.
//  * impostors.png: far-band cross-quad atlas (pine, oak, birch, dead, bush cells) rendered from the
//    LOD0 models, same layout as vegetationModels.ts' canvas atlas.
import {
  THREE, load, dl, parts, merge, simplify, thinCards, bbox, bboxOf, tris, applyMatrix, retex, standard, mesh,
  only, addScalar, exportGlb, ops, chain, toBase64,
} from './world.page.js';

const r3 = (x) => +x.toFixed(3);
const isLeaf = (m) => /leaf|leaves|grass|bush/i.test(m.name);

/**
 * Trunk axis of a unit-height tree: per 0.05-high slice, the centroid of the bark vertices close
 * to the previous slice's centre (follows leaning / curved trunks). Returns { radius, axisAt(y) }.
 */
function trunkAxis(bark) {
  const p = bark.getAttribute('position').array;
  const n = p.length / 3;
  // Base radius: bark vertices within +-6 % of the ground plane and 0.15 of the origin (decimated
  // trunks keep only a few rings, so the band must reach the root flare ring below y = 0).
  // Median radius, so root flares / low branches poking out of the band do not inflate it.
  const radii = [];
  for (let i = 0; i < n; i++) {
    const y = p[i * 3 + 1];
    if (y >= -0.06 && y <= 0.06) { const r = Math.hypot(p[i * 3], p[i * 3 + 2]); if (r < 0.15) radii.push(r); }
  }
  radii.sort((a, b) => a - b);
  const rb = Math.max(radii.length ? radii[Math.floor(radii.length * 0.5)] : 0.03, 0.01);
  const slices = [];
  let cx = 0, cz = 0;
  for (let y0 = 0; y0 < 0.7; y0 += 0.05) {
    let sx = 0, sz = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const y = p[i * 3 + 1];
      if (y < y0 || y >= y0 + 0.05) continue;
      const dx = p[i * 3] - cx, dz = p[i * 3 + 2] - cz;
      if (dx * dx + dz * dz > 9 * rb * rb) continue;
      sx += p[i * 3]; sz += p[i * 3 + 2]; k++;
    }
    if (k) { cx = sx / k; cz = sz / k; }
    slices.push([y0 + 0.025, cx, cz]);
  }
  const axisAt = (y) => {
    if (y <= slices[0][0]) return [slices[0][1], slices[0][2]];
    for (let i = 1; i < slices.length; i++) {
      if (y <= slices[i][0]) {
        const a = slices[i - 1], b = slices[i], t = (y - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
    }
    const l = slices[slices.length - 1];
    return [l[1], l[2]];
  };
  return { radius: rb, axisAt };
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Normalises a tree (bark + optional leaves geometries) to unit height, trunk base at the origin. */
function normaliseTree(bark, leaves) {
  const all = leaves ? [bark, leaves] : [bark];
  const H = bboxOf(all).max.y;
  // Trunk base centre: centroid of the bark vertices in the lowest 3 % above ground.
  const p = bark.getAttribute('position').array;
  let cx = 0, cz = 0, n = 0;
  for (let i = 0; i < p.length; i += 3) if (p[i + 1] >= -0.02 * H && p[i + 1] <= 0.03 * H) { cx += p[i]; cz += p[i + 2]; n++; }
  if (n) { cx /= n; cz /= n; }
  const m = new THREE.Matrix4().makeScale(1 / H, 1 / H, 1 / H).multiply(new THREE.Matrix4().makeTranslation(-cx, 0, -cz));
  for (const g of all) applyMatrix(g, m);
  return H;
}

const sway = (x, y) => Math.min(1, Math.max(0, (y - 0.08) / 0.92));

/**
 * `_trunk`: smooth weight (1 on the trunk core, 0 on branches / crown) so the renderer's
 * per-instance trunk-radius scale widens only the trunk; `_sway`: 0 at the base -> 1 at the top.
 */
function treeAttributes(bark, leaves) {
  const axis = trunkAxis(bark);
  const rb = axis.radius;
  addScalar(bark, 'sway', sway);
  addScalar(bark, 'trunk', (x, y, z) => {
    const [ax, az] = axis.axisAt(y);
    const r = Math.hypot(x - ax, z - az);
    return (1 - smoothstep(1.4 * rb, 2.6 * rb, r)) * (1 - smoothstep(0.3, 0.55, y));
  });
  if (leaves) {
    addScalar(leaves, 'sway', sway);
    addScalar(leaves, 'trunk', () => 0);
  }
  const b = bboxOf(leaves ? [bark, leaves] : [bark]);
  return { trunkRadius: r3(rb), crownWidth: r3(Math.max(b.max.x - b.min.x, b.max.z - b.min.z)), rootDepth: r3(-b.min.y) };
}

/** Leaves LOD: thin alpha cards when the canopy is made of many small cards, else decimate. */
async function reduceLeaves(g, target, seed) {
  if (tris(g) <= target) return g;
  const probe = thinCards(g, 1, 1);
  if (probe.cards >= 60) {
    const keep = target / tris(g);
    const grow = Math.min(1.9, Math.pow(1 / keep, 0.42));
    return thinCards(g, keep, grow, seed, target).geometry;
  }
  return simplify(g, target, { uvWeight: 2, normalWeight: 0.2 });
}

function leafTexture(src, size, tint) {
  return retex(src, size, { mime: 'image/png', op: chain(tint, ops.bleed(40)) });
}

/**
 * Builds one tree kind: every variant at LOD0 (<= budget.near tris) and LOD1 (<= budget.far).
 */
async function treeKind({ kind, sources, budget, barkOp, leafOp, barkSize = 512, leafSize = 512, outDir }) {
  let barkMat = null, leafMat = null;
  const root = new THREE.Group();
  root.name = `tree_${kind}`;
  const variants = [];
  let i = 0;
  for (const src of sources) {
    i++;
    const g = await load(dl(src));
    const ps = parts(g.scene);
    const barkParts = ps.filter((p) => !isLeaf(p.material));
    const leafParts = ps.filter((p) => isLeaf(p.material));
    if (!barkMat) {
      const b = barkParts[0].material;
      barkMat = standard(`${kind}_bark`, {
        map: retex(b.map, barkSize, { mime: 'image/jpeg', op: barkOp }),
        normalMap: b.normalMap ? retex(b.normalMap, 256, { mime: 'image/jpeg' }) : null,
        roughness: 0.95,
        metalness: 0,
      });
    }
    if (!leafMat && leafParts.length) {
      const l = leafParts[0].material;
      leafMat = standard(`${kind}_leaves`, { map: leafTexture(l.map, leafSize, leafOp), roughness: 0.9, metalness: 0, alphaTest: 0.5, doubleSided: true });
    }
    const bark0 = merge(barkParts.map((p) => only(p.geometry, ['position', 'normal', 'uv'])));
    const leaves0 = leafParts.length ? merge(leafParts.map((p) => only(p.geometry, ['position', 'normal', 'uv']))) : null;
    const height = normaliseTree(bark0, leaves0);
    const lodGeo = async (b, l, cap, barkShare, seed) => {
      const lt = l ? Math.min(tris(l), Math.round(cap * (1 - barkShare))) : 0;
      const bark = await simplify(b, cap - lt, { uvWeight: 0.5, normalWeight: 0.4 });
      const leaves = l ? await reduceLeaves(l, Math.max(cap - tris(bark), Math.round(tris(l) * 0.25)), seed) : null;
      return { bark, leaves };
    };
    const lod0 = await lodGeo(bark0, leaves0, budget.near, budget.barkShare, 0x1000 + i);
    const lod1 = await lodGeo(lod0.bark, lod0.leaves, budget.far, budget.barkShare, 0x2000 + i);
    const info = treeAttributes(lod0.bark, lod0.leaves);
    treeAttributes(lod1.bark, lod1.leaves);
    const id = `${kind}_${i}`;
    for (const [suffix, lod] of [['', lod0], ['_lod1', lod1]]) {
      const grp = new THREE.Group();
      grp.name = id + suffix;
      grp.add(mesh(`${id}${suffix}_bark`, lod.bark, barkMat));
      if (lod.leaves) grp.add(mesh(`${id}${suffix}_leaves`, lod.leaves, leafMat));
      root.add(grp);
    }
    variants.push({ id, source: src.split('/').pop(), sourceHeight: r3(height), tris: tris(lod0.bark) + (lod0.leaves ? tris(lod0.leaves) : 0), lod1Tris: tris(lod1.bark) + (lod1.leaves ? tris(lod1.leaves) : 0), ...info });
  }
  const file = `${outDir}/tree_${kind}.glb`;
  const bytes = await exportGlb(root, file);
  return { kind, file, bytes, variants, root };
}

// ------------------------------------------------------------------------------------------------

async function rocks({ src, nodes, outDir, near, far }) {
  const g = await load(dl(src));
  const root = new THREE.Group();
  root.name = 'rocks';
  let mat = null;
  const variants = [];
  let i = 0;
  for (const nodeName of nodes) {
    i++;
    const node = g.scene.getObjectByName(nodeName);
    if (!node) throw new Error(`no rock node ${nodeName}`);
    const ps = parts(g.scene, { under: node });
    if (!mat) {
      const m = ps[0].material;
      mat = standard('rock', {
        map: retex(m.map, 512, { mime: 'image/jpeg' }),
        normalMap: retex(m.normalMap, 512, { mime: 'image/jpeg' }),
        roughnessMap: m.roughnessMap ? retex(m.roughnessMap, 256, { mime: 'image/jpeg' }) : null,
        roughness: 1,
        metalness: 0,
      });
    }
    let geo = merge(ps.map((p) => only(p.geometry, ['position', 'normal', 'uv'])));
    // Base plane y = 0, top y = 1, horizontal radius 1 (non-uniform: RockDef scales (r, h, r)).
    const b = bbox(geo), c = b.getCenter(new THREE.Vector3());
    const rad = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
    const span = b.max.y - b.min.y;
    const m = new THREE.Matrix4().makeTranslation(0, -0.2, 0)
      .multiply(new THREE.Matrix4().makeScale(1 / rad, 1.2 / span, 1 / rad))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z));
    applyMatrix(geo, m);
    const src0 = tris(geo);
    const lod0 = await simplify(geo, near, { uvWeight: 1, normalWeight: 0.3 });
    const lod1 = await simplify(lod0, far, { uvWeight: 1, normalWeight: 0.3 });
    const id = `rock_${i}`;
    root.add(mesh(id, lod0, mat));
    root.add(mesh(`${id}_lod1`, lod1, mat));
    const s = b.getSize(new THREE.Vector3());
    variants.push({ id, source: nodeName, sourceTris: src0, tris: tris(lod0), lod1Tris: tris(lod1), sourceSize: [r3(s.x), r3(s.y), r3(s.z)] });
  }
  const file = `${outDir}/rocks.glb`;
  return { file, bytes: await exportGlb(root, file), variants };
}

// ------------------------------------------------------------------------------------------------

async function bushes({ sources, outDir, near, far, width = 1.6 }) {
  const root = new THREE.Group();
  root.name = 'bushes';
  const variants = [];
  const mats = new Map();
  let i = 0;
  for (const s of sources) {
    i++;
    const g = await load(dl(s.src));
    const ps = parts(g.scene);
    const srcMat = ps[0].material;
    // Same source pack + material name = same texture: share one material (and one image).
    const key = `${s.src.slice(0, s.src.lastIndexOf('/'))}|${srcMat.name}`;
    if (!mats.has(key)) {
      mats.set(key, standard(`bush_leaves_${mats.size + 1}`, { map: leafTexture(srcMat.map, 512, s.tint), roughness: 0.9, metalness: 0, alphaTest: 0.5, doubleSided: true }));
    }
    const mat = mats.get(key);
    let geo = merge(ps.map((p) => only(p.geometry, ['position', 'normal', 'uv'])));
    const b = bbox(geo), c = b.getCenter(new THREE.Vector3());
    const k = width / Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    applyMatrix(geo, new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z)));
    const lod0 = await reduceLeaves(geo, near, 0x3000 + i);
    const lod1 = await reduceLeaves(lod0, far, 0x4000 + i);
    for (const x of [lod0, lod1]) addScalar(x, 'sway', (px, py) => Math.max(0, py) * 2.2);
    const id = `bush_${i}`;
    root.add(mesh(id, lod0, mat));
    root.add(mesh(`${id}_lod1`, lod1, mat));
    const bb = bbox(lod0);
    variants.push({ id, source: s.src.split('/').pop(), tris: tris(lod0), lod1Tris: tris(lod1), height: r3(bb.max.y), material: mat.name });
  }
  const file = `${outDir}/bushes.glb`;
  return { file, bytes: await exportGlb(root, file), variants, root };
}

async function grass({ sources, outDir, maxTris }) {
  const root = new THREE.Group();
  root.name = 'grass';
  const variants = [];
  const mats = new Map();
  let i = 0;
  for (const s of sources) {
    i++;
    const g = await load(dl(s.src));
    const ps = parts(g.scene);
    const srcMat = ps[0].material;
    // Same source pack + material name = same texture: share one material (and one image).
    const key = `${s.src.slice(0, s.src.lastIndexOf('/'))}|${srcMat.name}`;
    if (!mats.has(key)) mats.set(key, standard(`grass_${mats.size + 1}`, { map: leafTexture(srcMat.map, 256, s.tint), roughness: 0.95, metalness: 0, alphaTest: 0.5, doubleSided: true }));
    let geo = merge(ps.map((p) => only(p.geometry, ['position', 'normal', 'uv'])));
    const b = bbox(geo), c = b.getCenter(new THREE.Vector3());
    const H = b.max.y;
    applyMatrix(geo, new THREE.Matrix4().makeScale(1 / H, 1 / H, 1 / H).multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z)));
    geo = await simplify(geo, maxTris, { uvWeight: 2, normalWeight: 0.1 });
    addScalar(geo, 'sway', (x, y) => Math.min(1, Math.max(0, y)));
    const id = `grass_${i}`;
    root.add(mesh(id, geo, mats.get(key)));
    const bb = bbox(geo);
    variants.push({ id, source: s.src.split('/').pop(), tris: tris(geo), width: r3(Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z)), sourceHeight: r3(H) });
  }
  const file = `${outDir}/grass.glb`;
  return { file, bytes: await exportGlb(root, file), variants };
}

// ------------------------------------------------------------------------------------------------

/**
 * Far-band impostor atlas: one cell per kind (pine, oak, birch, dead, bush), base at the bottom,
 * rendered orthographically from the side with unlit albedo (the impostor material is lit by the
 * scene). Cell width / height ratio = IMPOSTOR_WIDTH of vegetationModels.ts.
 */
async function impostors({ cells, outDir, cellW = 256, cellH = 512 }) {
  const W = cellW * cells.length, H = cellH;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.clear();
  cells.forEach((cell, k) => {
    const scene = new THREE.Scene();
    const obj = cell.object.clone(true);
    obj.position.set(0, 0, 0);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      // Unlit albedo, slightly darkened toward the bottom / inside of the crown (fake occlusion).
      const basic = new THREE.MeshBasicMaterial({ map: m.map, alphaTest: m.alphaTest, side: THREE.DoubleSide, color: 0xd8d8d8 });
      o.material = basic;
    });
    scene.add(obj);
    const h = cell.height, w = h * cell.widthRatio;
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h, 0, -50, 50);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    // Orthographic frustum spans y 0..h (base at the bottom of the cell).
    cam.top = h; cam.bottom = 0; cam.updateProjectionMatrix();
    renderer.setViewport(k * cellW, 0, cellW, cellH);
    renderer.setScissor(k * cellW, 0, cellW, cellH);
    renderer.setScissorTest(true);
    renderer.render(scene, cam);
  });
  const blob = await new Promise((res) => renderer.domElement.toBlob(res, 'image/png'));
  const file = `${outDir}/impostors.png`;
  await window.__writeFile(file, toBase64(await blob.arrayBuffer()));
  renderer.dispose();
  return { file, size: [W, H], cells: cells.map((c) => ({ name: c.name, widthRatio: c.widthRatio, height: c.height })) };
}

// ------------------------------------------------------------------------------------------------

export async function buildNature({ MEGAKIT, ULTNAT, PHB, outDir }) {
  const out = { trees: [] };
  const green = ops.tint([0.62, 0.86, 0.36], 1, 1.05);
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
  // The MegaKit bark is quite red: pull it toward a grey-brown for the temperate island look.
  const bark = ops.tint([1.05, 0.9, 0.78], 0.45, 1.0);
  const pine = await treeKind({
    kind: 'pine', outDir, sources: range(5, (i) => `${MEGAKIT}/Pine_${i}.gltf`),
    budget: { near: 2000, far: 640, barkShare: 0.62 }, barkOp: bark,
  });
  const oak = await treeKind({
    kind: 'oak', outDir, sources: range(5, (i) => `${MEGAKIT}/CommonTree_${i}.gltf`),
    budget: { near: 2000, far: 640, barkShare: 0.45 }, barkOp: bark,
  });
  const birch = await treeKind({
    kind: 'birch', outDir, sources: range(5, (i) => `${ULTNAT}/BirchTree_${i}.gltf`),
    budget: { near: 2000, far: 640, barkShare: 0.45 }, leafOp: green,
  });
  const dead = await treeKind({
    kind: 'dead', outDir, sources: range(5, (i) => `${MEGAKIT}/DeadTree_${i}.gltf`),
    budget: { near: 2000, far: 600, barkShare: 1 }, barkOp: ops.gain(1.45),
  });
  const bush = await bushes({
    outDir, near: 900, far: 300,
    sources: [
      // Bush_Common ships with the red autumn "twisted tree" leaves: re-tint (dark source -> more gain).
      { src: `${MEGAKIT}/Bush_Common.gltf`, tint: ops.tint([0.55, 0.8, 0.33], 1, 2.3) },
      // The Ultimate Nature bushes are lime green: tone them toward the island's foliage.
      { src: `${ULTNAT}/Bush.gltf`, tint: ops.tint([0.62, 0.8, 0.4], 0.45, 0.95) },
      { src: `${ULTNAT}/Bush_Large.gltf`, tint: ops.tint([0.62, 0.8, 0.4], 0.45, 0.95) },
    ],
  });
  const rock = await rocks({
    src: `${PHB}/rock_moss_set_01/rock_moss_set_01_1k.gltf`, outDir, near: 700, far: 180,
    nodes: ['rock_moss_set_01_rock01', 'rock_moss_set_01_rock02', 'rock_moss_set_01_rock03', 'rock_moss_set_01_rock04', 'rock_moss_set_01_rock05', 'rock_moss_set_01_rock06'],
  });
  const grassRes = await grass({
    outDir, maxTris: 120,
    sources: [
      { src: `${ULTNAT}/Grass_Small.gltf` },
      { src: `${ULTNAT}/Grass_Large.gltf` },
      { src: `${MEGAKIT}/Grass_Common_Short.gltf` },
    ],
  });
  // Cell width / height = the variant's crown width (+2 %), reported so the renderer can size the
  // far quads (IMPOSTOR_WIDTH) to match the atlas.
  const cellOf = (t, name) => ({ name, object: t.root.getObjectByName(`${name}_1`), height: 1, widthRatio: +(t.variants[0].crownWidth * 1.02).toFixed(3) });
  const imp = await impostors({
    outDir,
    cells: [cellOf(pine, 'pine'), cellOf(oak, 'oak'), cellOf(birch, 'birch'), cellOf(dead, 'dead'),
      // The renderer's bush quad is BUSH_IMPOSTOR_W x BUSH_IMPOSTOR_H = 1.7 x 1.0 m at scale 1.
      { name: 'bush', object: bush.root.getObjectByName('bush_1'), height: Math.max(1, bush.variants[0].height), widthRatio: 1.7 }],
  });
  for (const t of [pine, oak, birch, dead]) out.trees.push({ kind: t.kind, file: t.file, bytes: t.bytes, variants: t.variants });
  out.bushes = { file: bush.file, bytes: bush.bytes, variants: bush.variants };
  out.rocks = rock;
  out.grass = grassRes;
  out.impostors = imp;
  return out;
}
