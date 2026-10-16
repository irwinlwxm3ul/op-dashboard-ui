// Growable indexed geometry accumulator used to build merged meshes (buildings, props, roads,
// vegetation models, range markings). Backed by growable typed arrays so building ~200k vertices
// at load does not churn the garbage collector.

import * as THREE from 'three';

class FloatBuf {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(Math.max(16, cap));
  }
  reserve(k: number): void {
    if (this.n + k <= this.a.length) return;
    const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  final(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

class IndexBuf {
  a: Uint32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Uint32Array(Math.max(16, cap));
  }
  reserve(k: number): void {
    if (this.n + k <= this.a.length) return;
    const b = new Uint32Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
}

export class GeoBuilder {
  private readonly p = new FloatBuf(3 * 1024);
  private readonly nr = new FloatBuf(3 * 1024);
  private readonly c = new FloatBuf(3 * 1024);
  private readonly ix = new IndexBuf(6 * 1024);
  private readonly extras = new Map<string, { size: number; buf: FloatBuf }>();
  private count = 0;

  /** Declare an extra per-vertex attribute; every vertex must then get values via `extra()`. */
  addAttribute(name: string, size: number): this {
    if (!this.extras.has(name)) this.extras.set(name, { size, buf: new FloatBuf(size * 1024) });
    return this;
  }

  /** Positions written so far (x, y, z per vertex; entries past vertexCount * 3 are unused). */
  get pos(): Float32Array {
    return this.p.a;
  }

  get vertexCount(): number {
    return this.count;
  }

  get isEmpty(): boolean {
    return this.ix.n === 0;
  }

  /** Append a vertex (position, normal, linear colour); returns its index. */
  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, r: number, g: number, b: number): number {
    const p = this.p, n = this.nr, c = this.c;
    p.reserve(3);
    n.reserve(3);
    c.reserve(3);
    let o = p.n;
    p.a[o] = px; p.a[o + 1] = py; p.a[o + 2] = pz; p.n = o + 3;
    o = n.n;
    n.a[o] = nx; n.a[o + 1] = ny; n.a[o + 2] = nz; n.n = o + 3;
    o = c.n;
    c.a[o] = r; c.a[o + 1] = g; c.a[o + 2] = b; c.n = o + 3;
    return this.count++;
  }

  /** Values of an extra attribute for the vertex just added. */
  extra(name: string, a: number, b = 0, c = 0, d = 0): void {
    const e = this.extras.get(name);
    if (!e) throw new Error(`GeoBuilder: unknown attribute ${name}`);
    const buf = e.buf;
    buf.reserve(e.size);
    const o = buf.n;
    buf.a[o] = a;
    if (e.size > 1) buf.a[o + 1] = b;
    if (e.size > 2) buf.a[o + 2] = c;
    if (e.size > 3) buf.a[o + 3] = d;
    buf.n = o + e.size;
  }

  tri(a: number, b: number, c: number): void {
    const ix = this.ix;
    ix.reserve(3);
    const o = ix.n;
    ix.a[o] = a; ix.a[o + 1] = b; ix.a[o + 2] = c;
    ix.n = o + 3;
  }

  /** Quad from 4 vertices in counter-clockwise order (seen from the front). */
  quad(a: number, b: number, c: number, d: number): void {
    const ix = this.ix;
    ix.reserve(6);
    const o = ix.n;
    ix.a[o] = a; ix.a[o + 1] = b; ix.a[o + 2] = c;
    ix.a[o + 3] = a; ix.a[o + 4] = c; ix.a[o + 5] = d;
    ix.n = o + 6;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.count;
    g.setAttribute('position', new THREE.BufferAttribute(this.p.final(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nr.final(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.c.final(), 3));
    for (const [name, e] of this.extras) {
      if (e.buf.n !== n * e.size) throw new Error(`GeoBuilder: attribute ${name} has ${e.buf.n / e.size} of ${n} vertices`);
      g.setAttribute(name, new THREE.BufferAttribute(e.buf.final(), e.size));
    }
    const idx = this.ix.a.subarray(0, this.ix.n);
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(idx.slice(), 1) : new THREE.BufferAttribute(Uint16Array.from(idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _c = new THREE.Color();

/** sRGB hex -> linear RGB triple written into `out` (offset o). */
export function hexToLinear(hex: number, out: Float32Array | number[], o = 0): void {
  const c = _c.setHex(hex);
  out[o] = c.r;
  out[o + 1] = c.g;
  out[o + 2] = c.b;
}

/** Linear RGB of an sRGB hex as a fresh tuple (build-time helper). */
export function linearRgb(hex: number): [number, number, number] {
  const c = _c.setHex(hex);
  return [c.r, c.g, c.b];
}
