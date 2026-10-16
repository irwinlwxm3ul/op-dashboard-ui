// Small DOM helpers shared by every screen / widget. Plain DOM, no framework.
//
// Text rules: every user-visible string goes through t(). Static labels are created with `tx()`,
// which also tags the element with `data-i18n` so `translateDom()` re-translates it when the
// language changes. Text with parameters is re-rendered by its owning component instead.

import { t, type PluralKey, type TKey } from '../i18n';

export type Params = Record<string, string | number>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: HTMLElement | null,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (parent) parent.appendChild(el);
  return el;
}

/** Static translated text (re-translated automatically on language change). */
export function tx<E extends HTMLElement>(el: E, key: TKey): E {
  el.dataset.i18n = key;
  el.textContent = t(key);
  return el;
}

/** Translated text with parameters (owner must call again on language change). */
export function txp<E extends HTMLElement>(el: E, key: TKey | PluralKey, params: Params): E {
  delete el.dataset.i18n;
  el.textContent = t(key, params);
  return el;
}

/** Translated `title` attribute (tooltip). */
export function titleTx<E extends HTMLElement>(el: E, key: TKey): E {
  el.dataset.i18nTitle = key;
  el.title = t(key);
  return el;
}

/** Translated `aria-label`. */
export function ariaTx<E extends HTMLElement>(el: E, key: TKey): E {
  el.dataset.i18nAria = key;
  el.setAttribute('aria-label', t(key));
  return el;
}

/** Translated `placeholder`. */
export function placeholderTx<E extends HTMLInputElement | HTMLTextAreaElement>(el: E, key: TKey): E {
  el.dataset.i18nPlaceholder = key;
  el.placeholder = t(key);
  return el;
}

/**
 * Re-translate every element under `root` tagged by the helpers above. Equivalent to the i18n
 * module's translateDom for the attributes this module uses; kept local so the UI does not
 * depend on the exact attribute handling of that implementation.
 */
export function retranslate(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as TKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as TKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria as TKey));
  });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder as TKey);
  });
}

export interface ButtonOpts {
  cls?: string;
  /** Translated label */
  label?: TKey;
  /** Leading icon markup (static SVG, no text) */
  icon?: string;
  parent?: HTMLElement | null;
  onClick?: (ev: MouseEvent) => void;
}

/** A <button type="button">. Click / hover sounds are handled by delegation in the UI root. */
export function button(opts: ButtonOpts): HTMLButtonElement {
  const b = h('button', `dz-btn${opts.cls ? ` ${opts.cls}` : ''}`, opts.parent ?? null);
  b.type = 'button';
  if (opts.icon) {
    const i = h('span', 'dz-btn-icon', b);
    i.innerHTML = opts.icon;
    i.setAttribute('aria-hidden', 'true');
  }
  if (opts.label) tx(h('span', 'dz-btn-label', b), opts.label);
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

/**
 * User-generated text (player / lobby names, chat): direction detected from the content and
 * isolated from the surrounding bidi context, so an Arabic UI shows Latin names (and vice versa)
 * in the right place.
 */
export function userText<E extends HTMLElement>(el: E, text: string): E {
  el.textContent = text;
  markUserText(el);
  return el;
}

/** Mark an element whose content is user-generated (see userText). */
export function markUserText(el: HTMLElement): void {
  el.dir = 'auto';
  el.classList.add('dz-user');
}

/** Wrap user text interpolated into a translated sentence in Unicode first-strong isolates. */
export function isolate(text: string): string {
  return `\u2068${text}\u2069`;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Inline SVG helper: returns an element from static markup (icons only, never text). */
export function svgIcon(markup: string, cls = 'dz-icon'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = markup;
  return s;
}

// ---------------------------------------------------------------------------
// Change-detecting setters for per-frame HUD updates (avoid DOM writes when nothing changed).
// ---------------------------------------------------------------------------

/** Text slot that only writes the DOM when the string changes. */
export class TextSlot {
  private last: string | null = null;
  constructor(readonly el: HTMLElement) {}
  set(s: string): void {
    if (s !== this.last) {
      this.last = s;
      this.el.textContent = s;
    }
  }
  invalidate(): void {
    this.last = null;
  }
}

/** Numeric text slot: formats only when the (rounded) number changes. */
export class NumSlot {
  private last = Number.NaN;
  constructor(readonly el: HTMLElement, private readonly fmt: (n: number) => string) {}
  set(n: number): void {
    if (n !== this.last && !(Number.isNaN(n) && Number.isNaN(this.last))) {
      this.last = n;
      this.el.textContent = this.fmt(n);
    }
  }
  invalidate(): void {
    this.last = Number.NaN;
    this.el.textContent = '';
  }
}

/** Visibility toggle with caching. Uses the `dz-hidden` class (display: none). */
export class Vis {
  private last: boolean | null = null;
  constructor(readonly el: HTMLElement) {}
  set(v: boolean): void {
    if (v !== this.last) {
      this.last = v;
      this.el.classList.toggle('dz-hidden', !v);
    }
  }
  get visible(): boolean {
    return this.last === true;
  }
  invalidate(): void {
    this.last = null;
  }
}

/** Cached class toggle. */
export class ClassFlag {
  private last: boolean | null = null;
  constructor(readonly el: HTMLElement, readonly cls: string) {}
  set(v: boolean): void {
    if (v !== this.last) {
      this.last = v;
      this.el.classList.toggle(this.cls, v);
    }
  }
}

/** Bar fill driven by transform: scaleX / scaleY (compositor only). Writes when the change is visible. */
export class BarFill {
  private last = -1;
  constructor(readonly el: HTMLElement, private readonly eps = 0.002, private readonly axis: 'x' | 'y' = 'x') {}
  set(frac: number): void {
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    if (Math.abs(f - this.last) >= this.eps || (f === 0 && this.last !== 0) || (f === 1 && this.last !== 1)) {
      this.last = f;
      this.el.style.transform = this.axis === 'x' ? `scaleX(${f.toFixed(4)})` : `scaleY(${f.toFixed(4)})`;
    }
  }
  invalidate(): void {
    this.last = -1;
  }
}

/** Cached CSS custom property / style writer. */
export class StyleSlot {
  private last: string | null = null;
  constructor(readonly el: HTMLElement, readonly prop: string) {}
  set(v: string): void {
    if (v !== this.last) {
      this.last = v;
      if (this.prop.startsWith('--')) this.el.style.setProperty(this.prop, v);
      else (this.el.style as unknown as Record<string, string>)[this.prop] = v;
    }
  }
  invalidate(): void {
    this.last = null;
  }
}

/** True when keyboard focus is in an editable field (don't hijack keys there). */
export function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  const tag = a.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (a as HTMLInputElement).type;
    return type === 'text' || type === 'search' || type === 'number' || type === 'email' || type === 'password';
  }
  return a.isContentEditable;
}

/** Focus the first focusable control inside `root`. */
export function focusFirst(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>(
    '[data-autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
  );
  el?.focus({ preventScroll: true });
}

/** Keep Tab focus inside `root` (modal focus trap). */
export function trapFocus(root: HTMLElement, ev: KeyboardEvent): void {
  if (ev.key !== 'Tab') return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'),
  ).filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !root.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !root.contains(active))) {
    ev.preventDefault();
    first.focus();
  }
}
