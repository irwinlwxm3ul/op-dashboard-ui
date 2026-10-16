// Persistent, validated user settings (localStorage key `dz.settings`). Works without
// localStorage (Node tests, private mode): falls back to in-memory only.

import { MAX_NAME_LEN } from '../../shared/constants';
import { DEFAULT_KEYBINDS, isKeyAction, isKeyCode, KEY_ACTIONS } from './keybinds';
import type { CameraMode, KeyAction, Quality, Settings, SettingsStore } from './types';

export const SETTINGS_STORAGE_KEY = 'dz.settings';

export const FOV_MIN = 70;
export const FOV_MAX = 100;
export const SENSITIVITY_MIN = 0.05;
export const SENSITIVITY_MAX = 5;
export const RENDER_SCALE_MIN = 0.5;
export const RENDER_SCALE_MAX = 1.5;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  playerName: '',
  quality: 'medium',
  renderScale: 1,
  fov: 85,
  mouseSensitivity: 1,
  adsSensitivity: 1,
  scopeSensitivity: 1,
  invertY: false,
  masterVolume: 0.8,
  sfxVolume: 1,
  uiVolume: 0.7,
  showFps: false,
  damageNumbers: true,
  toggleCrouch: true,
  toggleAds: false,
  cameraMode: 'tpp',
  keybinds: { ...DEFAULT_KEYBINDS },
} satisfies Settings);

/** Minimal Storage surface (localStorage or a test double). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const QUALITIES: readonly Quality[] = ['low', 'medium', 'high', 'ultra'];
const CAMERA_MODES: readonly CameraMode[] = ['tpp', 'fpp'];

const num = (x: unknown, lo: number, hi: number, def: number): number =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def;
const bool = (x: unknown, def: boolean): boolean => (typeof x === 'boolean' ? x : def);

function cleanName(x: unknown, def: string): string {
  if (typeof x !== 'string') return def;
  // eslint-disable-next-line no-control-regex
  return x.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LEN);
}

function cleanKeybinds(raw: unknown, base: Record<KeyAction, string>): Record<KeyAction, string> {
  const out: Record<KeyAction, string> = { ...base };
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [action, code] of Object.entries(raw as Record<string, unknown>)) {
    if (isKeyAction(action) && isKeyCode(code)) out[action] = code;
  }
  return out;
}

/** Validate an arbitrary (possibly corrupted / partial) object into complete Settings. */
export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    playerName: cleanName(r.playerName, base.playerName),
    quality: QUALITIES.includes(r.quality as Quality) ? (r.quality as Quality) : base.quality,
    renderScale: num(r.renderScale, RENDER_SCALE_MIN, RENDER_SCALE_MAX, base.renderScale),
    fov: Math.round(num(r.fov, FOV_MIN, FOV_MAX, base.fov)),
    mouseSensitivity: num(r.mouseSensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX, base.mouseSensitivity),
    adsSensitivity: num(r.adsSensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX, base.adsSensitivity),
    scopeSensitivity: num(r.scopeSensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX, base.scopeSensitivity),
    invertY: bool(r.invertY, base.invertY),
    masterVolume: num(r.masterVolume, 0, 1, base.masterVolume),
    sfxVolume: num(r.sfxVolume, 0, 1, base.sfxVolume),
    uiVolume: num(r.uiVolume, 0, 1, base.uiVolume),
    showFps: bool(r.showFps, base.showFps),
    damageNumbers: bool(r.damageNumbers, base.damageNumbers),
    toggleCrouch: bool(r.toggleCrouch, base.toggleCrouch),
    toggleAds: bool(r.toggleAds, base.toggleAds),
    cameraMode: CAMERA_MODES.includes(r.cameraMode as CameraMode) ? (r.cameraMode as CameraMode) : base.cameraMode,
    keybinds: cleanKeybinds(r.keybinds, base.keybinds),
  };
}

function browserStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    // Accessing storage can throw (blocked cookies / sandboxed iframes).
    ls.getItem(SETTINGS_STORAGE_KEY);
    return ls;
  } catch {
    return null;
  }
}

/**
 * Settings store. `get()` returns an immutable snapshot that is replaced (new object) on every
 * change, so consumers can cheaply detect changes by reference.
 */
export class LocalSettingsStore implements SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(private readonly storage: StorageLike | null = browserStorage(), private readonly key = SETTINGS_STORAGE_KEY) {
    let stored: unknown = null;
    if (storage) {
      try {
        const text = storage.getItem(key);
        if (text) stored = JSON.parse(text);
      } catch {
        stored = null; // corrupted JSON -> defaults
      }
    }
    this.current = freeze(sanitizeSettings(stored));
  }

  get(): Settings {
    return this.current;
  }

  set(patch: Partial<Settings>): void {
    const merged = { ...this.current, ...patch } as Settings;
    if (patch.keybinds) merged.keybinds = { ...this.current.keybinds, ...patch.keybinds };
    this.commit(sanitizeSettings(merged, this.current));
  }

  /** Bind `code` to `action`; an action that already used `code` takes over the old key (swap). */
  setKey(action: KeyAction, code: string): void {
    if (!isKeyAction(action) || !isKeyCode(code)) return;
    const binds = { ...this.current.keybinds };
    const previous = binds[action];
    for (const other of KEY_ACTIONS) {
      if (other !== action && binds[other] === code) binds[other] = previous;
    }
    binds[action] = code;
    this.commit({ ...this.current, keybinds: binds });
  }

  resetKeybinds(): void {
    this.commit({ ...this.current, keybinds: { ...DEFAULT_KEYBINDS } });
  }

  subscribe(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private commit(next: Settings): void {
    this.current = freeze(next);
    if (this.storage) {
      try {
        this.storage.setItem(this.key, JSON.stringify(this.current));
      } catch {
        // quota / privacy mode: keep the in-memory value
      }
    }
    for (const cb of this.listeners) {
      try {
        cb(this.current);
      } catch (err) {
        console.error('[settings] listener failed', err);
      }
    }
  }
}

function freeze(s: Settings): Settings {
  Object.freeze(s.keybinds);
  return Object.freeze(s);
}

/** App-wide settings singleton. */
export const settings: SettingsStore = new LocalSettingsStore();
