// Full-screen map (toggle with the map key): zoom (wheel / +/-), pan (drag / arrows), grid squares
// with letters and numbers, town labels, zone circles, plane path, teammates, self and a local
// waypoint placed / removed with right-click.

import { fmtNumber } from '../../i18n';
import type { FrameState } from '../../game/types';
import type { CameraState } from '../../render/contracts';
import { ariaTx, button, h, svgIcon, tx } from '../dom';
import { bearingFromYaw, gridColumnLabel } from '../format';
import { ICONS } from '../icons';
import {
  drawGrid, drawMates, drawPlane, drawRunLine, drawSelf, drawTerrain, drawWaypoint, drawZone, fromX, fromY, toX, toY,
  type MapView,
} from './mapDraw';
import { getMapTexture, type MapTexture } from './mapTexture';
import { MEMBER_COLORS, viewPos, type HudEnv } from './shared';

const MAX_ZOOM = 8;
const GRID_DIVISIONS = 8;
const WAYPOINT_HIT_PX = 14;

export class FullMap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly area: HTMLDivElement;
  private env: HudEnv | null = null;
  private tex: MapTexture | null = null;
  private frame: FrameState | null = null;
  private heading = 0;
  private open = false;
  private zoom = 1;
  private readonly view: MapView = { cx: 0, cz: 0, s: 1, w: 1, h: 1, dpr: 1 };
  private dirty = true;
  private lastDraw = 0;
  private lastTexVersion = -1;
  private drag: { id: number; x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;

  constructor(private readonly onClose: () => void) {
    this.el = h('div', 'dz-fullmap dz-hidden');
    const panel = h('div', 'dz-fullmap-panel', this.el);
    const head = h('div', 'dz-fullmap-head', panel);
    tx(h('h2', 'dz-fullmap-title', head), 'map.title');
    const legend = h('div', 'dz-fullmap-legend', head);
    const item = (cls: string, key: 'map.you' | 'map.teammate' | 'map.zone' | 'map.nextZone' | 'map.planePath' | 'map.waypoint') => {
      const it = h('span', 'dz-legend-item', legend);
      h('span', `dz-legend-swatch ${cls}`, it);
      tx(h('span', '', it), key);
    };
    item('dz-sw-you', 'map.you');
    item('dz-sw-mate', 'map.teammate');
    item('dz-sw-zone', 'map.zone');
    item('dz-sw-next', 'map.nextZone');
    item('dz-sw-plane', 'map.planePath');
    item('dz-sw-wp', 'map.waypoint');
    const close = button({ cls: 'dz-btn-icon-only', icon: ICONS.close, parent: head, onClick: () => this.onClose() });
    ariaTx(close, 'common.close');

    this.area = h('div', 'dz-fullmap-area', panel);
    this.canvas = h('canvas', 'dz-fullmap-canvas', this.area);
    this.ctx = this.canvas.getContext('2d');
    const foot = h('div', 'dz-fullmap-foot', panel);
    foot.appendChild(svgIcon(ICONS.waypoint, 'dz-icon dz-icon-sm dz-accent'));
    tx(h('span', '', foot), 'map.waypointHint');
    tx(h('span', 'dz-fullmap-zoomhint', foot), 'map.zoomHint');

    this.canvas.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    this.canvas.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.canvas.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    this.canvas.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    this.canvas.addEventListener('pointercancel', () => { this.drag = null; });
    this.canvas.addEventListener('contextmenu', (ev) => this.onContextMenu(ev));
    this.canvas.addEventListener('dblclick', (ev) => {
      const p = this.local(ev);
      this.zoomAt(p.x, p.y, 2);
    });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(this.area);
  }

  get isOpen(): boolean {
    return this.open;
  }

  attach(env: HudEnv): void {
    this.env = env;
    this.tex = getMapTexture(env.world);
    this.dirty = true;
  }

  detach(): void {
    this.env = null;
    this.frame = null;
    this.setOpen(false);
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.el.classList.toggle('dz-hidden', !open);
    this.drag = null;
    if (open) {
      this.resize();
      this.centerOnPlayer();
    }
  }

  private resize(): void {
    const w = this.area.clientWidth, hgt = this.area.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.view.dpr = dpr;
    this.view.w = this.canvas.width;
    this.view.h = this.canvas.height;
    this.applyZoom();
  }

  private fitScale(): number {
    const size = this.env?.world.size ?? 1024;
    return Math.min(this.view.w, this.view.h) / size;
  }

  private applyZoom(): void {
    this.view.s = this.fitScale() * this.zoom;
    this.clampCenter();
    this.dirty = true;
  }

  private clampCenter(): void {
    const half = this.env?.world.half ?? 512;
    const v = this.view;
    // Allow panning until the map edge reaches the canvas centre region.
    const mx = Math.max(0, half - v.w / 2 / v.s), mz = Math.max(0, half - v.h / 2 / v.s);
    v.cx = Math.min(mx, Math.max(-mx, v.cx));
    v.cz = Math.min(mz, Math.max(-mz, v.cz));
  }

  private centerOnPlayer(): void {
    const f = this.frame;
    const pos = f ? viewPos(f) : null;
    const inPlane = !!f && (f.phase === 'plane' || f.self?.mode === 'plane');
    this.zoom = inPlane ? 1 : 2.5;
    this.view.cx = inPlane || !pos ? 0 : pos.x;
    this.view.cz = inPlane || !pos ? 0 : pos.z;
    this.applyZoom();
  }

  private local(ev: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * this.view.dpr, y: (ev.clientY - r.top) * this.view.dpr };
  }

  zoomBy(factor: number): void {
    this.zoomAt(this.view.w / 2, this.view.h / 2, factor);
  }

  pan(dxPx: number, dyPx: number): void {
    this.view.cx += (dxPx * this.view.dpr) / this.view.s;
    this.view.cz += (dyPx * this.view.dpr) / this.view.s;
    this.clampCenter();
    this.dirty = true;
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const v = this.view;
    const wx = fromX(v, px), wz = fromY(v, py);
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, this.zoom * factor));
    v.s = this.fitScale() * this.zoom;
    // Keep the world point under the cursor fixed.
    v.cx = wx - (px - v.w / 2) / v.s;
    v.cz = wz - (py - v.h / 2) / v.s;
    this.clampCenter();
    this.dirty = true;
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const p = this.local(ev);
    const unit = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1;
    this.zoomAt(p.x, p.y, Math.exp(-ev.deltaY * unit * 0.0016));
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    this.canvas.setPointerCapture(ev.pointerId);
    this.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, cx: this.view.cx, cz: this.view.cz, moved: false };
    this.canvas.classList.add('dz-dragging');
  }

  private onPointerMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== ev.pointerId) return;
    const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    this.view.cx = d.cx - (dx * this.view.dpr) / this.view.s;
    this.view.cz = d.cz - (dy * this.view.dpr) / this.view.s;
    this.clampCenter();
    this.dirty = true;
  }

  private onPointerUp(ev: PointerEvent): void {
    if (this.drag?.id === ev.pointerId) {
      this.drag = null;
      this.canvas.classList.remove('dz-dragging');
    }
  }

  private onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const env = this.env;
    if (!env) return;
    const p = this.local(ev);
    const wp = env.waypoint;
    if (wp.active) {
      const dx = toX(this.view, wp.x) - p.x, dy = toY(this.view, wp.z) - p.y;
      if (Math.hypot(dx, dy) < WAYPOINT_HIT_PX * this.view.dpr) {
        wp.clear();
        this.dirty = true;
        return;
      }
    }
    const half = env.world.half;
    const x = fromX(this.view, p.x), z = fromY(this.view, p.y);
    if (Math.abs(x) > half || Math.abs(z) > half) return;
    wp.set(x, z);
    this.dirty = true;
  }

  /** Called every frame (cheap when closed). */
  update(frame: FrameState, cam: CameraState): void {
    this.frame = frame;
    this.heading = bearingFromYaw(cam.yaw);
    if (!this.open || !this.ctx || !this.tex || !this.env) return;
    const now = performance.now();
    if (this.tex.version !== this.lastTexVersion) {
      this.lastTexVersion = this.tex.version;
      this.dirty = true;
    }
    // Moving entities: redraw at ~20 Hz; interaction: immediately.
    if (!this.dirty && now - this.lastDraw < 50) return;
    this.dirty = false;
    this.lastDraw = now;
    this.draw(frame);
  }

  private draw(frame: FrameState): void {
    const ctx = this.ctx!;
    const env = this.env!;
    const v = this.view;
    const world = env.world;
    drawTerrain(ctx, this.tex!, v);
    const step = world.size / GRID_DIVISIONS;
    drawGrid(ctx, v, world, step, 0.22);
    this.drawTowns(ctx, frame);
    if (frame.config.mode !== 'training') drawZone(ctx, v, frame.zone);
    const self = frame.self;
    const pos = viewPos(frame);
    if (self && pos && self.life !== 'dead' && frame.config.mode !== 'training') drawRunLine(ctx, v, pos.x, pos.z, frame.zone);
    if (frame.plane && (frame.phase === 'plane' || self?.mode === 'plane' || frame.plane.active)) drawPlane(ctx, v, frame);
    drawWaypoint(ctx, v, env.waypoint, false);
    if (self) drawMates(ctx, v, frame, env, false, self.id);
    if (self && pos) drawSelf(ctx, v, pos.x, pos.z, this.heading, self.life === 'dead' ? '#cfd3d6' : env.memberColor(self.id) ?? MEMBER_COLORS[0]);
    this.drawGridLabels(ctx, step);
  }

  private drawTowns(ctx: CanvasRenderingContext2D, frame: FrameState): void {
    const v = this.view;
    const towns = frame.world.towns;
    if (!towns.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const town of towns) {
      const x = toX(v, town.x), y = toY(v, town.z);
      if (x < -100 || y < -40 || x > v.w + 100 || y > v.h + 40) continue;
      const size = Math.round((town.tier === 2 ? 15 : town.tier === 1 ? 13 : 11.5) * v.dpr * Math.min(1.5, 0.85 + this.zoom * 0.08));
      ctx.font = `${town.tier === 2 ? 800 : 700} ${size}px system-ui, "Segoe UI", sans-serif`;
      ctx.lineWidth = 3.5 * v.dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.fillStyle = town.tier === 2 ? '#ffd27a' : '#ffffff';
      ctx.strokeText(town.name, x, y);
      ctx.fillText(town.name, x, y);
    }
    ctx.restore();
  }

  /** Column letters along the top, row numbers along the left edge (screen anchored). */
  private drawGridLabels(ctx: CanvasRenderingContext2D, step: number): void {
    const v = this.view;
    const half = this.env!.world.half;
    ctx.save();
    ctx.font = `700 ${Math.round(11 * v.dpr)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3 * v.dpr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < GRID_DIVISIONS; i++) {
      const x = toX(v, -half + (i + 0.5) * step);
      if (x < 0 || x > v.w) continue;
      const label = gridColumnLabel(i);
      ctx.strokeText(label, x, 6 * v.dpr);
      ctx.fillText(label, x, 6 * v.dpr);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < GRID_DIVISIONS; i++) {
      const y = toY(v, -half + (i + 0.5) * step);
      if (y < 0 || y > v.h) continue;
      const label = fmtNumber(i + 1);
      ctx.strokeText(label, 6 * v.dpr, y);
      ctx.fillText(label, 6 * v.dpr, y);
    }
    ctx.restore();
  }

  relabel(): void {
    this.dirty = true;
  }
}
