// Interaction prompt ("[F] Pick up AR-5 Rifle", "Hold [F] to revive Alex" with hold progress) and the
// centre progress bar for healing / reviving / being revived.

import { fmtNumber, itemName, t, vehicleName } from '../../i18n';
import { REVIVE_TIME } from '../../../shared/constants';
import type { ConsumableId, EntityId, ItemId, VehicleType } from '../../../shared/types';
import type { FrameState, Interaction, InteractionKind } from '../../game/types';
import { BarFill, h, isolate, StyleSlot, TextSlot, tx, Vis } from '../dom';
import { keyCapLabel } from '../keys';
import type { HudEnv, Widget } from './shared';

const MARK = '\u0001';
const CONSUMABLE_ORDER: readonly ConsumableId[] = ['bandage', 'firstaid', 'medkit', 'energy', 'fuel'];

export class Prompt implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly line: HTMLDivElement;
  private readonly holdProgress: StyleSlot;
  // Last rendered signature.
  private kind: InteractionKind | null = null;
  private targetId: EntityId | undefined;
  private item: ItemId | undefined;
  private count: number | undefined;
  private vehicleType: VehicleType | undefined;
  private seat: number | undefined;
  private name: string | undefined;
  private keyCode = '';
  private lastHold = -1;

  constructor() {
    this.el = h('div', 'dz-prompt');
    this.vis = new Vis(this.el);
    this.line = h('div', 'dz-prompt-line', this.el);
    this.holdProgress = new StyleSlot(this.el, '--p');
  }

  update(frame: FrameState, _cam: unknown, env: HudEnv): void {
    const self = frame.self;
    const it = self && self.life !== 'dead' ? frame.interaction : null;
    this.vis.set(!!it);
    if (!it || !self) {
      this.kind = null;
      return;
    }
    const keyCode = env.keys.interact;
    if (!this.same(it, keyCode)) this.render(it, keyCode);
    const p = it.kind === 'revive' && self.reviveProgress >= 0 ? self.reviveProgress : 0;
    const q = Math.round(p * 200) / 200;
    if (q !== this.lastHold) {
      this.lastHold = q;
      this.holdProgress.set(String(q));
      this.el.classList.toggle('dz-prompt-holding', q > 0);
    }
  }

  private same(it: Interaction, keyCode: string): boolean {
    return it.kind === this.kind && it.targetId === this.targetId && it.item === this.item && it.count === this.count
      && it.vehicleType === this.vehicleType && it.seat === this.seat && it.name === this.name && keyCode === this.keyCode;
  }

  private render(it: Interaction, keyCode: string): void {
    this.kind = it.kind;
    this.targetId = it.targetId;
    this.item = it.item;
    this.count = it.count;
    this.vehicleType = it.vehicleType;
    this.seat = it.seat;
    this.name = it.name;
    this.keyCode = keyCode;
    this.line.textContent = '';
    this.el.classList.toggle('dz-prompt-hold', it.hold);

    const item = it.item ? itemName(it.item) : '';
    const vehicle = it.vehicleType ? vehicleName(it.vehicleType) : '';
    let text: string;
    switch (it.kind) {
      case 'jump': text = t('prompt.jump'); break;
      case 'chute': text = t('prompt.openChute'); break;
      case 'pickup': text = (it.count ?? 1) > 1 ? t('prompt.pickupCount', { item, count: it.count ?? 1 }) : t('prompt.pickup', { item }); break;
      case 'enter': text = it.seat === 0 ? t('prompt.drive', { vehicle }) : t('prompt.enter', { vehicle }); break;
      case 'exit': text = t('prompt.exitVehicle'); break;
      case 'refuel': text = t('prompt.refuel'); break;
      case 'give': text = t('prompt.takeFromRack', { item }); break;
      case 'revive': text = t('prompt.revive', { key: MARK, name: isolate(it.name ?? '') }); break;
      default: text = '';
    }
    if (it.kind === 'revive') {
      this.appendTemplate(text, keyCode);
    } else if (it.hold) {
      this.appendTemplate(t('prompt.hold', { key: MARK }), keyCode);
      h('span', 'dz-prompt-text', this.line).textContent = text;
    } else {
      this.keyCap(keyCode);
      h('span', 'dz-prompt-text', this.line).textContent = text;
    }
  }

  /** Text with the key placeholder replaced by a key cap element. */
  private appendTemplate(text: string, keyCode: string): void {
    const parts = text.split(MARK);
    parts.forEach((part, i) => {
      if (i > 0) this.keyCap(keyCode);
      if (part.trim()) h('span', 'dz-prompt-text', this.line).textContent = part.trim();
    });
  }

  private keyCap(keyCode: string): void {
    const cap = h('span', 'dz-key dz-key-prompt', this.line);
    h('span', 'dz-key-ring', cap);
    h('span', 'dz-key-label', cap).textContent = keyCapLabel(keyCode);
  }

  relabel(): void {
    this.kind = null;
  }

  reset(): void {
    this.kind = null;
    this.lastHold = -1;
    this.vis.invalidate();
  }
}

/** Centre progress for using an item, reviving someone, or being revived. */
export class ActionProgress implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly label: TextSlot;
  private readonly time: TextSlot;
  private readonly fill: BarFill;
  private readonly hint: Vis;
  private sig = 0;
  private lastTenth = -1;
  private revivedSince = 0;
  private revivedBy: EntityId | null = null;

  constructor() {
    this.el = h('div', 'dz-action');
    this.vis = new Vis(this.el);
    const top = h('div', 'dz-action-top', this.el);
    this.label = new TextSlot(h('span', 'dz-action-label', top));
    this.time = new TextSlot(h('span', 'dz-action-time', top));
    const bar = h('div', 'dz-action-bar', this.el);
    this.fill = new BarFill(h('div', 'dz-action-fill', bar));
    const hint = tx(h('div', 'dz-action-hint', this.el), 'hud.cancelHint');
    this.hint = new Vis(hint);
  }

  update(frame: FrameState): void {
    const self = frame.self;
    if (!self || self.life === 'dead') {
      this.vis.set(false);
      this.revivedBy = null;
      this.sig = 0;
      return;
    }
    // Signature: kind * 2^24 + subject (item index / player id); 0 = nothing to show.
    let sig = 0;
    let progress = 0;
    let remaining = 0;
    if (self.use && self.useProgress >= 0) {
      sig = 1 * 16777216 + CONSUMABLE_ORDER.indexOf(self.use.item);
      progress = self.useProgress;
      remaining = Math.max(0, self.use.total - self.use.elapsed);
    } else if (self.revive && self.reviveProgress >= 0) {
      sig = 2 * 16777216 + self.revive.target;
      progress = self.reviveProgress;
      remaining = REVIVE_TIME * (1 - progress);
    } else if (self.revivedBy !== null && self.life === 'downed') {
      const by = self.revivedBy;
      if (this.revivedBy !== by) {
        this.revivedBy = by;
        this.revivedSince = performance.now();
      }
      sig = 3 * 16777216 + by;
      const el = (performance.now() - this.revivedSince) / 1000;
      progress = Math.min(1, el / REVIVE_TIME);
      remaining = Math.max(0, REVIVE_TIME - el);
    }
    if (self.revivedBy === null) this.revivedBy = null;
    this.vis.set(sig !== 0);
    if (sig === 0) {
      this.sig = 0;
      return;
    }
    if (sig !== this.sig) {
      this.sig = sig;
      const kind = Math.floor(sig / 16777216);
      if (kind === 1 && self.use) this.label.set(t('hud.using', { item: itemName(self.use.item) }));
      else if (kind === 2 && self.revive) this.label.set(t('hud.reviving', { name: isolate(frame.roster.get(self.revive.target)?.name ?? '') }));
      else if (kind === 3 && self.revivedBy !== null) this.label.set(t('hud.beingRevived', { name: isolate(frame.roster.get(self.revivedBy)?.name ?? '') }));
      this.hint.set(kind === 1);
      this.lastTenth = -1;
    }
    this.fill.set(progress);
    const tenth = Math.ceil(remaining * 10);
    if (tenth !== this.lastTenth) {
      this.lastTenth = tenth;
      this.time.set(t('unit.seconds', { n: fmtNumber(tenth / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
    }
  }

  relabel(): void {
    this.sig = -1;
  }

  reset(): void {
    this.sig = 0;
    this.revivedBy = null;
    this.vis.invalidate();
  }
}
