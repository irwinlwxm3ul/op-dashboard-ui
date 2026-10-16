// Training ground hit readout next to the crosshair: damage, body part and distance per target hit.
// The newest line sits at the crosshair height; older lines slide up and fade.

import type { HitPart } from '../../../shared/types';
import { fmtNumber, t } from '../../i18n';
import { div, el, setOpacity } from './dom';

const ROWS = 5;
const LIFE = 2.4;
const ROW_HEIGHT = 21;

interface Row {
  root: HTMLDivElement;
  dmg: HTMLElement;
  part: HTMLSpanElement;
  dist: HTMLSpanElement;
  born: number;
  active: boolean;
  lastY: number;
  lastOpacity: number;
}

export class TrainingReadout {
  private readonly rows: Row[] = [];
  /** Rows in display order, newest first. */
  private readonly order: Row[] = [];

  constructor(parent: HTMLElement) {
    for (let i = 0; i < ROWS; i++) {
      const root = div(parent, 'dzf-ro');
      const dmg = el(root, 'b', '');
      const part = el(root, 'span', 'dzf-ro-part');
      const dist = el(root, 'span', 'dzf-ro-dist');
      this.rows.push({ root, dmg, part, dist, born: 0, active: false, lastY: NaN, lastOpacity: -1 });
    }
  }

  push(damage: number, part: HitPart, distance: number, now: number): void {
    // Reuse a free row, else the oldest one.
    const row = this.rows.find((r) => !r.active) ?? this.order[this.order.length - 1];
    const idx = this.order.indexOf(row);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.unshift(row);
    row.active = true;
    row.born = now;
    row.dmg.textContent = t('feel.target.damage', { damage: Math.round(damage) });
    row.part.textContent = t(part === 'head' ? 'training.part.head' : part === 'limb' ? 'training.part.limb' : 'training.part.body');
    row.dist.textContent = t('feel.target.distance', { distance: fmtNumber(Math.round(distance)) });
    row.root.className = `dzf-ro dzf-${part}`;
    row.root.style.display = 'block';
    row.lastOpacity = -1;
  }

  update(now: number): void {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const r = this.order[i];
      const age = now - r.born;
      if (age >= LIFE) {
        r.active = false;
        r.root.style.display = 'none';
        r.lastY = NaN;
        this.order.splice(i, 1);
      }
    }
    for (let i = 0; i < this.order.length; i++) {
      const r = this.order[i];
      const age = now - r.born;
      const y = -i * ROW_HEIGHT;
      if (y !== r.lastY) {
        r.root.style.transform = `translateY(${y}px)`;
        r.lastY = y;
      }
      const u = age / LIFE;
      r.lastOpacity = setOpacity(r.root, u < 0.65 ? 1 : 1 - (u - 0.65) / 0.35, r.lastOpacity);
    }
  }

  clear(): void {
    for (const r of this.order) {
      r.active = false;
      r.root.style.display = 'none';
      r.lastY = NaN;
    }
    this.order.length = 0;
  }
}
