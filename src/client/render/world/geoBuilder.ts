// Growable indexed geometry accumulator used to build merged meshes (terrain skirts, buildings,
// props, roads, vegetation models). Build-time only (allocation is fine here).

import * as THREE from 'three';

export class GeoBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  private readonly extras = new Map<string, { size: number; data: number[] }>();

  /** Declare an extra per-vertex attribute; `vertex()` callers must then push values via `extra()`. */
  addAttribute(name: string, size: number): this {
    if (!this.extras.has(name)) this.extras.set(name, { size, data: [] });
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  /** Append a vertex (position, normal, linear colour); returns its index. */
  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, r: number, g: number, b: number): number {
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.col.push(r, g, b);
    return this.pos.length / 3 - 1;
  }

  /** Push values of an extra attribute for the vertex just added. */
  extra(name: string, a: number, b = 0, c = 0, d = 0): void {
    const e = this.extras.get(name);
    if (!e) throw new Error(`GeoBuilder: unknown attribute ${name}`);
    e.data.push(a);
    if (e.size > 1) e.data.push(b);
    if (e.size > 2) e.data.push(c);
    if (e.size > 3) e.data.push(d);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Quad from 4 vertices in counter-clockwise order (seen from the front). */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.vertexCount;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    for (const [name, e] of this.extras) {
      if (e.data.length !== n * e.size) throw new Error(`GeoBuilder: attribute ${name} has ${e.data.length / e.size} of ${n} vertices`);
      g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(e.data), e.size));
    }
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** sRGB hex -> linear RGB triple written into `out` (offset o). */
export function hexToLinear(hex: number, out: Float32Array | number[], o = 0): void {
  const c = _c.setHex(hex);
  out[o] = c.r;
  out[o + 1] = c.g;
  out[o + 2] = c.b;
}
const _c = new THREE.Color();

/** Linear RGB of an sRGB hex as a fresh tuple (build-time helper). */
export function linearRgb(hex: number): [number, number, number] {
  const c = _c.setHex(hex);
  return [c.r, c.g, c.b];
}
