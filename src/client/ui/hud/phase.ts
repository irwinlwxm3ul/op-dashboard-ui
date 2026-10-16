// Phase-specific HUD panels: plane (auto-jump timer), freefall / parachute altimeter, vehicle HUD
// (speed, fuel, health, seats), spectating / eliminated banner and the pre-match waiting banner.

import { fmtDuration, t } from '../../i18n';
import { AUTO_CHUTE_HEIGHT, PLANE_ALTITUDE } from '../../../shared/constants';
import { VEHICLES } from '../../../shared/vehicles';
import type { EntityId, VehicleType } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import { BarFill, ClassFlag, h, isolate, NumSlot, StyleSlot, svgIcon, TextSlot, tx, Vis } from '../dom';
import { ceilSeconds, clamp01, kmh } from '../format';
import { ICONS, vehicleIcon } from '../icons';
import { keyCapLabel, keyLabel } from '../keys';
import type { HudEnv, Widget } from './shared';

/** Plane phase: headline + automatic jump countdown. */
export class PlanePanel implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly timer: TextSlot;
  private lastSec = -1;

  constructor() {
    this.el = h('div', 'dz-banner dz-plane-panel');
    this.vis = new Vis(this.el);
    this.el.appendChild(svgIcon(ICONS.plane, 'dz-icon dz-banner-icon'));
    const text = h('div', 'dz-banner-text', this.el);
    tx(h('div', 'dz-banner-title', text), 'banner.dropZone');
    this.timer = new TextSlot(h('div', 'dz-banner-sub', text));
  }

  update(frame: FrameState): void {
    const self = frame.self;
    const show = !!self && self.mode === 'plane' && self.life !== 'dead';
    this.vis.set(show);
    if (!show) return;
    const plane = frame.plane;
    const pos = frame.planePos;
    let remaining = -1;
    if (plane && pos && plane.speed > 0) remaining = Math.hypot(plane.end.x - pos.x, plane.end.z - pos.z) / plane.speed;
    const sec = remaining < 0 ? -1 : ceilSeconds(remaining);
    if (sec !== this.lastSec) {
      this.lastSec = sec;
      this.timer.set(sec < 0 ? '' : t('hud.plane.autoJump', { time: fmtDuration(sec) }));
    }
  }

  relabel(): void {
    this.lastSec = -2;
  }

  reset(): void {
    this.lastSec = -2;
    this.vis.invalidate();
  }
}

/** Freefall / parachute altimeter with speed and the automatic chute line. */
export class DropMeter implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly alt: NumSlot;
  private readonly speed: NumSlot;
  private readonly marker: StyleSlot;
  private readonly fill: BarFill;
  private readonly hintAuto: Vis;
  private readonly controls: TextSlot;
  private readonly chute: ClassFlag;
  private controlsDirty = true;
  private lastF = -1;

  constructor() {
    this.el = h('div', 'dz-drop');
    this.vis = new Vis(this.el);
    this.chute = new ClassFlag(this.el, 'dz-drop-chute');
    const gauge = h('div', 'dz-drop-gauge', this.el);
    const bar = h('div', 'dz-drop-bar', gauge);
    this.fill = new BarFill(h('div', 'dz-drop-fill', bar), 0.002, 'y');
    const line = h('div', 'dz-drop-line', bar);
    line.style.bottom = `${(AUTO_CHUTE_HEIGHT / PLANE_ALTITUDE) * 100}%`;
    const me = h('div', 'dz-drop-me', bar);
    this.marker = new StyleSlot(me, 'bottom');
    const read = h('div', 'dz-drop-read', this.el);
    const a = h('div', 'dz-drop-stat', read);
    tx(h('span', 'dz-drop-label', a), 'hud.altitude');
    this.alt = new NumSlot(h('span', 'dz-drop-value', a), (n) => t('unit.meters', { n }));
    const s = h('div', 'dz-drop-stat', read);
    tx(h('span', 'dz-drop-label', s), 'hud.speed');
    this.speed = new NumSlot(h('span', 'dz-drop-value', s), (n) => t('unit.kmh', { n }));
    const auto = h('div', 'dz-drop-hint', read);
    auto.textContent = t('hud.freefall.autoOpen', { n: AUTO_CHUTE_HEIGHT });
    this.hintAuto = new Vis(auto);
    this.controls = new TextSlot(h('div', 'dz-drop-hint', read));
  }

  update(frame: FrameState, _cam: unknown, env: HudEnv): void {
    const self = frame.self;
    const show = !!self && (self.mode === 'freefall' || self.mode === 'parachute') && self.life !== 'dead';
    this.vis.set(show);
    if (!show || !self) return;
    const alt = Math.max(0, Math.round(self.altitude));
    this.alt.set(alt);
    this.speed.set(kmh(Math.hypot(self.vel.x, self.vel.y, self.vel.z)));
    const f = clamp01(self.altitude / PLANE_ALTITUDE);
    this.fill.set(f);
    if (Math.abs(f - this.lastF) > 0.002) {
      this.lastF = f;
      this.marker.set(`${(f * 100).toFixed(1)}%`);
    }
    const chute = self.mode === 'parachute';
    this.chute.set(chute);
    this.hintAuto.set(!chute);
    if (this.controlsDirty) {
      this.controlsDirty = false;
      this.controls.set(t('hud.freefall.controls', { forward: keyCapLabel(env.keys.forward), back: keyCapLabel(env.keys.back) }));
    }
  }

  relabel(): void {
    this.controlsDirty = true;
    this.lastF = -1;
    this.alt.invalidate();
    this.speed.invalidate();
    this.hintAuto.el.textContent = t('hud.freefall.autoOpen', { n: AUTO_CHUTE_HEIGHT });
  }

  reset(): void {
    this.relabel();
    this.vis.invalidate();
  }
}

/** Vehicle HUD: speed, fuel, health, seats (with seat keys) and warnings. */
export class VehiclePanel implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly icon: HTMLElement;
  private readonly speed: NumSlot;
  private readonly fuel: BarFill;
  private readonly hp: BarFill;
  private readonly fuelLow: ClassFlag;
  private readonly hpLow: ClassFlag;
  private readonly role: TextSlot;
  private readonly warn: TextSlot;
  private readonly seats: HTMLDivElement;
  private seatEls: HTMLElement[] = [];
  private type: VehicleType | null = null;
  private seatSig = -1;
  private warnState = '';

  constructor() {
    this.el = h('div', 'dz-vehicle');
    this.vis = new Vis(this.el);
    const head = h('div', 'dz-vehicle-head', this.el);
    this.icon = h('span', 'dz-vehicle-icon', head);
    const sp = h('div', 'dz-vehicle-speed', head);
    this.speed = new NumSlot(h('span', 'dz-vehicle-speed-value', sp), (n) => t('unit.kmh', { n }));
    this.role = new TextSlot(h('span', 'dz-vehicle-role', head));
    const bars = h('div', 'dz-vehicle-bars', this.el);
    const fuelRow = h('div', 'dz-vehicle-row', bars);
    fuelRow.appendChild(svgIcon(ICONS.fuel, 'dz-icon dz-icon-sm'));
    fuelRow.title = t('hud.fuel');
    fuelRow.dataset.i18nTitle = 'hud.fuel';
    const fuelBar = h('div', 'dz-vehicle-bar dz-vehicle-fuel', fuelRow);
    this.fuel = new BarFill(h('div', 'dz-vehicle-fill', fuelBar));
    this.fuelLow = new ClassFlag(fuelBar, 'dz-low');
    const hpRow = h('div', 'dz-vehicle-row', bars);
    hpRow.appendChild(svgIcon(ICONS.car, 'dz-icon dz-icon-sm'));
    hpRow.title = t('hud.vehicleHealth');
    hpRow.dataset.i18nTitle = 'hud.vehicleHealth';
    const hpBar = h('div', 'dz-vehicle-bar dz-vehicle-hp', hpRow);
    this.hp = new BarFill(h('div', 'dz-vehicle-fill', hpBar));
    this.hpLow = new ClassFlag(hpBar, 'dz-low');
    this.seats = h('div', 'dz-vehicle-seats', this.el);
    this.warn = new TextSlot(h('div', 'dz-vehicle-warn', this.el));
  }

  update(frame: FrameState, _cam: unknown, env: HudEnv): void {
    const self = frame.self;
    const v = self && self.vehicleId !== null && self.life !== 'dead' ? frame.vehicles.get(self.vehicleId) : undefined;
    this.vis.set(!!v);
    if (!v || !self) return;
    const def = VEHICLES[v.type];
    if (v.type !== this.type) {
      this.type = v.type;
      this.icon.innerHTML = vehicleIcon(v.type);
      this.seatSig = -1;
    }
    this.speed.set(kmh(v.speed));
    const fuel = clamp01(v.fuel / def.fuelMax);
    const hp = clamp01(v.hp / def.health);
    this.fuel.set(fuel);
    this.hp.set(hp);
    this.fuelLow.set(fuel < 0.15);
    this.hpLow.set(hp < 0.25);

    // Seats: rebuild only when occupancy or our own seat change (keys / language via relabel()).
    let sig = self.seat * 1024 + v.seats.length * 64;
    for (let i = 0; i < v.seats.length; i++) if (v.seats[i] !== null) sig += 1 << i;
    if (sig !== this.seatSig) {
      this.seatSig = sig;
      this.renderSeats(v.seats, self.seat, env);
      this.role.set(self.seat === 0 ? t('hud.driver') : t('hud.passenger'));
    }
    const warn = v.burning || v.destroyed ? 'b' : v.fuel <= 0 ? 'f' : '';
    if (warn !== this.warnState) {
      this.warnState = warn;
      this.warn.set(warn === 'b' ? t('hud.vehicleBurning') : warn === 'f' ? t('hud.outOfFuel') : '');
      this.warn.el.classList.toggle('dz-hidden', !warn);
    }
  }

  private renderSeats(seats: (EntityId | null)[], mine: number, env: HudEnv): void {
    this.seats.textContent = '';
    this.seatEls = [];
    const keys = [env.keys.slot1, env.keys.slot2, env.keys.slot3, env.keys.slot4];
    for (let i = 0; i < seats.length; i++) {
      const s = h('div', 'dz-seat', this.seats);
      s.classList.toggle('dz-seat-taken', seats[i] !== null);
      s.classList.toggle('dz-seat-mine', i === mine);
      s.title = i === 0 ? t('hud.driver') : t('hud.seat', { n: i + 1 });
      h('span', 'dz-key dz-key-xs', s).textContent = keyLabel(keys[i] ?? '');
      this.seatEls.push(s);
    }
  }

  relabel(): void {
    this.seatSig = -1;
    this.warnState = '-';
    this.speed.invalidate();
  }

  reset(): void {
    this.type = null;
    this.relabel();
    this.vis.invalidate();
  }
}

/** Spectating / eliminated / waiting banner (top centre). */
export class StatusBanner implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly title: TextSlot;
  private readonly tag: TextSlot;
  private readonly sub: TextSlot;
  /** Rendered state: mode code * 2^20 + target id (+ killer flag); -1 = dirty. */
  private sig = -1;

  constructor() {
    this.el = h('div', 'dz-banner dz-status-banner');
    this.vis = new Vis(this.el);
    const text = h('div', 'dz-banner-text', this.el);
    const top = h('div', 'dz-banner-title', text);
    this.title = new TextSlot(h('span', '', top));
    this.tag = new TextSlot(h('span', 'dz-tag dz-tag-danger', top));
    this.sub = new TextSlot(h('div', 'dz-banner-sub', text));
  }

  update(frame: FrameState, _cam: unknown, env: HudEnv): void {
    const self = frame.self;
    let sig = 0;
    let mode: 'spectate' | 'dead' | 'waiting' | '' = '';
    let target: EntityId | null = null;
    let killer = false;
    if (frame.phase === 'waiting') {
      mode = 'waiting';
      sig = 1;
    } else if (self && self.life === 'dead' && frame.phase !== 'ended') {
      target = frame.viewTargetId !== null && frame.viewTargetId !== self.id ? frame.viewTargetId : self.spectating;
      if (target !== null && target !== self.id) {
        mode = 'spectate';
        killer = target === self.killerId;
        sig = 3 * 1048576 + target * 2 + (killer ? 1 : 0);
      } else {
        mode = 'dead';
        sig = 2;
      }
    }
    this.vis.set(mode !== '');
    if (sig === this.sig) return;
    this.sig = sig;
    const targetName = target !== null ? frame.roster.get(target)?.name ?? frame.players.get(target)?.name ?? '' : '';
    this.el.dataset.mode = mode;
    if (mode === 'waiting') {
      this.title.set(t('lobby.waitingForPlayers'));
      this.tag.set('');
      this.sub.set('');
    } else if (mode === 'spectate') {
      this.title.set(t('hud.spectating', { name: isolate(targetName) }));
      this.tag.set(killer ? t('hud.spectateKiller') : '');
      this.sub.set(`${t('hud.spectateSwitch', { prev: keyLabel('ArrowLeft'), next: keyLabel('ArrowRight') })} · ${t('ui.hud.eliminatedHint', { key: keyCapLabel(env.keys.menu) })}`);
    } else if (mode === 'dead') {
      this.title.set(t('banner.eliminated'));
      this.tag.set('');
      this.sub.set(t('ui.hud.eliminatedHint', { key: keyCapLabel(env.keys.menu) }));
    }
    this.tag.el.classList.toggle('dz-hidden', !killer || mode !== 'spectate');
  }

  relabel(): void {
    this.sig = -1;
  }

  reset(): void {
    this.sig = -1;
    this.vis.invalidate();
  }
}
