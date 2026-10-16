// Geometry builder for procedural viewmodel meshes: collects primitive parts per material and
// merges them into one mesh per material (few draw calls), plus the shared viewmodel materials.
//
// Gun-local convention: origin at the firing hand's grip point, -Z is the muzzle direction,
// +Y up, +X right (same orientation as the first-person camera).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type MatKey =
  | 'metal' | 'darkMetal' | 'polymer' | 'wood' | 'olive' | 'tan' | 'brass' | 'shell'
  | 'glass' | 'lens' | 'sleeve' | 'glove' | 'cuff' | 'medRed' | 'medWhite' | 'can' | 'jerry' | 'bandage' | 'grenade';

/**
 * Materials. Colours are kept in line with the third-person gun palette (dark gunmetal, black
 * polymer, walnut wood, olive sniper chassis) so swapping views never changes a gun's identity.
 * Metalness stays moderate: the viewmodel scene has no environment map unless the world sets one.
 */
function createMaterials(): Record<MatKey, THREE.Material> {
  const std = (color: number, roughness: number, metalness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  return {
    metal: std(0x5b6068, 0.4, 0.45),
    darkMetal: std(0x3d4045, 0.48, 0.4),
    polymer: std(0x3a3c40, 0.7, 0.06),
    wood: std(0x80542f, 0.6, 0.02),
    olive: std(0x5f6a40, 0.7, 0.05),
    tan: std(0x8d7a56, 0.7, 0.05),
    brass: std(0xc9a14a, 0.35, 0.8),
    shell: std(0xa3261e, 0.55, 0.05),
    glass: new THREE.MeshStandardMaterial({
      color: 0x8fb8c8, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide,
    }),
    lens: std(0x10202c, 0.08, 0.6, { emissive: 0x0a1a24, emissiveIntensity: 0.6 }),
    sleeve: std(0x5d6644, 0.92, 0),
    glove: std(0x4a4139, 0.78, 0.02),
    cuff: std(0x3f3a34, 0.85, 0),
    medRed: std(0xb3221d, 0.6, 0.05),
    medWhite: std(0xe8e6e0, 0.6, 0),
    can: std(0x2e7bc4, 0.35, 0.6),
    jerry: std(0xa31f17, 0.55, 0.25),
    bandage: std(0xe9e2cf, 0.95, 0),
    grenade: std(0x4d5631, 0.62, 0.25),
  };
}

let shared: Record<MatKey, THREE.Material> | null = null;
let users = 0;

export function retainMaterials(): Record<MatKey, THREE.Material> {
  users++;
  if (!shared) shared = createMaterials();
  return shared;
}

export function releaseMaterials(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && shared) {
    for (const m of Object.values(shared)) m.dispose();
    shared = null;
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3(1, 1, 1);

/** Collects primitives for one rigid part; build() merges them per material. */
export class PartBuilder {
  private readonly lists = new Map<MatKey, THREE.BufferGeometry[]>();

  constructor(private readonly mats: Record<MatKey, THREE.Material>) {}

  private push(mat: MatKey, g: THREE.BufferGeometry, x: number, y: number, z: number, rx: number, ry: number, rz: number): this {
    tmpE.set(rx, ry, rz, 'XYZ');
    tmpQ.setFromEuler(tmpE);
    tmpP.set(x, y, z);
    tmpM.compose(tmpP, tmpQ, tmpS);
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    ng.applyMatrix4(tmpM);
    // Keep only attributes every primitive has so merging always succeeds.
    for (const name of Object.keys(ng.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') ng.deleteAttribute(name);
    }
    ng.clearGroups();
    let list = this.lists.get(mat);
    if (!list) { list = []; this.lists.set(mat, list); }
    list.push(ng);
    return this;
  }

  /** Box of size (w,h,d) centred at (x,y,z) rotated by euler (rx,ry,rz). */
  box(mat: MatKey, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    return this.push(mat, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  }

  /** Cylinder along Z (barrels, tubes) of length len centred at (x,y,z). rFront is the -Z end radius. */
  cylZ(mat: MatKey, rFront: number, rBack: number, len: number, x: number, y: number, z: number, seg = 12, open = false): this {
    // CylinderGeometry runs along +Y with radiusTop at +Y. Rotating +90deg about X maps +Y to +Z,
    // so radiusTop ends up at the back (+Z) and radiusBottom at the front (-Z).
    const g = new THREE.CylinderGeometry(rBack, rFront, len, seg, 1, open);
    return this.push(mat, g, x, y, z, Math.PI / 2, 0, 0);
  }

  /** Cylinder along X. */
  cylX(mat: MatKey, r: number, len: number, x: number, y: number, z: number, seg = 10): this {
    return this.push(mat, new THREE.CylinderGeometry(r, r, len, seg), x, y, z, 0, 0, Math.PI / 2);
  }

  /** Cylinder along Y with optional rotation. */
  cylY(mat: MatKey, rTop: number, rBot: number, len: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, seg = 10): this {
    return this.push(mat, new THREE.CylinderGeometry(rTop, rBot, len, seg), x, y, z, rx, ry, rz);
  }

  sphere(mat: MatKey, r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): this {
    const g = new THREE.SphereGeometry(r, 10, 8);
    g.scale(sx, sy, sz);
    return this.push(mat, g, x, y, z, 0, 0, 0);
  }

  /** Ring (torus) facing along Z. */
  ringZ(mat: MatKey, r: number, tube: number, x: number, y: number, z: number): this {
    return this.push(mat, new THREE.TorusGeometry(r, tube, 6, 16), x, y, z, 0, 0, 0);
  }

  /** Flat disc facing +Z (towards the camera) at (x,y,z). */
  discZ(mat: MatKey, r: number, x: number, y: number, z: number, flip = false): this {
    return this.push(mat, new THREE.CircleGeometry(r, 18), x, y, z, 0, flip ? Math.PI : 0, 0);
  }

  get empty(): boolean {
    return this.lists.size === 0;
  }

  /** Merge into a group with one mesh per material. */
  build(name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.lists) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this.mats[mat]);
      mesh.name = `${name}-${mat}`;
      mesh.frustumCulled = false;
      // Transparent glass after the opaque parts.
      if (mat === 'glass') mesh.renderOrder = 2;
      group.add(mesh);
    }
    this.lists.clear();
    return group;
  }
}

/** Dispose every geometry below an object (materials are shared and released separately). */
export function disposeGeometries(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}
