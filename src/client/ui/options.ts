// Option lists shared by the single-player setup, lobby creation and lobby room.

import type { TKey } from '../i18n';
import type { BotDifficulty, TeamSize } from '../../shared/types';
import type { SegOption } from './controls';

export const TEAM_SIZE_OPTIONS: SegOption<TeamSize>[] = [
  { value: 1, label: 'ui.teamSize.solo' },
  { value: 2, label: 'ui.teamSize.duo' },
  { value: 4, label: 'ui.teamSize.squad' },
];

export const DIFFICULTY_OPTIONS: SegOption<BotDifficulty>[] = [
  { value: 'easy', label: 'ui.difficulty.easy' },
  { value: 'normal', label: 'ui.difficulty.normal' },
  { value: 'hard', label: 'ui.difficulty.hard' },
];

/** Zone timing multipliers (1 = normal, < 1 = faster). Stay inside the server clamp [0.25, 2]. */
export const ZONE_SPEED_OPTIONS: SegOption<number>[] = [
  { value: 1.5, label: 'ui.zoneSpeed.relaxed' },
  { value: 1, label: 'ui.zoneSpeed.normal' },
  { value: 0.7, label: 'ui.zoneSpeed.fast' },
  { value: 0.45, label: 'ui.zoneSpeed.blitz' },
];

export function teamSizeKey(ts: TeamSize): TKey {
  return ts === 1 ? 'ui.teamSize.solo' : ts === 2 ? 'ui.teamSize.duo' : 'ui.teamSize.squad';
}

export function difficultyKey(d: BotDifficulty): TKey {
  return d === 'easy' ? 'ui.difficulty.easy' : d === 'hard' ? 'ui.difficulty.hard' : 'ui.difficulty.normal';
}

export function difficultyDescKey(d: BotDifficulty): TKey {
  return d === 'easy' ? 'ui.difficulty.easyDesc' : d === 'hard' ? 'ui.difficulty.hardDesc' : 'ui.difficulty.normalDesc';
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
  return ZONE_SPEED_OPTIONS.find((o) => o.value === n)?.label ?? 'ui.zoneSpeed.normal';
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
