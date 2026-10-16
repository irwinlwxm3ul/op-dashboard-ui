// Main menu: animated DROPZONE title, primary navigation, player name and language switcher.

import { getLanguage, LANGUAGES, setLanguage, t, type Lang } from '../../i18n';
import { settings } from '../../game';
import { MAX_NAME_LEN } from '../../../shared/constants';
import { sanitizeName } from '../../../shared/validate';
import type { UiCtx, ScreenView } from '../context';
import { button, h, placeholderTx, svgIcon, titleTx, tx } from '../dom';
import { ICONS } from '../icons';

/** Decorative animated backdrop shared by the menu screens (pure CSS animation). */
export function menuBackdrop(parent: HTMLElement): HTMLDivElement {
  const bg = h('div', 'dz-menu-bg', parent);
  bg.setAttribute('aria-hidden', 'true');
  h('div', 'dz-menu-bg-grid', bg);
  h('div', 'dz-menu-bg-glow', bg);
  const plane = h('div', 'dz-menu-bg-plane', bg);
  plane.appendChild(svgIcon(ICONS.plane, 'dz-menu-bg-plane-icon'));
  h('div', 'dz-menu-bg-trail', plane);
  for (let i = 0; i < 5; i++) {
    const p = svgIcon(ICONS.parachute, 'dz-menu-bg-chute');
    p.style.setProperty('--i', String(i));
    bg.appendChild(p);
  }
  return bg;
}

/** Animated logo built from the (translated) title, one span per letter. */
export function buildLogo(el: HTMLElement): void {
  el.textContent = '';
  const title = t('app.title');
  el.setAttribute('aria-label', title);
  Array.from(title).forEach((ch, i) => {
    const s = h('span', 'dz-logo-letter', el);
    s.style.setProperty('--i', String(i));
    s.textContent = ch;
    s.setAttribute('aria-hidden', 'true');
  });
}

export class MainMenu implements ScreenView {
  readonly el: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly langSelect: HTMLSelectElement;
  private readonly logo: HTMLHeadingElement;
  private readonly nav: HTMLElement;

  constructor(private readonly ctx: UiCtx) {
    this.el = h('section', 'dz-screen dz-main');
    menuBackdrop(this.el);
    const layout = h('div', 'dz-main-layout', this.el);

    const left = h('div', 'dz-main-left', layout);
    this.logo = h('h1', 'dz-logo', left);
    buildLogo(this.logo);
    tx(h('p', 'dz-tagline', left), 'app.tagline');

    this.nav = h('nav', 'dz-main-nav', left);
    const sp = button({
      cls: 'dz-btn-primary dz-btn-xl', label: 'menu.singlePlayer', icon: ICONS.users, parent: this.nav,
      onClick: () => ctx.show('singleplayer'),
    });
    sp.dataset.autofocus = '';
    titleTx(sp, 'menu.singlePlayerDesc');
    sp.dataset.testid = 'main-sp';
    const training = button({ cls: 'dz-btn-xl', label: 'menu.training', icon: ICONS.target, parent: this.nav, onClick: () => ctx.actions.startTraining() });
    training.dataset.testid = 'main-training';
    titleTx(training, 'menu.trainingDesc');
    const mp = button({ cls: 'dz-btn-xl', label: 'menu.multiplayer', icon: ICONS.globe, parent: this.nav, onClick: () => this.openMultiplayer() });
    mp.dataset.testid = 'main-mp';
    titleTx(mp, 'menu.multiplayerDesc');
    const row = h('div', 'dz-main-nav-row', this.nav);
    button({ label: 'menu.settings', icon: ICONS.gear, parent: row, onClick: () => ctx.openSettings() }).dataset.testid = 'main-settings';
    button({ label: 'menu.controls', icon: ICONS.keyboard, parent: row, onClick: () => ctx.openControls() }).dataset.testid = 'main-controls';
    this.nav.addEventListener('keydown', (ev) => this.onNavKey(ev));

    const side = h('aside', 'dz-main-side dz-panel', layout);
    const nameField = h('div', 'dz-stack', side);
    const nameLabel = tx(h('label', 'dz-field-label', nameField), 'menu.playerName');
    this.nameInput = h('input', 'dz-input', nameField);
    this.nameInput.id = 'dz-main-name';
    this.nameInput.dataset.testid = 'name-input';
    nameLabel.htmlFor = this.nameInput.id;
    this.nameInput.type = 'text';
    this.nameInput.maxLength = MAX_NAME_LEN;
    this.nameInput.setAttribute('autocomplete', 'nickname');
    this.nameInput.spellcheck = false;
    placeholderTx(this.nameInput, 'menu.playerNamePlaceholder');
    this.nameInput.addEventListener('change', () => this.commitName());
    this.nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        this.commitName();
        this.nameInput.blur();
      }
    });

    const langField = h('div', 'dz-stack', side);
    const langLabel = tx(h('label', 'dz-field-label', langField), 'menu.language');
    this.langSelect = h('select', 'dz-select', langField);
    this.langSelect.id = 'dz-main-lang';
    this.langSelect.dataset.testid = 'lang-select';
    langLabel.htmlFor = this.langSelect.id;
    for (const l of LANGUAGES) {
      const o = h('option', '', this.langSelect);
      o.value = l.code;
      o.textContent = l.native;
      o.lang = l.code;
    }
    this.langSelect.addEventListener('change', () => setLanguage(this.langSelect.value as Lang));

    const footer = h('footer', 'dz-main-footer', this.el);
    tx(h('span', '', footer), 'menu.creditsText');
    tx(h('span', '', footer), 'ui.main.fontCredit');

    ctx.onLanguage(() => {
      buildLogo(this.logo);
      this.langSelect.value = getLanguage();
    });
    settings.subscribe((s) => {
      if (document.activeElement !== this.nameInput) this.nameInput.value = s.playerName;
    });
  }

  onShow(): void {
    this.nameInput.value = settings.get().playerName;
    this.langSelect.value = getLanguage();
    this.logo.classList.remove('dz-logo-anim');
    // Restart the drop-in animation each time the menu appears.
    void this.logo.offsetWidth;
    this.logo.classList.add('dz-logo-anim');
  }

  /** Current sanitized name (or null when invalid). */
  private commitName(): string | null {
    const name = sanitizeName(this.nameInput.value);
    this.nameInput.classList.toggle('dz-invalid', this.nameInput.value.trim().length > 0 && !name);
    if (name) {
      if (name !== settings.get().playerName) settings.set({ playerName: name });
      this.nameInput.value = name;
    }
    return name;
  }

  private openMultiplayer(): void {
    // Keep a name typed here; the lobby browser asks for one before connecting.
    this.commitName();
    this.ctx.show('multiplayer');
  }

  private onNavKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const items = Array.from(this.nav.querySelectorAll<HTMLButtonElement>('button'));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    ev.preventDefault();
    const n = (i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[n].focus();
  }
}
