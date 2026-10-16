// Center-screen X hitmarker: white body, red head, blue armor, orange knock, big red X + skull for
// kills. Rapid hits refresh the pop; a fresher, stronger marker (kill / knock) is not downgraded by
// trailing pellet hits.

import { div, PopToggle } from './dom';
import { shatterIcon, skullIcon } from './icons';

export type HitKind = 'body' | 'armor' | 'head' | 'knock' | 'kill';

export const HIT_PRIORITY: Record<HitKind, number> = { body: 0, armor: 1, head: 2, knock: 3, kill: 4 };
/** Visible life per kind (s); matches the CSS --d durations. */
const LIFE: Record<HitKind, number> = { body: 0.3, armor: 0.32, head: 0.4, knock: 0.55, kill: 0.75 };

export class Hitmarker {
  private readonly root: HTMLDivElement;
  private readonly pop = new PopToggle();
  private kind: HitKind | null = null;
  private until = 0;

  constructor(parent: HTMLElement) {
    this.root = div(parent, 'dzf-hm');
    for (let i = 0; i < 4; i++) this.root.appendChild(parent.ownerDocument.createElement('i'));
    this.root.appendChild(skullIcon(parent.ownerDocument, 'dzf-hm-skull'));
    this.root.appendChild(shatterIcon(parent.ownerDocument, 'dzf-hm-shard'));
  }

  show(kind: HitKind, now: number, shatter = false): void {
    if (this.kind !== null && now < this.until - LIFE[this.kind] * 0.4 && HIT_PRIORITY[this.kind] > HIT_PRIORITY[kind]) {
      kind = this.kind;
    }
    this.root.className = `dzf-hm dzf-hm-${kind} ${this.pop.next()}${shatter ? ' dzf-hm-shatter' : ''}`;
    this.kind = kind;
    this.until = now + LIFE[kind];
  }

  update(now: number): void {
    if (this.kind !== null && now >= this.until) {
      this.kind = null;
      this.root.className = 'dzf-hm';
    }
  }

  clear(): void {
    this.kind = null;
    this.root.className = 'dzf-hm';
  }
}
