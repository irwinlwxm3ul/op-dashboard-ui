// Procedural low-poly geometry builder. Parts (boxes, cylinders, spheres, custom shapes) are
// accumulated with a transform, a colour, an optional material mask and a bone index, then baked
// into one non-indexed, flat-shaded BufferGeometry with vertex colours.
//
// Mask channels (attribute `aMask`, used by the character material):
//   x = team accent weight, y = skin weight, z = cloth (fatigue tint) weight.
// Build-time only: allocations here are fine (never called per frame).

import * as THREE from 'three';

export interface PartStyle {
  /** sRGB hex colour. */
  color: number;
  /** [accent, skin, cloth] weights. */
  mask?: readonly [number, number, number];
  /** Bone index (skinned / per-bone builds). */
  bone?: number;
  /** Keep smooth normals instead of per-face normals. */
  smooth?: boolean;
}

export const M_ACCENT = [1, 0, 0] as const;
export const M_SKIN = [0, 1, 0] as const;
export const M_CLOTH = [0, 0, 1] as const;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Matrix3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _col = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

/** Transform helper: translation, rotation (radians, Euler YXZ) and scale. */
export function xform(
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, out = new THREE.Matrix4(),
): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

export interface BakeOptions {
  /** Include the `aMask` attribute (character materials). */
  mask?: boolean;
  /** Include skinIndex/skinWeight from the part bone (rigid skinning). */
  skin?: boolean;
  /**
   * Resolve masks into vertex colours instead of emitting the attribute (props / loot).
   * Colours are sRGB hex.
   */
  bake?: { accent: number; skin: number; cloth: number };
}

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private msk: number[] = [];
  private bone: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Append any geometry (indexed or not) transformed by `m`. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, style: PartStyle): this {
    const src = g.index ? g.toNonIndexed() : g;
    if (!src.getAttribute('normal')) src.computeVertexNormals();
    const p = src.getAttribute('position') as THREE.BufferAttribute;
    const n = src.getAttribute('normal') as THREE.BufferAttribute;
    _n.getNormalMatrix(m);
    _col.setHex(style.color);
    const mask = style.mask ?? [0, 0, 0];
    const bone = style.bone ?? 0;
    const flipped = m.determinant() < 0;
    const count = p.count - (p.count % 3);
    for (let i = 0; i < count; i += 3) {
      // Mirror transforms flip the winding; swap two vertices to keep faces front-facing.
      const order = flipped ? [i, i + 2, i + 1] : [i, i + 1, i + 2];
      _a.fromBufferAttribute(p, order[0]).applyMatrix4(m);
      _b.fromBufferAttribute(p, order[1]).applyMatrix4(m);
      _c.fromBufferAttribute(p, order[2]).applyMatrix4(m);
      let fx = 0, fy = 0, fz = 0;
      if (!style.smooth) {
        // Flat face normal.
        const ux = _b.x - _a.x, uy = _b.y - _a.y, uz = _b.z - _a.z;
        const vx = _c.x - _a.x, vy = _c.y - _a.y, vz = _c.z - _a.z;
        fx = uy * vz - uz * vy; fy = uz * vx - ux * vz; fz = ux * vy - uy * vx;
        const l = Math.hypot(fx, fy, fz);
        if (l < 1e-12) continue; // degenerate triangle
        fx /= l; fy /= l; fz /= l;
      }
      const verts = [_a, _b, _c];
      for (let k = 0; k < 3; k++) {
        const v = verts[k];
        this.pos.push(v.x, v.y, v.z);
        if (style.smooth) {
          _p.fromBufferAttribute(n, order[k]).applyMatrix3(_n).normalize();
          this.nor.push(_p.x, _p.y, _p.z);
        } else {
          this.nor.push(fx, fy, fz);
        }
        this.col.push(_col.r, _col.g, _col.b);
        this.msk.push(mask[0], mask[1], mask[2]);
        this.bone.push(bone);
      }
    }
    if (src !== g) src.dispose();
    return this;
  }

  /** Box of size w×h×d centred at the transform origin. */
  box(w: number, h: number, d: number, m: THREE.Matrix4, style: PartStyle): this {
    const g = new THREE.BoxGeometry(w, h, d);
    this.add(g, m, style);
    g.dispose();
    return this;
  }

  /** Cylinder / cone along local Y, centred at the transform origin. */
  cyl(rTop: number, rBottom: number, h: number, seg: number, m: THREE.Matrix4, style: PartStyle, open = false): this {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open);
    this.add(g, m, style);
    g.dispose();
    return this;
  }

  /** Ellipsoid (sphere scaled by the transform). Optional partial sphere via phi/theta ranges. */
  sphere(
    r: number, wSeg: number, hSeg: number, m: THREE.Matrix4, style: PartStyle,
    thetaStart = 0, thetaLength = Math.PI,
  ): this {
    const g = new THREE.SphereGeometry(r, wSeg, hSeg, 0, Math.PI * 2, thetaStart, thetaLength);
    this.add(g, m, style);
    g.dispose();
    return this;
  }

  /** Cylindrical strut between two points (model space of `base`). */
  strut(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg: number,
    style: PartStyle, base?: THREE.Matrix4,
  ): this {
    _a.set(ax, ay, az);
    _b.set(bx, by, bz);
    _c.subVectors(_b, _a);
    const len = _c.length();
    if (len < 1e-6) return this;
    _c.multiplyScalar(1 / len);
    _q.setFromUnitVectors(_up, _c);
    _p.addVectors(_a, _b).multiplyScalar(0.5);
    _s.set(1, 1, 1);
    const m = new THREE.Matrix4().compose(_p, _q, _s);
    if (base) m.premultiply(base);
    return this.cyl(r, r, len, seg, m, style);
  }

  /** Torus (ring) around local Y axis (torus lies in XZ). */
  ring(radius: number, tube: number, radial: number, tubular: number, m: THREE.Matrix4, style: PartStyle): this {
    const g = new THREE.TorusGeometry(radius, tube, radial, tubular);
    g.rotateX(Math.PI / 2);
    this.add(g, m, style);
    g.dispose();
    return this;
  }

  /**
   * Tapered box: bottom face w0×d0, top face w1×d1, height h, centred at the origin (y from -h/2
   * to h/2). `dz` shifts the top face along z (forward lean / slope).
   */
  taper(w0: number, d0: number, w1: number, d1: number, h: number, m: THREE.Matrix4, style: PartStyle, dz = 0): this {
    const g = new THREE.BoxGeometry(1, h, 1);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const top = p.getY(i) > 0;
      p.setX(i, p.getX(i) * (top ? w1 : w0));
      p.setZ(i, p.getZ(i) * (top ? d1 : d0) + (top ? dz : 0));
    }
    this.add(g, m, style);
    g.dispose();
    return this;
  }

  /** Extruded 2D polygon (XY outline) with depth along Z, centred on z. */
  extrude(shape: THREE.Shape, depth: number, m: THREE.Matrix4, style: PartStyle): this {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 4 });
    g.translate(0, 0, -depth / 2);
    this.add(g, m, style);
    g.dispose();
    return this;
  }

  /** Append another builder's content transformed by `m` (keeps colours/masks/bones). */
  merge(other: GeoBuilder, m: THREE.Matrix4, boneOverride?: number): this {
    _n.getNormalMatrix(m);
    const flipped = m.determinant() < 0;
    const n = other.pos.length / 3;
    for (let i = 0; i < n; i += 3) {
      const order = flipped ? [i, i + 2, i + 1] : [i, i + 1, i + 2];
      for (const j of order) {
        _a.set(other.pos[j * 3], other.pos[j * 3 + 1], other.pos[j * 3 + 2]).applyMatrix4(m);
        _b.set(other.nor[j * 3], other.nor[j * 3 + 1], other.nor[j * 3 + 2]).applyMatrix3(_n).normalize();
        this.pos.push(_a.x, _a.y, _a.z);
        this.nor.push(_b.x, _b.y, _b.z);
        this.col.push(other.col[j * 3], other.col[j * 3 + 1], other.col[j * 3 + 2]);
        this.msk.push(other.msk[j * 3], other.msk[j * 3 + 1], other.msk[j * 3 + 2]);
        this.bone.push(boneOverride ?? other.bone[j]);
      }
    }
    return this;
  }

  /** Bake into a BufferGeometry. */
  build(opts: BakeOptions = {}): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.pos.length / 3;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    let colors = this.col;
    if (opts.bake) {
      const acc = new THREE.Color().setHex(opts.bake.accent);
      const skn = new THREE.Color().setHex(opts.bake.skin);
      const clo = new THREE.Color().setHex(opts.bake.cloth);
      colors = new Array<number>(n * 3);
      for (let i = 0; i < n; i++) {
        let r = this.col[i * 3], gg = this.col[i * 3 + 1], b = this.col[i * 3 + 2];
        const ma = this.msk[i * 3], ms = this.msk[i * 3 + 1], mc = this.msk[i * 3 + 2];
        r = r + (r * clo.r - r) * mc; gg = gg + (gg * clo.g - gg) * mc; b = b + (b * clo.b - b) * mc;
        r = r + (skn.r - r) * ms; gg = gg + (skn.g - gg) * ms; b = b + (skn.b - b) * ms;
        r = r + (acc.r - r) * ma; gg = gg + (acc.g - gg) * ma; b = b + (acc.b - b) * ma;
        colors[i * 3] = r; colors[i * 3 + 1] = gg; colors[i * 3 + 2] = b;
      }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    if (opts.mask) g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.msk, 3));
    if (opts.skin) {
      const idx = new Uint16Array(n * 4);
      const w = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        idx[i * 4] = this.bone[i];
        w[i * 4] = 1;
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
