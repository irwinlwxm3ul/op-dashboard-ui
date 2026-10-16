// Canvas drawing shared by the minimap and the full map (north-up, world → canvas transform).

import type { World, ZoneState } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import type { MapTexture } from './mapTexture';
import { MEMBER_COLORS, type HudEnv, type Waypoint } from './shared';

export interface MapView {
  /** World point at the canvas centre. */
  cx: number;
  cz: number;
  /** Canvas pixels per world meter. */
  s: number;
  /** Canvas size in pixels. */
  w: number;
  h: number;
  /** Device pixel ratio (line widths / icon sizes). */
  dpr: number;
}

export const toX = (v: MapView, x: number): number => (x - v.cx) * v.s + v.w / 2;
export const toY = (v: MapView, z: number): number => (z - v.cz) * v.s + v.h / 2;
export const fromX = (v: MapView, px: number): number => (px - v.w / 2) / v.s + v.cx;
export const fromY = (v: MapView, py: number): number => (py - v.h / 2) / v.s + v.cz;

const SEA = '#16405f';
const ZONE_BLUE = '#3d7dff';
const WAYPOINT = '#ffd23f';

/** Terrain texture (or sea while it is still being generated). */
export function drawTerrain(ctx: CanvasRenderingContext2D, tex: MapTexture, v: MapView): void {
  ctx.fillStyle = SEA;
  ctx.fillRect(0, 0, v.w, v.h);
  const world = tex.world;
  const ppm = tex.ppm;
  // Visible world rect → texture rect, clipped to the texture.
  const wx0 = fromX(v, 0), wz0 = fromY(v, 0), wx1 = fromX(v, v.w), wz1 = fromY(v, v.h);
  let sx0 = (wx0 + world.half) * ppm, sy0 = (wz0 + world.half) * ppm;
  let sx1 = (wx1 + world.half) * ppm, sy1 = (wz1 + world.half) * ppm;
  const cx0 = Math.max(0, sx0), cy0 = Math.max(0, sy0), cx1 = Math.min(tex.px, sx1), cy1 = Math.min(tex.px, sy1);
  if (cx1 <= cx0 || cy1 <= cy0) return;
  const k = v.s / ppm; // canvas px per texture px
  const dx = (cx0 - sx0) * k, dy = (cy0 - sy0) * k;
  sx0 = cx0; sy0 = cy0; sx1 = cx1; sy1 = cy1;
  ctx.imageSmoothingEnabled = k < 4;
  ctx.drawImage(tex.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, dx, dy, (sx1 - sx0) * k, (sy1 - sy0) * k);
}

/** Grid lines every `step` meters (map squares). */
export function drawGrid(ctx: CanvasRenderingContext2D, v: MapView, world: World, step: number, alpha: number): void {
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = v.dpr;
  ctx.beginPath();
  for (let g = -world.half; g <= world.half + 0.01; g += step) {
    const x = Math.round(toX(v, g)) + 0.5;
    const y = Math.round(toY(v, g)) + 0.5;
    if (x >= 0 && x <= v.w) { ctx.moveTo(x, Math.max(0, toY(v, -world.half))); ctx.lineTo(x, Math.min(v.h, toY(v, world.half))); }
    if (y >= 0 && y <= v.h) { ctx.moveTo(Math.max(0, toX(v, -world.half)), y); ctx.lineTo(Math.min(v.w, toX(v, world.half)), y); }
  }
  ctx.stroke();
  ctx.restore();
}

/** Blue zone (with outside tint) and the white next circle. */
export function drawZone(ctx: CanvasRenderingContext2D, v: MapView, z: ZoneState): void {
  if (z.r <= 0) return;
  const x = toX(v, z.cx), y = toY(v, z.cz), r = z.r * v.s;
  if (z.stage !== 'pre') {
    ctx.save();
    ctx.fillStyle = 'rgba(40,80,230,0.24)';
    ctx.beginPath();
    ctx.rect(0, 0, v.w, v.h);
    ctx.arc(x, y, r, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = ZONE_BLUE;
    ctx.lineWidth = 2 * v.dpr;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (z.nr > 0 && (z.stage !== 'pre' || z.nr < z.r - 0.5)) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.5 * v.dpr;
    ctx.beginPath();
    ctx.arc(toX(v, z.nx), toY(v, z.nz), z.nr * v.s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Dashed line from the view position to the closest point of the next circle when outside it. */
export function drawRunLine(ctx: CanvasRenderingContext2D, v: MapView, px: number, pz: number, z: ZoneState): void {
  if (z.nr <= 0 || z.stage === 'pre') return;
  const dx = px - z.nx, dz = pz - z.nz;
  const d = Math.hypot(dx, dz);
  if (d <= z.nr) return;
  const ex = z.nx + (dx / d) * z.nr, ez = z.nz + (dz / d) * z.nr;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5 * v.dpr;
  ctx.setLineDash([4 * v.dpr, 4 * v.dpr]);
  ctx.beginPath();
  ctx.moveTo(toX(v, px), toY(v, pz));
  ctx.lineTo(toX(v, ex), toY(v, ez));
  ctx.stroke();
  ctx.restore();
}

/** Plane flight path and the plane icon. */
export function drawPlane(ctx: CanvasRenderingContext2D, v: MapView, frame: FrameState): void {
  const plane = frame.plane;
  if (!plane) return;
  const ax = toX(v, plane.start.x), ay = toY(v, plane.start.z);
  const bx = toX(v, plane.end.x), by = toY(v, plane.end.z);
  const ang = Math.atan2(by - ay, bx - ax);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.5 * v.dpr;
  ctx.setLineDash([7 * v.dpr, 5 * v.dpr]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);
  // Arrow head at the end of the path.
  const ah = 8 * v.dpr;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - Math.cos(ang - 0.4) * ah, by - Math.sin(ang - 0.4) * ah);
  ctx.lineTo(bx - Math.cos(ang + 0.4) * ah, by - Math.sin(ang + 0.4) * ah);
  ctx.closePath();
  ctx.fill();
  if (frame.planePos && plane.active) {
    const x = toX(v, frame.planePos.x), y = toY(v, frame.planePos.z);
    ctx.translate(x, y);
    ctx.rotate(ang + Math.PI / 2);
    const s = 7 * v.dpr;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = v.dpr;
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.3);
    ctx.lineTo(s * 0.25, -s * 0.4);
    ctx.lineTo(s * 1.3, s * 0.2);
    ctx.lineTo(s * 1.3, s * 0.5);
    ctx.lineTo(s * 0.25, s * 0.2);
    ctx.lineTo(s * 0.2, s * 0.9);
    ctx.lineTo(s * 0.6, s * 1.2);
    ctx.lineTo(-s * 0.6, s * 1.2);
    ctx.lineTo(-s * 0.2, s * 0.9);
    ctx.lineTo(-s * 0.25, s * 0.2);
    ctx.lineTo(-s * 1.3, s * 0.5);
    ctx.lineTo(-s * 1.3, s * 0.2);
    ctx.lineTo(-s * 0.25, -s * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Clamp a canvas point into the view rect (with margin); returns true when clamped. */
function clampPoint(v: MapView, p: { x: number; y: number }, margin: number): boolean {
  const x = Math.min(v.w - margin, Math.max(margin, p.x));
  const y = Math.min(v.h - margin, Math.max(margin, p.y));
  const clamped = x !== p.x || y !== p.y;
  p.x = x;
  p.y = y;
  return clamped;
}

const tmp = { x: 0, y: 0 };

export function drawWaypoint(ctx: CanvasRenderingContext2D, v: MapView, wp: Waypoint, clampToEdge: boolean): void {
  if (!wp.active) return;
  tmp.x = toX(v, wp.x);
  tmp.y = toY(v, wp.z);
  const s = 7 * v.dpr;
  if (clampToEdge) clampPoint(v, tmp, s + 2);
  else if (tmp.x < -s || tmp.y < -s || tmp.x > v.w + s || tmp.y > v.h + s) return;
  ctx.save();
  ctx.translate(tmp.x, tmp.y);
  ctx.fillStyle = WAYPOINT;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = v.dpr;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-s * 0.9, -s * 1.1, -s * 0.9, -s * 2.2, 0, -s * 2.2);
  ctx.bezierCurveTo(s * 0.9, -s * 2.2, s * 0.9, -s * 1.1, 0, 0);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(0, -s * 1.45, s * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Teammates (numbered dots in member colours; X when dead, red ring when downed). */
export function drawMates(ctx: CanvasRenderingContext2D, v: MapView, frame: FrameState, env: HudEnv, clampToEdge: boolean, selfId: number): void {
  const r = 5.5 * v.dpr;
  ctx.save();
  ctx.font = `bold ${Math.round(8 * v.dpr)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const id of env.team) {
    if (id === selfId) continue;
    const p = frame.players.get(id);
    if (!p) continue;
    tmp.x = toX(v, p.pos.x);
    tmp.y = toY(v, p.pos.z);
    if (clampToEdge) clampPoint(v, tmp, r + 2);
    else if (tmp.x < -r || tmp.y < -r || tmp.x > v.w + r || tmp.y > v.h + r) continue;
    const color = env.memberColor(id) ?? MEMBER_COLORS[0];
    if (p.life === 'dead') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * v.dpr;
      ctx.beginPath();
      ctx.moveTo(tmp.x - r * 0.7, tmp.y - r * 0.7);
      ctx.lineTo(tmp.x + r * 0.7, tmp.y + r * 0.7);
      ctx.moveTo(tmp.x + r * 0.7, tmp.y - r * 0.7);
      ctx.lineTo(tmp.x - r * 0.7, tmp.y + r * 0.7);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = p.life === 'downed' ? '#ff3b30' : 'rgba(0,0,0,0.75)';
    ctx.lineWidth = (p.life === 'downed' ? 2 : 1) * v.dpr;
    ctx.beginPath();
    ctx.arc(tmp.x, tmp.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.fillText(String(env.memberNumber(id)), tmp.x, tmp.y + 0.5 * v.dpr);
  }
  ctx.restore();
}

/** Self arrow pointing along `bearingDeg` (clockwise from north). */
export function drawSelf(ctx: CanvasRenderingContext2D, v: MapView, x: number, z: number, bearingDeg: number, color: string, size = 7): void {
  const s = size * v.dpr;
  ctx.save();
  ctx.translate(toX(v, x), toY(v, z));
  ctx.rotate((bearingDeg * Math.PI) / 180);
  // View cone.
  const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 5);
  cone.addColorStop(0, 'rgba(255,255,255,0.28)');
  cone.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, s * 5, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 1.4 * v.dpr;
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.2);
  ctx.lineTo(s * 0.85, s * 0.9);
  ctx.lineTo(0, s * 0.45);
  ctx.lineTo(-s * 0.85, s * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
