// Damage taken: red arcs around the screen center pointing toward the damage source (they keep
// pointing at the world position as you turn), a screen-edge red flash scaled by damage, and the
// armor-break shatter icon.

import { wrapAngle, yawTo } from '../../../shared/math';
import type { EntityId, Vec3 } from '../../../shared/types';
import { t } from '../../i18n';
import { div, el, PopToggle, setOpacity } from './dom';
import { shatterIcon } from './icons';

const ARC_COUNT = 6;
/** Seconds a direction arc stays visible. */
const ARC_LIFE = 1.5;
/** Flash decay per second. */
const FLASH_DECAY = 2.4;

interface Arc {
  el: HTMLDivElement;
  active: boolean;
  shown: boolean;
  attacker: EntityId;
  born: number;
  strength: number;
  x: number;
  z: number;
  lastOpacity: number;
  lastAngle: number;
}

export class DamageIndicators {
  private readonly arcs: Arc[] = [];
  private readonly flashEl: HTMLDivElement;
  private flash = 0;
  private flashOpacity = 0;
  private readonly armorEl: HTMLDivElement;
  private readonly armorText: HTMLSpanElement;
  private readonly armorPop = new PopToggle();
  private armorUntil = 0;

  constructor(parent: HTMLElement) {
    this.flashEl = div(parent, 'dzf-full dzf-flash');
    for (let i = 0; i < ARC_COUNT; i++) {
      this.arcs.push({
        el: div(parent, 'dzf-dir'), active: false, shown: false, attacker: -1, born: 0, strength: 0,
        x: 0, z: 0, lastOpacity: -1, lastAngle: NaN,
      });
    }
    this.armorEl = div(parent, 'dzf-ab');
    this.armorEl.appendChild(shatterIcon(parent.ownerDocument));
    this.armorText = el(this.armorEl, 'span', '');
  }

  /** Local player took `damage`. `from` is the source position (null: no meaningful direction). */
  hit(attacker: EntityId, from: Vec3 | null, damage: number, now: number): void {
    const strength = Math.min(1, 0.45 + damage / 45);
    this.flash = Math.min(1, Math.max(this.flash, 0.3 + damage / 55));
    if (!from) return;
    let slot: Arc | null = null;
    for (const a of this.arcs) {
      if (a.active && a.attacker === attacker && attacker >= 0) {
        slot = a;
        break;
      }
    }
    if (!slot) {
      for (const a of this.arcs) {
        if (!a.active) {
          slot = a;
          break;
        }
        if (!slot || a.born < slot.born) slot = a;
      }
    }
    if (!slot) return;
    slot.strength = slot.active && now - slot.born < ARC_LIFE ? Math.min(1, Math.max(slot.strength, strength) + 0.1) : strength;
    slot.active = true;
    slot.attacker = attacker;
    slot.born = now;
    slot.x = from.x;
    slot.z = from.z;
  }

  /** Small flash without a direction (zone, bleeding, fall). */
  flashOnly(amount: number): void {
    this.flash = Math.min(1, Math.max(this.flash, amount));
  }

  armorBroken(helmet: boolean, now: number): void {
    this.armorText.textContent = t(helmet ? 'banner.helmetBroken' : 'banner.armorBroken');
    this.armorEl.className = `dzf-ab ${this.armorPop.next()}`;
    this.armorUntil = now + 1.45;
  }

  /** `origin`/`viewYaw`: the local player's position and the camera yaw the arcs are relative to. */
  update(origin: Vec3 | null, viewYaw: number, now: number, dt: number): void {
    this.flash = Math.max(0, this.flash - FLASH_DECAY * dt);
    this.flashOpacity = setOpacity(this.flashEl, this.flash * 0.9, this.flashOpacity);

    for (const a of this.arcs) {
      if (!a.active) continue;
      const age = now - a.born;
      if (age >= ARC_LIFE || !origin) {
        if (age >= ARC_LIFE) a.active = false;
        this.hideArc(a);
        continue;
      }
      if (!a.shown) {
        a.el.style.display = 'block';
        a.shown = true;
      }
      // Positive relative yaw = source to the left; CSS rotation is clockwise-positive.
      const rel = wrapAngle(yawTo(origin, a) - viewYaw);
      const angle = Math.round(-rel * 1000) / 1000;
      if (angle !== a.lastAngle) {
        a.el.style.transform = `rotate(${angle}rad)`;
        a.lastAngle = angle;
      }
      const fade = 1 - age / ARC_LIFE;
      // Brief bright pop on (re)hit, then a smooth fade.
      const pop = age < 0.12 ? 1 + (0.12 - age) * 2.5 : 1;
      a.lastOpacity = setOpacity(a.el, Math.min(1, a.strength * Math.sqrt(fade) * pop), a.lastOpacity);
    }

    if (this.armorUntil > 0 && now >= this.armorUntil) {
      this.armorUntil = 0;
      this.armorEl.className = 'dzf-ab';
    }
  }

  private hideArc(a: Arc): void {
    if (!a.shown) return;
    a.el.style.display = 'none';
    a.shown = false;
    a.lastOpacity = -1;
    a.lastAngle = NaN;
  }

  clear(): void {
    this.flash = 0;
    for (const a of this.arcs) {
      a.active = false;
      this.hideArc(a);
    }
  }
}
