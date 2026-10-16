// Procedural canvas textures for the FX module (and the viewmodel muzzle flash): one sprite atlas
// for particles and one for decals. Generated once on first use and shared by every system.
//
// Sprite atlas: 4 x 4 cells (128 px each, 512 px total), white RGB with the shape in alpha so the
// particle colour comes from per-instance attributes. Each cell keeps a padding margin so mipmaps
// do not bleed into neighbours.

import * as THREE from 'three';
import { Rng } from '../../../shared/rng';

/** Particle atlas cells. */
export const CELL = {
  PUFF: 0,
  SMOKE: 1,
  SPARK: 2,
  STAR: 3,
  CHUNK: 4,
  DROP: 5,
  RING: 6,
  FIRE: 7,
  SPLINTER: 8,
  FLAME: 9,
  DUST: 10,
  GLOW: 11,
  MIST: 12,
  BLADE: 13,
} as const;
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;

/** Decal atlas cells (4 x 2). */
export const DECAL = {
  HOLE: 0,
  HOLE_METAL: 1,
  HOLE_WOOD: 2,
  DIRT: 3,
  SCORCH: 4,
  BLOOD: 5,
} as const;
export const DECAL_COLS = 4;
export const DECAL_ROWS = 2;

const CELL_PX = 128;

let spriteAtlas: THREE.Texture | null = null;
let decalAtlas: THREE.Texture | null = null;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

/** Fallback 1x1 white texture when no canvas is available (headless). */
function whiteTexture(): THREE.Texture {
  const data = new Uint8Array([255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

function radial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stops: [number, string][]): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Run `draw` with the context translated to the cell's centre and clipped to the cell. */
function inCell(ctx: CanvasRenderingContext2D, cols: number, cell: number, draw: (c: CanvasRenderingContext2D, half: number) => void): void {
  const cx = (cell % cols) * CELL_PX;
  const cy = Math.floor(cell / cols) * CELL_PX;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx + 2, cy + 2, CELL_PX - 4, CELL_PX - 4);
  ctx.clip();
  ctx.translate(cx + CELL_PX / 2, cy + CELL_PX / 2);
  draw(ctx, CELL_PX / 2 - 6);
  ctx.restore();
}

function noisyBlob(c: CanvasRenderingContext2D, half: number, rng: Rng, blobs: number, alpha: number, spread: number): void {
  for (let i = 0; i < blobs; i++) {
    const a = rng.next() * Math.PI * 2;
    const d = Math.sqrt(rng.next()) * half * spread;
    const r = half * (0.25 + rng.next() * 0.35);
    radial(c, Math.cos(a) * d, Math.sin(a) * d, r, [
      [0, `rgba(255,255,255,${alpha})`],
      [1, 'rgba(255,255,255,0)'],
    ]);
  }
}

function drawSprites(ctx: CanvasRenderingContext2D): void {
  const rng = new Rng(0x5eed);
  inCell(ctx, ATLAS_COLS, CELL.PUFF, (c, h) => {
    radial(c, 0, 0, h, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
  });
  inCell(ctx, ATLAS_COLS, CELL.SMOKE, (c, h) => {
    noisyBlob(c, h, rng, 26, 0.22, 0.55);
    radial(c, 0, 0, h * 0.8, [[0, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
  });
  inCell(ctx, ATLAS_COLS, CELL.SPARK, (c, h) => {
    radial(c, 0, 0, h, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.9)'], [0.4, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]);
  });
  inCell(ctx, ATLAS_COLS, CELL.STAR, (c, h) => {
    radial(c, 0, 0, h * 0.55, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    const spikes = 7;
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * Math.PI * 2 + rng.next() * 0.3;
      const len = h * (0.65 + rng.next() * 0.35);
      const w = h * (0.07 + rng.next() * 0.05);
      c.save();
      c.rotate(a);
      const g = c.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(0, -w);
      c.lineTo(len, 0);
      c.lineTo(0, w);
      c.closePath();
      c.fill();
      c.restore();
    }
  });
  inCell(ctx, ATLAS_COLS, CELL.CHUNK, (c, h) => {
    c.fillStyle = 'rgba(255,255,255,1)';
    c.beginPath();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = h * (0.45 + rng.next() * 0.45);
      if (i === 0) c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.closePath();
    c.fill();
    // Darker lower half to fake shading (RGB multiplies the particle colour).
    c.globalCompositeOperation = 'source-atop';
    const g = c.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(110,110,110,1)');
    c.fillStyle = g;
    c.fillRect(-h, -h, h * 2, h * 2);
  });
  inCell(ctx, ATLAS_COLS, CELL.DROP, (c, h) => {
    radial(c, 0, 0, h * 0.7, [[0, 'rgba(255,255,255,1)'], [0.7, 'rgba(235,235,235,0.9)'], [1, 'rgba(255,255,255,0)']]);
  });
  inCell(ctx, ATLAS_COLS, CELL.RING, (c, h) => {
    const g = c.createRadialGradient(0, 0, h * 0.55, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, h, 0, Math.PI * 2);
    c.fill();
  });
  inCell(ctx, ATLAS_COLS, CELL.FIRE, (c, h) => {
    noisyBlob(c, h, rng, 18, 0.4, 0.45);
    radial(c, 0, 0, h * 0.7, [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
  });
  inCell(ctx, ATLAS_COLS, CELL.SPLINTER, (c, h) => {
    c.fillStyle = 'rgba(255,255,255,1)';
    c.beginPath();
    c.moveTo(0, -h);
    c.lineTo(h * 0.14, -h * 0.2);
    c.lineTo(h * 0.08, h);
    c.lineTo(-h * 0.1, h * 0.6);
    c.lineTo(-h * 0.12, -h * 0.3);
    c.closePath();
    c.fill();
  });
  inCell(ctx, ATLAS_COLS, CELL.FLAME, (c, h) => {
    // Elongated teardrop along the cell's vertical axis (base at the bottom).
    c.save();
    c.scale(0.38, 1);
    radial(c, 0, h * 0.35, h * 0.95, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    c.restore();
  });
  inCell(ctx, ATLAS_COLS, CELL.DUST, (c, h) => {
    noisyBlob(c, h, rng, 30, 0.16, 0.6);
  });
  inCell(ctx, ATLAS_COLS, CELL.GLOW, (c, h) => {
    radial(c, 0, 0, h, [[0, 'rgba(255,255,255,0.9)'], [0.3, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]);
  });
  inCell(ctx, ATLAS_COLS, CELL.MIST, (c, h) => {
    noisyBlob(c, h, rng, 22, 0.3, 0.5);
    for (let i = 0; i < 26; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = (0.3 + rng.next() * 0.65) * h;
      radial(c, Math.cos(a) * d, Math.sin(a) * d, h * (0.04 + rng.next() * 0.06), [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
    }
  });
  inCell(ctx, ATLAS_COLS, CELL.BLADE, (c, h) => {
    c.fillStyle = 'rgba(255,255,255,1)';
    c.beginPath();
    c.ellipse(0, 0, h * 0.18, h * 0.8, 0.3, 0, Math.PI * 2);
    c.fill();
  });
}

function drawDecals(ctx: CanvasRenderingContext2D): void {
  const rng = new Rng(0xdeca1);
  const hole = (c: CanvasRenderingContext2D, h: number, rim: string, chips: string, chipCount: number) => {
    // Chipped surround
    for (let i = 0; i < chipCount; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = h * (0.18 + rng.next() * 0.35);
      radial(c, Math.cos(a) * d, Math.sin(a) * d, h * (0.08 + rng.next() * 0.12), [[0, chips], [1, 'rgba(0,0,0,0)']]);
    }
    radial(c, 0, 0, h * 0.5, [[0, rim], [1, 'rgba(0,0,0,0)']]);
    radial(c, 0, 0, h * 0.2, [[0, 'rgba(8,8,8,1)'], [0.7, 'rgba(15,15,15,0.95)'], [1, 'rgba(20,20,20,0)']]);
  };
  inCell(ctx, DECAL_COLS, DECAL.HOLE, (c, h) => hole(c, h, 'rgba(40,40,40,0.75)', 'rgba(70,70,68,0.5)', 10));
  inCell(ctx, DECAL_COLS, DECAL.HOLE_METAL, (c, h) => {
    radial(c, 0, 0, h * 0.42, [[0, 'rgba(200,200,205,0.9)'], [0.6, 'rgba(150,150,155,0.6)'], [1, 'rgba(0,0,0,0)']]);
    radial(c, 0, 0, h * 0.2, [[0, 'rgba(5,5,5,1)'], [0.75, 'rgba(10,10,10,1)'], [1, 'rgba(30,30,30,0)']]);
  });
  inCell(ctx, DECAL_COLS, DECAL.HOLE_WOOD, (c, h) => {
    for (let i = 0; i < 8; i++) {
      const a = rng.next() * Math.PI * 2;
      c.save();
      c.rotate(a);
      c.fillStyle = 'rgba(190,150,100,0.6)';
      c.fillRect(0, -h * 0.03, h * (0.3 + rng.next() * 0.3), h * 0.06);
      c.restore();
    }
    radial(c, 0, 0, h * 0.22, [[0, 'rgba(20,12,6,1)'], [0.7, 'rgba(35,22,10,0.95)'], [1, 'rgba(40,25,10,0)']]);
  });
  inCell(ctx, DECAL_COLS, DECAL.DIRT, (c, h) => {
    noisyBlob(c, h, rng, 14, 0.35, 0.4);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(45,35,25,1)';
    c.fillRect(-h, -h, h * 2, h * 2);
    c.globalCompositeOperation = 'source-over';
    radial(c, 0, 0, h * 0.2, [[0, 'rgba(15,10,5,0.95)'], [1, 'rgba(15,10,5,0)']]);
  });
  inCell(ctx, DECAL_COLS, DECAL.SCORCH, (c, h) => {
    noisyBlob(c, h, rng, 30, 0.35, 0.6);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(12,10,8,1)';
    c.fillRect(-h, -h, h * 2, h * 2);
    c.globalCompositeOperation = 'source-over';
    radial(c, 0, 0, h * 0.55, [[0, 'rgba(5,5,5,0.9)'], [1, 'rgba(5,5,5,0)']]);
  });
  inCell(ctx, DECAL_COLS, DECAL.BLOOD, (c, h) => {
    for (let i = 0; i < 16; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = h * Math.sqrt(rng.next()) * 0.6;
      radial(c, Math.cos(a) * d, Math.sin(a) * d, h * (0.06 + rng.next() * 0.16), [[0, 'rgba(90,6,6,0.95)'], [1, 'rgba(70,4,4,0)']]);
    }
  });
}

function finishTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  // Sprite masks are white (colour comes from instances); decal colours are authored in sRGB.
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Shared particle sprite atlas (lazily generated). */
export function getSpriteAtlas(): THREE.Texture {
  if (spriteAtlas) return spriteAtlas;
  const c = makeCanvas(CELL_PX * ATLAS_COLS, CELL_PX * ATLAS_ROWS);
  if (!c) {
    spriteAtlas = whiteTexture();
    return spriteAtlas;
  }
  drawSprites(c.ctx);
  spriteAtlas = finishTexture(c.canvas, false);
  return spriteAtlas;
}

/** Shared decal atlas (lazily generated). */
export function getDecalAtlas(): THREE.Texture {
  if (decalAtlas) return decalAtlas;
  const c = makeCanvas(CELL_PX * DECAL_COLS, CELL_PX * DECAL_ROWS);
  if (!c) {
    decalAtlas = whiteTexture();
    return decalAtlas;
  }
  drawDecals(c.ctx);
  decalAtlas = finishTexture(c.canvas, true);
  return decalAtlas;
}

/** Remap a plane geometry's UVs (0..1) to one cell of the sprite atlas. */
export function mapUvToCell(geom: THREE.BufferGeometry, cell: number): void {
  const uv = geom.getAttribute('uv') as THREE.BufferAttribute;
  const col = cell % ATLAS_COLS;
  const row = Math.floor(cell / ATLAS_COLS);
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    // Canvas rows go top-down while UV v goes bottom-up (flipY textures).
    uv.setXY(i, (col + u) / ATLAS_COLS, 1 - (row + 1 - v) / ATLAS_ROWS);
  }
  uv.needsUpdate = true;
}

let users = 0;

/** Register a user of the shared atlases (FX renderer, viewmodel). Pair with releaseAtlases(). */
export function retainAtlases(): void {
  users++;
}

/** Drop one user; the atlases are disposed when the last user is gone. */
export function releaseAtlases(): void {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  spriteAtlas?.dispose();
  decalAtlas?.dispose();
  spriteAtlas = null;
  decalAtlas = null;
}
