// Shared context handed to every screen / widget of the UI module.

import type { TKey } from '../i18n';
import type { Params } from './dom';
import type { ModalManager } from './modal';
import type { AppActions, Screen } from './contracts';

export interface UiCtx {
  readonly actions: AppActions;
  readonly root: HTMLElement;
  readonly modals: ModalManager;
  readonly screen: Screen;
  show(screen: Screen): void;
  openSettings(): void;
  openControls(): void;
  /** Transient notification (errors are red). */
  toast(key: TKey, params?: Params, kind?: 'error' | 'info'): void;
  /** Register a callback run after the language changed (static labels are re-translated already). */
  onLanguage(cb: () => void): void;
}

/** A full-screen menu screen. */
export interface ScreenView {
  readonly el: HTMLElement;
  onShow?(): void;
  onHide?(): void;
  /** Esc pressed while this screen is active and no modal is open. Return true if handled. */
  onEscape?(): boolean;
}
