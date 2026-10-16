// Text feedback: the center-bottom kill / death banner (skull pop, headshot tag, kill count), the
// top-center match-moment banner (zone warnings, winner celebration, elimination) and a small stack
// of notices (teammate knocked / killed, revives). All text arrives already translated.

import { div, el, PopToggle } from './dom';
import { skullIcon } from './icons';

export type KillBannerKind = 'kill' | 'knock' | 'death' | 'downed';

export class KillBanner {
  private readonly root: HTMLDivElement;
  private readonly main: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private readonly pop = new PopToggle();
  private until = 0;

  constructor(parent: HTMLElement) {
    this.root = div(parent, 'dzf-kb');
    const icon = div(this.root, 'dzf-kb-icon');
    icon.appendChild(skullIcon(parent.ownerDocument));
    this.main = div(this.root, 'dzf-kb-main');
    this.sub = div(this.root, 'dzf-kb-sub');
  }

  /**
   * `tag`: highlighted badge (e.g. "Headshot"); `details`: secondary texts (kill count, distance,
   * weapon) shown after the tag.
   */
  show(kind: KillBannerKind, main: string, tag: string | null, details: readonly string[], now: number): void {
    this.main.textContent = main;
    this.sub.replaceChildren();
    if (tag) el(this.sub, 'span', 'dzf-kb-tag').textContent = tag;
    for (const d of details) if (d) el(this.sub, 'span', '').textContent = d;
    const variant = kind === 'kill' ? '' : kind === 'knock' ? ' dzf-kb-knock' : ' dzf-kb-death';
    this.root.className = `dzf-kb${variant} ${this.pop.next()}`;
    this.until = now + 3.25;
  }

  update(now: number): void {
    if (this.until > 0 && now >= this.until) {
      this.until = 0;
      this.root.className = 'dzf-kb';
    }
  }
}

export type MomentKind = 'zone' | 'win' | 'lose' | 'info';

/** Priority: a winner / elimination banner is never replaced by a routine zone warning. */
const MOMENT_PRIORITY: Record<MomentKind, number> = { info: 0, zone: 1, lose: 2, win: 3 };

export class MomentBanner {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private readonly pop = new PopToggle();
  private until = 0;
  private kind: MomentKind = 'info';

  constructor(parent: HTMLElement) {
    this.root = div(parent, 'dzf-mb');
    this.title = div(this.root, 'dzf-mb-title');
    this.sub = div(this.root, 'dzf-mb-sub');
  }

  show(kind: MomentKind, title: string, sub: string, duration: number, now: number): void {
    if (this.until > now && MOMENT_PRIORITY[this.kind] > MOMENT_PRIORITY[kind]) return;
    this.title.textContent = title;
    this.sub.textContent = sub;
    this.root.style.setProperty('--d', `${duration}s`);
    this.root.className = `dzf-mb dzf-mb-${kind} ${this.pop.next()}`;
    this.kind = kind;
    this.until = now + duration + 0.05;
  }

  update(now: number): void {
    if (this.until > 0 && now >= this.until) {
      this.until = 0;
      this.root.className = 'dzf-mb';
    }
  }
}

export type NoticeTone = 'info' | 'bad' | 'good';

const NOTICE_COUNT = 4;
const NOTICE_LIFE = 3.65;

interface Notice {
  el: HTMLDivElement;
  pop: PopToggle;
  until: number;
}

export class Notices {
  private readonly root: HTMLDivElement;
  private readonly items: Notice[] = [];

  constructor(parent: HTMLElement) {
    this.root = div(parent, 'dzf-notes');
    for (let i = 0; i < NOTICE_COUNT; i++) this.items.push({ el: div(this.root, 'dzf-note'), pop: new PopToggle(), until: 0 });
  }

  push(text: string, tone: NoticeTone, now: number): void {
    let slot = this.items[0];
    for (const n of this.items) {
      if (n.until <= now) {
        slot = n;
        break;
      }
      if (n.until < slot.until) slot = n;
    }
    slot.el.textContent = text;
    slot.el.className = `dzf-note${tone === 'info' ? '' : ` dzf-${tone}`} ${slot.pop.next()}`;
    slot.until = now + NOTICE_LIFE;
    // Newest at the bottom of the stack.
    this.root.appendChild(slot.el);
  }

  update(now: number): void {
    for (const n of this.items) {
      if (n.until > 0 && now >= n.until) {
        n.until = 0;
        n.el.className = 'dzf-note';
      }
    }
  }
}
