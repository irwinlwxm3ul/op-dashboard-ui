// Bottom-centre vitals: health bar (white → red, damage "ghost" trail, heal preview), boost
// segments, downed bleed-out bar, armour durability rings and backpack level.

import { t } from '../../i18n';
import { DOWNED_HEALTH, MAX_HEALTH } from '../../../shared/constants';
import { CONSUMABLES, GEAR } from '../../../shared/items';
import type { ConsumableId, GearId } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import { BarFill, ClassFlag, h, StyleSlot, svgIcon, TextSlot, tx, Vis } from '../dom';
import { approach, boostSegmentFill, BOOST_SEGMENTS, healthRgb } from '../format';
import { ICONS } from '../icons';
import type { HudEnv, Widget } from './shared';

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;
const GHOST_HOLD = 0.45;
const HELMETS: readonly GearId[] = ['helmet1', 'helmet2', 'helmet3'];
const VESTS: readonly GearId[] = ['vest1', 'vest2', 'vest3'];

class GearSlot {
  readonly el: HTMLDivElement;
  private readonly ring: SVGCircleElement | null;
  private readonly level: TextSlot;
  private readonly vis: Vis;
  private lastLevel = -1;
  private lastFrac = -1;

  constructor(parent: HTMLElement, icon: string, kind: 'helmet' | 'vest' | 'pack', labelKey: 'inv.slot.helmet' | 'inv.slot.vest' | 'inv.slot.pack') {
    this.el = h('div', `dz-gear dz-gear-${kind}`, parent);
    this.el.title = t(labelKey);
    this.el.dataset.i18nTitle = labelKey;
    if (kind !== 'pack') {
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('viewBox', '0 0 36 36');
      svg.setAttribute('class', 'dz-gear-ring');
      const bg = document.createElementNS(svgNs, 'circle');
      bg.setAttribute('cx', '18');
      bg.setAttribute('cy', '18');
      bg.setAttribute('r', String(RING_R));
      bg.setAttribute('class', 'dz-gear-ring-bg');
      const fg = document.createElementNS(svgNs, 'circle');
      fg.setAttribute('cx', '18');
      fg.setAttribute('cy', '18');
      fg.setAttribute('r', String(RING_R));
      fg.setAttribute('class', 'dz-gear-ring-fg');
      fg.setAttribute('stroke-dasharray', RING_C.toFixed(2));
      svg.append(bg, fg);
      this.el.appendChild(svg);
      this.ring = fg;
    } else {
      this.ring = null;
    }
    this.el.appendChild(svgIcon(icon, 'dz-gear-icon'));
    this.level = new TextSlot(h('span', 'dz-gear-level', this.el));
    this.vis = new Vis(this.el);
  }

  set(level: number, frac: number): void {
    this.vis.set(level > 0);
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      this.el.dataset.level = String(level);
      this.level.set(level > 0 ? t('inv.level', { n: level }) : '');
    }
    if (this.ring && Math.abs(frac - this.lastFrac) > 0.005) {
      this.lastFrac = frac;
      this.ring.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
      this.el.classList.toggle('dz-gear-low', frac < 0.25);
    }
  }

  invalidate(): void {
    this.lastLevel = -1;
    this.lastFrac = -1;
    this.vis.invalidate();
  }
}

export class Vitals implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly helmet: GearSlot;
  private readonly vest: GearSlot;
  private readonly pack: GearSlot;
  private readonly boostWrap: Vis;
  private readonly boostSegs: BarFill[] = [];
  private readonly healthWrap: Vis;
  private readonly fill: BarFill;
  private readonly ghost: BarFill;
  private readonly heal: BarFill;
  private readonly healVis: Vis;
  private readonly color: StyleSlot;
  private readonly low: ClassFlag;
  private readonly critical: ClassFlag;
  private readonly hpText: TextSlot;
  private readonly downed: Vis;
  private readonly downedFill: BarFill;
  private readonly downedLabel: TextSlot;
  private ghostHp = MAX_HEALTH;
  private ghostHold = 0;
  private lastHp = MAX_HEALTH;
  private lastRgbHp = -1;
  private lastDownedKey = '';

  constructor() {
    this.el = h('div', 'dz-vitals');
    this.vis = new Vis(this.el);
    const gear = h('div', 'dz-vitals-gear', this.el);
    this.helmet = new GearSlot(gear, ICONS.helmet, 'helmet', 'inv.slot.helmet');
    this.vest = new GearSlot(gear, ICONS.vest, 'vest', 'inv.slot.vest');
    this.pack = new GearSlot(gear, ICONS.pack, 'pack', 'inv.slot.pack');

    const bars = h('div', 'dz-vitals-bars', this.el);
    const boost = h('div', 'dz-boost', bars);
    boost.title = t('hud.boost');
    boost.dataset.i18nTitle = 'hud.boost';
    this.boostWrap = new Vis(boost);
    for (const size of BOOST_SEGMENTS) {
      const seg = h('div', 'dz-boost-seg', boost);
      seg.style.flexGrow = String(size);
      this.boostSegs.push(new BarFill(h('div', 'dz-boost-fill', seg)));
    }

    const health = h('div', 'dz-health', bars);
    health.setAttribute('role', 'meter');
    health.dataset.i18nAria = 'hud.health';
    health.setAttribute('aria-label', t('hud.health'));
    health.setAttribute('aria-valuemin', '0');
    health.setAttribute('aria-valuemax', String(MAX_HEALTH));
    this.healthWrap = new Vis(health);
    this.ghost = new BarFill(h('div', 'dz-health-ghost', health));
    const healEl = h('div', 'dz-health-heal', health);
    this.heal = new BarFill(healEl);
    this.healVis = new Vis(healEl);
    const fillEl = h('div', 'dz-health-fill', health);
    this.fill = new BarFill(fillEl, 0.001);
    this.color = new StyleSlot(health, '--hp-rgb');
    this.low = new ClassFlag(health, 'dz-health-low');
    this.critical = new ClassFlag(health, 'dz-health-critical');
    this.hpText = new TextSlot(h('span', 'dz-health-text', health));

    const down = h('div', 'dz-downed', bars);
    this.downed = new Vis(down);
    this.downedLabel = new TextSlot(h('div', 'dz-downed-label', down));
    const dbar = h('div', 'dz-downed-bar', down);
    this.downedFill = new BarFill(h('div', 'dz-downed-fill', dbar));
    tx(h('div', 'dz-downed-hint', down), 'hud.downedHint');
  }

  update(frame: FrameState): void {
    const self = frame.self;
    if (!self || self.life === 'dead' || self.mode === 'plane') {
      this.vis.set(false);
      return;
    }
    this.vis.set(true);
    const a = self.armor;
    this.helmet.set(a.helmet, a.helmet ? a.helmetHp / GEAR[HELMETS[a.helmet - 1]].durability : 0);
    this.vest.set(a.vest, a.vest ? a.vestHp / GEAR[VESTS[a.vest - 1]].durability : 0);
    this.pack.set(a.pack, 1);

    const isDowned = self.life === 'downed';
    this.downed.set(isDowned);
    this.healthWrap.set(!isDowned);
    if (isDowned) {
      this.downedFill.set(self.downedHp / DOWNED_HEALTH);
      const reviver = self.revivedBy !== null ? frame.roster.get(self.revivedBy)?.name ?? '' : '';
      const key = reviver ? `r:${reviver}` : 'd';
      if (key !== this.lastDownedKey) {
        this.lastDownedKey = key;
        this.downedLabel.set(reviver ? t('hud.beingRevived', { name: reviver }) : t('hud.downed'));
        this.downedLabel.el.classList.toggle('dz-downed-reviving', !!reviver);
      }
    }

    const hp = Math.max(0, Math.min(MAX_HEALTH, self.health));
    const dt = frame.dt;
    // Damage ghost: hold briefly at the old value, then drain toward the new one.
    if (hp < this.lastHp - 0.01) this.ghostHold = GHOST_HOLD;
    if (hp >= this.ghostHp) {
      this.ghostHp = hp;
    } else if (this.ghostHold > 0) {
      this.ghostHold -= dt;
    } else {
      this.ghostHp = Math.max(hp, this.ghostHp - (this.ghostHp - hp) * approach(5, dt) - 12 * dt);
    }
    this.lastHp = hp;
    this.fill.set(hp / MAX_HEALTH);
    this.ghost.set(this.ghostHp / MAX_HEALTH);
    const rounded = Math.ceil(hp);
    this.hpText.set(String(rounded));
    if (rounded !== this.lastRgbHp) {
      this.lastRgbHp = rounded;
      this.color.set(healthRgb(rounded));
      this.healthWrap.el.setAttribute('aria-valuenow', String(rounded));
    }
    this.low.set(hp < 50);
    this.critical.set(hp < 25);

    // Heal preview while a healing item is being used.
    const use = self.use;
    let preview = 0;
    if (use && use.item !== 'fuel' && use.item !== 'energy') {
      const def = CONSUMABLES[use.item as ConsumableId];
      if (def && def.heal > 0) preview = Math.max(hp, Math.min(def.healCap, hp + def.heal));
    }
    this.healVis.set(preview > hp + 0.5);
    if (preview > 0) this.heal.set(preview / MAX_HEALTH);

    const boost = self.boost;
    this.boostWrap.set(boost > 0.01);
    for (let i = 0; i < this.boostSegs.length; i++) this.boostSegs[i].set(boostSegmentFill(boost, i));
  }

  relabel(): void {
    this.helmet.invalidate();
    this.vest.invalidate();
    this.pack.invalidate();
    this.lastDownedKey = '';
  }

  reset(): void {
    this.ghostHp = MAX_HEALTH;
    this.lastHp = MAX_HEALTH;
    this.ghostHold = 0;
    this.lastRgbHp = -1;
    this.relabel();
    this.vis.invalidate();
  }
}
