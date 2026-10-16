// Weapon knowledge for bots: ballistic look-up tables (time of flight and hold-over against the
// 100 m zeroed sight, sampled every 10 m so the per-tick aim code never integrates trajectories),
// preferred engagement ranges and a simple weapon rating.

import { WEAPONS, WEAPON_IDS, simulateTrajectory, sightDrop } from '../items';
import type { PlayerState, WeaponDef, WeaponId, WeaponInstance } from '../types';

const TABLE_STEP = 10;
const TABLE_MAX = 1200;
const TABLE_N = TABLE_MAX / TABLE_STEP + 1;

interface BallisticTable {
  tof: Float32Array;
  /** Pitch to add (radians) so the bullet lands on the aim point at that range. */
  hold: Float32Array;
}

const tables = new Map<WeaponId, BallisticTable>();

function tableFor(w: WeaponDef): BallisticTable {
  let t = tables.get(w.id);
  if (t) return t;
  const tof = new Float32Array(TABLE_N);
  const hold = new Float32Array(TABLE_N);
  for (let i = 1; i < TABLE_N; i++) {
    const d = i * TABLE_STEP;
    const tr = simulateTrajectory(w, d);
    tof[i] = Number.isFinite(tr.time) ? tr.time : 10;
    const drop = sightDrop(w, d);
    hold[i] = Number.isFinite(drop) ? Math.atan2(drop, d) : 0.1;
  }
  t = { tof, hold };
  tables.set(w.id, t);
  return t;
}

function sample(arr: Float32Array, d: number): number {
  const f = Math.min(TABLE_N - 1.001, Math.max(0, d / TABLE_STEP));
  const i = Math.floor(f);
  const t = f - i;
  return arr[i] + (arr[i + 1] - arr[i]) * t;
}

/** Bullet time of flight (s) to a horizontal range; 0 for hitscan weapons. */
export function timeOfFlight(w: WeaponDef, d: number): number {
  if (w.hitscan) return 0;
  return sample(tableFor(w).tof, d);
}

/** Extra pitch (rad) to hold over at range d with the zeroed sight; 0 for hitscan weapons. */
export function holdOver(w: WeaponDef, d: number): number {
  if (w.hitscan) return 0;
  return sample(tableFor(w).hold, d);
}

/** Precompute every ballistic table (optional warm-up so the first fight never stalls). */
export function warmBallistics(): void {
  for (const id of WEAPON_IDS) tableFor(WEAPONS[id]);
}

/** Preferred (ideal) and maximum sensible engagement range per weapon (m). */
export const WEAPON_RANGE: Record<WeaponId, { ideal: number; max: number }> = {
  pistol: { ideal: 10, max: 45 },
  smg: { ideal: 14, max: 70 },
  ar: { ideal: 30, max: 220 },
  shotgun: { ideal: 6, max: 22 },
  dmr: { ideal: 90, max: 450 },
  sniper: { ideal: 150, max: 650 },
};

/** Overall weapon quality for a bot (0..1). */
export const WEAPON_TIER: Record<WeaponId, number> = {
  pistol: 0.25,
  shotgun: 0.6,
  smg: 0.72,
  ar: 0.95,
  dmr: 0.85,
  sniper: 0.78,
};

/** Rounds a bot wants in reserve for a weapon. */
export function wantedReserve(w: WeaponDef): number {
  return w.fireMode === 'bolt' ? 20 : w.fireMode === 'pump' ? 20 : Math.max(30, w.magSize * 3);
}

/** Weapon in a slot (-1 / out of range = none). */
export function weaponAt(p: PlayerState, slot: number): WeaponInstance | null {
  return slot === 0 || slot === 1 || slot === 2 ? p.weapons[slot] : null;
}

/** Total rounds available for the weapon in a slot (magazine + reserve). */
export function slotRounds(p: PlayerState, slot: number): number {
  const wi = weaponAt(p, slot);
  if (!wi) return 0;
  return wi.mag + (p.ammo[WEAPONS[wi.id].ammo] || 0);
}

/** How well a weapon suits a fight at distance d (higher is better). */
export function rangeSuitability(id: WeaponId, d: number): number {
  const r = WEAPON_RANGE[id];
  let s: number;
  if (d <= r.ideal) {
    // Long-range weapons are clumsy up close.
    s = id === 'sniper' || id === 'dmr' ? 0.45 + 0.55 * (d / r.ideal) : 1;
  } else if (d <= r.max) {
    s = 1 - 0.6 * ((d - r.ideal) / (r.max - r.ideal));
  } else {
    s = Math.max(0.05, 0.4 - (d - r.max) / r.max);
  }
  return s * (0.6 + 0.4 * WEAPON_TIER[id]);
}

/** Best slot (0..2) for a fight at distance d, or -1 when no weapon has ammo. */
export function bestSlotForRange(p: PlayerState, d: number): -1 | 0 | 1 | 2 {
  let best: -1 | 0 | 1 | 2 = -1;
  let bestS = -1;
  for (let s = 0; s < 3; s++) {
    const wi = weaponAt(p, s);
    if (!wi || slotRounds(p, s) <= 0) continue;
    const sc = rangeSuitability(wi.id, d) * (wi.mag > 0 ? 1 : 0.7);
    if (sc > bestS) {
      bestS = sc;
      best = s as 0 | 1 | 2;
    }
  }
  return best;
}

/** Best slot overall (by weapon tier) with ammo, or -1. */
export function bestSlotOverall(p: PlayerState): -1 | 0 | 1 | 2 {
  let best: -1 | 0 | 1 | 2 = -1;
  let bestS = -1;
  for (let s = 0; s < 3; s++) {
    const wi = weaponAt(p, s);
    if (!wi || slotRounds(p, s) <= 0) continue;
    const sc = WEAPON_TIER[wi.id];
    if (sc > bestS) {
      bestS = sc;
      best = s as 0 | 1 | 2;
    }
  }
  return best;
}
