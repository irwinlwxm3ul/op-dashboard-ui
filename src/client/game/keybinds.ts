// Default keyboard bindings (KeyboardEvent.code values). Chosen to avoid browser-reserved Ctrl
// combinations. Mouse buttons are fixed: left = fire, right = ADS, wheel = cycle weapons.

import type { KeyAction } from './types';

export const DEFAULT_KEYBINDS: Readonly<Record<KeyAction, string>> = Object.freeze({
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  walk: 'KeyX',
  jump: 'Space',
  crouch: 'KeyC',
  prone: 'KeyZ',
  leanLeft: 'KeyQ',
  leanRight: 'KeyE',
  reload: 'KeyR',
  interact: 'KeyF',
  throw: 'KeyG',
  holster: 'KeyH',
  slot1: 'Digit1',
  slot2: 'Digit2',
  slot3: 'Digit3',
  slot4: 'Digit4',
  swapWeapons: 'KeyB',
  inventory: 'Tab',
  map: 'KeyM',
  cameraToggle: 'KeyV',
  freeLook: 'AltLeft',
  useBandage: 'Digit7',
  useFirstAid: 'Digit8',
  useMedkit: 'Digit9',
  useEnergy: 'Digit0',
  refuel: 'KeyT',
  stats: 'F3',
  scoreboard: 'KeyP',
  menu: 'Escape',
});

/** Every bindable action, in a stable display order (controls screen). */
export const KEY_ACTIONS: readonly KeyAction[] = Object.freeze(Object.keys(DEFAULT_KEYBINDS) as KeyAction[]);

export function isKeyAction(x: unknown): x is KeyAction {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_KEYBINDS, x);
}

/** Plausible KeyboardEvent.code (letters, digits, named keys); rejects junk from storage. */
export function isKeyCode(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= 32 && /^[A-Za-z0-9]+$/.test(x);
}
