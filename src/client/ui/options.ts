// Option lists shared by the single-player setup, lobby creation and lobby room.

import type { TKey } from '../i18n';
import type { BotDifficulty, TeamSize } from '../../shared/types';
import type { SegOption } from './controls';

export const TEAM_SIZE_OPTIONS: SegOption<TeamSize>[] = [
  { value: 1, label: 'sp.solo' },
  { value: 2, label: 'sp.duo' },
  { value: 4, label: 'sp.squad' },
];

export const DIFFICULTY_OPTIONS: SegOption<BotDifficulty>[] = [
  { value: 'easy', label: 'sp.easy' },
  { value: 'normal', label: 'sp.normal' },
  { value: 'hard', label: 'sp.hard' },
];

/** Zone timing multipliers (1 = normal, < 1 = faster). Stay inside the server clamp [0.25, 2]. */
export const ZONE_SPEED_OPTIONS: SegOption<number>[] = [
  { value: 1.5, label: 'sp.zoneSlow' },
  { value: 1, label: 'sp.zoneNormal' },
  { value: 0.6, label: 'sp.zoneFast' },
];

export function teamSizeKey(ts: TeamSize): TKey {
  return ts === 1 ? 'sp.solo' : ts === 2 ? 'sp.duo' : 'sp.squad';
}

export function difficultyKey(d: BotDifficulty): TKey {
  return d === 'easy' ? 'sp.easy' : d === 'hard' ? 'sp.hard' : 'sp.normal';
}

export function difficultyDescKey(d: BotDifficulty): TKey {
  return d === 'easy' ? 'sp.easyDesc' : d === 'hard' ? 'sp.hardDesc' : 'sp.normalDesc';
}

/** Closest zone speed option for an arbitrary multiplier. */
export function nearestZoneSpeed(v: number): number {
  let best = ZONE_SPEED_OPTIONS[1].value;
  let bd = Infinity;
  for (const o of ZONE_SPEED_OPTIONS) {
    const d = Math.abs(o.value - v);
    if (d < bd) { bd = d; best = o.value; }
  }
  return best;
}

export function zoneSpeedKey(v: number): TKey {
  const n = nearestZoneSpeed(v);
  return ZONE_SPEED_OPTIONS.find((o) => o.value === n)?.label ?? 'sp.zoneNormal';
}

export function isTeamSize(v: unknown): v is TeamSize {
  return v === 1 || v === 2 || v === 4;
}

export function isDifficulty(v: unknown): v is BotDifficulty {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

/** localStorage helpers (per-viewer conveniences only; every access guarded). */
export function loadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / blocked) */
  }
}
