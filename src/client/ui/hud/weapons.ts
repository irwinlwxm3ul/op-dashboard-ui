// Bottom-right weapon HUD: big ammo counter (mag / reserve), fire mode, reload progress, low-ammo
// tint, weapon slots 1–3 + frag count, quick-use consumables with their keys.

import { fmtNumber, itemName, t, type TKey } from '../../i18n';
import { WEAPONS } from '../../../shared/items';
import type { ConsumableId, WeaponId, WeaponInstance } from '../../../shared/types';
import type { FrameState, KeyAction } from '../../game/types';
import { BarFill, ClassFlag, h, NumSlot, svgIcon, TextSlot, Vis } from '../dom';
import { ICONS, weaponIcon } from '../icons';
import { keyCapLabel } from '../keys';
import type { HudEnv, Widget } from './shared';

const FIRE_MODE_KEYS: Record<string, TKey> = {
  auto: 'hud.fireMode.auto',
  semi: 'hud.fireMode.semi',
  bolt: 'hud.fireMode.bolt',
  pump: 'hud.fireMode.pump',
};

const SLOT_KEYS: readonly KeyAction[] = ['slot1', 'slot2', 'slot3'];

const QUICK: readonly { item: ConsumableId; action: KeyAction }[] = [
  { item: 'bandage', action: 'useBandage' },
  { item: 'firstaid', action: 'useFirstAid' },
  { item: 'medkit', action: 'useMedkit' },
  { item: 'energy', action: 'useEnergy' },
];

class WeaponSlotView {
  readonly el: HTMLDivElement;
  private readonly key: TextSlot;
  private readonly icon: HTMLElement;
  private readonly name: TextSlot;
  private readonly mag: NumSlot;
  private readonly active: ClassFlag;
  private readonly empty: ClassFlag;
  private id: WeaponId | null | undefined = undefined;

  constructor(parent: HTMLElement) {
    this.el = h('div', 'dz-wslot', parent);
    this.key = new TextSlot(h('span', 'dz-key dz-key-sm', this.el));
    this.icon = h('span', 'dz-wslot-icon', this.el);
    this.icon.setAttribute('aria-hidden', 'true');
    this.name = new TextSlot(h('span', 'dz-wslot-name', this.el));
    this.mag = new NumSlot(h('span', 'dz-wslot-mag', this.el), (n) => (n < 0 ? '' : fmtNumber(n)));
    this.active = new ClassFlag(this.el, 'dz-active');
    this.empty = new ClassFlag(this.el, 'dz-is-empty');
  }

  set(w: WeaponInstance | null, active: boolean, keyCode: string): void {
    this.key.set(keyCapLabel(keyCode));
    const id = w ? w.id : null;
    if (id !== this.id) {
      this.id = id;
      this.icon.innerHTML = id ? weaponIcon(id) : '';
      this.name.set(id ? itemName(id) : t('inv.empty'));
    }
    this.mag.set(w ? w.mag : -1);
    this.active.set(active && !!w);
    this.empty.set(!w);
  }

  invalidate(): void {
    this.id = undefined;
    this.key.invalidate();
    this.name.invalidate();
    this.mag.invalidate();
  }
}

class QuickSlot {
  readonly el: HTMLDivElement;
  private readonly key: TextSlot;
  private readonly count: NumSlot;
  private readonly none: ClassFlag;
  private readonly using: ClassFlag;

  constructor(parent: HTMLElement, readonly item: ConsumableId | 'frag', readonly action: KeyAction) {
    this.el = h('div', `dz-quick-slot dz-quick-${item}`, parent);
    this.el.title = itemName(item);
    this.el.appendChild(svgIcon(item === 'frag' ? ICONS.frag : ICONS[item as 'bandage' | 'firstaid' | 'medkit' | 'energy'], 'dz-quick-icon'));
    this.count = new NumSlot(h('span', 'dz-quick-count', this.el), (n) => fmtNumber(n));
    this.key = new TextSlot(h('span', 'dz-key dz-key-xs', this.el));
    this.none = new ClassFlag(this.el, 'dz-is-empty');
    this.using = new ClassFlag(this.el, 'dz-using');
  }

  set(count: number, keyCode: string, using: boolean): void {
    this.count.set(count);
    this.key.set(keyCapLabel(keyCode));
    this.none.set(count <= 0);
    this.using.set(using);
  }

  invalidate(): void {
    this.el.title = itemName(this.item);
    this.key.invalidate();
    this.count.invalidate();
  }
}

export class WeaponPanel implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly ammo: HTMLElement;
  private readonly mag: NumSlot;
  private readonly reserve: TextSlot;
  private readonly sep: Vis;
  private readonly fireMode: TextSlot;
  private readonly status: TextSlot;
  private readonly reloadVis: Vis;
  private readonly reloadFill: BarFill;
  private readonly low: ClassFlag;
  private readonly out: ClassFlag;
  private readonly slots: WeaponSlotView[] = [];
  private readonly frag: QuickSlot;
  private readonly quick: QuickSlot[] = [];
  private lastWeapon: WeaponId | null | undefined = undefined;
  private lastReserve = Number.NaN;
  private lastStatus = '';

  constructor() {
    this.el = h('div', 'dz-weapons');
    this.vis = new Vis(this.el);

    const quick = h('div', 'dz-quick', this.el);
    for (const q of QUICK) this.quick.push(new QuickSlot(quick, q.item, q.action));

    this.ammo = h('div', 'dz-ammo', this.el);
    const counter = h('div', 'dz-ammo-counter', this.ammo);
    this.mag = new NumSlot(h('span', 'dz-ammo-mag', counter), (n) => fmtNumber(n));
    const sep = h('span', 'dz-ammo-sep', counter);
    sep.textContent = '/';
    this.sep = new Vis(sep);
    this.reserve = new TextSlot(h('span', 'dz-ammo-reserve', counter));
    const meta = h('div', 'dz-ammo-meta', this.ammo);
    this.fireMode = new TextSlot(h('span', 'dz-firemode', meta));
    this.status = new TextSlot(h('span', 'dz-ammo-status', meta));
    const reload = h('div', 'dz-reload', this.ammo);
    this.reloadVis = new Vis(reload);
    this.reloadFill = new BarFill(h('div', 'dz-reload-fill', reload));
    this.low = new ClassFlag(this.ammo, 'dz-ammo-low');
    this.out = new ClassFlag(this.ammo, 'dz-ammo-out');

    const slots = h('div', 'dz-wslots', this.el);
    for (let i = 0; i < 3; i++) this.slots.push(new WeaponSlotView(slots));
    this.frag = new QuickSlot(slots, 'frag', 'slot4');
    this.frag.el.classList.add('dz-frag-slot');
  }

  update(frame: FrameState, _cam: unknown, env: HudEnv): void {
    const self = frame.self;
    const hidden = !self || self.life === 'dead' || self.mode === 'plane' || self.mode === 'freefall' || self.mode === 'parachute';
    this.vis.set(!hidden);
    if (!self || hidden) return;
    const keys = env.keys;

    for (let i = 0; i < 3; i++) this.slots[i].set(self.weapons[i], self.activeSlot === i, keys[SLOT_KEYS[i]]);
    this.frag.set(self.items.frag ?? 0, keys.slot4, false);
    const useItem = self.use ? self.use.item : null;
    for (const q of this.quick) q.set(self.items[q.item] ?? 0, keys[q.action], useItem === q.item);

    const slot = self.activeSlot;
    const inst = slot === -1 ? null : self.weapons[slot];
    const id = inst ? inst.id : null;
    if (id !== this.lastWeapon) {
      this.lastWeapon = id;
      this.lastReserve = Number.NaN;
      this.fireMode.set(id ? t(FIRE_MODE_KEYS[WEAPONS[id].fireMode]) : '');
      this.ammo.classList.toggle('dz-ammo-fists', !id);
    }
    let status = '';
    if (!inst || !id) {
      this.mag.invalidate();
      this.reserve.set(t('hud.fists'));
      this.sep.set(false);
      this.low.set(false);
      this.out.set(false);
      this.reloadVis.set(false);
    } else {
      const def = WEAPONS[id];
      const infinite = frame.config.infiniteAmmo;
      const reserve = infinite ? -1 : self.ammo[def.ammo] ?? 0;
      this.mag.set(inst.mag);
      this.sep.set(true);
      if (reserve !== this.lastReserve) {
        this.lastReserve = reserve;
        this.reserve.set(reserve < 0 ? '∞' : fmtNumber(reserve));
      }
      const lowThreshold = Math.max(1, Math.ceil(def.magSize * 0.25));
      const reloading = self.reloadProgress >= 0;
      this.low.set(inst.mag > 0 && inst.mag <= lowThreshold);
      this.out.set(inst.mag === 0);
      this.reloadVis.set(reloading);
      if (reloading) {
        this.reloadFill.set(self.reloadProgress);
        status = 'r';
      } else if (inst.mag === 0 && reserve === 0) status = 'n';
      else if (inst.mag > 0 && inst.mag <= lowThreshold) status = 'l';
    }
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.status.set(status === 'r' ? t('hud.reloading') : status === 'n' ? t('hud.noAmmo') : status === 'l' ? t('hud.lowAmmo') : '');
    }
  }

  relabel(): void {
    for (const s of this.slots) s.invalidate();
    for (const q of this.quick) q.invalidate();
    this.frag.invalidate();
    this.lastWeapon = undefined;
    this.lastStatus = '-';
    this.reserve.invalidate();
  }

  reset(): void {
    this.relabel();
    this.vis.invalidate();
  }
}
