// Training range visuals: painted firing line, lane dividers and range lines on the ground,
// rails under moving targets, and distance signs (numerals only, canvas atlas) beside every
// static target, facing the firing line and sized to stay readable through scopes.

import * as THREE from 'three';
import type { TrainingTarget, World } from '../../../shared/types';
import { GeoBuilder, linearRgb } from './geoBuilder';

const PAINT_LIFT = 0.045;
const LINE_WHITE = linearRgb(0xe8e6de);
const LINE_YELLOW = linearRgb(0xd8b840);
const RAIL = linearRgb(0x4a4744);
const POST = linearRgb(0x6b5a45);
const BOARD_BACK = linearRgb(0x5a4a38);

const CELL_W = 256;
const CELL_H = 128;
const ATLAS_COLS = 4;

interface Frame {
  fx: number;
  fz: number;
  dx: number;
  dz: number;
  /** Left of the firing direction. */
  px: number;
  pz: number;
}

export class TrainingRenderer {
  readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly texture: THREE.CanvasTexture | null = null;

  constructor(world: World) {
    this.group.name = 'training-range';
    const tr = world.training;
    if (world.kind !== 'training' || !tr) return;
    const statics = tr.targets.filter((t) => t.kind === 'static');
    const all = tr.targets;
    if (all.length === 0) return;

    // Firing direction: the spawn faces the range (yaw 0 = -Z); fall back to the mean target.
    let dx = -Math.sin(tr.spawnYaw), dz = -Math.cos(tr.spawnYaw);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) {
      let mx = 0, mz = 0;
      for (const t of all) {
        mx += t.pos.x;
        mz += t.pos.z;
      }
      dx = mx / all.length - tr.firingLine.x;
      dz = mz / all.length - tr.firingLine.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
    }
    const f: Frame = { fx: tr.firingLine.x, fz: tr.firingLine.z, dx, dz, px: dz, pz: -dx };

    const paint = new GeoBuilder();
    const along = (t: TrainingTarget): number => (t.pos.x - f.fx) * f.dx + (t.pos.z - f.fz) * f.dz;
    const lateral = (x: number, z: number): number => (x - f.fx) * f.px + (z - f.fz) * f.pz;

    // Lanes from the lateral positions of static targets (merged within 1.5 m).
    const lats = (statics.length ? statics : all).map((t) => lateral(t.pos.x, t.pos.z)).sort((a, b) => a - b);
    const centres: number[] = [];
    for (const l of lats) if (!centres.length || l - centres[centres.length - 1] > 1.5) centres.push(l);
    let laneW = Infinity;
    for (let i = 1; i < centres.length; i++) laneW = Math.min(laneW, centres[i] - centres[i - 1]);
    laneW = Number.isFinite(laneW) ? Math.min(12, Math.max(2.5, laneW)) : 5;
    let maxRange = 0;
    for (const t of all) maxRange = Math.max(maxRange, along(t));
    const laneEnd = maxRange + 12;
    const left = centres[0] - laneW / 2, right = centres[centres.length - 1] + laneW / 2;

    const point = (a: number, l: number): [number, number] => [f.fx + f.dx * a + f.px * l, f.fz + f.dz * a + f.pz * l];
    // Firing line (yellow, across all lanes) and lane dividers.
    this.strip(paint, world, point(0, left - 1), point(0, right + 1), 0.4, LINE_YELLOW);
    const dividers: number[] = [left];
    for (let i = 1; i < centres.length; i++) dividers.push((centres[i - 1] + centres[i]) / 2);
    dividers.push(right);
    for (const l of dividers) this.strip(paint, world, point(0, l), point(laneEnd, l), 0.12, LINE_WHITE);
    // Range lines at every target distance.
    const ranges = [...new Set(statics.map((t) => t.range))].sort((a, b) => a - b);
    for (const r of ranges) {
      const sample = statics.find((t) => t.range === r)!;
      const a = along(sample);
      this.strip(paint, world, point(a - 1.5, left), point(a - 1.5, right), 0.22, LINE_WHITE);
    }
    // Rails under moving targets.
    for (const t of all) {
      if (t.kind !== 'moving' || !t.a || !t.b) continue;
      this.strip(paint, world, [t.a.x, t.a.z], [t.b.x, t.b.z], 0.35, RAIL);
    }
    if (!paint.isEmpty) {
      const mat = new THREE.MeshStandardMaterial({
        name: 'dz-range-paint',
        vertexColors: true,
        roughness: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });
      this.add(paint, mat, 'range-paint', false);
    }

    // Distance signs.
    if (statics.length === 0 || typeof document === 'undefined') return;
    const uniq = [...new Set(statics.map((t) => t.range))].sort((a, b) => a - b);
    this.texture = this.createAtlas(uniq);
    if (!this.texture) return;
    const rows = Math.ceil(uniq.length / ATLAS_COLS);
    const faces = new GeoBuilder().addAttribute('uv', 2);
    const wood = new GeoBuilder();
    for (const t of statics) {
      const idx = uniq.indexOf(t.range);
      const w = Math.min(4.5, Math.max(0.9, 0.8 + t.range * 0.006));
      const h = w * 0.5;
      const side = Math.min(laneW * 0.5 - 0.2, 0.6 + w * 0.5);
      const lat = lateral(t.pos.x, t.pos.z) + side;
      const a = along(t);
      const [cx, cz] = point(a, lat);
      const ground = world.heightAt(cx, cz);
      const bottom = ground + 0.35 + t.range * 0.0008;
      // Board faces the firing line (normal -D); "right" as seen from the firing line is -P.
      const rx = -f.px, rz = -f.pz;
      const nx = -f.dx, nz = -f.dz;
      const x0 = cx - rx * w / 2, z0 = cz - rz * w / 2;
      const x1 = cx + rx * w / 2, z1 = cz + rz * w / 2;
      const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS);
      const u0 = col / ATLAS_COLS, u1 = (col + 1) / ATLAS_COLS;
      const v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows;
      const ox = nx * 0.03, oz = nz * 0.03;
      const v = [
        faces.vertex(x0 + ox, bottom, z0 + oz, nx, 0, nz, 1, 1, 1),
        faces.vertex(x1 + ox, bottom, z1 + oz, nx, 0, nz, 1, 1, 1),
        faces.vertex(x1 + ox, bottom + h, z1 + oz, nx, 0, nz, 1, 1, 1),
        faces.vertex(x0 + ox, bottom + h, z0 + oz, nx, 0, nz, 1, 1, 1),
      ];
      faces.extra('uv', u0, v0);
      faces.extra('uv', u1, v0);
      faces.extra('uv', u1, v1);
      faces.extra('uv', u0, v1);
      this.orientedQuad(faces, v, nx, nz);
      // Board body (thin box behind the face) and two posts.
      const thick = 0.06;
      this.box(wood, cx - nx * thick / 2, bottom + h / 2, cz - nz * thick / 2, rx, rz, w / 2, h / 2, thick / 2, BOARD_BACK);
      for (const s of [-1, 1]) {
        const qx = cx + rx * s * w * 0.35 - nx * 0.06, qz = cz + rz * s * w * 0.35 - nz * 0.06;
        const gy = world.heightAt(qx, qz);
        const top = bottom + h * 0.9;
        this.box(wood, qx, (gy - 0.3 + top) / 2, qz, rx, rz, 0.05, (top - gy + 0.3) / 2, 0.05, POST);
      }
    }
    const faceMat = new THREE.MeshStandardMaterial({ name: 'dz-range-sign', map: this.texture, roughness: 0.85, vertexColors: true });
    this.add(faces, faceMat, 'range-sign-faces', true);
    const woodMat = new THREE.MeshStandardMaterial({ name: 'dz-range-wood', vertexColors: true, roughness: 0.9 });
    this.add(wood, woodMat, 'range-sign-boards', true);
  }

  private add(gb: GeoBuilder, mat: THREE.Material, name: string, shadows: boolean): void {
    if (gb.isEmpty) {
      mat.dispose();
      return;
    }
    const geo = gb.build();
    this.geometries.push(geo);
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
  }

  /** Quad that faces (nx, 0, nz); vertices given bottom-left, bottom-right, top-right, top-left as seen from the front. */
  private orientedQuad(gb: GeoBuilder, v: number[], nx: number, nz: number): void {
    const p = gb.pos;
    const ax = p[v[0] * 3], ay = p[v[0] * 3 + 1], az = p[v[0] * 3 + 2];
    const e1x = p[v[1] * 3] - ax, e1y = p[v[1] * 3 + 1] - ay, e1z = p[v[1] * 3 + 2] - az;
    const e2x = p[v[2] * 3] - ax, e2y = p[v[2] * 3 + 1] - ay, e2z = p[v[2] * 3 + 2] - az;
    const cx = e1y * e2z - e1z * e2y, cz = e1x * e2y - e1y * e2x;
    if (cx * nx + cz * nz >= 0) gb.quad(v[0], v[1], v[2], v[3]);
    else gb.quad(v[1], v[0], v[3], v[2]);
  }

  /** Oriented box (axes: right r, up, normal n = r x up) as 6 outward quads. */
  private box(
    gb: GeoBuilder, cx: number, cy: number, cz: number, rx: number, rz: number,
    hw: number, hh: number, hd: number, col: readonly [number, number, number],
  ): void {
    // Depth axis perpendicular to r on the ground plane.
    const dx = -rz, dz = rx;
    const axes: [number, number, number][] = [[rx, 0, rz], [0, 1, 0], [dx, 0, dz]];
    const half = [hw, hh, hd];
    for (let a = 0; a < 3; a++) {
      for (const s of [1, -1]) {
        const n = axes[a].map((c) => c * s) as [number, number, number];
        const u = axes[(a + 1) % 3], w = axes[(a + 2) % 3];
        const hu = half[(a + 1) % 3], hv = half[(a + 2) % 3];
        const c0 = [cx + n[0] * half[a], cy + n[1] * half[a], cz + n[2] * half[a]];
        const corner = (su: number, sv: number): number =>
          gb.vertex(
            c0[0] + u[0] * hu * su + w[0] * hv * sv,
            c0[1] + u[1] * hu * su + w[1] * hv * sv,
            c0[2] + u[2] * hu * su + w[2] * hv * sv,
            n[0], n[1], n[2], col[0], col[1], col[2],
          );
        const v = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        // u x w = +axis (cyclic): winding (v0, v1, v2) faces +axis; flip for the negative side.
        if (s > 0) gb.quad(v[0], v[1], v[2], v[3]);
        else gb.quad(v[1], v[0], v[3], v[2]);
      }
    }
  }

  /** Flat painted strip draped over the terrain. */
  private strip(gb: GeoBuilder, world: World, a: [number, number], b: [number, number], width: number, col: readonly [number, number, number]): void {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    const px = (-dz / len) * width / 2, pz = (dx / len) * width / 2;
    const steps = Math.max(1, Math.ceil(len / 4));
    let prev: [number, number] | null = null;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a[0] + dx * t, z = a[1] + dz * t;
      const l = gb.vertex(x + px, world.heightAt(x + px, z + pz) + PAINT_LIFT, z + pz, 0, 1, 0, col[0], col[1], col[2]);
      const r = gb.vertex(x - px, world.heightAt(x - px, z - pz) + PAINT_LIFT, z - pz, 0, 1, 0, col[0], col[1], col[2]);
      if (prev) {
        // Upward winding check on the first triangle (prevL, l, prevR).
        const p = gb.pos;
        const ux = p[l * 3] - p[prev[0] * 3], uz = p[l * 3 + 2] - p[prev[0] * 3 + 2];
        const vx = p[prev[1] * 3] - p[prev[0] * 3], vz = p[prev[1] * 3 + 2] - p[prev[0] * 3 + 2];
        if (uz * vx - ux * vz > 0) {
          gb.tri(prev[0], l, prev[1]);
          gb.tri(prev[1], l, r);
        } else {
          gb.tri(prev[0], prev[1], l);
          gb.tri(prev[1], r, l);
        }
      }
      prev = [l, r];
    }
  }

  private createAtlas(ranges: readonly number[]): THREE.CanvasTexture | null {
    const rows = Math.max(1, Math.ceil(ranges.length / ATLAS_COLS));
    const cv = document.createElement('canvas');
    cv.width = CELL_W * ATLAS_COLS;
    cv.height = CELL_H * rows;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#2b2925';
    g.fillRect(0, 0, cv.width, cv.height);
    ranges.forEach((r, i) => {
      const x = (i % ATLAS_COLS) * CELL_W, y = Math.floor(i / ATLAS_COLS) * CELL_H;
      g.fillStyle = '#f1ede2';
      g.fillRect(x + 6, y + 6, CELL_W - 12, CELL_H - 12);
      g.strokeStyle = '#1d1c1a';
      g.lineWidth = 6;
      g.strokeRect(x + 12, y + 12, CELL_W - 24, CELL_H - 24);
      g.fillStyle = '#161513';
      g.font = 'bold 84px Arial, Helvetica, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // Numerals only (no words) so no localisation is needed.
      g.fillText(String(Math.round(r)), x + CELL_W / 2, y + CELL_H / 2 + 4);
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  setAnisotropy(a: number): void {
    if (this.texture && this.texture.anisotropy !== a) {
      this.texture.anisotropy = a;
      this.texture.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.texture?.dispose();
    this.group.removeFromParent();
  }
}
