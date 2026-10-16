// Bottom-left minimap: north-up 250 m view centred on the view target, zone circles, plane path,
// teammates, waypoint, self arrow and a run line to the next circle. Content never mirrors (RTL).

import type { FrameState } from '../../game/types';
import type { CameraState } from '../../render/contracts';
import { h, tx, Vis } from '../dom';
import { bearingFromYaw } from '../format';
import { drawMates, drawPlane, drawRunLine, drawSelf, drawTerrain, drawWaypoint, drawZone, drawGrid, type MapView } from './mapDraw';
import { getMapTexture, type MapTexture } from './mapTexture';
import { MEMBER_COLORS, viewPos, type HudEnv, type Widget } from './shared';

const VIEW_METERS = 250;
const REDRAW_MS = 33;
/** Same squares as the full map grid. */
const GRID_DIVISIONS = 8;

export class Minimap implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private tex: MapTexture | null = null;
  private lastDraw = 0;
  private cssSize = 0;
  private readonly view: MapView = { cx: 0, cz: 0, s: 1, w: 1, h: 1, dpr: 1 };
  /** Hidden while the full map is open. */
  suppressed = false;

  constructor() {
    this.el = h('div', 'dz-minimap');
    this.el.dir = 'ltr';
    this.vis = new Vis(this.el);
    this.canvas = h('canvas', 'dz-minimap-canvas', this.el);
    this.ctx = this.canvas.getContext('2d');
    tx(h('div', 'dz-minimap-north', this.el), 'hud.compass.n');
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.el);
    }
  }

  attach(env: HudEnv): void {
    this.tex = getMapTexture(env.world);
    this.lastDraw = 0;
  }

  private resize(): void {
    const css = this.el.clientWidth;
    if (!css) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssSize = css;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.view.dpr = dpr;
    this.lastDraw = 0;
  }

  update(frame: FrameState, cam: CameraState, env: HudEnv): void {
    const self = frame.self;
    const show = !!self && !this.suppressed && !!this.ctx && !!this.tex;
    this.vis.set(show);
    if (!show || !self || !this.ctx || !this.tex) return;
    const now = performance.now();
    if (now - this.lastDraw < REDRAW_MS) return;
    this.lastDraw = now;
    if (!this.cssSize) this.resize();
    if (!this.cssSize) return;
    const pos = viewPos(frame) ?? self.pos;
    const v = this.view;
    v.w = this.canvas.width;
    v.h = this.canvas.height;
    v.s = v.w / VIEW_METERS;
    v.cx = pos.x;
    v.cz = pos.z;
    const ctx = this.ctx;
    drawTerrain(ctx, this.tex, v);
    drawGrid(ctx, v, env.world, env.world.size / GRID_DIVISIONS, 0.14);
    if (frame.config.mode !== 'training') {
      drawZone(ctx, v, frame.zone);
      if (self.life !== 'dead') drawRunLine(ctx, v, pos.x, pos.z, frame.zone);
    }
    if (frame.phase === 'plane' || self.mode === 'plane') drawPlane(ctx, v, frame);
    drawWaypoint(ctx, v, env.waypoint, true);
    drawMates(ctx, v, frame, env, true, self.id);
    const selfColor = env.memberColor(self.id) ?? MEMBER_COLORS[0];
    drawSelf(ctx, v, pos.x, pos.z, bearingFromYaw(cam.yaw), self.life === 'dead' ? '#cfd3d6' : selfColor);
  }

  relabel(): void {
    this.lastDraw = 0;
  }

  reset(): void {
    this.lastDraw = 0;
    this.vis.invalidate();
  }
}
