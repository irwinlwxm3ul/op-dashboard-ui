// English dictionary: the source of truth for every translation key.
//
// Composed from fragments so several modules can add strings in parallel:
//   * en.core.ts                  — core keys (i18n module)
//   * src/client/ui/strings.en.ts — `ui.*` keys (UI module)
//   * src/client/feel/strings.en.ts — `feel.*` keys (game-feel module)
//   * src/client/app/strings.en.ts  — `flow.*` keys (app controller)
import { enCore } from './en.core';
import { uiStrings } from '../../ui/strings.en';
import { feelStrings } from '../../feel/strings.en';
import { appStrings } from '../../app/strings.en';

export const en = { ...enCore, ...uiStrings, ...feelStrings, ...appStrings } as const;

/** Every translation key of the merged English dictionary. */
export type TKey = keyof typeof en;

/** Keys owned by the i18n core dictionary (fully translated in every locale). */
export type CoreKey = keyof typeof enCore;

/**
 * Shape of a PRIORITY locale (zh-CN, zh-TW, zh-HK, ja — the game's main markets): every key is
 * required, so a missing translation is a compile error and `npm run check:i18n` fails.
 */
export type PriorityLocaleDict = Record<TKey, string>;

/**
 * Shape of every other locale (ru, es, fr, de, pt, ko, ar). These are lower priority for new strings:
 * any key may be missing and falls back to English at runtime (check:i18n reports it as a warning).
 */
export type LocaleDict = Partial<Record<TKey, string>>;
