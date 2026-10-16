// In-game pause menu (Esc): resume, settings, controls, leave match.

import type { UiCtx } from '../context';
import { button, h, tx } from '../dom';
import { ICONS } from '../icons';
import { Modal, type ModalManager } from '../modal';

export class PauseMenu extends Modal {
  private readonly leaveBtn: HTMLButtonElement;
  private readonly leaveLabel: HTMLElement;

  constructor(mgr: ModalManager, private readonly ctx: UiCtx) {
    super(mgr, 'menu.paused', 'dz-pause-modal', false);
    this.panel.dataset.testid = 'pause-menu';
    const list = h('div', 'dz-pause-list', this.body);
    const resume = button({ cls: 'dz-btn-primary dz-btn-xl', label: 'menu.resume', icon: ICONS.play, parent: list, onClick: () => this.escape() });
    resume.dataset.testid = 'pause-resume';
    resume.dataset.autofocus = '';
    button({ cls: 'dz-btn-xl', label: 'menu.settings', icon: ICONS.gear, parent: list, onClick: () => ctx.openSettings() });
    button({ cls: 'dz-btn-xl', label: 'menu.controls', icon: ICONS.keyboard, parent: list, onClick: () => ctx.openControls() });
    this.leaveBtn = button({ cls: 'dz-btn-xl dz-btn-danger', icon: ICONS.close, parent: list, onClick: () => this.leave() });
    this.leaveBtn.dataset.testid = 'pause-leave';
    this.leaveLabel = h('span', 'dz-btn-label', this.leaveBtn);
    tx(this.leaveLabel, 'menu.leaveMatch');
  }

  /** Set the leave label for the match context (back to lobby in multiplayer). */
  setMultiplayer(mp: boolean): void {
    tx(this.leaveLabel, mp ? 'results.backToLobby' : 'menu.leaveMatch');
  }

  /** Esc / resume: close and let the app re-lock the pointer. */
  override escape(): void {
    this.close();
    this.ctx.actions.resumeGame();
  }

  private leave(): void {
    this.close();
    this.ctx.actions.leaveMatch();
  }
}
