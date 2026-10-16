// Hay stack build (browser side): Kenney Graveyard Kit "hay-bale-bundled" (CC0) recoloured to
// straw, decimated, and stacked 2 x 3 x 2 into the world generator's 1.6 x 0.9 x 1.2 m barn box.
import {
  THREE, load, dl, parts, merge, simplify, bboxOf, bbox, tris, applyMatrix, retex, standard, mesh, only,
  exportGlb, sceneTris,
} from '/scripts/world/world.page.js';

const r3 = (v) => v.toArray().map((x) => +x.toFixed(3));

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export async function inspect() {
  const out = {};
  for (const f of ['hay-bale.glb', 'hay-bale-bundled.glb']) {
    const g = await load(dl(f));
    const ps = parts(g.scene);
    const geo = ps[0].geometry;
    const uv = geo.getAttribute('uv').array;
    const us = new Map();
    const idx = geo.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const u = uv[idx[i] * 2].toFixed(4);
      us.set(u, (us.get(u) || 0) + 1);
    }
    out[f] = { parts: ps.length, tris: tris(geo), verts: geo.getAttribute('position').count, size: r3(bbox(geo).getSize(new THREE.Vector3())), min: r3(bbox(geo).min), uCols: Object.fromEntries(us), mat: ps[0].material.name, map: !!ps[0].material.map, flipY: ps[0].material.map && ps[0].material.map.flipY };
  }
  return out;
}

const BODY_U = 0.46875, STRING_U = 0.34375;
/** Mean albedo of the procedural hay box (PAL.hay 0xc4ac6a, sRGB) and a sisal twine. */
// The per-bale vertex shade averages 0.92: the palette is brightened by 1 / 0.92 to compensate.
const SHADE_MEAN = 0.92;
const STRAW = [196, 172, 106].map((c) => c / SHADE_MEAN), TWINE = [150, 104, 62].map((c) => c / SHADE_MEAN);

/** Splits the bale into body / string triangles by their palette column. */
function splitByColumn(geo) {
  const uv = geo.getAttribute('uv').array, idx = geo.index.array;
  const body = [], str = [];
  for (let i = 0; i < idx.length; i += 3) (Math.abs(uv[idx[i] * 2] - BODY_U) < 1e-3 ? body : str).push(idx[i], idx[i + 1], idx[i + 2]);
  const sub = (list) => {
    const g = geo.clone();
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(list), 1));
    return compactGeo(g);
  };
  return { body: sub(body), strings: sub(str) };
}

function compactGeo(g) {
  const idx = g.index.array, n0 = g.getAttribute('position').count;
  const remap = new Int32Array(n0).fill(-1);
  let n = 0;
  const outIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) { if (remap[idx[i]] < 0) remap[idx[i]] = n++; outIdx[i] = remap[idx[i]]; }
  const out = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(g.attributes)) {
    const s = a.itemSize, src = a.array, dst = new Float32Array(n * s);
    for (let v = 0; v < n0; v++) { const r = remap[v]; if (r >= 0) for (let c = 0; c < s; c++) dst[r * s + c] = src[v * s + c]; }
    out.setAttribute(k, new THREE.BufferAttribute(dst, s));
  }
  out.setIndex(new THREE.BufferAttribute(outIdx, 1));
  return out;
}

/** Remaps palette uvs: body -> left half, strings -> right half; v (0.525..0.975) -> 0..1 per half. */
function remapUv(geo, isBody) {
  const uv = geo.getAttribute('uv').array;
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] = isBody ? 0.25 : 0.75;
    const v0 = isBody ? 0.5 : 0.75;
    uv[i + 1] = Math.min(1, Math.max(0, (uv[i + 1] - v0) / 0.25));
  }
  geo.getAttribute('uv').needsUpdate = true;
}

/**
 * 64 x 64 palette: left half straw, right half twine, each with the luminance profile of the
 * Kenney colormap column it replaces (so the original top-to-bottom shading is kept).
 */
function strawPalette(colormap) {
  const img = colormap.image;
  const c0 = document.createElement('canvas');
  c0.width = img.width; c0.height = img.height;
  const x0 = c0.getContext('2d', { willReadFrequently: true });
  x0.drawImage(img, 0, 0);
  const src = x0.getImageData(0, 0, img.width, img.height).data;
  const W = img.width, H = img.height;
  const lumAt = (u, v) => {
    const x = Math.min(W - 1, Math.floor(u * W)), y = Math.min(H - 1, Math.floor(v * H));
    const i = (y * W + x) * 4;
    return 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  };
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const d = ctx.createImageData(S, S);
  const prof = (u, v0, lo, hi) => {
    const p = [];
    for (let j = 0; j < S; j++) p.push(lumAt(u, v0 + ((j + 0.5) / S) * 0.25));
    // Mean over the range actually used by the mesh (lo..hi in remapped v).
    let m = 0, k = 0;
    for (let j = Math.floor(lo * S); j < Math.ceil(hi * S); j++) { m += p[j]; k++; }
    return p.map((x) => x / (m / k));
  };
  const body = prof(BODY_U, 0.5, 0.1, 0.9), str = prof(STRING_U, 0.75, 0.1, 0.9);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const left = i < S / 2;
      const k = left ? body[j] : str[j];
      const col = left ? STRAW : TWINE;
      const o = (j * S + i) * 4;
      d.data[o] = Math.min(255, col[0] * k); d.data[o + 1] = Math.min(255, col[1] * k); d.data[o + 2] = Math.min(255, col[2] * k); d.data[o + 3] = 255;
    }
  }
  ctx.putImageData(d, 0, 0);
  const t = new THREE.Texture(c);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.userData.mimeType = 'image/png';
  t.name = 'hay_palette';
  t.needsUpdate = true;
  return { tex: t, body, str };
}

/** Triangle normal (from positions) of triangle starting at index i. */
function triInfo(pos, idx, i, n, c) {
  const ax = pos[idx[i] * 3], ay = pos[idx[i] * 3 + 1], az = pos[idx[i] * 3 + 2];
  const bx = pos[idx[i + 1] * 3], by = pos[idx[i + 1] * 3 + 1], bz = pos[idx[i + 1] * 3 + 2];
  const cx = pos[idx[i + 2] * 3], cy = pos[idx[i + 2] * 3 + 1], cz = pos[idx[i + 2] * 3 + 2];
  n.set(bx - ax, by - ay, bz - az).cross(new THREE.Vector3(cx - ax, cy - ay, cz - az)).normalize();
  c.minX = Math.min(ax, bx, cx); c.maxX = Math.max(ax, bx, cx);
}

/** Copy of `geo` without the triangles for which drop(normal, info) is true. */
function dropTris(geo, drop) {
  const pos = geo.getAttribute('position').array, idx = geo.index.array;
  const keep = [];
  const n = new THREE.Vector3(), c = {};
  for (let i = 0; i < idx.length; i += 3) {
    triInfo(pos, idx, i, n, c);
    if (!drop(n, c)) keep.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  const g = geo.clone();
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(keep), 1));
  return compactGeo(g);
}

/**
 * Builds the stack: `grid` = [nx, ny, nz] bales of `bale` = [L, H, W] metres. Faces that are
 * always hidden are left out: the twine's side walls (4 mm high), the bottoms of the lowest layer
 * (on the floor) and the end caps where two bales of a row meet (rows overlap by `overlap`).
 */
export async function buildHay({ out, bale = [0.8, 0.45, 0.4], grid = [2, 2, 3], bodyTris = 9999, overlap = 0.015, dropEnds = false, shots = null, seed = 0x4a7 }) {
  const g = await load(dl('hay-bale-bundled.glb'));
  const ps = parts(g.scene);
  const src = only(ps[0].geometry, ['position', 'normal', 'uv']);
  const split = splitByColumn(src);
  // Twine: outer surface only.
  const strings = dropTris(split.strings, (n) => Math.abs(n.x) > 0.7);
  const body = await simplify(split.body, bodyTris, { uvWeight: 0.2, normalWeight: 0.6 });
  remapUv(body, true); remapUv(strings, false);
  const one = merge([body, strings]);
  const bb = bbox(one), sz = bb.getSize(new THREE.Vector3()), cc = bb.getCenter(new THREE.Vector3());
  const endCap = (bb.max.x - cc.x) * (0.25 / 0.303);
  one.translate(-cc.x, -bb.min.y, -cc.z);
  const len = bale[0] + overlap;
  const sx = len / sz.x, sy = bale[1] / sz.y, sz2 = bale[2] / sz.z;
  const rnd = rng(seed);
  const pieces = [];
  const [nx, ny, nz] = grid;
  const capX = endCap * sx;
  for (let y = 0; y < ny; y++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const flip = rnd() < 0.5;
        // Inner ends (towards a neighbour in the row) in the bale's own frame.
        const innerPos = dropEnds && ix < nx - 1, innerNeg = dropEnds && ix > 0;
        const dropPos = flip ? innerNeg : innerPos, dropNeg = flip ? innerPos : innerNeg;
        const p = dropTris(one.clone().scale(sx, sy, sz2), (n, c) =>
          (y === 0 && n.y < -0.7) || (dropPos && c.minX > capX - 1e-4) || (dropNeg && c.maxX < -capX + 1e-4));
        const x = (ix - (nx - 1) / 2) * bale[0], z = (iz - (nz - 1) / 2) * bale[2];
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(x + (rnd() - 0.5) * 0.01, y * bale[1], z + (rnd() - 0.5) * 0.03),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (rnd() - 0.5) * 0.035 + (flip ? Math.PI : 0), 0)),
          new THREE.Vector3(1, 1, 0.97 + rnd() * 0.05),
        );
        applyMatrix(p, m);
        // Per-bale shade (vertex colour) so the stack reads as separate bales.
        const k = 0.84 + rnd() * 0.16, old = rnd() < 0.3;
        const n = p.getAttribute('position').count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { col[i * 3] = k * (old ? 0.95 : 1); col[i * 3 + 1] = k * (old ? 0.96 : 1); col[i * 3 + 2] = k; }
        p.setAttribute('color', new THREE.BufferAttribute(col, 3));
        pieces.push(p);
      }
    }
  }
  const geo = merge(pieces);
  const b = bbox(geo), c = b.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -b.min.y, -c.z);
  const pal = strawPalette(ps[0].material.map);
  const mat = standard('hay_bales', { map: pal.tex, roughness: 0.95, metalness: 0, vertexColors: true });
  const root = new THREE.Group();
  root.name = 'hay_bales';
  root.add(mesh('hay_bales', geo, mat));
  let bytes = 0;
  if (out) bytes = await exportGlb(root, out);
  if (shots) await preview(root, one.clone().scale(sx, sy, sz2), pal.tex, shots);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  return { tris: sceneTris(root), baleTris: tris(one), bodyTris: tris(body), stringTris: tris(strings), size: r3(box.getSize(new THREE.Vector3())), min: r3(box.min), bytes, verts: geo.getAttribute('position').count };
}

async function preview(root, one, tex, shots) {
  const r = new THREE.WebGLRenderer({ antialias: true });
  r.setSize(1280, 720);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(r.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9aa7b0);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x5a4a30, 1.2));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(3, 5, 2);
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x6b5a45 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  // Stack, a second stack on top of a third (as the barns do), procedural box for comparison, one bale.
  const a = root.clone(); a.position.set(-1.0, 0, 0); scene.add(a);
  const b2 = root.clone(); b2.position.set(1.0, 0, 0); scene.add(b2);
  const b3 = root.clone(); b3.position.set(1.0, 0.9, 0); scene.add(b3);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.2), new THREE.MeshStandardMaterial({ color: 0xc4ac6a, roughness: 0.95 }));
  box.position.set(-1.0, 0.45, 2.0); scene.add(box);
  const single = new THREE.Mesh(one, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  single.position.set(1.2, 0, 2.0); scene.add(single);
  const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 100);
  cam.position.set(1.5, 2.3, 5.8); cam.lookAt(0, 0.6, 0.6);
  r.render(scene, cam);
  await window.__shot(shots + '-a.png');
  cam.position.set(-3.2, 1.0, 2.6); cam.lookAt(0, 0.5, 0.5);
  r.render(scene, cam);
  await window.__shot(shots + '-b.png');
}

export async function classify() {
  const g = await load(dl('hay-bale-bundled.glb'));
  const src = only(parts(g.scene)[0].geometry, ['position', 'normal', 'uv']);
  const { body, strings } = splitByColumn(src);
  const stat = (geo) => {
    const p = geo.getAttribute('position').array, idx = geo.index.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    const cls = { endX: 0, down: 0, up: 0, side: 0 };
    const xs = new Set();
    for (let i = 0; i < idx.length; i += 3) {
      a.fromArray(p, idx[i] * 3); b.fromArray(p, idx[i + 1] * 3); c.fromArray(p, idx[i + 2] * 3);
      n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize().negate();
      if (Math.abs(n.x) > 0.7) cls.endX++; else if (n.y < -0.7) cls.down++; else if (n.y > 0.7) cls.up++; else cls.side++;
      for (const v of [a, b, c]) xs.add(v.x.toFixed(3));
    }
    return { tris: idx.length / 3, cls, xs: [...xs].sort((x, y) => x - y) };
  };
  return { body: stat(body), strings: stat(strings) };
}
