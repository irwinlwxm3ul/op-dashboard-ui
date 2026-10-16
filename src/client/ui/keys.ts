// Human-readable labels for KeyboardEvent.code values (keybind display). Uses the Keyboard Map API
// (Chromium) when available so AZERTY / QWERTZ users see the key printed on their keyboard; named
// keys (Space, Shift, …) are translated through i18n.

import { t, type TKey } from '../i18n';

type LayoutMap = { get(code: string): string | undefined };
interface KeyboardApi {
  getLayoutMap(): Promise<LayoutMap>;
  addEventListener?(type: 'layoutchange', cb: () => void): void;
}

let layout: LayoutMap | null = null;
let layoutRequested = false;
const layoutListeners = new Set<() => void>();

/** Ask the browser for the keyboard layout once; listeners fire when it becomes known / changes. */
export function initKeyboardLayout(): void {
  if (layoutRequested) return;
  layoutRequested = true;
  const kb = (typeof navigator !== 'undefined' ? (navigator as unknown as { keyboard?: KeyboardApi }).keyboard : undefined);
  if (!kb || typeof kb.getLayoutMap !== 'function') return;
  const load = () => {
    kb.getLayoutMap().then(
      (m) => {
        layout = m;
        for (const cb of layoutListeners) cb();
      },
      () => { /* permission / unsupported: keep code-based labels */ },
    );
  };
  load();
  kb.addEventListener?.('layoutchange', load);
}

export function onKeyboardLayout(cb: () => void): () => void {
  layoutListeners.add(cb);
  return () => layoutListeners.delete(cb);
}

const NAMED: Record<string, TKey> = {
  Space: 'ui.key.space',
  Tab: 'ui.key.tab',
  Escape: 'ui.key.escape',
  Enter: 'ui.key.enter',
  NumpadEnter: 'ui.key.enter',
  Backspace: 'ui.key.backspace',
  ShiftLeft: 'ui.key.shiftLeft',
  ShiftRight: 'ui.key.shiftRight',
  ControlLeft: 'ui.key.ctrlLeft',
  ControlRight: 'ui.key.ctrlRight',
  AltLeft: 'ui.key.altLeft',
  AltRight: 'ui.key.altRight',
  CapsLock: 'ui.key.capsLock',
  Delete: 'ui.key.delete',
  Insert: 'ui.key.insert',
  Home: 'ui.key.home',
  End: 'ui.key.end',
  PageUp: 'ui.key.pageUp',
  PageDown: 'ui.key.pageDown',
  ContextMenu: 'ui.key.menu',
};

const SYMBOLS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '<',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
  NumpadDecimal: '.',
};

/** Label for a KeyboardEvent.code. Empty / unknown codes give the "unbound" label. */
export function keyLabel(code: string | undefined | null): string {
  if (!code) return t('ui.key.unbound');
  const named = NAMED[code];
  if (named) return t(named);
  const fromLayout = layout?.get(code);
  if (fromLayout && fromLayout.trim().length === 1) return fromLayout.toUpperCase();
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    const sym = SYMBOLS[code];
    return t('ui.key.numpad', { key: sym ?? rest });
  }
  if (/^F\d{1,2}$/.test(code)) return code;
  const sym = SYMBOLS[code];
  if (sym) return sym;
  return code;
}

/** Codes the UI refuses to bind (browser / OS reserved). */
export const RESERVED_CODES: ReadonlySet<string> = new Set([
  'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
]);
