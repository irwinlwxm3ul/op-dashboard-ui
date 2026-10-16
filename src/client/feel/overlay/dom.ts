// Tiny DOM helpers shared by the feel overlays.

export function el<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement, tag: K, cls: string,
): HTMLElementTagNameMap[K] {
  const e = parent.ownerDocument.createElement(tag);
  if (cls) e.className = cls;
  parent.appendChild(e);
  return e;
}

export const div = (parent: HTMLElement, cls: string): HTMLDivElement => el(parent, 'div', cls);

/**
 * Alternates between the `dzf-pa` / `dzf-pb` animation classes. Swapping to the twin keyframe set
 * restarts a CSS animation without a forced reflow.
 */
export class PopToggle {
  private flip = false;
  next(): string {
    this.flip = !this.flip;
    return this.flip ? 'dzf-pa' : 'dzf-pb';
  }
}

/** Sets an element's opacity only when it changed noticeably (avoids style churn every frame). */
export function setOpacity(e: HTMLElement, value: number, last: number): number {
  const v = Math.round(value * 100) / 100;
  if (v !== last) e.style.opacity = String(v);
  return v;
}

/**
 * Like setOpacity, but removes the element from rendering (display: none) while fully transparent,
 * so idle full-screen layers cost nothing to composite.
 */
export function setFade(e: HTMLElement, value: number, last: number): number {
  const v = Math.round(value * 100) / 100;
  if (v === last) return v;
  if (v <= 0) {
    e.style.display = 'none';
  } else {
    if (last <= 0) e.style.display = 'block';
    e.style.opacity = String(v);
  }
  return v;
}
