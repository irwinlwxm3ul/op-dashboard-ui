// Controls modal: every rebindable KeyAction with its current key (click to rebind: the next key
// press is captured), fixed mouse / vehicle / parachute rows, reset to defaults.

import { t, type TKey } from '../../i18n';
import { audio } from '../../audio';
import { settings } from '../../game';
import type { KeyAction, Settings } from '../../game/types';
import type { UiCtx } from '../context';
import { button, clear, h, tx } from '../dom';
import { keyLabel, onKeyboardLayout, RESERVED_CODES } from '../keys';
import { Modal, type ModalManager } from '../modal';

interface Group {
  title: TKey;
  actions: KeyAction[];
}

const GROUPS: Group[] = [
  { title: 'controls.section.movement', actions: ['forward', 'back', 'left', 'right', 'sprint', 'walk', 'jump', 'crouch', 'prone', 'leanLeft', 'leanRight', 'freeLook'] },
  { title: 'controls.section.combat', actions: ['reload', 'throw', 'holster', 'slot1', 'slot2', 'slot3', 'slot4', 'swapWeapons', 'cameraToggle'] },
  { title: 'controls.section.items', actions: ['interact', 'useBandage', 'useFirstAid', 'useMedkit', 'useEnergy', 'refuel'] },
  { title: 'controls.section.interface', actions: ['inventory', 'map', 'scoreboard', 'stats', 'menu'] },
];

export const ACTION_LABELS: Record<KeyAction, TKey> = {
  forward: 'controls.action.forward',
  back: 'controls.action.back',
  left: 'controls.action.left',
  right: 'controls.action.right',
  sprint: 'controls.action.sprint',
  walk: 'controls.action.walk',
  jump: 'controls.action.jump',
  crouch: 'controls.action.crouch',
  prone: 'controls.action.prone',
  leanLeft: 'controls.action.leanLeft',
  leanRight: 'controls.action.leanRight',
  reload: 'controls.action.reload',
  interact: 'controls.action.interact',
  throw: 'controls.action.throw',
  holster: 'controls.action.holster',
  slot1: 'controls.action.slot1',
  slot2: 'controls.action.slot2',
  slot3: 'controls.action.slot3',
  slot4: 'controls.action.slot4',
  swapWeapons: 'controls.action.swapWeapons',
  inventory: 'controls.action.inventory',
  map: 'controls.action.map',
  cameraToggle: 'controls.action.cameraToggle',
  freeLook: 'controls.action.freeLook',
  useBandage: 'controls.action.useBandage',
  useFirstAid: 'controls.action.useFirstAid',
  useMedkit: 'controls.action.useMedkit',
  useEnergy: 'controls.action.useEnergy',
  refuel: 'controls.action.refuel',
  stats: 'controls.action.stats',
  scoreboard: 'controls.action.scoreboard',
  menu: 'controls.action.menu',
};

/** Fixed rows: label + a function producing the key text from the current settings. */
interface FixedRow {
  label: TKey;
  keys: (s: Settings) => string;
}

const join = (...codes: string[]): string => codes.map((c) => keyLabel(c)).join(' / ');

const FIXED: { title: TKey; rows: FixedRow[] }[] = [
  {
    title: 'ui.controls.groupMouse',
    rows: [
      { label: 'controls.fire', keys: () => t('key.mouseLeft') },
      { label: 'controls.ads', keys: () => t('key.mouseRight') },
      { label: 'controls.cycleWeapons', keys: () => t('key.wheel') },
      { label: 'controls.holdBreath', keys: (s) => join(s.keybinds.sprint) },
    ],
  },
  {
    title: 'controls.section.vehicle',
    rows: [
      { label: 'controls.vehicle.throttle', keys: (s) => join(s.keybinds.forward, s.keybinds.back) },
      { label: 'controls.vehicle.steer', keys: (s) => join(s.keybinds.left, s.keybinds.right) },
      { label: 'controls.vehicle.handbrake', keys: (s) => join(s.keybinds.jump) },
      { label: 'controls.vehicle.boost', keys: (s) => join(s.keybinds.sprint) },
      { label: 'controls.vehicle.switchSeat', keys: (s) => `${keyLabel(s.keybinds.slot1)}–${keyLabel(s.keybinds.slot4)}` },
      { label: 'controls.vehicle.exit', keys: (s) => join(s.keybinds.interact) },
    ],
  },
  {
    title: 'controls.section.parachute',
    rows: [
      { label: 'controls.drop.jump', keys: (s) => join(s.keybinds.interact) },
      { label: 'controls.drop.dive', keys: (s) => join(s.keybinds.forward) },
      { label: 'controls.drop.slow', keys: (s) => join(s.keybinds.back) },
      { label: 'controls.drop.openChute', keys: (s) => join(s.keybinds.interact) },
    ],
  },
];

export class ControlsModal extends Modal {
  private readonly list: HTMLElement;
  private capturing: KeyAction | null = null;
  private keyButtons = new Map<KeyAction, HTMLButtonElement>();
  private fixedCells: { cell: HTMLElement; row: FixedRow }[] = [];
  private readonly status: HTMLElement;

  constructor(mgr: ModalManager, ctx: UiCtx) {
    super(mgr, 'controls.title', 'dz-controls-modal');
    tx(h('p', 'dz-lead', this.body), 'controls.rebindHint');
    this.list = h('div', 'dz-keys', this.body);
    this.status = h('div', 'dz-keys-status', this.body);
    this.status.setAttribute('role', 'status');
    this.build();

    button({ cls: 'dz-btn-ghost', label: 'controls.resetKeys', parent: this.footer, onClick: () => this.reset() });
    button({ cls: 'dz-btn-primary', label: 'common.ok', parent: this.footer, onClick: () => this.close() });

    this.captureKey = (ev) => this.onKey(ev);
    this.el.addEventListener('pointerdown', (ev) => {
      if (this.capturing && !(ev.target as HTMLElement).closest('.dz-keycap-capturing')) this.stopCapture();
    }, true);
    settings.subscribe(() => this.refresh());
    onKeyboardLayout(() => this.refresh());
    ctx.onLanguage(() => this.refresh());
  }

  protected override beforeOpen(): void {
    this.stopCapture();
    this.status.textContent = '';
    this.refresh();
  }

  override close(): void {
    this.stopCapture();
    super.close();
  }

  private build(): void {
    clear(this.list);
    this.keyButtons.clear();
    this.fixedCells = [];
    for (const g of GROUPS) {
      const sec = h('section', 'dz-keys-group', this.list);
      tx(h('h3', 'dz-keys-title', sec), g.title);
      for (const a of g.actions) {
        const row = h('div', 'dz-keys-row', sec);
        const label = tx(h('span', 'dz-keys-label', row), ACTION_LABELS[a]);
        label.id = `dz-key-${a}`;
        const cap = h('button', 'dz-keycap', row);
        cap.type = 'button';
        cap.setAttribute('aria-describedby', label.id);
        cap.addEventListener('click', () => this.startCapture(a));
        this.keyButtons.set(a, cap);
      }
    }
    for (const g of FIXED) {
      const sec = h('section', 'dz-keys-group dz-keys-fixed', this.list);
      tx(h('h3', 'dz-keys-title', sec), g.title);
      for (const r of g.rows) {
        const row = h('div', 'dz-keys-row', sec);
        tx(h('span', 'dz-keys-label', row), r.label);
        const cell = h('span', 'dz-keycap dz-keycap-fixed', row);
        this.fixedCells.push({ cell, row: r });
      }
    }
  }

  private refresh(): void {
    const s = settings.get();
    for (const [a, btn] of this.keyButtons) {
      if (a === this.capturing) {
        btn.textContent = t('controls.pressKey');
      } else {
        btn.textContent = keyLabel(s.keybinds[a]);
      }
      btn.setAttribute('aria-label', t('ui.controls.rebindAria', { action: t(ACTION_LABELS[a]), key: keyLabel(s.keybinds[a]) }));
    }
    for (const { cell, row } of this.fixedCells) cell.textContent = row.keys(s);
  }

  private startCapture(a: KeyAction): void {
    this.stopCapture();
    this.capturing = a;
    const btn = this.keyButtons.get(a);
    btn?.classList.add('dz-keycap-capturing');
    this.status.textContent = t('ui.controls.capturing', { action: t(ACTION_LABELS[a]) });
    this.refresh();
  }

  private stopCapture(): void {
    if (!this.capturing) return;
    this.keyButtons.get(this.capturing)?.classList.remove('dz-keycap-capturing');
    this.capturing = null;
    this.refresh();
  }

  private onKey(ev: KeyboardEvent): boolean {
    const a = this.capturing;
    if (!a) return false;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.repeat) return true;
    const code = ev.code;
    if (!code || code === 'Unidentified') return true;
    if (code === 'Escape' && a !== 'menu') {
      this.status.textContent = '';
      this.stopCapture();
      return true;
    }
    if (RESERVED_CODES.has(code)) {
      audio.ui('error');
      this.status.textContent = t('ui.controls.reserved', { key: keyLabel(code) });
      return true;
    }
    const s = settings.get();
    const prev = s.keybinds[a];
    const other = (Object.keys(s.keybinds) as KeyAction[]).find((k) => k !== a && s.keybinds[k] === code);
    settings.setKey(a, code);
    if (other) {
      // Swap so no action is left sharing (or missing) a key.
      settings.setKey(other, prev);
      this.status.textContent = t('ui.controls.swapped', { action: t(ACTION_LABELS[other]), key: keyLabel(prev) });
      const ob = this.keyButtons.get(other);
      if (ob) {
        ob.classList.remove('dz-flash');
        void ob.offsetWidth;
        ob.classList.add('dz-flash');
      }
    } else {
      this.status.textContent = '';
    }
    const btn = this.keyButtons.get(a);
    this.stopCapture();
    btn?.focus({ preventScroll: true });
    return true;
  }

  private reset(): void {
    this.stopCapture();
    settings.resetKeybinds();
    this.status.textContent = t('ui.controls.resetDone');
    this.refresh();
  }
}
