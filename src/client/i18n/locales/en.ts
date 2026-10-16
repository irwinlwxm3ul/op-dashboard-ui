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
 * Shape of a non-English locale. Every core key is required (a missing core translation is a
 * compile error); fragment keys (`ui.*`, `feel.*`, `flow.*`) are optional during the parallel
 * build and fall back to English at runtime.
 */
export type LocaleDict = Record<CoreKey, string> & Partial<Record<TKey, string>>;
