// Browser-side weapon / item normalisation (run by build-weapons.mjs and build-items.mjs inside
// headless Chromium). Converts a source model (FBX or glTF scene) into ONE vertex-coloured mesh
// with a single material (1 draw call, instancing friendly) in the project weapon frame:
// right-hand grip at the origin, barrel along -Z, up +Y, right +X, metres.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** Shared colour palette (matches render/entities/weaponModels.ts procedural guns). */
export const PALETTE = {
  Black: 0x1b1d1f, Black2: 0x16181a, DarkMetal: 0x2b2e31, Metal: 0x3d4145, LightMetal: 0x5c6166,
  Grey: 0x34373a, Wood: 0x7a5232, DarkWood: 0x5a3b22, Green: 0x4c5541, Glass: 0x1b2a38,
  Main: 0x2a2c2e, MainDark: 0x1f2123, MainLight: 0x3a3d40,
};

/**
 * Bakes every mesh of `root` (world transforms applied) into one non-indexed-safe geometry with a
 * `color` attribute. `colorOf(material)` returns a THREE.Color (defaults: PALETTE by material
 * name, else the material colour).
 */
export function bakeToSingleGeometry(root, colorOf) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    let g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.attributes.position.count, materialIndex: 0 }];
    const ng = g.index ? g.toNonIndexed() : g;
    for (const grp of groups) {
      const m = mats[grp.materialIndex ?? 0] || mats[0];
      const c = colorOf(m);
      const start = grp.start, count = Math.min(grp.count, ng.attributes.position.count - start);
      if (count <= 0) continue;
      const pos = ng.attributes.position.array.slice(start * 3, (start + count) * 3);
      const nor = ng.attributes.normal.array.slice(start * 3, (start + count) * 3);
      const col = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      pg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(pg);
    }
  });
  const merged = mergeGeometries(parts, false);
  // Re-index (shared vertices where position+normal+colour match) to keep files small.
  return mergeVertices(merged, 1e-5);
}

export function paletteColor(m) {
  const base = (m.name || '').replace(/[._]\d+$/, '');
  if (PALETTE[base] !== undefined) return new THREE.Color(PALETTE[base]);
  return m.color ? m.color.clone() : new THREE.Color(0x808080);
}

/** Rotates a geometry about Y so the barrel (source axis `muzzleAxis`) points to -Z. */
export function orientLongAxis(geo, muzzleAxis) {
  const angle = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': Math.PI, '-z': 0 }[muzzleAxis];
  geo.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle));
  return geo;
}

export function geometryTris(geo) {
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}

/** Highest Y of vertices within `rz` of z (and |x| < rx). */
export function topAt(geo, z, rz = 0.012, rx = 0.02) {
  const p = geo.attributes.position;
  let best = -Infinity;
  for (let i = 0; i < p.count; i++) if (Math.abs(p.getZ(i) - z) < rz && Math.abs(p.getX(i)) < rx) best = Math.max(best, p.getY(i));
  return best;
}

/** Mean Y of vertices within `rz` of the given z (bore height at the muzzle / butt). */
export function meanYAt(geo, z, rz = 0.01) {
  const p = geo.attributes.position;
  let s = 0, n = 0;
  for (let i = 0; i < p.count; i++) if (Math.abs(p.getZ(i) - z) < rz) { s += p.getY(i); n++; }
  return n ? s / n : 0;
}

/** Builds the exported object: one mesh + empty marker nodes for the hold points. */
export function weaponObject(name, geo, markers) {
  const mat = new THREE.MeshStandardMaterial({ name: 'weapon', vertexColors: true, roughness: 0.55, metalness: 0.35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  const root = new THREE.Group();
  root.name = name;
  root.add(mesh);
  for (const [k, v] of Object.entries(markers)) {
    const m = new THREE.Object3D();
    m.name = k;
    m.position.fromArray(v);
    root.add(m);
  }
  return root;
}
