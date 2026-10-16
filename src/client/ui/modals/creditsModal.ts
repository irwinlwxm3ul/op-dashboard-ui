// Credits modal (main menu and pause menu): third-party assets with author, licence and links, as
// required by the CC BY 4.0 assets. Titles, authors and licence names are data (proper nouns),
// rendered with bidi isolation; headings and labels are translated.

import type { TKey } from '../../i18n';
import { WORLD_ASSET_CREDITS } from '../../assets/manifest-world';
import { button, h, tx, userText } from '../dom';
import { Modal, type ModalManager } from '../modal';

type LicenseId = 'CC0-1.0' | 'CC-BY-4.0' | 'OFL-1.1';

interface Credit {
  title: string;
  author: string;
  license: LicenseId;
  url: string;
}

/** Licence display names and canonical licence pages (data, not translated). */
const LICENSES: Record<LicenseId, { name: string; url: string }> = {
  'CC0-1.0': { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-4.0': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'OFL-1.1': { name: 'SIL OFL 1.1', url: 'https://openfontlicense.org/' },
};

/** Characters, animations, weapons and items (docs/ASSETS.md; no exported list in src/client/assets). */
const CHARACTER_ITEM_CREDITS: readonly Credit[] = [
  { title: 'Ultimate Modular Men', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com/packs/ultimatemodularcharacters.html' },
  { title: 'Ultimate Modular Women', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com/packs/ultimatemodularwomen.html' },
  { title: 'Universal Animation Library 1 & 2', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com' },
  { title: 'Ultimate Gun Pack', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com/packs/ultimategun.html' },
  { title: 'Survival Pack', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com/packs/survival.html' },
  { title: 'Toon Shooter Game Kit', author: 'Quaternius', license: 'CC0-1.0', url: 'https://quaternius.com/packs/toonshootergamekit.html' },
  { title: 'Low Poly Weapons Pack V.1', author: 'Zsky (@Zsky_01)', license: 'CC-BY-4.0', url: 'https://zsky2000.itch.io/low-poly-weapons-pack-v1' },
];

const SOUND_CREDITS: readonly Credit[] = [
  { title: 'Starter Kit FPS', author: 'Kenney', license: 'CC0-1.0', url: 'https://github.com/KenneyNL/Starter-Kit-FPS' },
];

const FONT_CREDITS: readonly Credit[] = [
  { title: 'Lilita One', author: 'Juan Montoreano', license: 'OFL-1.1', url: 'https://fonts.google.com/specimen/Lilita+One' },
];

/** All model credits: characters / items first, then the world (vehicles, props, nature). */
function modelCredits(): Credit[] {
  const world: Credit[] = WORLD_ASSET_CREDITS.map((c) => ({ title: c.title, author: c.author, license: c.license, url: c.url }));
  // Attribution-required (CC BY) entries first within each group, then alphabetical.
  const order = (a: Credit, b: Credit) =>
    (a.license === 'CC-BY-4.0' ? 0 : 1) - (b.license === 'CC-BY-4.0' ? 0 : 1) || a.title.localeCompare(b.title);
  return [...CHARACTER_ITEM_CREDITS].sort(order).concat(world.sort(order));
}

function link(parent: HTMLElement, cls: string, text: string, url: string): HTMLAnchorElement {
  const a = userText(h('a', cls, parent), text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export class CreditsModal extends Modal {
  constructor(mgr: ModalManager) {
    super(mgr, 'menu.credits', 'dz-credits-modal');
    tx(h('p', 'dz-lead', this.body), 'ui.credits.intro');
    this.section('ui.credits.models', modelCredits(), 'ui.credits.modifiedNote');
    this.section('ui.credits.sounds', SOUND_CREDITS);
    this.section('ui.credits.fonts', FONT_CREDITS);
    button({ cls: 'dz-btn-primary', label: 'common.close', parent: this.footer, onClick: () => this.close() });
  }

  private section(title: TKey, credits: readonly Credit[], note?: TKey): void {
    const sec = h('section', 'dz-credits-section', this.body);
    tx(h('h3', 'dz-keys-title', sec), title);
    if (note) tx(h('p', 'dz-credits-note', sec), note);
    const table = h('div', 'dz-table dz-credits-table', sec);
    table.setAttribute('role', 'table');
    const head = h('div', 'dz-tr dz-th', table);
    head.setAttribute('role', 'row');
    for (const k of ['ui.credits.colAsset', 'ui.credits.colAuthor', 'ui.credits.colLicense'] as const) {
      tx(h('div', 'dz-td', head), k).setAttribute('role', 'columnheader');
    }
    for (const c of credits) {
      const row = h('div', 'dz-tr', table);
      row.setAttribute('role', 'row');
      const lic = LICENSES[c.license];
      const titleCell = h('div', 'dz-td dz-td-strong', row);
      link(titleCell, 'dz-credits-link', c.title, c.url);
      userText(h('div', 'dz-td', row), c.author);
      const licCell = h('div', 'dz-td', row);
      link(licCell, `dz-credits-license${c.license === 'CC-BY-4.0' ? ' dz-credits-by' : ''}`, lic.name, lic.url);
      for (const cell of Array.from(row.children)) cell.setAttribute('role', 'cell');
    }
  }
}
