// Settings modal: graphics, mouse, audio, gameplay and language. Every change applies immediately
// through the settings store (persisted by src/client/game); audio volumes are also pushed to the
// audio engine right away.

import { fmtNumber, getLanguage, LANGUAGES, setLanguage, t, type Lang, type TKey } from '../../i18n';
import { audio } from '../../audio';
import { settings } from '../../game';
import type { CameraMode, Quality, Settings } from '../../game/types';
import type { UiCtx } from '../context';
import { fieldRow, Segmented, Select, Slider, Toggle, type Control } from '../controls';
import { h, tx } from '../dom';
import { Modal, type ModalManager } from '../modal';

type Tab = 'graphics' | 'mouse' | 'audio' | 'gameplay';

const TABS: { id: Tab; label: TKey }[] = [
  { id: 'graphics', label: 'ui.settings.tabGraphics' },
  { id: 'mouse', label: 'ui.settings.tabMouse' },
  { id: 'audio', label: 'ui.settings.tabAudio' },
  { id: 'gameplay', label: 'ui.settings.tabGameplay' },
];

const QUALITY_OPTIONS: { value: Quality; label: TKey }[] = [
  { value: 'low', label: 'ui.settings.qualityLow' },
  { value: 'medium', label: 'ui.settings.qualityMedium' },
  { value: 'high', label: 'ui.settings.qualityHigh' },
  { value: 'ultra', label: 'ui.settings.qualityUltra' },
];

const CAMERA_OPTIONS: { value: CameraMode; label: TKey }[] = [
  { value: 'tpp', label: 'ui.settings.cameraTpp' },
  { value: 'fpp', label: 'ui.settings.cameraFpp' },
];

const pct = (v: number): string => t('ui.common.percent', { n: fmtNumber(Math.round(v * 100)) });
const mult = (v: number): string => fmtNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export class SettingsModal extends Modal {
  private readonly tabs = new Map<Tab, { btn: HTMLButtonElement; page: HTMLElement }>();
  private active: Tab = 'graphics';
  /** Re-sync functions (settings → controls). */
  private readonly syncers: Array<(s: Settings) => void> = [];
  private readonly relabels: Array<() => void> = [];

  constructor(mgr: ModalManager, ctx: UiCtx) {
    super(mgr, 'ui.settings.title', 'dz-settings-modal');
    const tabBar = h('div', 'dz-tabs', this.body);
    tabBar.setAttribute('role', 'tablist');
    const pages = h('div', 'dz-tab-pages', this.body);
    for (const tab of TABS) {
      const btn = h('button', 'dz-tab', tabBar);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      tx(btn, tab.label);
      btn.addEventListener('click', () => this.select(tab.id));
      const page = h('div', 'dz-tab-page dz-form', pages);
      page.setAttribute('role', 'tabpanel');
      this.tabs.set(tab.id, { btn, page });
    }
    tabBar.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const rtl = getComputedStyle(tabBar).direction === 'rtl';
      const dir = (ev.key === 'ArrowRight') !== rtl ? 1 : -1;
      const i = TABS.findIndex((x) => x.id === this.active);
      const next = TABS[(i + dir + TABS.length) % TABS.length].id;
      this.select(next);
      this.tabs.get(next)?.btn.focus();
    });

    const s0 = settings.get();
    const page = (id: Tab) => this.tabs.get(id)!.page;

    // Graphics
    this.seg(page('graphics'), 'ui.settings.quality', QUALITY_OPTIONS, s0.quality, (v) => settings.set({ quality: v }), (s) => s.quality, 'ui.settings.qualityHint');
    this.slider(page('graphics'), 'ui.settings.renderScale', { min: 0.5, max: 1.5, step: 0.05, format: pct }, (s) => s.renderScale, (v) => settings.set({ renderScale: v }), 'ui.settings.renderScaleHint');
    this.slider(page('graphics'), 'ui.settings.fov', { min: 70, max: 100, step: 1, format: (v) => t('ui.common.degrees', { n: fmtNumber(v) }) }, (s) => s.fov, (v) => settings.set({ fov: v }));
    this.toggle(page('graphics'), 'ui.settings.showFps', (s) => s.showFps, (v) => settings.set({ showFps: v }));

    // Mouse
    this.slider(page('mouse'), 'ui.settings.mouseSensitivity', { min: 0.1, max: 3, step: 0.05, format: mult }, (s) => s.mouseSensitivity, (v) => settings.set({ mouseSensitivity: v }));
    this.slider(page('mouse'), 'ui.settings.adsSensitivity', { min: 0.1, max: 2, step: 0.05, format: mult }, (s) => s.adsSensitivity, (v) => settings.set({ adsSensitivity: v }), 'ui.settings.adsSensitivityHint');
    this.slider(page('mouse'), 'ui.settings.scopeSensitivity', { min: 0.1, max: 2, step: 0.05, format: mult }, (s) => s.scopeSensitivity, (v) => settings.set({ scopeSensitivity: v }), 'ui.settings.scopeSensitivityHint');
    this.toggle(page('mouse'), 'ui.settings.invertY', (s) => s.invertY, (v) => settings.set({ invertY: v }));

    // Audio
    const pushAudio = () => {
      const s = settings.get();
      audio.setSettings({ master: s.masterVolume, sfx: s.sfxVolume, ui: s.uiVolume });
    };
    this.slider(page('audio'), 'ui.settings.masterVolume', { min: 0, max: 1, step: 0.01, format: pct }, (s) => s.masterVolume, (v) => { settings.set({ masterVolume: v }); pushAudio(); });
    this.slider(page('audio'), 'ui.settings.sfxVolume', { min: 0, max: 1, step: 0.01, format: pct }, (s) => s.sfxVolume, (v) => { settings.set({ sfxVolume: v }); pushAudio(); });
    this.slider(page('audio'), 'ui.settings.uiVolume', { min: 0, max: 1, step: 0.01, format: pct }, (s) => s.uiVolume, (v) => { settings.set({ uiVolume: v }); pushAudio(); }, undefined, () => audio.ui('click'));

    // Gameplay
    this.seg(page('gameplay'), 'ui.settings.cameraMode', CAMERA_OPTIONS, s0.cameraMode, (v) => settings.set({ cameraMode: v }), (s) => s.cameraMode, 'ui.settings.cameraModeHint');
    this.toggle(page('gameplay'), 'ui.settings.toggleCrouch', (s) => s.toggleCrouch, (v) => settings.set({ toggleCrouch: v }), 'ui.settings.toggleCrouchHint');
    this.toggle(page('gameplay'), 'ui.settings.toggleAds', (s) => s.toggleAds, (v) => settings.set({ toggleAds: v }), 'ui.settings.toggleAdsHint');
    this.toggle(page('gameplay'), 'ui.settings.damageNumbers', (s) => s.damageNumbers, (v) => settings.set({ damageNumbers: v }));
    const lang = new Select<Lang>(LANGUAGES.map((l) => ({ value: l.code, raw: l.native })), getLanguage(), (v) => setLanguage(v));
    Array.from(lang.el.options).forEach((o, i) => { o.lang = LANGUAGES[i].code; });
    fieldRow(page('gameplay'), 'ui.settings.language', lang);
    this.relabels.push(() => { lang.value = getLanguage(); });

    const done = h('button', 'dz-btn dz-btn-primary', this.footer);
    done.type = 'button';
    tx(done, 'ui.common.done');
    done.addEventListener('click', () => this.close());

    settings.subscribe((s) => {
      if (this.isOpen) this.sync(s);
    });
    ctx.onLanguage(() => {
      for (const r of this.relabels) r();
    });
    this.select('graphics');
  }

  protected override beforeOpen(): void {
    this.sync(settings.get());
    for (const r of this.relabels) r();
  }

  private sync(s: Settings): void {
    for (const f of this.syncers) f(s);
  }

  private select(tab: Tab): void {
    this.active = tab;
    for (const [id, { btn, page }] of this.tabs) {
      const on = id === tab;
      btn.classList.toggle('dz-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      page.classList.toggle('dz-hidden', !on);
    }
  }

  private slider(
    parent: HTMLElement, label: TKey,
    range: { min: number; max: number; step: number; format: (v: number) => string },
    get: (s: Settings) => number, set: (v: number) => void, hint?: TKey, onCommit?: () => void,
  ): void {
    const sl = new Slider({ ...range, value: get(settings.get()), onInput: set, onCommit });
    fieldRow(parent, label, sl, hint);
    this.syncers.push((s) => {
      if (document.activeElement !== sl.input) sl.value = get(s);
    });
    this.relabels.push(() => sl.relabel());
  }

  private toggle(parent: HTMLElement, label: TKey, get: (s: Settings) => boolean, set: (v: boolean) => void, hint?: TKey): void {
    const tg = new Toggle(get(settings.get()), set);
    fieldRow(parent, label, tg, hint);
    this.syncers.push((s) => { tg.value = get(s); });
  }

  private seg<T extends string>(
    parent: HTMLElement, label: TKey, options: { value: T; label: TKey }[], value: T,
    set: (v: T) => void, get: (s: Settings) => T, hint?: TKey,
  ): void {
    const sg = new Segmented<T>(options, value, set, label);
    fieldRow(parent, label, sg as Control, hint);
    this.syncers.push((s) => { sg.value = get(s); });
  }
}
