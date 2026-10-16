// Browser-side helpers for the world-asset pipeline (vehicles / props / nature), loaded from
// /scripts/world/world.page.js inside the headless page created by ../harness.mjs. Everything
// here treats the downloaded files as data only (glTF JSON + buffers + images).
//
// Building blocks:
//  * parts(): flatten a loaded glTF into root-space geometry parts (matrices baked, winding fixed),
//  * simplify(): attribute-aware meshoptimizer decimation (UV / normal seams preserved),
//  * thinCards(): foliage LOD by dropping whole alpha cards and growing the survivors,
//  * texture helpers that resize / recolour images on a canvas before export,
//  * exportGlb(): binary glTF via GLTFExporter, streamed back to Node.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from '/meshopt/meshopt_simplifier.js';

export { THREE };

const loader = new GLTFLoader();
export function load(url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

/** URL of a file under $ASSETS_DL (mounted at /dl/). */
export function dl(rel) {
  return '/dl/' + rel.split('/').map(encodeURIComponent).join('/');
}

// ------------------------------------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------------------------------------

const KEEP_ATTRS = ['position', 'normal', 'uv', 'color'];

/** Plain (non-interleaved, float) copy of an attribute. */
function plain(attr) {
  const n = attr.count, s = attr.itemSize;
  const out = new Float32Array(n * s);
  for (let i = 0; i < n; i++) {
    out[i * s] = attr.getX(i);
    if (s > 1) out[i * s + 1] = attr.getY(i);
    if (s > 2) out[i * s + 2] = attr.getZ(i);
    if (s > 3) out[i * s + 3] = attr.getW(i);
  }
  return new THREE.BufferAttribute(out, s);
}

/** Indexed, float, position/normal/uv/color-only copy of `geo` transformed by `matrix`. */
export function bake(geo, matrix) {
  const g = new THREE.BufferGeometry();
  for (const k of KEEP_ATTRS) {
    const a = geo.getAttribute(k);
    if (!a) continue;
    if (k === 'color' && a.itemSize === 4) {
      const c = plain(a), rgb = new Float32Array(c.count * 3);
      for (let i = 0; i < c.count; i++) { rgb[i * 3] = c.array[i * 4]; rgb[i * 3 + 1] = c.array[i * 4 + 1]; rgb[i * 3 + 2] = c.array[i * 4 + 2]; }
      g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    } else g.setAttribute(k, plain(a));
  }
  const count = g.getAttribute('position').count;
  const index = geo.index ? Uint32Array.from({ length: geo.index.count }, (_, i) => geo.index.getX(i)) : Uint32Array.from({ length: count }, (_, i) => i);
  g.setIndex(new THREE.BufferAttribute(index, 1));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (matrix) applyMatrix(g, matrix);
  return g;
}

/** Applies a matrix to positions + normals and flips the winding for mirroring matrices. */
export function applyMatrix(g, matrix) {
  g.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.index.needsUpdate = true;
  }
  return g;
}

/**
 * Mesh parts below `under` (default: the whole scene) as { name, node, geometry, material } with
 * geometry in the coordinate space of `root` (the loaded gltf.scene). Multi-material meshes are
 * split by group.
 */
export function parts(root, { under = null, filter = null } = {}) {
  root.updateMatrixWorld(true);
  const out = [];
  (under || root).traverse((o) => {
    if (!o.isMesh || (filter && !filter(o))) return;
    const g = bake(o.geometry, o.matrixWorld);
    if (Array.isArray(o.material)) {
      for (const grp of o.geometry.groups) {
        out.push({ name: o.name, node: o, geometry: subset(g, grp.start, grp.count), material: o.material[grp.materialIndex] });
      }
    } else out.push({ name: o.name, node: o, geometry: g, material: o.material });
  });
  return out;
}

function subset(g, start, count) {
  const idx = g.index.array.slice(start, start + count);
  return compact(g, idx);
}

/** New geometry holding only the vertices referenced by `indices` (Uint32Array). */
export function compact(g, indices) {
  const remap = new Int32Array(g.getAttribute('position').count).fill(-1);
  let n = 0;
  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] < 0) remap[v] = n++;
    outIdx[i] = remap[v];
  }
  const out = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(g.attributes)) {
    const s = a.itemSize, src = a.array, dst = new Float32Array(n * s);
    for (let v = 0; v < remap.length; v++) {
      const r = remap[v];
      if (r < 0) continue;
      for (let c = 0; c < s; c++) dst[r * s + c] = src[v * s + c];
    }
    out.setAttribute(k, new THREE.BufferAttribute(dst, s));
  }
  out.setIndex(new THREE.BufferAttribute(outIdx, 1));
  return out;
}

/** Indexed copy with vertices merged by position (+uv when present); normals dropped. */
export function weldGeometry(g) {
  const c = g.clone();
  c.deleteAttribute('normal');
  for (const k of Object.keys(c.attributes)) if (k !== 'position' && k !== 'uv') c.deleteAttribute(k);
  const m = mergeVertices(c, 1e-5);
  m.computeVertexNormals();
  return m;
}

/** Normals with hard edges above `angle` degrees (re-indexed). */
export function creased(g, angle = 40) {
  const keep = {};
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') keep[k] = true;
  const nonIdx = toCreasedNormals(g, (angle * Math.PI) / 180);
  const m = mergeVertices(nonIdx, 1e-6);
  return m;
}

export function tris(g) {
  return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
}

/** Merges geometries (missing uv -> 0, missing colour -> white when any part has colours). */
export function merge(geos) {
  if (geos.length === 1) return geos[0];
  const hasUv = geos.some((g) => g.getAttribute('uv')), hasColor = geos.some((g) => g.getAttribute('color'));
  const custom = new Set();
  for (const g of geos) for (const k of Object.keys(g.attributes)) if (!KEEP_ATTRS.includes(k)) custom.add(k);
  const norm = geos.map((g) => {
    const c = new THREE.BufferGeometry();
    const n = g.getAttribute('position').count;
    c.setAttribute('position', g.getAttribute('position'));
    c.setAttribute('normal', g.getAttribute('normal'));
    if (hasUv) c.setAttribute('uv', g.getAttribute('uv') || new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (hasColor) c.setAttribute('color', g.getAttribute('color') || new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    for (const k of custom) c.setAttribute(k, g.getAttribute(k) || new THREE.BufferAttribute(new Float32Array(n), 1));
    c.setIndex(g.index);
    return c;
  });
  const m = mergeGeometries(norm, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

export function bbox(g) {
  g.computeBoundingBox();
  return g.boundingBox.clone();
}

export function bboxOf(geos) {
  const b = new THREE.Box3();
  for (const g of geos) b.union(bbox(g));
  return b;
}

/**
 * Attribute-aware meshoptimizer decimation to about `target` triangles. The error bound is relaxed
 * step by step until the target is reached (or `maxError`). UV / normal seams stay intact.
 * Returns the new geometry (input untouched).
 */
export async function simplify(g, target, { uvWeight = 1, normalWeight = 0.5, maxError = 0.25, lockBorder = false, regularize = false, weld = false, crease = 40 } = {}) {
  await MeshoptSimplifier.ready;
  if (tris(g) <= target) return g;
  if (weld) {
    // Flat-shaded sources split every vertex per face, which makes every edge a seam. Weld by
    // position (+uv), simplify, then rebuild creased normals.
    const w = weldGeometry(g);
    const s = await simplify(w, target, { uvWeight, normalWeight: 0, maxError, lockBorder, regularize });
    return creased(s, crease);
  }
  const pos = g.getAttribute('position').array;
  const nrm = g.getAttribute('normal').array;
  const uv = g.getAttribute('uv') ? g.getAttribute('uv').array : null;
  const n = pos.length / 3;
  const stride = uv ? 5 : 3;
  const attrs = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    attrs[i * stride] = nrm[i * 3]; attrs[i * stride + 1] = nrm[i * 3 + 1]; attrs[i * stride + 2] = nrm[i * 3 + 2];
    if (uv) { attrs[i * stride + 3] = uv[i * 2]; attrs[i * stride + 4] = uv[i * 2 + 1]; }
  }
  const weights = uv ? [normalWeight, normalWeight, normalWeight, uvWeight, uvWeight] : [normalWeight, normalWeight, normalWeight];
  const idx = Uint32Array.from(g.index.array);
  const flags = [];
  if (lockBorder) flags.push('LockBorder');
  if (regularize) flags.push('Regularize');
  const t3 = Math.max(3, Math.floor(target)) * 3;
  let best = null;
  for (let err = 0.01; err <= maxError + 1e-9; err *= 1.6) {
    const [res] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, attrs, stride, weights, null, t3, err, flags);
    best = res;
    if (res.length <= t3 * 1.04) break;
  }
  if (best.length > t3 * 1.04) {
    // Seams / borders stopped the regular pass: allow collapses across attribute seams.
    const [res] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, attrs, stride, weights, null, t3, maxError, [...flags, 'Permissive']);
    if (res.length < best.length) best = res;
  }
  return compact(g, best);
}

/**
 * Foliage LOD: keeps a deterministic `keep` fraction of the connected components ("cards") of
 * `g` and scales each survivor by `grow` around its centroid so the canopy keeps its coverage.
 */
export function thinCards(g, keep, grow = 1, seed = 1) {
  const pos = g.getAttribute('position').array;
  const n = pos.length / 3;
  // Union-find over vertices welded by quantised position (cards split at UV seams stay whole).
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const weld = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * 2000)},${Math.round(pos[i * 3 + 1] * 2000)},${Math.round(pos[i * 3 + 2] * 2000)}`;
    const w = weld.get(k);
    if (w === undefined) weld.set(k, i); else unite(i, w);
  }
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { unite(idx[i], idx[i + 1]); unite(idx[i], idx[i + 2]); }
  const comps = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]);
    let c = comps.get(r);
    if (!c) { c = { tris: [], verts: new Set() }; comps.set(r, c); }
    c.tris.push(t);
    c.verts.add(idx[t]); c.verts.add(idx[t + 1]); c.verts.add(idx[t + 2]);
  }
  const list = [...comps.values()];
  // Deterministic shuffle (xorshift) so the kept subset is spread over the whole canopy.
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const keyed = list.map((c) => ({ c, k: rnd() }));
  keyed.sort((a, b) => a.k - b.k);
  const count = Math.max(1, Math.round(list.length * keep));
  const kept = keyed.slice(0, count).map((x) => x.c);
  const out = g.clone();
  const p = out.getAttribute('position').array;
  const newIdx = [];
  for (const c of kept) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of c.verts) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; }
    cx /= c.verts.size; cy /= c.verts.size; cz /= c.verts.size;
    for (const v of c.verts) {
      p[v * 3] = cx + (pos[v * 3] - cx) * grow;
      p[v * 3 + 1] = cy + (pos[v * 3 + 1] - cy) * grow;
      p[v * 3 + 2] = cz + (pos[v * 3 + 2] - cz) * grow;
    }
    for (const t of c.tris) newIdx.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  return { geometry: compact(out, Uint32Array.from(newIdx)), cards: list.length, kept: count };
}

/** Adds a float attribute computed per vertex: fn(x, y, z, i) -> number. */
export function addScalar(g, name, fn) {
  const pos = g.getAttribute('position').array;
  const n = pos.length / 3;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], i);
  g.setAttribute(name, new THREE.BufferAttribute(a, 1));
  return g;
}

/** Sets a constant vertex colour (linear RGB) on every vertex. */
export function setColor(g, r, gg, b) {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Sets every uv to (u, v) (palette lookups). */
export function setUv(g, u, v) {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = u; a[i * 2 + 1] = v; }
  g.setAttribute('uv', new THREE.BufferAttribute(a, 2));
  return g;
}

/** Drops every attribute not listed. */
export function only(g, names) {
  for (const k of Object.keys(g.attributes)) if (!names.includes(k)) g.deleteAttribute(k);
  return g;
}

/** Recomputes smooth normals (after scaling non-uniformly etc.). */
export function renormal(g) {
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------------------------------------
// Textures
// ------------------------------------------------------------------------------------------------

/**
 * Draws `image` into a new canvas whose larger edge is `size` (aspect kept, power of two), then
 * runs `op(data, w, h)` on its RGBA pixels when given.
 */
export function canvasOf(image, size, op = null) {
  const iw = image.width, ih = image.height;
  const k = Math.min(1, size / Math.max(iw, ih));
  const pow2 = (x) => 2 ** Math.round(Math.log2(Math.max(1, x)));
  const w = pow2(iw * k), h = pow2(ih * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  if (op) {
    const d = ctx.getImageData(0, 0, w, h);
    op(d.data, w, h);
    ctx.putImageData(d, 0, 0);
  }
  return c;
}

/** Texture copy of `src` resized to `size` with optional pixel op; mime 'image/jpeg' | 'image/png'. */
export function retex(src, size, { op = null, mime = 'image/jpeg', colorSpace = null } = {}) {
  const t = new THREE.Texture(canvasOf(src.image, size, op));
  t.flipY = src.flipY;
  t.wrapS = src.wrapS; t.wrapT = src.wrapT;
  t.magFilter = src.magFilter; t.minFilter = src.minFilter;
  t.colorSpace = colorSpace ?? src.colorSpace;
  t.channel = src.channel;
  t.userData.mimeType = mime;
  t.name = src.name;
  t.needsUpdate = true;
  return t;
}

/** Texture made from a canvas drawn by `draw(ctx, w, h)`. */
export function paintTex(w, h, draw, { mime = 'image/png', srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.Texture(c);
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.userData.mimeType = mime;
  t.needsUpdate = true;
  return t;
}

/** Pixel ops (sRGB bytes). */
export const ops = {
  /** Multiplies RGB by k (brighten > 1). */
  gain: (k) => (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = Math.min(255, d[i] * k); d[i + 1] = Math.min(255, d[i + 1] * k); d[i + 2] = Math.min(255, d[i + 2] * k); } },
  /** Re-tints by luminance: out = lerp(original, lum * tint, amount). tint is [r,g,b] 0..1 (sRGB). */
  tint: (tint, amount = 1, lumGain = 1) => (d) => {
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * lumGain;
      d[i] = Math.min(255, d[i] + (l * tint[0] - d[i]) * amount);
      d[i + 1] = Math.min(255, d[i + 1] + (l * tint[1] - d[i + 1]) * amount);
      d[i + 2] = Math.min(255, d[i + 2] + (l * tint[2] - d[i + 2]) * amount);
    }
  },
  /** Colour-key: pixels with alpha below `cut` get the average opaque colour (avoids dark halos when mipmapped). */
  bleed: (cut = 32) => (d) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return;
    r /= n; g /= n; b /= n;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] < cut) { d[i] = r; d[i + 1] = g; d[i + 2] = b; }
  },
};

export function chain(...fns) {
  return (d, w, h) => { for (const f of fns) if (f) f(d, w, h); };
}

/** Average colour of the opaque pixels of an image (sRGB 0..1). */
export function averageColor(image) {
  const c = canvasOf(image, 64);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 1, 1];
}

// ------------------------------------------------------------------------------------------------
// Materials / export
// ------------------------------------------------------------------------------------------------

/** MeshStandardMaterial from options (only what glTF core can express). */
export function standard(name, o = {}) {
  const m = new THREE.MeshStandardMaterial({
    name,
    color: o.color ?? 0xffffff,
    map: o.map ?? null,
    normalMap: o.normalMap ?? null,
    roughnessMap: o.ormMap ?? o.roughnessMap ?? null,
    metalnessMap: o.ormMap ?? o.metalnessMap ?? null,
    aoMap: o.aoMap ?? null,
    roughness: o.roughness ?? 1,
    metalness: o.metalness ?? 0,
    alphaTest: o.alphaTest ?? 0,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    vertexColors: o.vertexColors ?? false,
    emissive: o.emissive ?? 0x000000,
  });
  if (o.normalScale) m.normalScale.set(o.normalScale, o.normalScale);
  return m;
}

export function mesh(name, geometry, material) {
  const m = new THREE.Mesh(geometry, material);
  m.name = name;
  return m;
}

export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Exports `object` as GLB to `absPath` (Node side) and returns the byte size. */
export async function exportGlb(object, absPath) {
  const exporter = new GLTFExporter();
  const buf = await exporter.parseAsync(object, { binary: true, maxTextureSize: 1024, onlyVisible: true });
  await window.__writeFile(absPath, toBase64(buf));
  return buf.byteLength;
}

/** Triangle count of every mesh under `root` (unique geometries). */
export function sceneTris(root) {
  const seen = new Set();
  let t = 0;
  root.traverse((o) => { if (o.isMesh && !seen.has(o.geometry)) { seen.add(o.geometry); t += tris(o.geometry); } });
  return t;
}
