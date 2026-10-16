// Transient notifications (errors, info) stacked at the top of the screen.

import { audio } from '../audio';
import { ariaTx, button, h, svgIcon } from './dom';
import { ICONS } from './icons';

const TOAST_MS = 5200;
const MAX_TOASTS = 4;

export class Toasts {
  readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = h('div', 'dz-toasts', parent);
    this.el.setAttribute('aria-live', 'assertive');
  }

  show(text: string, kind: 'error' | 'info' = 'info'): void {
    // Collapse duplicates (e.g. repeated server errors) by refreshing the existing toast.
    for (const el of Array.from(this.el.children) as HTMLElement[]) {
      if (el.dataset.text === text) {
        el.remove();
      }
    }
    const toast = h('div', `dz-toast dz-toast-${kind}`, this.el);
    toast.dataset.text = text;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (kind === 'error') toast.dataset.testid = 'error-toast';
    toast.appendChild(svgIcon(kind === 'error' ? ICONS.close : ICONS.check, 'dz-icon dz-toast-icon'));
    h('span', 'dz-toast-text', toast).textContent = text;
    const close = button({ cls: 'dz-btn-icon-only dz-toast-close', icon: ICONS.close, parent: toast, onClick: () => dismiss() });
    ariaTx(close, 'common.close');
    if (kind === 'error') audio.ui('error');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      toast.classList.add('dz-toast-out');
      setTimeout(() => toast.remove(), 260);
    };
    timer = setTimeout(dismiss, TOAST_MS);
    while (this.el.childElementCount > MAX_TOASTS) this.el.firstElementChild?.remove();
  }
}
