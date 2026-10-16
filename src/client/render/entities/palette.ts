// Colour palettes for entities: team accent hues, muted military clothing, skin tones and vehicle
// paints. Pure helpers (no scene access) so they can be reused by nameplates, the map, etc.
//
// Team colours: every team gets a distinct, saturated hue generated from its id with the golden
// ratio (neighbouring ids land far apart on the wheel). The cyan/blue band is reserved for the local
// player's team, which always renders in LOCAL_TEAM_COLOR so "my squad" is unmistakable.

import * as THREE from 'three';
import { hash32 } from '../../../shared/rng';
import type { EntityId, TeamId } from '../../../shared/types';

/** Fixed accent of the local player's team (bright cyan-blue). sRGB hex. */
export const LOCAL_TEAM_COLOR = 0x1ec8ff;

/** Hue band (degrees) reserved for the local team; enemy hues never fall inside it. */
const RESERVED_HUE_MIN = 172;
const RESERVED_HUE_MAX = 236;
const GOLDEN = 0.618033988749895;

/** Hue (degrees, 0..360) of a team that is not the local team. Pure / deterministic. */
export function teamHue(team: TeamId): number {
  const t = (((team + 1) * GOLDEN) % 1 + 1) % 1;
  const span = 360 - (RESERVED_HUE_MAX - RESERVED_HUE_MIN);
  // Map t over the allowed span, skipping the reserved band.
  let h = (RESERVED_HUE_MAX + t * span) % 360;
  if (h >= RESERVED_HUE_MIN && h < RESERVED_HUE_MAX) h = (h + (RESERVED_HUE_MAX - RESERVED_HUE_MIN)) % 360;
  return h;
}

/** HSL -> sRGB hex. h in degrees, s/l in 0..1. */
export function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(Math.max(0, Math.min(1, c)) * 255);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** sRGB hex accent colour for a team as seen by the local player. */
export function teamColorHex(team: TeamId, localTeam: TeamId): number {
  if (team === localTeam) return LOCAL_TEAM_COLOR;
  // Alternate lightness a little so adjacent hues stay distinguishable.
  const l = (team & 1) === 0 ? 0.52 : 0.6;
  return hslToHex(teamHue(team), 0.88, l);
}

/** Team accent colour (linear working space) written into `out`. */
export function teamColor(team: TeamId, localTeam: TeamId, out: THREE.Color): THREE.Color {
  return out.setHex(teamColorHex(team, localTeam));
}

const cssCache = new Map<number, string>();
/** CSS colour string (`#rrggbb`) for a team; cached so per-frame use never allocates. */
export function teamCss(team: TeamId, localTeam: TeamId): string {
  const hex = teamColorHex(team, localTeam);
  let s = cssCache.get(hex);
  if (s === undefined) {
    s = '#' + hex.toString(16).padStart(6, '0');
    cssCache.set(hex, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Clothing / skin
// ---------------------------------------------------------------------------

/** Muted military fatigue tints (multiplied onto the neutral cloth vertex colour). sRGB hex. */
export const CLOTH_TINTS: readonly number[] = [
  0x6b7347, // olive drab
  0x8a7d5a, // khaki
  0x5f6a5c, // grey-green
  0x6e5b45, // woodland brown
  0x55604a, // dark olive
  0x7b7a6c, // stone grey
  0x4f5a4f, // forest green
];

export const SKIN_TONES: readonly number[] = [0xe0b394, 0xc99a74, 0xa87655, 0x8a5a3c, 0x6b4430, 0xf0c8a8];

/** Deterministic per-player fatigue tint (sRGB hex). */
export function clothTintHex(id: EntityId): number {
  return CLOTH_TINTS[hash32(id, 0x5eed) % CLOTH_TINTS.length];
}

/** Deterministic per-player skin tone (sRGB hex). */
export function skinToneHex(id: EntityId): number {
  return SKIN_TONES[hash32(id, 0x5c1d) % SKIN_TONES.length];
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

/** Team-independent vehicle paints: army green, rust, sand (plus close variants). sRGB hex. */
export const VEHICLE_PAINTS: readonly number[] = [0x4f5a36, 0x8a4a2a, 0xc2ab78, 0x5c6640, 0x9a5634, 0xb59a66];

export function vehiclePaintHex(id: EntityId): number {
  return VEHICLE_PAINTS[hash32(id, 0xca7) % VEHICLE_PAINTS.length];
}

/** Colour multiplier for a burnt-out wreck. sRGB hex. */
export const WRECK_TINT = 0x2a2725;
