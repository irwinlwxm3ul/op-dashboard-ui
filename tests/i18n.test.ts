import { afterEach, describe, expect, it } from 'vitest';
import type { ItemId, VehicleType } from '../src/shared/types';
import {
  DICTIONARIES, LANGUAGES, errorText, fmtDuration, fmtNumber, getLanguage, hasKey, initI18n, isLang, isRTL,
  itemName, langDir, onLanguageChange, pickLanguage, setLanguage, t, translateDom, vehicleName,
  type Lang,
} from '../src/client/i18n';
import { en } from '../src/client/i18n/locales/en';
import { enCore } from '../src/client/i18n/locales/en.core';
import {
  compareKeys, comparePlaceholders, emptyValues, extractPlaceholders, incompletePluralFamilies, scanSource,
} from '../scripts/check-i18n';

const OTHER_LANGS = LANGUAGES.map((l) => l.code).filter((c): c is Exclude<Lang, 'en'> => c !== 'en');
const CORE_KEYS = Object.keys(enCore);

afterEach(() => setLanguage('en'));

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

describe('locale dictionaries', () => {
  it('LANGUAGES lists the 10 supported languages with native names; only Arabic is RTL', () => {
    expect(LANGUAGES).toHaveLength(10);
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'ru', 'zh', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'ar']);
    expect(LANGUAGES.map((l) => l.native)).toEqual([
      'English', 'Русский', '中文', 'Español', 'Français', 'Deutsch', 'Português', '日本語', '한국어', 'العربية',
    ]);
    expect(LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code)).toEqual(['ar']);
  });

  it.each(OTHER_LANGS)('%s translates every core key and has no unknown keys', (code) => {
    const dict = DICTIONARIES[code];
    expect(CORE_KEYS.filter((k) => !Object.hasOwn(dict, k))).toEqual([]);
    expect(compareKeys(en, dict).extra).toEqual([]);
    expect(emptyValues(dict)).toEqual([]);
  });

  it.each(OTHER_LANGS)('%s keeps the English placeholder set in every translation', (code) => {
    expect(comparePlaceholders(en, DICTIONARIES[code])).toEqual([]);
  });

  it.each(OTHER_LANGS)('%s actually translates (not an English copy)', (code) => {
    const dict = DICTIONARIES[code];
    const differs = CORE_KEYS.filter((k) => dict[k] !== (enCore as Record<string, string>)[k]).length;
    expect(differs / CORE_KEYS.length).toBeGreaterThan(0.6);
  });

  it('English core values are non-empty and plural families cover every CLDR category', () => {
    expect(emptyValues(enCore)).toEqual([]);
    expect(incompletePluralFamilies(enCore)).toEqual([]);
  });

  it('every language uses only plural categories that the core dictionary provides', () => {
    for (const { code } of LANGUAGES) {
      const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
      for (const c of categories) expect(Object.hasOwn(enCore, `hud.kills_${c}`), `${code}: ${c}`).toBe(true);
    }
  });

  it('has a key for every lobby error code and item / vehicle id', () => {
    const items: ItemId[] = [
      'pistol', 'smg', 'ar', 'shotgun', 'dmr', 'sniper', 'ammo_9mm', 'ammo_556', 'ammo_762', 'ammo_12g', 'ammo_300',
      'bandage', 'firstaid', 'medkit', 'energy', 'fuel', 'frag',
      'vest1', 'vest2', 'vest3', 'helmet1', 'helmet2', 'helmet3', 'pack1', 'pack2', 'pack3',
    ];
    for (const id of items) expect(hasKey(`item.${id}`), id).toBe(true);
    const vehicles: VehicleType[] = ['buggy', 'uaz', 'bike'];
    for (const v of vehicles) expect(hasKey(`vehicle.${v}`), v).toBe(true);
    for (const code of [
      'lobby.notFound', 'lobby.full', 'lobby.inGame', 'lobby.notHost', 'lobby.teamFull', 'lobby.notReady',
      'lobby.badSettings', 'lobby.nameInvalid', 'net.rateLimited', 'net.badMessage', 'net.versionMismatch', 'net.kicked',
    ]) {
      expect(hasKey(`error.${code}`), code).toBe(true);
    }
    expect(hasKey('hud.distanceMeters')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Language selection
// ---------------------------------------------------------------------------

describe('pickLanguage', () => {
  it('prefers a valid stored language', () => {
    expect(pickLanguage('ja', ['de-DE'])).toBe('ja');
    expect(pickLanguage('ar', [])).toBe('ar');
  });

  it('ignores an invalid stored value and falls back to the browser languages', () => {
    expect(pickLanguage('xx', ['fr-FR'])).toBe('fr');
    expect(pickLanguage('', ['ko'])).toBe('ko');
    expect(pickLanguage(null, ['ru-RU', 'en'])).toBe('ru');
  });

  it('matches by primary subtag', () => {
    expect(pickLanguage(null, ['pt-BR'])).toBe('pt');
    expect(pickLanguage(null, ['zh-TW'])).toBe('zh');
    expect(pickLanguage(null, ['zh-Hans-CN'])).toBe('zh');
    expect(pickLanguage(null, ['ar-EG'])).toBe('ar');
    expect(pickLanguage(null, ['es_MX'])).toBe('es');
  });

  it('takes the first supported browser language and defaults to English', () => {
    expect(pickLanguage(null, ['nl-NL', 'sv', 'de-AT'])).toBe('de');
    expect(pickLanguage(null, ['nl-NL', 'sv'])).toBe('en');
    expect(pickLanguage(null, [])).toBe('en');
    expect(pickLanguage('tlh', ['x-klingon'])).toBe('en');
  });

  it('isLang validates codes', () => {
    expect(isLang('ko')).toBe(true);
    expect(isLang('kr')).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });

  it('initI18n works without a DOM and returns a supported language', () => {
    const lang = initI18n();
    expect(isLang(lang)).toBe(true);
    expect(getLanguage()).toBe(lang);
  });
});

// ---------------------------------------------------------------------------
// t(), plurals, formatting
// ---------------------------------------------------------------------------

describe('t', () => {
  it('interpolates parameters and leaves unknown placeholders untouched', () => {
    expect(t('banner.youKilled', { name: 'Alex' })).toBe('You killed Alex');
    expect(t('prompt.pickupCount', { item: itemName('ammo_556'), count: 30 })).toBe('Pick up 5.56mm x30');
    expect(t('banner.youKilled')).toBe('You killed {name}');
    expect(t('feed.killed', { killer: 'A', victim: 'B' })).toBe('A killed B with {weapon}');
  });

  it('formats numeric parameters for the language', () => {
    expect(t('hud.distanceMeters', { n: 1234 })).toBe('1,234 m');
    setLanguage('de');
    expect(t('hud.distanceMeters', { n: 1234.5 })).toBe('1.234,5 m');
  });

  it('selects English plural forms', () => {
    expect(t('hud.kills', { count: 0 })).toBe('0 kills');
    expect(t('hud.kills', { count: 1 })).toBe('1 kill');
    expect(t('hud.kills', { count: 2 })).toBe('2 kills');
    expect(t('banner.killCount', { count: 1 })).toBe('1 kill');
    expect(t('hud.alive', { count: 1234 })).toBe('1,234 alive');
  });

  it('selects Russian plural forms', () => {
    setLanguage('ru');
    expect(t('hud.kills', { count: 1 })).toBe('1 убийство');
    expect(t('hud.kills', { count: 3 })).toBe('3 убийства');
    expect(t('hud.kills', { count: 5 })).toBe('5 убийств');
    expect(t('hud.kills', { count: 11 })).toBe('11 убийств');
    expect(t('hud.kills', { count: 21 })).toBe('21 убийство');
    expect(t('hud.kills', { count: 0 })).toBe('0 убийств');
    expect(t('lobby.startingIn', { count: 2 })).toBe('Матч начнётся через 2 секунды');
  });

  it('selects Arabic plural forms (zero, one, two, few, many, other)', () => {
    setLanguage('ar');
    expect(t('hud.kills', { count: 0 })).toBe('لا قتلى');
    expect(t('hud.kills', { count: 1 })).toBe('قتيل واحد');
    expect(t('hud.kills', { count: 2 })).toBe('قتيلان');
    expect(t('hud.kills', { count: 3 })).toBe(`${fmtNumber(3)} قتلى`);
    expect(t('hud.kills', { count: 11 })).toBe(`${fmtNumber(11)} قتيلًا`);
    expect(t('hud.kills', { count: 100 })).toBe(`${fmtNumber(100)} قتيل`);
  });

  it('falls back to _other, then to the key itself, when variants are missing', () => {
    expect(t('common.ok', { count: 3 })).toBe('OK');
    expect(t('mp.playersOfMax', { players: 3, max: 16 })).toBe('3/16');
  });

  it('falls back to English for keys a locale has not translated yet', () => {
    const untranslated = Object.keys(en).find((k) => !Object.hasOwn(DICTIONARIES.ru, k));
    setLanguage('ru');
    if (untranslated !== undefined && hasKey(untranslated)) {
      expect(t(untranslated)).toBe((en as Record<string, string>)[untranslated]);
    }
    expect(t('common.ok')).toBe('ОК');
  });

  it('itemName / vehicleName / errorText map codes to text', () => {
    expect(itemName('ar')).toBe('AR-5 Rifle');
    expect(vehicleName('uaz')).toBe('Off-road 4x4');
    expect(errorText('lobby.full')).toBe(t('error.lobby.full'));
    expect(errorText('net.serverOffline')).toBe(t('error.net.serverOffline'));
    expect(errorText('something.else')).toBe(t('error.unknown'));
    setLanguage('ja');
    expect(itemName('frag')).toBe('破片手榴弾');
  });
});

describe('formatting', () => {
  it('fmtDuration renders m:ss', () => {
    expect(fmtDuration(0)).toBe('0:00');
    expect(fmtDuration(5)).toBe('0:05');
    expect(fmtDuration(65.9)).toBe('1:05');
    expect(fmtDuration(3599)).toBe('59:59');
    expect(fmtDuration(4000)).toBe('66:40');
    expect(fmtDuration(-3)).toBe('0:00');
    expect(fmtDuration(Number.NaN)).toBe('0:00');
  });

  it('fmtNumber follows the language', () => {
    expect(fmtNumber(1234.5)).toBe('1,234.5');
    expect(fmtNumber(0.256, { style: 'percent' })).toBe('26%');
    setLanguage('de');
    expect(fmtNumber(1234.5)).toBe('1.234,5');
    setLanguage('fr');
    expect(fmtDuration(75)).toBe('1:15');
  });
});

describe('language switching', () => {
  it('notifies listeners on change and supports unsubscribe', () => {
    const seen: Lang[] = [];
    const off = onLanguageChange((l) => seen.push(l));
    setLanguage('ko');
    setLanguage('ko'); // unchanged: no notification
    setLanguage('ar');
    off();
    setLanguage('es');
    expect(seen).toEqual(['ko', 'ar']);
  });

  it('tracks direction', () => {
    setLanguage('ar');
    expect(isRTL()).toBe(true);
    expect(langDir()).toBe('rtl');
    setLanguage('zh');
    expect(isRTL()).toBe(false);
    expect(langDir('ar')).toBe('rtl');
  });

  it('ignores unsupported codes', () => {
    setLanguage('de');
    setLanguage('xx' as Lang);
    expect(getLanguage()).toBe('de');
  });
});

// ---------------------------------------------------------------------------
// translateDom (with a minimal element fake; the test environment has no DOM)
// ---------------------------------------------------------------------------

class FakeElement {
  textContent = '';
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  constructor(attrs: Record<string, string> = {}, children: FakeElement[] = []) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    this.children.push(...children);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  /** Supports the attribute-presence selector lists translateDom uses. */
  matches(selector: string): boolean {
    return selector.split(',').some((s) => this.attrs.has(s.trim().replace(/^\[|\]$/g, '')));
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

describe('translateDom', () => {
  it('fills text, title, placeholder and aria-label, with JSON params', () => {
    const label = new FakeElement({ 'data-i18n': 'menu.settings' });
    const input = new FakeElement({ 'data-i18n-placeholder': 'lobby.chatPlaceholder', 'data-i18n-title': 'lobby.chat' });
    const btn = new FakeElement({ 'data-i18n-aria': 'common.close' });
    const banner = new FakeElement({ 'data-i18n': 'banner.youKilled', 'data-i18n-params': '{"name":"Kim"}' });
    const broken = new FakeElement({ 'data-i18n': 'common.ok', 'data-i18n-params': '{not json' });
    const root = new FakeElement({ 'data-i18n': 'app.title' }, [label, new FakeElement({}, [input, btn, banner, broken])]);

    setLanguage('fr');
    translateDom(root as unknown as ParentNode);
    expect(root.textContent).toBe('DROPZONE');
    expect(label.textContent).toBe('Paramètres');
    expect(input.getAttribute('placeholder')).toBe('Écrivez un message…');
    expect(input.getAttribute('title')).toBe('Discussion');
    expect(btn.getAttribute('aria-label')).toBe('Fermer');
    expect(banner.textContent).toBe('Vous avez tué Kim');
    expect(broken.textContent).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
// check-i18n helpers
// ---------------------------------------------------------------------------

describe('check-i18n key helpers', () => {
  it('extracts placeholders', () => {
    expect(extractPlaceholders('{killer} killed {victim} with {weapon} ({killer})')).toEqual(['killer', 'victim', 'weapon']);
    expect(extractPlaceholders('no params')).toEqual([]);
  });

  it('reports missing / unknown keys and placeholder mismatches', () => {
    const ref = { a: 'Hello {name}', b: 'B', c_one: '{count} item', c_other: '{count} items' };
    expect(compareKeys(ref, { a: 'x {name}', z: 'z' })).toEqual({ missing: ['b', 'c_one', 'c_other'], extra: ['z'] });
    expect(comparePlaceholders(ref, { a: 'Hallo {nom}', c_one: 'ein Ding', c_other: 'Dinge' })).toEqual([
      { key: 'a', expected: ['name'], actual: ['nom'] },
      { key: 'c_other', expected: ['count'], actual: [] },
    ]);
    expect(incompletePluralFamilies(ref)).toEqual([{ stem: 'c', missing: ['zero', 'two', 'few', 'many'] }]);
  });
});

describe('check-i18n hardcoded-string scanner', () => {
  const lines = (src: string) => scanSource(src).map((v) => v.line);

  it('flags literal text assigned to textContent and ignores t() calls', () => {
    expect(scanSource('el.textContent = "Hello";')).toHaveLength(1);
    expect(scanSource("el.textContent = 'Hello'")[0]).toMatchObject({ line: 1, sink: '.textContent', text: 'Hello' });
    expect(scanSource('el.textContent = t("x");')).toEqual([]);
    expect(scanSource("el.textContent = t('hud.kills', { count: n }) + ' · ' + fmtDuration(s);")).toEqual([]);
  });

  it('checks every text sink', () => {
    expect(lines("a.innerText = 'Go';\nb.placeholder = 'Name';\nc.title = 'Close';\nd.alt = 'Logo';\ne.textContent += 'more';")).toEqual([1, 2, 3, 4, 5]);
    expect(lines("el.setAttribute('title', 'Close');\nel.setAttribute('aria-label', `Open ${x}`);")).toEqual([1, 2]);
    expect(scanSource("el.setAttribute('aria-label', t('common.close'));\nel.setAttribute('data-id', 'abc');")).toEqual([]);
  });

  it('allows templates that interpolate only expressions, digits and symbols', () => {
    expect(scanSource('el.textContent = `${a} / ${b}`;')).toEqual([]);
    expect(scanSource('el.textContent = `${mag}  |  ${reserve} — 100%`;')).toEqual([]);
    expect(scanSource("el.textContent = '';\nel.textContent = String(n);\nel.textContent = `#${place}`;")).toEqual([]);
    expect(lines('el.textContent = `${n} kills`;')).toEqual([1]);
    expect(lines('el.textContent = `${ok ? "Yes" : t("common.no")}`;')).toEqual([1]);
  });

  it('flags literals reaching the sink through conditionals and concatenation', () => {
    expect(lines("el.textContent = ready ? t('common.ready') : 'Waiting';")).toEqual([1]);
    expect(lines("el.textContent = n + ' kills';")).toEqual([1]);
    expect(lines("el.textContent = (a ?? 'Unknown');")).toEqual([1]);
    expect(scanSource("el.textContent = names.join(', ');\nel.textContent = map['key'];")).toEqual([]);
  });

  it('scans innerHTML for visible words outside tags and attributes', () => {
    expect(scanSource('el.innerHTML = `<div class="row"><span class="k">${t("a")}</span>${v}</div>`;')).toEqual([]);
    expect(scanSource("el.innerHTML = '<br>&nbsp;<hr/>';")).toEqual([]);
    expect(lines('el.innerHTML = "<b>Hello</b>";')).toEqual([1]);
    expect(lines('el.innerHTML = `<button data-x="${id}">\n  Close\n</button>`;')).toEqual([1]);
    expect(lines('el.innerHTML = `<button title="Close">×</button>`;')).toEqual([1]);
    expect(lines('el.innerHTML = rows.map((r) => `<li>Item ${r}</li>`).join("");')).toEqual([1]);
    expect(scanSource('el.innerHTML = rows.map((r) => `<li class="i">${esc(r)}</li>`).join("");')).toEqual([]);
  });

  it('flags alert/confirm/prompt with literal text only for the global dialogs', () => {
    expect(lines("alert('Oops');\nwindow.confirm('Sure?');\nconst x = prompt(`Name?`);")).toEqual([1, 2, 3]);
    expect(scanSource("alert(t('error.unknown'));\nui.prompt('pickup');\nfunction confirm(msg: string) { return msg; }")).toEqual([]);
  });

  it('honours i18n-ignore on the line or on a comment line right above', () => {
    expect(scanSource("el.textContent = 'DEBUG'; // i18n-ignore")).toEqual([]);
    expect(scanSource("// i18n-ignore: developer overlay\nel.textContent = 'DEBUG';")).toEqual([]);
    expect(lines("const x = 1; // i18n-ignore\n\nel.textContent = 'DEBUG';")).toEqual([3]);
  });

  it('is not fooled by comments, strings or regex literals', () => {
    expect(scanSource("// el.textContent = 'Hello';\n/* el.title = 'x' */\nconst s = \"el.textContent = 'Hi'\";")).toEqual([]);
    expect(lines("const re = /'[a-z]\"/g;\nconst d = a / b / c;\nel.textContent = 'Hi';")).toEqual([3]);
    expect(scanSource("el.textContent = '\\n\\t';\nel.className = 'hud-label';\nif (el.title === 'x') {}")).toEqual([]);
  });

  it('reports the right line in multi-line statements', () => {
    const src = ['function f() {', '  label.textContent =', '    cond', "      ? t('a')", "      : 'Fallback';", '}'].join('\n');
    expect(lines(src)).toEqual([5]);
  });
});
