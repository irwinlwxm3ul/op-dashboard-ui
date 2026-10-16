// Square heightmap covering [-half, half]^2 with `res` vertices per side, row-major (z rows, x columns).
//
// The surface is the triangle mesh a rotated three.js PlaneGeometry produces: every cell
// (ix, iz)-(ix+1, iz+1) is split along the diagonal from (ix+1, iz) to (ix, iz+1), i.e. the
// lower triangle is tx + tz <= 1 in cell-local coordinates. heightAt/normalAt evaluate exactly
// that piecewise-linear surface so physics matches the rendered terrain.

import type { Vec3 } from '../types';

export interface Range {
  min: number;
  max: number;
}

export class Heightfield {
  readonly size: number;
  readonly half: number;
  readonly res: number;
  readonly cell: number;
  private readonly inv: number;
  readonly h: Float32Array;

  constructor(size: number, res: number) {
    this.size = size;
    this.half = size / 2;
    this.res = res;
    this.cell = size / (res - 1);
    this.inv = 1 / this.cell;
    this.h = new Float32Array(res * res);
  }

  /** World coordinate of vertex column / row i. */
  coord(i: number): number {
    return -this.half + i * this.cell;
  }

  heightAt(x: number, z: number): number {
    const res = this.res, last = res - 1;
    let fx = (x + this.half) * this.inv, fz = (z + this.half) * this.inv;
    if (!(fx > 0)) fx = 0; else if (fx > last) fx = last;
    if (!(fz > 0)) fz = 0; else if (fz > last) fz = last;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix > last - 1) ix = last - 1;
    if (iz > last - 1) iz = last - 1;
    const tx = fx - ix, tz = fz - iz;
    const i00 = iz * res + ix, h = this.h;
    const h00 = h[i00], h10 = h[i00 + 1], h01 = h[i00 + res], h11 = h[i00 + res + 1];
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  /** Face normal of the terrain triangle under (x, z). */
  normalAt(x: number, z: number, out: Vec3): Vec3 {
    const res = this.res, last = res - 1;
    let fx = (x + this.half) * this.inv, fz = (z + this.half) * this.inv;
    if (!(fx > 0)) fx = 0; else if (fx > last) fx = last;
    if (!(fz > 0)) fz = 0; else if (fz > last) fz = last;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix > last - 1) ix = last - 1;
    if (iz > last - 1) iz = last - 1;
    const tx = fx - ix, tz = fz - iz;
    const i00 = iz * res + ix, h = this.h;
    const h00 = h[i00], h10 = h[i00 + 1], h01 = h[i00 + res], h11 = h[i00 + res + 1];
    let gx: number, gz: number;
    if (tx + tz <= 1) {
      gx = (h10 - h00) * this.inv;
      gz = (h01 - h00) * this.inv;
    } else {
      gx = (h11 - h01) * this.inv;
      gz = (h11 - h10) * this.inv;
    }
    const l = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    out.x = -gx * l;
    out.y = l;
    out.z = -gz * l;
    return out;
  }

  /** Y component of the face normal (1 = flat). */
  flatness(x: number, z: number): number {
    const res = this.res, last = res - 1;
    let fx = (x + this.half) * this.inv, fz = (z + this.half) * this.inv;
    if (!(fx > 0)) fx = 0; else if (fx > last) fx = last;
    if (!(fz > 0)) fz = 0; else if (fz > last) fz = last;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix > last - 1) ix = last - 1;
    if (iz > last - 1) iz = last - 1;
    const tx = fx - ix, tz = fz - iz;
    const i00 = iz * res + ix, h = this.h;
    const h00 = h[i00], h10 = h[i00 + 1], h01 = h[i00 + res], h11 = h[i00 + res + 1];
    let gx: number, gz: number;
    if (tx + tz <= 1) {
      gx = (h10 - h00) * this.inv;
      gz = (h01 - h00) * this.inv;
    } else {
      gx = (h11 - h01) * this.inv;
      gz = (h11 - h10) * this.inv;
    }
    return 1 / Math.sqrt(gx * gx + 1 + gz * gz);
  }

  /**
   * Exact min / max of the piecewise-linear surface over an axis-aligned rectangle: the extrema
   * lie on mesh vertices inside the rectangle or on the rectangle boundary at its corners and its
   * crossings with grid lines and cell diagonals.
   */
  rangeIn(x0: number, z0: number, x1: number, z1: number, out: Range = { min: 0, max: 0 }): Range {
    let mn = Infinity, mx = -Infinity;
    const take = (v: number): void => {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    };
    const cell = this.cell, half = this.half, res = this.res;
    // Interior vertices.
    const ia = Math.max(0, Math.ceil((x0 + half) / cell)), ib = Math.min(res - 1, Math.floor((x1 + half) / cell));
    const ja = Math.max(0, Math.ceil((z0 + half) / cell)), jb = Math.min(res - 1, Math.floor((z1 + half) / cell));
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) take(this.h[j * res + i]);
    // Boundary breakpoints along an edge parallel to X at z, and parallel to Z at x.
    const edgeX = (z: number): void => {
      take(this.heightAt(x0, z));
      take(this.heightAt(x1, z));
      const tz = (z + half) / cell - Math.floor((z + half) / cell);
      for (let i = Math.floor((x0 + half) / cell); i <= Math.ceil((x1 + half) / cell); i++) {
        const gx = -half + i * cell;
        if (gx > x0 && gx < x1) take(this.heightAt(gx, z));
        const dx = gx + (1 - tz) * cell;
        if (dx > x0 && dx < x1) take(this.heightAt(dx, z));
      }
    };
    const edgeZ = (x: number): void => {
      const tx = (x + half) / cell - Math.floor((x + half) / cell);
      for (let j = Math.floor((z0 + half) / cell); j <= Math.ceil((z1 + half) / cell); j++) {
        const gz = -half + j * cell;
        if (gz > z0 && gz < z1) take(this.heightAt(x, gz));
        const dz = gz + (1 - tx) * cell;
        if (dz > z0 && dz < z1) take(this.heightAt(x, dz));
      }
    };
    edgeX(z0);
    edgeX(z1);
    edgeZ(x0);
    edgeZ(x1);
    out.min = mn;
    out.max = mx;
    return out;
  }

  /** Mean of the vertex heights inside a rectangle (falls back to the centre sample). */
  meanIn(x0: number, z0: number, x1: number, z1: number): number {
    const cell = this.cell, half = this.half, res = this.res;
    const ia = Math.max(0, Math.ceil((x0 + half) / cell)), ib = Math.min(res - 1, Math.floor((x1 + half) / cell));
    const ja = Math.max(0, Math.ceil((z0 + half) / cell)), jb = Math.min(res - 1, Math.floor((z1 + half) / cell));
    let s = 0, n = 0;
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) { s += this.h[j * res + i]; n++; }
    return n > 0 ? s / n : this.heightAt((x0 + x1) / 2, (z0 + z1) / 2);
  }

  /**
   * Blend vertices toward `target` around a rectangle: weight 1 within `inner` meters of the
   * rectangle, smoothly falling to 0 at `outer` meters.
   */
  flattenRect(x0: number, z0: number, x1: number, z1: number, target: number, inner: number, outer: number): void {
    const cell = this.cell, half = this.half, res = this.res;
    const ia = Math.max(0, Math.floor((x0 - outer + half) / cell)), ib = Math.min(res - 1, Math.ceil((x1 + outer + half) / cell));
    const ja = Math.max(0, Math.floor((z0 - outer + half) / cell)), jb = Math.min(res - 1, Math.ceil((z1 + outer + half) / cell));
    for (let j = ja; j <= jb; j++) {
      const z = -half + j * cell;
      const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
      for (let i = ia; i <= ib; i++) {
        const x = -half + i * cell;
        const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= outer) continue;
        const w = d <= inner ? 1 : 1 - smooth01((d - inner) / (outer - inner));
        const k = j * res + i;
        this.h[k] += (target - this.h[k]) * w;
      }
    }
  }

  /** Same as flattenRect for a disc. */
  flattenDisc(cx: number, cz: number, target: number, inner: number, outer: number): void {
    this.flattenRect(cx, cz, cx, cz, target, inner, outer);
  }
}

export function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
