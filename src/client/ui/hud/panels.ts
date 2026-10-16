// Small HUD panels: F3 performance overlay (+ optional FPS counter) and the training ground panel.

import { fmtNumber, t, type TKey } from '../../i18n';
import { settings } from '../../game';
import type { FrameState } from '../../game/types';
import type { RenderStats } from '../../render/contracts';
import { h, svgIcon, TextSlot, tx, Vis } from '../dom';
import { ICONS } from '../icons';
import { keyCapLabel } from '../keys';
import type { HudEnv, Widget } from './shared';

/** Key that respawns in the training ground (handled by the HUD; not a rebindable game action). */
export const RESPAWN_CODE = 'KeyK';

interface StatRow {
  value: TextSlot;
}

export class StatsOverlay implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly fps: Vis;
  private readonly fpsText: TextSlot;
  private readonly rows: Record<'fps' | 'frame' | 'draw' | 'tris' | 'ents' | 'ping', StatRow>;
  private open = false;
  private showFps = false;
  private stats: RenderStats | null = null;
  private ping = 0;
  private entities = 0;

  constructor() {
    this.el = h('div', 'dz-stats-wrap');
    const panel = h('div', 'dz-stats', this.el);
    this.vis = new Vis(panel);
    const row = (key: TKey): StatRow => {
      const r = h('div', 'dz-stats-row', panel);
      tx(h('span', 'dz-stats-k', r), key);
      return { value: new TextSlot(h('span', 'dz-stats-v', r)) };
    };
    this.rows = {
      fps: row('hud.stats.fps'),
      frame: row('hud.stats.frame'),
      draw: row('hud.stats.drawCalls'),
      tris: row('hud.stats.triangles'),
      ents: row('hud.stats.entities'),
      ping: row('hud.stats.ping'),
    };
    const fps = h('div', 'dz-fps', this.el);
    this.fps = new Vis(fps);
    this.fpsText = new TextSlot(fps);
    this.showFps = settings.get().showFps;
    settings.subscribe((s) => {
      this.showFps = s.showFps;
      this.render();
    });
    this.render();
  }

  toggle(): void {
    this.open = !this.open;
    this.render();
  }

  get isOpen(): boolean {
    return this.open;
  }

  set(stats: RenderStats, ping: number, entities: number): void {
    this.stats = stats;
    this.ping = ping;
    this.entities = entities;
    this.render();
  }

  private render(): void {
    this.vis.set(this.open);
    this.fps.set(!this.open && this.showFps && !!this.stats);
    const s = this.stats;
    if (!s) return;
    if (this.open) {
      this.rows.fps.value.set(fmtNumber(Math.round(s.fps)));
      this.rows.frame.value.set(t('hud.stats.ms', { n: fmtNumber(s.frameMs, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
      this.rows.draw.value.set(fmtNumber(s.drawCalls));
      this.rows.tris.value.set(fmtNumber(s.triangles));
      this.rows.ents.value.set(fmtNumber(this.entities));
      this.rows.ping.value.set(t('hud.stats.ms', { n: fmtNumber(Math.round(this.ping)) }));
    } else if (this.showFps) {
      this.fpsText.set(`${fmtNumber(Math.round(s.fps))} ${t('hud.stats.fps')}`);
    }
  }

  update(): void {}

  relabel(): void {
    for (const r of Object.values(this.rows)) r.value.invalidate();
    this.fpsText.invalidate();
    this.render();
  }

  reset(): void {
    this.open = false;
    this.stats = null;
    this.render();
  }
}

/** Training ground info panel (infinite ammo, respawn key, item spawner hint). */
export class TrainingPanel implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly respawn: TextSlot;
  private readonly give: TextSlot;
  private readonly racks: TextSlot;
  private dirty = true;

  constructor() {
    this.el = h('div', 'dz-training');
    this.vis = new Vis(this.el);
    tx(h('div', 'dz-training-title', this.el), 'training.title');
    const ammo = h('div', 'dz-training-row dz-accent', this.el);
    ammo.appendChild(svgIcon(ICONS.infinity, 'dz-icon dz-icon-sm'));
    tx(h('span', '', ammo), 'training.infiniteAmmo');
    this.respawn = new TextSlot(h('div', 'dz-training-row', this.el));
    this.racks = new TextSlot(h('div', 'dz-training-row', this.el));
    this.give = new TextSlot(h('div', 'dz-training-row', this.el));
  }

  update(frame: FrameState, _cam: unknown, env: HudEnv): void {
    const show = frame.config.mode === 'training';
    this.vis.set(show);
    if (!show || !this.dirty) return;
    this.dirty = false;
    this.respawn.set(t('training.hint.respawn', { key: keyCapLabel(RESPAWN_CODE) }));
    this.racks.set(t('training.hint.racks', { key: keyCapLabel(env.keys.interact) }));
    this.give.set(`${t('training.hint.give')} (${keyCapLabel(env.keys.inventory)})`);
  }

  relabel(): void {
    this.dirty = true;
  }

  reset(): void {
    this.dirty = true;
    this.vis.invalidate();
  }
}
