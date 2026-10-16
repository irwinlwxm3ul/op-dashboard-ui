// Top-centre compass strip: heading ticks with cardinal letters (translated) and bearings, a heading
// readout, and markers for teammates and the map waypoint. Spatial content never mirrors in RTL.

import { fmtNumber, t, type TKey } from '../../i18n';
import type { FrameState } from '../../game/types';
import type { CameraState } from '../../render/contracts';
import { h, NumSlot, StyleSlot, Vis } from '../dom';
import { bearingFromYaw, bearingTo, relBearing } from '../format';
import { MEMBER_COLORS, viewPos, type HudEnv, type Widget } from './shared';

/** Pixels per degree on the strip. */
const PX = 3.2;
/** The track covers [-180, 540) degrees so any heading in [0, 360) can be centred. */
const START = -180;
const SPAN = 720;

const CARDINALS: Record<number, TKey> = {
  0: 'hud.compass.n', 45: 'hud.compass.ne', 90: 'hud.compass.e', 135: 'hud.compass.se',
  180: 'hud.compass.s', 225: 'hud.compass.sw', 270: 'hud.compass.w', 315: 'hud.compass.nw',
};

class Marker {
  readonly el: HTMLDivElement;
  readonly vis: Vis;
  private readonly x: StyleSlot;
  private readonly color: StyleSlot;

  constructor(parent: HTMLElement, cls: string) {
    this.el = h('div', `dz-compass-marker ${cls}`, parent);
    this.vis = new Vis(this.el);
    this.x = new StyleSlot(this.el, 'transform');
    this.color = new StyleSlot(this.el, '--c');
  }

  private lastPx = Number.NaN;

  place(px: number, color: string | null): void {
    if (!(Math.abs(px - this.lastPx) < 0.3)) {
      this.lastPx = px;
      this.x.set(`translateX(${px.toFixed(1)}px)`);
    }
    if (color) this.color.set(color);
  }
}

export class Compass implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly strip: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly readout: NumSlot;
  private readonly mates: Marker[] = [];
  private readonly waypoint: Marker;
  private width = 0;
  private lastHeading = Number.NaN;

  constructor() {
    this.el = h('div', 'dz-compass');
    this.el.dir = 'ltr';
    this.vis = new Vis(this.el);
    this.strip = h('div', 'dz-compass-strip', this.el);
    this.track = h('div', 'dz-compass-track', this.strip);
    this.track.style.width = `${SPAN * PX}px`;
    this.buildTicks();
    for (let i = 0; i < 4; i++) this.mates.push(new Marker(this.strip, 'dz-compass-mate'));
    this.waypoint = new Marker(this.strip, 'dz-compass-wp');
    h('div', 'dz-compass-center', this.strip);
    this.readout = new NumSlot(h('div', 'dz-compass-readout', this.el), (n) => fmtNumber(n));
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        this.width = this.strip.clientWidth;
        this.lastHeading = Number.NaN;
      }).observe(this.strip);
    }
  }

  private buildTicks(): void {
    this.track.textContent = '';
    for (let d = START; d < START + SPAN; d += 5) {
      const deg = ((d % 360) + 360) % 360;
      const x = (d - START) * PX;
      const major = deg % 15 === 0;
      const tick = h('div', `dz-compass-tick${major ? ' dz-major' : ''}`, this.track);
      tick.style.left = `${x}px`;
      if (deg % 45 === 0) {
        const lab = h('div', 'dz-compass-label dz-cardinal', this.track);
        lab.style.left = `${x}px`;
        lab.textContent = t(CARDINALS[deg]);
        if (deg === 0) lab.classList.add('dz-north');
      } else if (major) {
        const lab = h('div', 'dz-compass-label', this.track);
        lab.style.left = `${x}px`;
        lab.textContent = fmtNumber(deg);
      }
    }
  }

  update(frame: FrameState, cam: CameraState, env: HudEnv): void {
    const self = frame.self;
    this.vis.set(!!self);
    if (!self) return;
    if (!this.width) this.width = this.strip.clientWidth || 420;
    const heading = bearingFromYaw(cam.yaw);
    if (Math.abs(heading - this.lastHeading) > 0.05) {
      this.lastHeading = heading;
      const x = this.width / 2 - (heading - START) * PX;
      this.track.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
      this.readout.set(Math.round(heading) % 360);
    }
    const half = this.width / 2;
    const maxRel = half / PX - 2;
    const pos = viewPos(frame);
    // Teammates.
    let used = 0;
    if (pos) {
      for (const id of env.team) {
        if (used >= this.mates.length) break;
        if (id === self.id) continue;
        const p = frame.players.get(id);
        if (!p || p.life === 'dead') continue;
        const rel = relBearing(heading, bearingTo(pos.x, pos.z, p.pos.x, p.pos.z));
        const m = this.mates[used++];
        const visible = Math.abs(rel) <= maxRel;
        m.vis.set(visible);
        if (visible) m.place(half + rel * PX, env.memberColor(id) ?? MEMBER_COLORS[0]);
      }
    }
    for (let i = used; i < this.mates.length; i++) this.mates[i].vis.set(false);
    // Waypoint.
    const wp = env.waypoint;
    if (wp.active && pos) {
      const rel = relBearing(heading, bearingTo(pos.x, pos.z, wp.x, wp.z));
      const visible = Math.abs(rel) <= maxRel;
      this.waypoint.vis.set(visible);
      if (visible) this.waypoint.place(half + rel * PX, null);
    } else this.waypoint.vis.set(false);
  }

  relabel(): void {
    this.buildTicks();
    this.lastHeading = Number.NaN;
    this.readout.invalidate();
  }

  reset(): void {
    this.lastHeading = Number.NaN;
    this.vis.invalidate();
    for (const m of this.mates) m.vis.set(false);
    this.waypoint.vis.set(false);
  }
}
