// Top-right match info: alive / teams / kills counters, zone state + timer + progress, ping.
// Also the centre "outside the play area" warning.

import { fmtDuration, fmtNumber, t } from '../../i18n';
import type { ZoneStage } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import { BarFill, ClassFlag, h, NumSlot, svgIcon, TextSlot, tx, Vis } from '../dom';
import { ceilSeconds, clamp01, distOutsideCircle } from '../format';
import { ICONS } from '../icons';
import { viewPos, type HudEnv, type Widget } from './shared';

function counter(parent: HTMLElement, label: 'hud.aliveLabel' | 'hud.killsLabel' | 'ui.hud.teamsLabel', cls: string): { box: Vis; value: NumSlot } {
  const box = h('div', `dz-counter ${cls}`, parent);
  const value = new NumSlot(h('span', 'dz-counter-value', box), (n) => fmtNumber(n));
  tx(h('span', 'dz-counter-label', box), label);
  return { box: new Vis(box), value };
}

export class MatchInfo implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly alive: { box: Vis; value: NumSlot };
  private readonly teams: { box: Vis; value: NumSlot };
  private readonly kills: { box: Vis; value: NumSlot };
  private readonly zone: Vis;
  private readonly zoneText: TextSlot;
  private readonly zonePhase: TextSlot;
  private readonly zoneFill: BarFill;
  private readonly zoneShrinking: ClassFlag;
  private readonly ping: Vis;
  private readonly pingText: TextSlot;
  private readonly pingBad: ClassFlag;
  private lastStage: ZoneStage | '' = '';
  private lastSecond = -1;
  private lastPhase = -1;
  private lastPing = -1;

  constructor() {
    this.el = h('div', 'dz-matchinfo');
    this.vis = new Vis(this.el);
    const counters = h('div', 'dz-counters', this.el);
    this.alive = counter(counters, 'hud.aliveLabel', 'dz-counter-alive');
    this.teams = counter(counters, 'ui.hud.teamsLabel', 'dz-counter-teams');
    this.kills = counter(counters, 'hud.killsLabel', 'dz-counter-kills');

    const zone = h('div', 'dz-zone', this.el);
    this.zone = new Vis(zone);
    const row = h('div', 'dz-zone-row', zone);
    row.appendChild(svgIcon(ICONS.zone, 'dz-icon dz-zone-icon'));
    this.zoneText = new TextSlot(h('span', 'dz-zone-text', row));
    this.zonePhase = new TextSlot(h('span', 'dz-zone-phase', row));
    const bar = h('div', 'dz-zone-bar', zone);
    this.zoneFill = new BarFill(h('div', 'dz-zone-fill', bar));
    this.zoneShrinking = new ClassFlag(zone, 'dz-zone-shrinking');

    const ping = h('div', 'dz-ping', this.el);
    this.ping = new Vis(ping);
    ping.appendChild(svgIcon(ICONS.wifi, 'dz-icon dz-icon-sm'));
    this.pingText = new TextSlot(h('span', '', ping));
    this.pingBad = new ClassFlag(ping, 'dz-ping-bad');
  }

  update(frame: FrameState, _cam: unknown, _env: HudEnv): void {
    const training = frame.config.mode === 'training';
    this.vis.set(!training);
    if (training) return;
    const self = frame.self;
    this.alive.value.set(frame.alive);
    const teamGame = frame.config.teamSize > 1;
    this.teams.box.set(teamGame);
    if (teamGame) this.teams.value.set(frame.teamsAlive);
    this.kills.box.set(!!self);
    if (self) this.kills.value.set(self.stats.kills);

    // Zone.
    const z = frame.zone;
    const showZone = frame.phase !== 'waiting' && frame.phase !== 'ended';
    this.zone.set(showZone);
    if (showZone) {
      const sec = ceilSeconds(z.timer);
      if (z.stage !== this.lastStage || sec !== this.lastSecond) {
        this.lastStage = z.stage;
        this.lastSecond = sec;
        const time = fmtDuration(sec);
        switch (z.stage) {
          case 'pre': this.zoneText.set(t('hud.zone.pre', { time })); break;
          case 'waiting': this.zoneText.set(t('hud.zone.waiting', { time })); break;
          case 'shrinking': this.zoneText.set(`${t('hud.zone.shrinking')} · ${time}`); break;
          default: this.zoneText.set(t('hud.zone.final'));
        }
      }
      if (z.phase !== this.lastPhase) {
        this.lastPhase = z.phase;
        this.zonePhase.set(z.phase > 0 ? t('hud.zone.phase', { n: z.phase }) : '');
      }
      this.zoneFill.set(z.stage === 'final' ? 1 : z.stageTotal > 0 ? clamp01(1 - z.timer / z.stageTotal) : 0);
      this.zoneShrinking.set(z.stage === 'shrinking');
    }

    // Ping.
    const ping = Math.round(frame.ping);
    this.ping.set(ping > 0);
    if (ping > 0 && ping !== this.lastPing) {
      this.lastPing = ping;
      this.pingText.set(t('hud.ping', { ms: ping }));
      this.pingBad.set(ping > 150);
    }
  }

  relabel(): void {
    this.lastStage = '';
    this.lastSecond = -1;
    this.lastPhase = -1;
    this.lastPing = -1;
    this.alive.value.invalidate();
    this.teams.value.invalidate();
    this.kills.value.invalidate();
  }

  reset(): void {
    this.relabel();
    this.vis.invalidate();
  }
}

/** Centre warning while the view target is outside the current (blue) circle. */
export class ZoneWarning implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly dist: NumSlot;

  constructor() {
    this.el = h('div', 'dz-zone-warning');
    this.el.setAttribute('role', 'alert');
    this.vis = new Vis(this.el);
    tx(h('div', 'dz-zone-warning-text', this.el), 'hud.zone.outside');
    this.dist = new NumSlot(h('div', 'dz-zone-warning-dist', this.el), (n) => t('unit.meters', { n }));
  }

  update(frame: FrameState): void {
    const self = frame.self;
    const pos = viewPos(frame);
    const z = frame.zone;
    let show = false;
    if (self && pos && self.life !== 'dead' && frame.config.mode !== 'training' && frame.phase === 'playing'
      && z.stage !== 'pre' && self.mode !== 'plane' && self.mode !== 'freefall' && self.mode !== 'parachute') {
      const d = distOutsideCircle(pos.x, pos.z, z.cx, z.cz, z.r);
      show = d > 0;
      if (show) this.dist.set(Math.ceil(d));
    }
    this.vis.set(show);
  }

  relabel(): void {
    this.dist.invalidate();
  }

  reset(): void {
    this.vis.invalidate();
  }
}
