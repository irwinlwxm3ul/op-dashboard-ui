// Internationalisation: type-checked translation keys, plural selection via Intl.PluralRules,
// locale-aware number/duration formatting, <html lang dir> handling and declarative DOM
// translation through data-i18n* attributes.
//
// English (`locales/en.ts`) is the source of truth. Every other locale falls back to English for
// keys it does not (yet) translate, so a missing translation never shows a raw key.

import type { ItemId, VehicleType } from '../../shared/types';
import type { LobbyErrorCode } from '../../shared/protocol';
import type { KeyAction } from '../game/types';
import { en, type TKey } from './locales/en';
import { ru } from './locales/ru';
import { zh } from './locales/zh';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { de } from './locales/de';
import { pt } from './locales/pt';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { ar } from './locales/ar';

export type { TKey, CoreKey, LocaleDict } from './locales/en';

export type Lang = 'en' | 'ru' | 'zh' | 'es' | 'fr' | 'de' | 'pt' | 'ja' | 'ko' | 'ar';

export const LANGUAGES: { code: Lang; native: string; dir: 'ltr' | 'rtl' }[] = [
  { code: 'en', native: 'English', dir: 'ltr' },
  { code: 'ru', native: 'Русский', dir: 'ltr' },
  { code: 'zh', native: '中文', dir: 'ltr' },
  { code: 'es', native: 'Español', dir: 'ltr' },
  { code: 'fr', native: 'Français', dir: 'ltr' },
  { code: 'de', native: 'Deutsch', dir: 'ltr' },
  { code: 'pt', native: 'Português', dir: 'ltr' },
  { code: 'ja', native: '日本語', dir: 'ltr' },
  { code: 'ko', native: '한국어', dir: 'ltr' },
  { code: 'ar', native: 'العربية', dir: 'rtl' },
];

/** localStorage key holding the player's chosen language. */
export const LANG_STORAGE_KEY = 'dz.lang';

/** Plural categories used as key suffixes (`key_one`, `key_few`, ...). */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * Base keys of plural families: `hud.alive` for `hud.alive_one` / `hud.alive_other` / ....
 * Every family has an `_other` variant, so the stems are derived from those.
 */
export type PluralKey = PluralStem<TKey>;
type PluralStem<K> = K extends `${infer B}_other` ? B : never; // distributive over the key union

/** Parameters for interpolation. `count` (number) also selects the plural variant. */
export type TParams = Record<string, string | number>;

/** Error codes the UI can display (server lobby/net codes plus client-side network failures). */
export type ErrorCode = LobbyErrorCode | 'net.disconnected' | 'net.connectFailed' | 'net.serverOffline';

type Dict = Readonly<Partial<Record<string, string>>>;

const DICTS: Record<Lang, Dict> = { en, ru, zh, es, fr, de, pt, ja, ko, ar };
const EN: Dict = en;

/** Every language's dictionary (read-only; used by scripts/check-i18n.ts and tests). */
export const DICTIONARIES: Readonly<Record<Lang, Dict>> = DICTS;

/** BCP 47 locale handed to Intl for each language (zh is Simplified Chinese). */
const INTL_LOCALE: Record<Lang, string> = {
  en: 'en', ru: 'ru', zh: 'zh-CN', es: 'es', fr: 'fr', de: 'de', pt: 'pt-BR', ja: 'ja', ko: 'ko', ar: 'ar',
};

const LANG_SET: ReadonlySet<string> = new Set(LANGUAGES.map((l) => l.code));
const RTL_SET: ReadonlySet<Lang> = new Set(LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code));

let current: Lang = 'en';
let dict: Dict = EN;
const listeners: ((lang: Lang) => void)[] = [];

// ---------------------------------------------------------------------------
// Intl caches (constructing Intl objects is expensive; t()/fmt* run every frame from the HUD)
// ---------------------------------------------------------------------------

let pluralRules: Intl.PluralRules | null = null;
let numberFmt: Intl.NumberFormat | null = null;
let minutesFmt: Intl.NumberFormat | null = null;
let secondsFmt: Intl.NumberFormat | null = null;
const customNumberFmts = new Map<string, Intl.NumberFormat>();

function resetIntlCaches(): void {
  pluralRules = null;
  numberFmt = null;
  minutesFmt = null;
  secondsFmt = null;
  customNumberFmts.clear();
}

function getPluralRules(): Intl.PluralRules {
  return (pluralRules ??= new Intl.PluralRules(INTL_LOCALE[current]));
}

// ---------------------------------------------------------------------------
// Language selection
// ---------------------------------------------------------------------------

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && LANG_SET.has(value);
}

/**
 * Chooses the UI language: a valid stored choice wins, then the first browser language whose
 * primary subtag is supported (pt-BR -> pt, zh-TW -> zh, ar-EG -> ar), else English.
 */
export function pickLanguage(stored: string | null, navLangs: readonly string[]): Lang {
  if (stored != null) {
    const s = stored.trim().toLowerCase();
    if (isLang(s)) return s;
  }
  for (const tag of navLangs) {
    if (typeof tag !== 'string') continue;
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLang(primary)) return primary;
  }
  return 'en';
}

function readStoredLanguage(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null; // storage blocked (privacy mode, sandboxed iframe)
  }
}

function writeStoredLanguage(lang: Lang): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Storage unavailable: the choice simply lasts for this session.
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return typeof navigator.language === 'string' && navigator.language ? [navigator.language] : [];
}

function applyDocumentLanguage(): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const html = document.documentElement;
  html.setAttribute('lang', current === 'zh' ? 'zh-Hans' : current);
  html.setAttribute('dir', RTL_SET.has(current) ? 'rtl' : 'ltr');
}

function translateBody(): void {
  if (typeof document !== 'undefined' && document.body) translateDom(document.body);
}

function switchTo(lang: Lang): boolean {
  const changed = lang !== current;
  current = lang;
  dict = DICTS[lang];
  if (changed) resetIntlCaches();
  applyDocumentLanguage();
  translateBody();
  return changed;
}

function notify(): void {
  // Copy so listeners may unsubscribe (or subscribe) while being notified.
  for (const cb of listeners.slice()) {
    try {
      cb(current);
    } catch (err) {
      console.error('[i18n] language listener failed', err);
    }
  }
}

/** Detects the language (localStorage > navigator.languages > en) and applies <html lang dir>. */
export function initI18n(): Lang {
  const lang = pickLanguage(readStoredLanguage(), browserLanguages());
  if (switchTo(lang)) notify();
  return lang;
}

/** Switches language: persists the choice, updates <html lang dir>, re-translates the DOM, notifies. */
export function setLanguage(lang: Lang): void {
  if (!isLang(lang)) return;
  writeStoredLanguage(lang);
  if (switchTo(lang)) notify();
}

export function getLanguage(): Lang {
  return current;
}

/** Subscribes to language changes; returns the unsubscribe function. */
export function onLanguageChange(cb: (lang: Lang) => void): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function isRTL(): boolean {
  return RTL_SET.has(current);
}

/** Text direction of a language (defaults to the current one). */
export function langDir(lang: Lang = current): 'ltr' | 'rtl' {
  return RTL_SET.has(lang) ? 'rtl' : 'ltr';
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** True when `key` exists in the English dictionary (useful for keys built at runtime). */
export function hasKey(key: string): key is TKey {
  return Object.hasOwn(EN, key);
}

function lookup(key: string): string {
  return dict[key] ?? EN[key] ?? key;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(text: string, params: TParams): string {
  if (text.indexOf('{') < 0) return text;
  return text.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    const v = params[name];
    return typeof v === 'number' ? fmtNumber(v) : v;
  });
}

/**
 * Translates `key` into the current language.
 * * `{name}` placeholders are replaced from `params` (numbers formatted for the language).
 * * When `params.count` is a number, the plural variant `key_<category>` is chosen with
 *   Intl.PluralRules (falling back to `key_other`, then `key`).
 */
export function t(key: TKey | PluralKey, params?: TParams): string {
  let k: string = key;
  if (params !== undefined && typeof params.count === 'number') {
    const variant = `${key}_${getPluralRules().select(params.count)}`;
    if (Object.hasOwn(EN, variant)) k = variant;
    else if (Object.hasOwn(EN, `${key}_other`)) k = `${key}_other`;
  }
  const text = lookup(k);
  return params === undefined ? text : interpolate(text, params);
}

export function itemName(id: ItemId): string {
  return t(`item.${id}`);
}

export function vehicleName(type: VehicleType): string {
  return t(`vehicle.${type}`);
}

/** Human-readable description of a key binding action (controls screen). */
export function actionName(action: KeyAction): string {
  return t(`controls.action.${action}`);
}

/** Message for a server/network error code; unknown codes map to a generic error. */
export function errorText(code: ErrorCode | (string & {})): string {
  const key = `error.${code}`;
  return hasKey(key) ? t(key) : t('error.unknown');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Formats a number for the current language (grouping, decimal separator, digits). */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  if (opts === undefined) {
    return (numberFmt ??= new Intl.NumberFormat(INTL_LOCALE[current], { maximumFractionDigits: 2 })).format(n);
  }
  const cacheKey = JSON.stringify(opts);
  let fmt = customNumberFmts.get(cacheKey);
  if (fmt === undefined) {
    fmt = new Intl.NumberFormat(INTL_LOCALE[current], opts);
    customNumberFmts.set(cacheKey, fmt);
  }
  return fmt.format(n);
}

/**
 * Formats seconds as m:ss (minutes are not capped, e.g. 75:03) with locale digits. Rounds down;
 * pass Math.ceil(x) for countdowns that should only show 0:00 once time is up.
 */
export function fmtDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const loc = INTL_LOCALE[current];
  minutesFmt ??= new Intl.NumberFormat(loc, { useGrouping: false, maximumFractionDigits: 0 });
  secondsFmt ??= new Intl.NumberFormat(loc, { useGrouping: false, minimumIntegerDigits: 2, maximumFractionDigits: 0 });
  return `${minutesFmt.format(Math.floor(total / 60))}:${secondsFmt.format(total % 60)}`;
}

// ---------------------------------------------------------------------------
// Declarative DOM translation
// ---------------------------------------------------------------------------

const DOM_SELECTOR = '[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria]';

function readDomParams(el: Element): TParams | undefined {
  const raw = el.getAttribute('data-i18n-params');
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const out: TParams = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') out[k] = v;
    }
    return out;
  } catch {
    return undefined;
  }
}

function translateElement(el: Element): void {
  const params = readDomParams(el);
  const text = el.getAttribute('data-i18n');
  if (text) el.textContent = t(text as TKey, params);
  const title = el.getAttribute('data-i18n-title');
  if (title) el.setAttribute('title', t(title as TKey, params));
  const placeholder = el.getAttribute('data-i18n-placeholder');
  if (placeholder) el.setAttribute('placeholder', t(placeholder as TKey, params));
  const aria = el.getAttribute('data-i18n-aria');
  if (aria) el.setAttribute('aria-label', t(aria as TKey, params));
}

/**
 * Fills every element under `root` (and `root` itself) carrying data-i18n (textContent),
 * data-i18n-title, data-i18n-placeholder or data-i18n-aria (aria-label). Optional
 * data-i18n-params holds a JSON object of interpolation parameters.
 */
export function translateDom(root: ParentNode): void {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const self = root as Partial<Element>;
  if (typeof self.matches === 'function' && self.matches(DOM_SELECTOR)) translateElement(root as Element);
  const nodes = root.querySelectorAll(DOM_SELECTOR);
  for (let i = 0; i < nodes.length; i++) translateElement(nodes[i]);
}
