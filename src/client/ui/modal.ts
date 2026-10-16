// Modal dialogs (settings, controls, pause menu): a stack with focus trapping and Esc handling.

import type { TKey } from '../i18n';
import { ariaTx, button, focusFirst, h, trapFocus, tx } from './dom';
import { ICONS } from './icons';

export class ModalManager {
  private stack: Modal[] = [];
  private listeners = new Set<() => void>();

  constructor(readonly layer: HTMLElement) {}

  get open(): boolean {
    return this.stack.length > 0;
  }

  top(): Modal | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  isOpen(m: Modal): boolean {
    return this.stack.includes(m);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  push(m: Modal): void {
    if (this.stack.includes(m)) {
      // Bring to front.
      this.stack.splice(this.stack.indexOf(m), 1);
    } else {
      m.opener = document.activeElement;
    }
    this.stack.forEach((s) => s.el.classList.add('dz-modal-under'));
    this.stack.push(m);
    this.layer.appendChild(m.el);
    m.el.classList.remove('dz-modal-under');
    // Next frame so the enter transition plays.
    requestAnimationFrame(() => m.el.classList.add('dz-modal-open'));
    focusFirst(m.panel);
    this.emit();
  }

  remove(m: Modal): void {
    const i = this.stack.indexOf(m);
    if (i < 0) return;
    this.stack.splice(i, 1);
    m.el.classList.remove('dz-modal-open');
    m.el.remove();
    const top = this.top();
    if (top) {
      top.el.classList.remove('dz-modal-under');
      const opener = m.opener as HTMLElement | null;
      if (opener && top.panel.contains(opener)) opener.focus({ preventScroll: true });
      else focusFirst(top.panel);
    } else {
      const opener = m.opener as HTMLElement | null;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    }
    m.opener = null;
    this.emit();
  }

  closeAll(): void {
    for (const m of [...this.stack].reverse()) m.close();
  }

  /** Keyboard handling for the top-most modal. Returns true when the event was consumed. */
  handleKey(ev: KeyboardEvent): boolean {
    const top = this.top();
    if (!top) return false;
    if (top.captureKey && top.captureKey(ev)) return true;
    if (ev.key === 'Escape') {
      top.escape();
      return true;
    }
    trapFocus(top.panel, ev);
    return false;
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

let modalSeq = 0;

export class Modal {
  readonly el: HTMLDivElement;
  readonly panel: HTMLDivElement;
  readonly header: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly footer: HTMLDivElement;
  opener: Element | null = null;
  /** Optional raw key capture (e.g. key rebinding); return true to consume. */
  captureKey: ((ev: KeyboardEvent) => boolean) | null = null;
  /** Called after the modal closed. */
  onClosed: (() => void) | null = null;

  constructor(protected readonly mgr: ModalManager, titleKey: TKey, cls = '', closable = true) {
    this.el = h('div', `dz-modal ${cls}`);
    this.el.addEventListener('pointerdown', (ev) => {
      if (ev.target === this.el && closable) this.escape();
    });
    this.panel = h('div', 'dz-modal-panel dz-panel', this.el);
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.header = h('div', 'dz-modal-header', this.panel);
    const title = tx(h('h2', 'dz-modal-title', this.header), titleKey);
    title.id = `dz-modal-title-${++modalSeq}`;
    this.panel.setAttribute('aria-labelledby', title.id);
    if (closable) {
      const x = button({ cls: 'dz-btn-icon-only dz-modal-close', icon: ICONS.close, parent: this.header, onClick: () => this.escape() });
      ariaTx(x, 'ui.common.close');
    }
    this.body = h('div', 'dz-modal-body', this.panel);
    this.footer = h('div', 'dz-modal-footer', this.panel);
  }

  get isOpen(): boolean {
    return this.mgr.isOpen(this);
  }

  open(): void {
    this.beforeOpen();
    this.mgr.push(this);
  }

  close(): void {
    if (!this.isOpen) return;
    this.mgr.remove(this);
    this.onClosed?.();
  }

  /** Esc / backdrop / close button. Subclasses may override (pause menu resumes the game). */
  escape(): void {
    this.close();
  }

  /** Hook to refresh content right before opening. */
  protected beforeOpen(): void {}
}
