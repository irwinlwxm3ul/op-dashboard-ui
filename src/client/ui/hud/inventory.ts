// Inventory overlay (inventory key): nearby ground loot (click → pick up), backpack with capacity
// (click a consumable → use, right-click / drop button → drop all), equipment (helmet / vest /
// backpack with durability, weapons with magazines, drop + swap) and, in the training ground, an
// item spawner palette (click → give). Takes the mouse while open.

import { fmtNumber, itemName, t, type TKey } from '../../i18n';
import { INTERACT_RANGE } from '../../../shared/constants';
import { ALL_ITEM_IDS, GEAR, itemCategory, WEAPONS } from '../../../shared/items';
import type { AmmoId, ClientAction, ConsumableId, EntityId, GearId, ItemCategory, ItemId, ThrowableId, WeaponInstance } from '../../../shared/types';
import type { FrameState, LocalPlayerView } from '../../game/types';
import { ariaTx, BarFill, button, clear, h, svgIcon, TextSlot, titleTx, tx } from '../dom';
import { gearIcon, ICONS, itemIcon, weaponIcon } from '../icons';
import type { HudEnv } from './shared';

const REFRESH_MS = 100;
const GROUND_DY = 2.5;
const BACKPACK_ORDER: ItemId[] = [
  'bandage', 'firstaid', 'medkit', 'energy', 'fuel', 'frag',
  'ammo_9mm', 'ammo_556', 'ammo_762', 'ammo_12g', 'ammo_300',
];
const USABLE: ReadonlySet<ItemId> = new Set<ItemId>(['bandage', 'firstaid', 'medkit', 'energy', 'fuel']);
const CATEGORY_LABEL: Record<ItemCategory, TKey> = {
  weapon: 'inv.category.weapon',
  ammo: 'inv.category.ammo',
  consumable: 'inv.category.consumable',
  throwable: 'inv.category.throwable',
  gear: 'inv.category.gear',
};
const HELMETS: readonly GearId[] = ['helmet1', 'helmet2', 'helmet3'];
const VESTS: readonly GearId[] = ['vest1', 'vest2', 'vest3'];
const PACKS: readonly GearId[] = ['pack1', 'pack2', 'pack3'];

export class Inventory {
  readonly el: HTMLDivElement;
  private open = false;
  private env: HudEnv | null = null;
  private lastRefresh = 0;
  private readonly ground: HTMLDivElement;
  private readonly backpack: HTMLDivElement;
  private readonly capText: TextSlot;
  private readonly capFill: BarFill;
  private readonly gear: HTMLDivElement;
  private readonly weapons: HTMLDivElement;
  private readonly palette: HTMLDivElement;
  private readonly paletteGrid: HTMLDivElement;
  private groundSig = '';
  private packSig = '';
  private equipSig = '';
  private paletteBuilt = false;

  constructor(private readonly onClose: () => void) {
    this.el = h('div', 'dz-inventory dz-hidden');
    this.el.setAttribute('role', 'dialog');
    ariaTx(this.el, 'inv.title');
    const panel = h('div', 'dz-inv-panel', this.el);
    const head = h('div', 'dz-inv-head', panel);
    tx(h('h2', 'dz-inv-title', head), 'inv.title');
    tx(h('span', 'dz-inv-hint', head), 'inv.hint');
    const close = button({ cls: 'dz-btn-icon-only', icon: ICONS.close, parent: head, onClick: () => this.onClose() });
    ariaTx(close, 'common.close');

    const cols = h('div', 'dz-inv-cols', panel);
    const groundCol = h('section', 'dz-inv-col dz-panel', cols);
    tx(h('h3', 'dz-inv-col-title', groundCol), 'inv.groundItems');
    this.ground = h('div', 'dz-inv-list', groundCol);

    const packCol = h('section', 'dz-inv-col dz-panel', cols);
    tx(h('h3', 'dz-inv-col-title', packCol), 'inv.backpack');
    const cap = h('div', 'dz-inv-cap', packCol);
    this.capText = new TextSlot(h('div', 'dz-inv-cap-text', cap));
    const capBar = h('div', 'dz-inv-cap-bar', cap);
    this.capFill = new BarFill(h('div', 'dz-inv-cap-fill', capBar));
    this.backpack = h('div', 'dz-inv-list', packCol);

    const equipCol = h('section', 'dz-inv-col dz-panel', cols);
    tx(h('h3', 'dz-inv-col-title', equipCol), 'inv.equipment');
    this.gear = h('div', 'dz-inv-gear', equipCol);
    const wHead = h('div', 'dz-inv-subhead', equipCol);
    tx(h('h3', 'dz-inv-col-title', wHead), 'inv.weapons');
    const swap = button({ cls: 'dz-btn-ghost dz-btn-sm', icon: ICONS.swap, parent: wHead, onClick: () => this.act({ a: 'swapWeapons' }) });
    titleTx(swap, 'controls.action.swapWeapons');
    ariaTx(swap, 'controls.action.swapWeapons');
    this.weapons = h('div', 'dz-inv-weapons', equipCol);

    this.palette = h('section', 'dz-inv-palette dz-panel dz-hidden', panel);
    const pHead = h('div', 'dz-inv-subhead', this.palette);
    tx(h('h3', 'dz-inv-col-title', pHead), 'training.giveItem');
    tx(h('span', 'dz-inv-hint', pHead), 'training.hint.give');
    this.paletteGrid = h('div', 'dz-inv-palette-grid', this.palette);

    // Right-click anywhere in the panel must never open the browser menu.
    this.el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  get isOpen(): boolean {
    return this.open;
  }

  attach(env: HudEnv): void {
    this.env = env;
    this.paletteBuilt = false;
    this.invalidate();
  }

  detach(): void {
    this.env = null;
    this.setOpen(false);
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.el.classList.toggle('dz-hidden', !open);
    this.lastRefresh = 0;
    this.invalidate();
    if (open && this.env?.context === 'training' && !this.paletteBuilt) this.buildPalette();
    this.palette.classList.toggle('dz-hidden', this.env?.context !== 'training');
  }

  invalidate(): void {
    this.groundSig = '';
    this.packSig = '';
    this.equipSig = '';
  }

  relabel(): void {
    this.invalidate();
    this.paletteBuilt = false;
    if (this.open && this.env?.context === 'training') this.buildPalette();
  }

  update(frame: FrameState): void {
    if (!this.open || !this.env) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    const self = frame.self;
    if (!self) return;
    this.renderGround(frame, self);
    this.renderBackpack(self);
    this.renderEquipment(self);
  }

  private act(a: ClientAction): void {
    this.env?.game.queueAction(a);
  }

  // --- ground -----------------------------------------------------------------------------------

  private renderGround(frame: FrameState, self: LocalPlayerView): void {
    const near: { id: EntityId; item: ItemId; count: number; mag?: number; d: number }[] = [];
    const p = self.pos;
    for (const l of frame.loot.values()) {
      const dx = l.pos.x - p.x, dz = l.pos.z - p.z;
      if (Math.abs(dx) > INTERACT_RANGE || Math.abs(dz) > INTERACT_RANGE) continue;
      const d = Math.hypot(dx, dz);
      if (d > INTERACT_RANGE || Math.abs(l.pos.y - p.y) > GROUND_DY) continue;
      near.push({ id: l.id, item: l.item, count: l.count, mag: l.mag, d });
    }
    near.sort((a, b) => a.d - b.d || a.id - b.id);
    const sig = near.map((n) => `${n.id}:${n.count}`).join(',');
    if (sig === this.groundSig) return;
    this.groundSig = sig;
    clear(this.ground);
    if (!near.length) {
      tx(h('div', 'dz-empty', this.ground), 'inv.nothingNearby');
      return;
    }
    for (const n of near) {
      const row = this.itemRow(this.ground, n.item, n.count, n.mag);
      titleTx(row, 'inv.pickUp');
      row.addEventListener('click', () => this.act({ a: 'pickup', id: n.id }));
    }
  }

  // --- backpack ---------------------------------------------------------------------------------

  private count(self: LocalPlayerView, id: ItemId): number {
    const cat = itemCategory(id);
    if (cat === 'ammo') return self.ammo[id as AmmoId] ?? 0;
    if (cat === 'consumable' || cat === 'throwable') return self.items[id as ConsumableId | ThrowableId] ?? 0;
    return 0;
  }

  private renderBackpack(self: LocalPlayerView): void {
    const [used, max] = self.capacity;
    this.capText.set(t('inv.capacity', { used: Math.round(used), max: Math.round(max) }));
    this.capFill.set(max > 0 ? used / max : 0);
    let sig = self.use ? `u${self.use.item}|` : '|';
    for (const id of BACKPACK_ORDER) sig += `${this.count(self, id)},`;
    if (sig === this.packSig) return;
    this.packSig = sig;
    clear(this.backpack);
    let any = false;
    for (const id of BACKPACK_ORDER) {
      const n = this.count(self, id);
      if (n <= 0) continue;
      any = true;
      const row = this.itemRow(this.backpack, id, n);
      const usable = USABLE.has(id);
      row.classList.toggle('dz-inv-usable', usable);
      if (self.use && self.use.item === id) row.classList.add('dz-inv-using');
      if (usable) {
        titleTx(row, 'inv.use');
        row.addEventListener('click', () => this.act({ a: 'use', item: id as ConsumableId }));
      }
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.act({ a: 'drop', item: id, count: n });
      });
      const drop = button({ cls: 'dz-btn-icon-only dz-inv-drop', icon: ICONS.drop, parent: row.parentElement as HTMLElement });
      ariaTx(drop, 'inv.dropAll');
      titleTx(drop, 'inv.dropAll');
      drop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.act({ a: 'drop', item: id, count: n });
      });
    }
    if (!any) tx(h('div', 'dz-empty', this.backpack), 'inv.empty');
  }

  // --- equipment --------------------------------------------------------------------------------

  private renderEquipment(self: LocalPlayerView): void {
    const a = self.armor;
    const w = self.weapons;
    const sig = `${a.helmet}:${Math.round(a.helmetHp)}|${a.vest}:${Math.round(a.vestHp)}|${a.pack}|`
      + `${w[0]?.id ?? ''}${w[0]?.mag ?? ''}|${w[1]?.id ?? ''}${w[1]?.mag ?? ''}|${w[2]?.id ?? ''}${w[2]?.mag ?? ''}|${self.activeSlot}`;
    if (sig === this.equipSig) return;
    this.equipSig = sig;
    clear(this.gear);
    this.gearSlot('inv.slot.helmet', a.helmet ? HELMETS[a.helmet - 1] : null, a.helmetHp);
    this.gearSlot('inv.slot.vest', a.vest ? VESTS[a.vest - 1] : null, a.vestHp);
    this.gearSlot('inv.slot.pack', a.pack ? PACKS[a.pack - 1] : null, -1);
    clear(this.weapons);
    for (let i = 0; i < 3; i++) this.weaponSlot(i as 0 | 1 | 2, w[i], self);
  }

  private gearSlot(label: TKey, id: GearId | null, hp: number): void {
    const slot = h('div', `dz-inv-gear-slot${id ? '' : ' dz-empty'}`, this.gear);
    slot.appendChild(svgIcon(id ? gearIcon(id) : label === 'inv.slot.helmet' ? ICONS.helmet : label === 'inv.slot.vest' ? ICONS.vest : ICONS.pack, 'dz-inv-gear-icon'));
    const text = h('div', 'dz-inv-gear-text', slot);
    tx(h('div', 'dz-inv-gear-label', text), label);
    const val = h('div', 'dz-inv-gear-value', text);
    if (!id) {
      tx(val, 'common.none');
      return;
    }
    const def = GEAR[id];
    val.textContent = t('inv.level', { n: def.level });
    if (hp >= 0 && def.durability > 0) {
      const pct = Math.round((hp / def.durability) * 100);
      const dur = h('div', 'dz-inv-dur', text);
      dur.textContent = t('inv.durability', { value: pct });
      const bar = h('div', 'dz-inv-dur-bar', text);
      const fill = h('div', 'dz-inv-dur-fill', bar);
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, hp / def.durability)).toFixed(3)})`;
      bar.classList.toggle('dz-low', pct < 25);
    }
    const drop = button({ cls: 'dz-btn-icon-only dz-inv-drop', icon: ICONS.drop, parent: slot, onClick: () => this.act({ a: 'drop', item: id }) });
    ariaTx(drop, 'inv.drop');
    titleTx(drop, 'inv.drop');
  }

  private weaponSlot(i: 0 | 1 | 2, w: WeaponInstance | null, self: LocalPlayerView): void {
    const slot = h('div', `dz-inv-weapon${w ? '' : ' dz-empty'}${self.activeSlot === i ? ' dz-active' : ''}`, this.weapons);
    const label = h('div', 'dz-inv-weapon-label', slot);
    label.textContent = i < 2 ? t('inv.slot.primary', { n: i + 1 }) : t('inv.slot.pistol');
    if (!w) {
      tx(h('div', 'dz-inv-weapon-name', slot), 'inv.empty');
      return;
    }
    const def = WEAPONS[w.id];
    const icon = h('div', 'dz-inv-weapon-icon', slot);
    icon.innerHTML = weaponIcon(w.id);
    icon.setAttribute('aria-hidden', 'true');
    h('div', 'dz-inv-weapon-name', slot).textContent = itemName(w.id);
    const meta = h('div', 'dz-inv-weapon-meta', slot);
    h('span', '', meta).textContent = `${fmtNumber(w.mag)}/${fmtNumber(def.magSize)}`;
    h('span', 'dz-dim', meta).textContent = itemName(def.ammo);
    const drop = button({ cls: 'dz-btn-icon-only dz-inv-drop', icon: ICONS.drop, parent: slot, onClick: () => this.act({ a: 'dropWeapon', slot: i }) });
    ariaTx(drop, 'inv.drop');
    titleTx(drop, 'inv.drop');
  }

  // --- shared rows ------------------------------------------------------------------------------

  /** A clickable item row; returns the row button (wrapped so a drop button can sit beside it). */
  private itemRow(parent: HTMLElement, id: ItemId, count: number, mag?: number): HTMLButtonElement {
    const wrap = h('div', 'dz-inv-item', parent);
    const row = h('button', 'dz-inv-row', wrap);
    row.type = 'button';
    const cat = itemCategory(id);
    row.appendChild(svgIcon(itemIcon(id, cat), `dz-inv-icon dz-inv-icon-${cat}`));
    h('span', 'dz-inv-name', row).textContent = itemName(id);
    const qty = h('span', 'dz-inv-qty', row);
    if (cat === 'weapon' && mag !== undefined) qty.textContent = fmtNumber(mag);
    else if (count > 1 || cat === 'ammo' || cat === 'consumable' || cat === 'throwable') qty.textContent = t('inv.count', { n: count });
    return row;
  }

  private buildPalette(): void {
    clear(this.paletteGrid);
    const groups = new Map<ItemCategory, ItemId[]>();
    for (const id of ALL_ITEM_IDS) {
      const c = itemCategory(id);
      let list = groups.get(c);
      if (!list) groups.set(c, (list = []));
      list.push(id);
    }
    for (const cat of ['weapon', 'ammo', 'consumable', 'throwable', 'gear'] as ItemCategory[]) {
      const ids = groups.get(cat);
      if (!ids?.length) continue;
      const group = h('div', 'dz-inv-palette-group', this.paletteGrid);
      tx(h('div', 'dz-inv-palette-title', group), CATEGORY_LABEL[cat]);
      const grid = h('div', 'dz-inv-palette-items', group);
      for (const id of ids) {
        const b = h('button', 'dz-inv-palette-item', grid);
        b.type = 'button';
        b.appendChild(svgIcon(itemIcon(id, cat), `dz-inv-icon dz-inv-icon-${cat}`));
        h('span', '', b).textContent = itemName(id);
        b.addEventListener('click', () => this.act({ a: 'give', item: id }));
      }
    }
    this.paletteBuilt = true;
  }
}
