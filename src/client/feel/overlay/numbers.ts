// Floating damage numbers anchored to the world hit position (projected every frame with the
// camera), rising and fading. Pellets / rapid hits on the same victim within a short window merge
// into one growing number so shotguns read as a single punchy value.

import type { HitPart, Vec3 } from '../../../shared/types';
import { fmtNumber } from '../../i18n';
import { projectToScreen, type ProjectionCamera, type ScreenPoint } from '../math';
import { div, PopToggle } from './dom';

const POOL_SIZE = 20;
/** Seconds a number stays on screen. */
const LIFE = 0.95;
/** Hits on the same victim within this window add up (s). */
const MERGE_WINDOW = 0.09;
/** Rise speed (px/s) with ease-out. */
const RISE_PX = 46;

export type NumberStyle = 'body' | 'head' | 'limb' | 'armor';

interface FloatingNumber {
  root: HTMLDivElement;
  text: HTMLSpanElement;
  pop: PopToggle;
  active: boolean;
  shown: boolean;
  born: number;
  victim: number;
  value: number;
  style: NumberStyle;
  lethal: boolean;
  wx: number;
  wy: number;
  wz: number;
  /** Horizontal spread so stacked numbers do not overlap (px). */
  offsetX: number;
  lastOpacity: number;
}

const STYLE_RANK: Record<NumberStyle, number> = { limb: 0, body: 1, armor: 2, head: 3 };

export class DamageNumbers {
  private readonly pool: FloatingNumber[] = [];
  private readonly scratch: ScreenPoint = { x: 0, y: 0, depth: 0, visible: false };
  private readonly world: Vec3 = { x: 0, y: 0, z: 0 };
  private spawnCount = 0;

  constructor(parent: HTMLElement) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const root = div(parent, 'dzf-num');
      const text = parent.ownerDocument.createElement('span');
      root.appendChild(text);
      this.pool.push({
        root, text, pop: new PopToggle(), active: false, shown: false, born: 0, victim: -1, value: 0,
        style: 'body', lethal: false, wx: 0, wy: 0, wz: 0, offsetX: 0, lastOpacity: -1,
      });
    }
  }

  static styleFor(part: HitPart, armor: boolean): NumberStyle {
    if (part === 'head') return 'head';
    if (armor) return 'armor';
    return part === 'limb' ? 'limb' : 'body';
  }

  spawn(victim: number, pos: Vec3, damage: number, style: NumberStyle, lethal: boolean, now: number): void {
    if (!(damage > 0)) return;
    // Merge into a fresh number on the same victim (shotgun pellets, very fast follow-up hits).
    for (let i = 0; i < this.pool.length; i++) {
      const n = this.pool[i];
      if (!n.active || n.victim !== victim || now - n.born > MERGE_WINDOW) continue;
      n.value += damage;
      if (STYLE_RANK[style] > STYLE_RANK[n.style]) n.style = style;
      n.lethal = n.lethal || lethal;
      this.render(n);
      return;
    }
    let slot: FloatingNumber | null = null;
    for (let i = 0; i < this.pool.length; i++) {
      const n = this.pool[i];
      if (!n.active) {
        slot = n;
        break;
      }
      if (!slot || n.born < slot.born) slot = n;
    }
    if (!slot) return;
    slot.active = true;
    slot.born = now;
    slot.victim = victim;
    slot.value = damage;
    slot.style = style;
    slot.lethal = lethal;
    slot.wx = pos.x;
    slot.wy = pos.y;
    slot.wz = pos.z;
    // Alternate small horizontal offsets so consecutive numbers fan out.
    const k = this.spawnCount++ % 5;
    slot.offsetX = (k - 2) * 12 + (Math.random() - 0.5) * 8;
    slot.lastOpacity = -1;
    this.render(slot);
  }

  private render(n: FloatingNumber): void {
    n.text.textContent = fmtNumber(Math.round(n.value));
    n.root.className = `dzf-num dzf-${n.style}${n.lethal ? ' dzf-lethal' : ''} ${n.pop.next()}`;
  }

  update(cam: ProjectionCamera | null, width: number, height: number, now: number): void {
    for (let i = 0; i < this.pool.length; i++) {
      const n = this.pool[i];
      if (!n.active) continue;
      const age = now - n.born;
      if (age >= LIFE || !cam) {
        this.hide(n);
        if (age >= LIFE) n.active = false;
        continue;
      }
      this.world.x = n.wx;
      this.world.y = n.wy;
      this.world.z = n.wz;
      const p = projectToScreen(cam, this.world, width, height, this.scratch);
      if (!p.visible) {
        this.hide(n);
        continue;
      }
      const u = age / LIFE;
      // Start above the hitmarker X (which sits on the crosshair) and drift up with an ease-out.
      const rise = RISE_PX * (1 - (1 - u) * (1 - u)) + 30;
      const x = Math.round(p.x + n.offsetX);
      const y = Math.round(p.y - rise);
      n.root.style.transform = `translate3d(${x}px,${y}px,0)`;
      const opacity = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
      const o = Math.round(opacity * 50) / 50;
      if (o !== n.lastOpacity) {
        n.root.style.opacity = String(o);
        n.lastOpacity = o;
      }
      if (!n.shown) {
        n.root.style.display = 'block';
        n.shown = true;
      }
    }
  }

  private hide(n: FloatingNumber): void {
    if (!n.shown) return;
    n.root.style.display = 'none';
    n.shown = false;
  }

  clear(): void {
    for (const n of this.pool) {
      n.active = false;
      this.hide(n);
    }
  }
}
