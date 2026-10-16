// Reusable form controls (keyboard accessible): labelled rows, sliders, segmented pickers, switches
// and selects. Labels are translation keys; value outputs are re-rendered on language change via
// `relabel()`.

import type { TKey } from '../i18n';
import { ariaTx, h, tx } from './dom';

let fieldSeq = 0;
const nextId = (): string => `dz-f${++fieldSeq}`;

export interface Control {
  readonly el: HTMLElement;
  relabel?(): void;
}

/** A labelled settings/form row: label on the inline-start side, control on the inline-end side. */
export function fieldRow(parent: HTMLElement, label: TKey, control: Control, hint?: TKey): HTMLDivElement {
  const row = h('div', 'dz-field', parent);
  const text = h('div', 'dz-field-text', row);
  const lab = tx(h('label', 'dz-field-label', text), label);
  const focusable = control.el.matches('input, select, button') ? control.el : control.el.querySelector('input, select, button');
  if (focusable) {
    if (!focusable.id) focusable.id = nextId();
    lab.htmlFor = focusable.id;
  }
  if (hint) tx(h('div', 'dz-field-hint', text), hint);
  const slot = h('div', 'dz-field-control', row);
  slot.appendChild(control.el);
  return row;
}

export interface SliderOpts {
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  /** Fired on release (change). Defaults to onInput only. */
  onCommit?: (v: number) => void;
}

export class Slider implements Control {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private readonly out: HTMLOutputElement;

  constructor(private readonly opts: SliderOpts) {
    this.el = h('div', 'dz-slider');
    this.input = h('input', 'dz-range', this.el);
    this.input.type = 'range';
    this.input.min = String(opts.min);
    this.input.max = String(opts.max);
    this.input.step = String(opts.step);
    this.out = h('output', 'dz-slider-value', this.el);
    this.value = opts.value;
    this.input.addEventListener('input', () => {
      const v = this.value;
      this.paint(v);
      opts.onInput(v);
    });
    this.input.addEventListener('change', () => opts.onCommit?.(this.value));
  }

  get value(): number {
    return Number(this.input.value);
  }

  set value(v: number) {
    this.input.value = String(v);
    this.paint(this.value);
  }

  relabel(): void {
    this.paint(this.value);
  }

  /** Change the lower bound (clamping the current value up to it). Returns the resulting value. */
  setMin(min: number): number {
    this.opts.min = min;
    this.input.min = String(min);
    if (Number(this.input.value) < min) this.input.value = String(min);
    this.paint(this.value);
    return this.value;
  }

  private paint(v: number): void {
    const { min, max } = this.opts;
    const f = max > min ? (v - min) / (max - min) : 0;
    // On the input itself so the track pseudo-element inherits it (LTR and RTL gradients).
    this.input.style.setProperty('--fill', `${(f * 100).toFixed(2)}%`);
    this.out.textContent = this.opts.format(v);
  }
}

export interface SegOption<T> {
  value: T;
  label: TKey;
}

/** Radio-group style segmented picker (arrow keys move the selection). */
export class Segmented<T extends string | number> implements Control {
  readonly el: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  private current: T;

  constructor(private readonly options: SegOption<T>[], value: T, private readonly onChange: (v: T) => void, aria?: TKey) {
    this.el = h('div', 'dz-seg');
    this.el.setAttribute('role', 'radiogroup');
    if (aria) ariaTx(this.el, aria);
    this.current = value;
    options.forEach((o, i) => {
      const b = h('button', 'dz-seg-btn', this.el);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      tx(b, o.label);
      b.addEventListener('click', () => this.select(o.value, true));
      b.addEventListener('keydown', (ev) => {
        const dir = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        ev.preventDefault();
        const rtl = getComputedStyle(this.el).direction === 'rtl' && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft');
        const n = (i + (rtl ? -dir : dir) + options.length) % options.length;
        this.select(options[n].value, true);
        this.buttons[n].focus();
      });
      this.buttons.push(b);
    });
    this.paint();
  }

  get value(): T {
    return this.current;
  }

  set value(v: T) {
    this.current = v;
    this.paint();
  }

  setDisabled(d: boolean): void {
    for (const b of this.buttons) b.disabled = d;
  }

  private select(v: T, user: boolean): void {
    if (v === this.current) return;
    this.current = v;
    this.paint();
    if (user) this.onChange(v);
  }

  private paint(): void {
    this.options.forEach((o, i) => {
      const on = o.value === this.current;
      const b = this.buttons[i];
      b.classList.toggle('dz-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  }
}

/** On/off switch: a native checkbox (role="switch") styled as a toggle. */
export class Toggle implements Control {
  readonly el: HTMLSpanElement;
  readonly input: HTMLInputElement;

  constructor(value: boolean, onChange: (v: boolean) => void) {
    this.el = h('span', 'dz-switch');
    this.input = h('input', 'dz-switch-input', this.el);
    this.input.type = 'checkbox';
    this.input.setAttribute('role', 'switch');
    const track = h('span', 'dz-switch-track', this.el);
    track.setAttribute('aria-hidden', 'true');
    h('span', 'dz-switch-knob', track);
    this.input.checked = value;
    this.input.addEventListener('change', () => onChange(this.input.checked));
  }

  get value(): boolean {
    return this.input.checked;
  }

  set value(v: boolean) {
    this.input.checked = v;
  }

  setDisabled(d: boolean): void {
    this.input.disabled = d;
  }
}

export interface SelectOption<T> {
  value: T;
  /** Translated label key, or a raw proper-noun label (language native names). */
  label?: TKey;
  raw?: string;
}

/** Native <select> (best keyboard / screen reader support). */
export class Select<T extends string | number> implements Control {
  readonly el: HTMLSelectElement;

  constructor(private readonly options: SelectOption<T>[], value: T, onChange: (v: T) => void) {
    this.el = h('select', 'dz-select');
    for (const o of options) {
      const opt = h('option', '', this.el);
      opt.value = String(o.value);
      if (o.label) tx(opt, o.label);
      else opt.textContent = o.raw ?? String(o.value);
    }
    this.value = value;
    this.el.addEventListener('change', () => onChange(this.value));
  }

  get value(): T {
    const i = this.el.selectedIndex;
    return this.options[Math.max(0, i)].value;
  }

  set value(v: T) {
    let idx = this.options.findIndex((o) => o.value === v);
    if (idx < 0) {
      // Pick the closest numeric option for values that are not exactly listed.
      if (typeof v === 'number') {
        let best = Infinity;
        this.options.forEach((o, i) => {
          const d = Math.abs((o.value as number) - v);
          if (d < best) { best = d; idx = i; }
        });
      } else idx = 0;
    }
    this.el.selectedIndex = Math.max(0, idx);
  }

  setDisabled(d: boolean): void {
    this.el.disabled = d;
  }
}
