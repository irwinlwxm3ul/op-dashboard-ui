// Pre-rendered map texture (north-up; +X east to the right, -Z north at the top) generated once per
// world from heights / surfaces (hill-shaded, contour lines, water depth), then roads, buildings,
// props and trees drawn on top. Generation is sliced over several macrotasks so attaching a match
// never blocks a frame for long. Cached per world (seed + kind).

import type { SurfaceMaterial, World } from '../../../shared/types';
import { SURFACE_LIST } from '../../../shared/world';

export interface MapTexture {
  readonly canvas: HTMLCanvasElement;
  /** Texture pixels per world meter. */
  readonly ppm: number;
  readonly px: number;
  readonly world: World;
  ready: boolean;
  /** Bumped whenever more of the texture became available (consumers redraw). */
  version: number;
}

const SURFACE_RGB: Record<SurfaceMaterial, [number, number, number]> = {
  grass: [112, 140, 74],
  dirt: [146, 124, 86],
  rock: [132, 130, 124],
  sand: [218, 202, 152],
  road: [104, 100, 92],
  wood: [124, 96, 64],
  concrete: [156, 154, 148],
  metal: [122, 128, 134],
  water: [70, 130, 160],
  snow: [238, 242, 244],
};

const SHALLOW: [number, number, number] = [92, 168, 190];
const DEEP: [number, number, number] = [24, 66, 104];
const SLICE_MS = 7;
const MAX_PX = 2048;
const MAX_CACHE = 2;

const cache = new Map<string, MapTexture>();

export function getMapTexture(world: World): MapTexture {
  const key = `${world.seed}:${world.kind}:${world.size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const ppm = Math.max(1, Math.min(2, Math.floor(MAX_PX / world.size)));
  const px = Math.round(world.size * ppm);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const tex: MapTexture = { canvas, ppm, px, world, ready: false, version: 0 };
  cache.set(key, tex);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
  generate(tex);
  return tex;
}

function generate(tex: MapTexture): void {
  const { world, canvas, ppm, px } = tex;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    tex.ready = true;
    return;
  }
  ctx.fillStyle = `rgb(${DEEP.join(',')})`;
  ctx.fillRect(0, 0, px, px);

  // --- per-vertex shaded colours ---------------------------------------------------------------
  const res = world.res;
  const cell = world.cell;
  const H = world.heights;
  const n = res * res;
  const vr = new Float32Array(n);
  const vg = new Float32Array(n);
  const vb = new Float32Array(n);
  // Light from the north-west, fairly high.
  const lx = -0.55, ly = 0.75, lz = -0.55;
  const ll = Math.hypot(lx, ly, lz);
  const flat = ly / ll;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix;
      const hL = H[iz * res + Math.max(0, ix - 1)];
      const hR = H[iz * res + Math.min(res - 1, ix + 1)];
      const hU = H[Math.max(0, iz - 1) * res + ix];
      const hD = H[Math.min(res - 1, iz + 1) * res + ix];
      const dx = (hR - hL) / (2 * cell);
      const dz = (hD - hU) / (2 * cell);
      const nl = Math.hypot(dx, 1, dz);
      const dot = (-dx * lx + ly - dz * lz) / (nl * ll);
      let shade = dot / flat;
      shade = shade < 0.5 ? 0.5 : shade > 1.3 ? 1.3 : shade;
      const elev = 0.94 + 0.12 * Math.min(1, Math.max(0, H[i] / 90));
      const mat = SURFACE_LIST[world.surface[i]] ?? 'grass';
      const c = SURFACE_RGB[mat] ?? SURFACE_RGB.grass;
      const k = shade * elev;
      vr[i] = c[0] * k;
      vg[i] = c[1] * k;
      vb[i] = c[2] * k;
    }
  }

  // --- per-pixel pass (sliced) -----------------------------------------------------------------
  const img = ctx.createImageData(px, px);
  const data = img.data;
  const half = world.half;
  const inv = 1 / cell;
  const last = res - 1;
  const water = world.waterLevel;
  const prevRow = new Int32Array(px).fill(-99999);
  let y = 0;

  const rowPass = (py: number): void => {
    const z = -half + (py + 0.5) / ppm;
    let fz = (z + half) * inv;
    if (fz < 0) fz = 0; else if (fz > last) fz = last;
    let iz = Math.floor(fz);
    if (iz > last - 1) iz = last - 1;
    const tz = fz - iz;
    let leftC = -99999;
    let o = py * px * 4;
    for (let pxi = 0; pxi < px; pxi++, o += 4) {
      const x = -half + (pxi + 0.5) / ppm;
      let fx = (x + half) * inv;
      if (fx < 0) fx = 0; else if (fx > last) fx = last;
      let ix = Math.floor(fx);
      if (ix > last - 1) ix = last - 1;
      const tx = fx - ix;
      const i00 = iz * res + ix;
      const i10 = i00 + 1;
      const i01 = i00 + res;
      const i11 = i01 + 1;
      const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
      const h = H[i00] * w00 + H[i10] * w10 + H[i01] * w01 + H[i11] * w11;
      let r: number, g: number, b: number;
      if (h < water) {
        const d = water - h;
        const k = d >= 14 ? 1 : (d / 14) * (d / 14) * (3 - 2 * (d / 14));
        r = SHALLOW[0] + (DEEP[0] - SHALLOW[0]) * k;
        g = SHALLOW[1] + (DEEP[1] - SHALLOW[1]) * k;
        b = SHALLOW[2] + (DEEP[2] - SHALLOW[2]) * k;
        if (d < 0.6) {
          r += 50; g += 44; b += 34;
        }
        prevRow[pxi] = -99999;
        leftC = -99999;
      } else {
        r = vr[i00] * w00 + vr[i10] * w10 + vr[i01] * w01 + vr[i11] * w11;
        g = vg[i00] * w00 + vg[i10] * w10 + vg[i01] * w01 + vg[i11] * w11;
        b = vb[i00] * w00 + vb[i10] * w10 + vb[i01] * w01 + vb[i11] * w11;
        // Contour lines every 10 m (every 50 m stronger).
        const c = Math.floor(h / 10);
        if ((leftC !== -99999 && c !== leftC) || (prevRow[pxi] !== -99999 && c !== prevRow[pxi])) {
          const strong = c % 5 === 0 || leftC % 5 === 0;
          const m = strong ? 0.74 : 0.86;
          r *= m; g *= m; b *= m;
        }
        leftC = c;
        prevRow[pxi] = c;
      }
      data[o] = r > 255 ? 255 : r;
      data[o + 1] = g > 255 ? 255 : g;
      data[o + 2] = b > 255 ? 255 : b;
      data[o + 3] = 255;
    }
  };

  const slice = (): void => {
    const start = performance.now();
    const y0 = y;
    while (y < px && performance.now() - start < SLICE_MS) {
      // Process a handful of rows between clock checks.
      const end = Math.min(px, y + 8);
      for (; y < end; y++) rowPass(y);
    }
    ctx.putImageData(img, 0, 0, 0, y0, px, y - y0);
    tex.version++;
    if (y < px) {
      setTimeout(slice, 0);
    } else {
      drawVectors(ctx, world, ppm);
      tex.ready = true;
      tex.version++;
    }
  };
  setTimeout(slice, 0);
}

function hex(c: number, mul = 1): string {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * mul));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * mul));
  const b = Math.min(255, Math.round((c & 255) * mul));
  return `rgb(${r},${g},${b})`;
}

/** Roads, buildings, free-standing props and trees. */
function drawVectors(ctx: CanvasRenderingContext2D, world: World, ppm: number): void {
  const half = world.half;
  const X = (x: number) => (x + half) * ppm;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Roads: dark casing then light surface.
  for (const pass of [0, 1] as const) {
    ctx.strokeStyle = pass === 0 ? 'rgba(52,48,42,0.85)' : 'rgb(178,170,152)';
    for (const r of world.roads) {
      ctx.lineWidth = Math.max(1, r.width * ppm * (pass === 0 ? 1 : 0.7));
      ctx.beginPath();
      ctx.moveTo(X(r.a.x), X(r.a.z));
      ctx.lineTo(X(r.b.x), X(r.b.z));
      ctx.stroke();
    }
  }
  // Trees (one batched path).
  ctx.fillStyle = 'rgba(38,66,34,0.55)';
  ctx.beginPath();
  for (const t of world.trees) {
    const r = Math.max(0.8, Math.min(3, t.scale * 1.6)) * ppm * 0.9;
    const x = X(t.x), y = X(t.z);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
  // Free-standing props (containers, crates, walls, targets, ramps...).
  ctx.fillStyle = 'rgba(70,66,60,0.85)';
  for (const b of world.boxes) {
    if (b.building !== -1) continue;
    const w = (b.max.x - b.min.x) * ppm;
    const hgt = (b.max.z - b.min.z) * ppm;
    if (w < 0.5 && hgt < 0.5) continue;
    ctx.fillRect(X(b.min.x), X(b.min.z), Math.max(1, w), Math.max(1, hgt));
  }
  // Buildings: roof colour with dark outline.
  ctx.lineWidth = Math.max(1, ppm * 0.6);
  ctx.strokeStyle = 'rgba(28,26,24,0.9)';
  for (const b of world.buildings) {
    const x = X(b.min.x), y = X(b.min.z);
    const w = (b.max.x - b.min.x) * ppm, hgt = (b.max.z - b.min.z) * ppm;
    ctx.fillStyle = hex(b.roofColor, 0.92);
    ctx.fillRect(x, y, w, hgt);
    ctx.strokeRect(x, y, w, hgt);
  }
  ctx.restore();
}
