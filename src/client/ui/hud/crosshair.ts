// Centre crosshair (gap = current spread cone projected with the camera FOV; hidden while aiming
// down sights) and the scope overlay (black vignette + reticle for 4x / 8x, red dot for reddot).

import { VEHICLES } from '../../../shared/vehicles';
import type { ScopeKind } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import type { CameraState } from '../../render/contracts';
import { ClassFlag, h, StyleSlot, Vis } from '../dom';
import { spreadToPixels } from '../format';
import type { Widget } from './shared';

const MIN_GAP = 3;
const MAX_GAP = 140;
/** Hide the crosshair once ADS is this far in. */
const ADS_HIDE = 0.55;

const NO_CROSSHAIR_MODES: ReadonlySet<CameraState['mode']> = new Set(['plane', 'freefall', 'parachute', 'spectate', 'death', 'menu', 'scope']);

const RETICLE_X4 = `<svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g fill="none" stroke="#111" stroke-width="1.6"><path d="M-100 0H-30M30 0H100M0 100V40"/></g>
<path d="M0 -2 L-9 12 L-6 12 L0 3 L6 12 L9 12 Z" fill="#ff6a1a" stroke="#4a1500" stroke-width=".6"/>
<g stroke="#111" stroke-width="1.2"><path d="M-6 22H6M-5 30H5M-4 38H4"/></g></svg>`;

const RETICLE_X8 = `<svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g stroke="#0c0c0c" fill="none"><path stroke-width="3.2" d="M-100 0H-22M22 0H100M0 100V22M0 -100V-22"/>
<path stroke-width=".9" d="M-22 0H22M0 -22V22"/></g>
<g fill="#0c0c0c"><circle cx="-8" cy="0" r="1.1"/><circle cx="-15" cy="0" r="1.1"/><circle cx="8" cy="0" r="1.1"/><circle cx="15" cy="0" r="1.1"/>
<circle cx="0" cy="8" r="1.1"/><circle cx="0" cy="15" r="1.1"/><circle cx="0" cy="-8" r="1.1"/><circle cx="0" cy="-15" r="1.1"/></g></svg>`;

const RETICLE_REDDOT = '<i class="dz-reddot"></i>';

/** Reticle markup per scope kind (iron sights draw nothing: the viewmodel shows them). */
const RETICLES: Record<ScopeKind, string> = { iron: '', reddot: RETICLE_REDDOT, x4: RETICLE_X4, x8: RETICLE_X8 };

export class Crosshair implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly gap: StyleSlot;
  private readonly fists: ClassFlag;
  private readonly busy: ClassFlag;
  private lastGap = -1;

  constructor() {
    this.el = h('div', 'dz-crosshair');
    this.el.setAttribute('aria-hidden', 'true');
    for (const k of ['t', 'b', 'l', 'r']) h('i', `dz-ch-arm dz-ch-${k}`, this.el);
    h('i', 'dz-ch-dot', this.el);
    this.vis = new Vis(this.el);
    this.gap = new StyleSlot(this.el, '--gap');
    this.fists = new ClassFlag(this.el, 'dz-ch-fists');
    this.busy = new ClassFlag(this.el, 'dz-ch-busy');
  }

  update(frame: FrameState, cam: CameraState): void {
    const self = frame.self;
    // Hidden while free-looking: the camera no longer points where shots go.
    let show = !!self && self.life === 'alive' && !cam.scope && !NO_CROSSHAIR_MODES.has(cam.mode) && self.ads < ADS_HIDE
      && !frame.camera.freeLook;
    if (show && self) {
      if (self.mode === 'plane' || self.mode === 'freefall' || self.mode === 'parachute') show = false;
      else if (self.vehicleId !== null) {
        const v = frame.vehicles.get(self.vehicleId);
        show = !!v && !!VEHICLES[v.type].seatCanShoot[self.seat];
      }
    }
    this.vis.set(show);
    if (!show || !self) return;
    this.fists.set(self.weapon === null);
    this.busy.set(self.reloadProgress >= 0 || self.drawProgress >= 0 || self.useProgress >= 0);
    const px = spreadToPixels(self.spread, cam.fov, window.innerHeight || 720);
    const gap = Math.round(Math.min(MAX_GAP, Math.max(MIN_GAP, px)) * 2) / 2;
    if (gap !== this.lastGap) {
      this.lastGap = gap;
      this.gap.set(`${gap}px`);
    }
  }

  relabel(): void {}

  reset(): void {
    this.lastGap = -1;
    this.vis.invalidate();
  }
}

export class ScopeOverlay implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly reticle: HTMLDivElement;
  private kind: ScopeKind | null = null;

  constructor() {
    this.el = h('div', 'dz-scope');
    this.el.setAttribute('aria-hidden', 'true');
    this.vis = new Vis(this.el);
    h('div', 'dz-scope-vignette', this.el);
    this.reticle = h('div', 'dz-scope-reticle', this.el);
  }

  update(frame: FrameState, cam: CameraState): void {
    const self = frame.self;
    const kind = self && self.life === 'alive' && cam.scope && cam.scope !== 'iron' ? cam.scope : null;
    this.vis.set(kind !== null);
    if (kind === this.kind) return;
    this.kind = kind;
    if (!kind) return;
    this.el.dataset.kind = kind;
    this.reticle.innerHTML = RETICLES[kind];
  }

  relabel(): void {}

  reset(): void {
    this.kind = null;
    this.vis.invalidate();
  }
}
