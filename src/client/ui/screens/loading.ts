// Loading screen: logo, progress bar, translated step label and rotating gameplay tips.

import { fmtNumber, t, type TKey } from '../../i18n';
import type { ScreenView, UiCtx } from '../context';
import { h, tx, txp } from '../dom';
import { buildLogo, menuBackdrop } from './mainMenu';

const TIPS: TKey[] = [
  'ui.tip.1', 'ui.tip.2', 'ui.tip.3', 'ui.tip.4', 'ui.tip.5', 'ui.tip.6', 'ui.tip.7', 'ui.tip.8', 'ui.tip.9', 'ui.tip.10',
];
const TIP_MS = 6000;

export class LoadingScreen implements ScreenView {
  readonly el: HTMLElement;
  private readonly logo: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly step: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly tip: HTMLElement;
  private stepKey = '';
  private progress = 0;
  private tipIndex = 0;
  private tipTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: UiCtx) {
    this.el = h('section', 'dz-screen dz-loading');
    this.el.dataset.testid = 'loading';
    menuBackdrop(this.el);
    const wrap = h('div', 'dz-loading-wrap', this.el);
    this.logo = h('div', 'dz-logo dz-logo-sm', wrap);
    buildLogo(this.logo);
    this.bar = h('div', 'dz-progress', wrap);
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.fill = h('div', 'dz-progress-fill', this.bar);
    const row = h('div', 'dz-loading-row', wrap);
    this.step = h('span', 'dz-loading-step', row);
    this.step.setAttribute('aria-live', 'polite');
    this.pct = h('span', 'dz-loading-pct', row);
    const tipBox = h('div', 'dz-loading-tip', wrap);
    tx(h('span', 'dz-loading-tip-label', tipBox), 'ui.loading.tip');
    this.tip = h('span', 'dz-loading-tip-text', tipBox);
    ctx.onLanguage(() => {
      buildLogo(this.logo);
      this.renderStep();
      this.renderTip();
    });
    this.tipIndex = Math.floor(Math.random() * TIPS.length);
  }

  onShow(): void {
    this.renderTip();
    if (this.tipTimer) clearInterval(this.tipTimer);
    this.tipTimer = setInterval(() => {
      this.tipIndex = (this.tipIndex + 1) % TIPS.length;
      this.renderTip();
    }, TIP_MS);
  }

  onHide(): void {
    if (this.tipTimer) clearInterval(this.tipTimer);
    this.tipTimer = null;
    this.set(0, '');
  }

  set(progress: number, stepKey: string): void {
    const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    // Never move backwards within one loading sequence (except the reset on hide).
    this.progress = stepKey === '' ? p : Math.max(this.progress, p);
    this.stepKey = stepKey;
    this.fill.style.transform = `scaleX(${this.progress.toFixed(4)})`;
    this.bar.setAttribute('aria-valuenow', String(Math.round(this.progress * 100)));
    this.renderStep();
  }

  private renderStep(): void {
    this.step.textContent = this.stepKey ? t(this.stepKey as TKey) : t('common.loading');
    txp(this.pct, 'unit.percent', { n: fmtNumber(Math.round(this.progress * 100)) });
  }

  private renderTip(): void {
    this.tip.textContent = t(TIPS[this.tipIndex]);
  }
}
