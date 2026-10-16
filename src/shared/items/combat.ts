// Combat math: fire cadence, spread cone, deterministic shot directions, server-authoritative
// recoil (learnable pattern + seeded jitter), recoil recovery and damage / armor.
//
// Everything here is pure and deterministic so the server, client prediction and bots agree.

import { MOVE_SPEED } from '../constants';
import { clamp, lerp, saturate } from '../math';
import { hash32, hashFloat } from '../rng';
import type { ArmorState, HitPart, Stance, Vec3, WeaponDef, WeaponId } from '../types';
import { GEAR, THROWABLES, WEAPONS } from './defs';

const TAU = Math.PI * 2;

// ============================================================================
// Cadence
// ============================================================================

/** Seconds between shots (bolt / pump: full cycle time). */
export function fireInterval(w: WeaponDef): number {
  return 60 / w.rpm;
}

// ============================================================================
// Spread
// ============================================================================

export interface SpreadContext {
  /** ADS blend 0..1 */
  ads: number;
  /** Horizontal speed (m/s) */
  speed: number;
  airborne: boolean;
  stance: Stance;
  /** Accumulated bloom (radians), clamped to the weapon's bloomMax. */
  bloom: number;
}

/** Stance multipliers on the spread cone. */
export const SPREAD_STANCE_MUL: Record<Stance, number> = { stand: 1, crouch: 0.8, prone: 0.6 };
/** Speeds below this (m/s) count as standing still (residual velocity, gentle slopes). */
const SPREAD_SPEED_DEADZONE = 0.25;
/** Movement penalty factor cap (vehicles can exceed sprint speed). */
const SPREAD_MOVE_MAX = 1.5;
/** Fraction of the movement penalty that remains at full ADS. */
const SPREAD_MOVE_ADS = 0.45;
/** Hard cap on the total cone (radians). */
export const MAX_SPREAD = 0.2;

/** Cone half-angle (radians) for the next shot. */
export function spreadCone(w: WeaponDef, ctx: SpreadContext): number {
  const ads = saturate(ctx.ads);
  const base = lerp(w.spreadHip, w.spreadAds, ads);
  const moveF = clamp(Math.max(0, ctx.speed - SPREAD_SPEED_DEADZONE) / MOVE_SPEED.sprint, 0, SPREAD_MOVE_MAX);
  const move = w.spreadMove * moveF * lerp(1, SPREAD_MOVE_ADS, ads);
  const air = ctx.airborne ? w.spreadAir : 0;
  const bloom = clamp(ctx.bloom, 0, w.bloomMax);
  const cone = (base + move + air + bloom) * SPREAD_STANCE_MUL[ctx.stance];
  return clamp(cone, 0, MAX_SPREAD);
}

// Hash salts so each random stream is independent of the others.
const SALT_CONE_R = 0x1c0e;
const SALT_CONE_A = 0x2a17;
const SALT_PELLET_R = 0x3b4d;
const SALT_PELLET_A = 0x4f61;
const SALT_PELLET_ROT = 0x5d83;

/**
 * Deterministic shot / pellet directions (unit vectors) for one trigger pull.
 * The shot direction is sampled uniformly over the disk of the spread cone around (yaw, pitch);
 * shotgun pellets are additionally laid out around it in a stratified ring pattern within
 * `pelletSpread` (consistent, fair patterns with a seeded rotation and jitter).
 * seed = hash32(playerId, shotCounter). Reuses the Vec3 objects in `out` when given.
 */
export function shotDirections(w: WeaponDef, yaw: number, pitch: number, cone: number, seed: number, out: Vec3[] = []): Vec3[] {
  const n = Math.max(1, w.pellets | 0);
  for (let i = out.length; i < n; i++) out.push({ x: 0, y: 0, z: 0 });
  out.length = n;

  // Orthonormal aim basis: f forward, r right (horizontal), u = r x f (up).
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, rz = -sy; // ry = 0
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;

  // Main shot offset: uniform over the cone disk.
  const c = Math.max(0, cone);
  const mr = c * Math.sqrt(hashFloat(seed, 0, SALT_CONE_R));
  const ma = TAU * hashFloat(seed, 0, SALT_CONE_A);
  const mox = mr * Math.cos(ma), moy = mr * Math.sin(ma);

  if (n === 1) {
    writeDir(out[0], mox, moy, fx, fy, fz, rx, rz, ux, uy, uz);
    return out;
  }

  const ps = Math.max(0, w.pelletSpread);
  const rot = TAU * hashFloat(seed, 0, SALT_PELLET_ROT);
  const ring = n - 1;
  for (let k = 0; k < n; k++) {
    let pr: number, pa: number;
    if (k === 0) {
      // Centre pellet keeps the pattern core dense.
      pr = ps * 0.3 * Math.sqrt(hashFloat(seed, k, SALT_PELLET_R));
      pa = TAU * hashFloat(seed, k, SALT_PELLET_A);
    } else {
      // Ring pellets: one per angular sector, jittered within 80% of the sector.
      pr = ps * Math.sqrt(0.25 + 0.75 * hashFloat(seed, k, SALT_PELLET_R));
      pa = rot + TAU * (k - 1 + 0.5 + (hashFloat(seed, k, SALT_PELLET_A) - 0.5) * 0.8) / ring;
    }
    writeDir(out[k], mox + pr * Math.cos(pa), moy + pr * Math.sin(pa), fx, fy, fz, rx, rz, ux, uy, uz);
  }
  return out;
}

/** Rotate the forward axis by angular offset (ox right, oy up) radians; exact angle = hypot(ox, oy). */
function writeDir(
  o: Vec3, ox: number, oy: number,
  fx: number, fy: number, fz: number, rx: number, rz: number, ux: number, uy: number, uz: number,
): void {
  const a = Math.sqrt(ox * ox + oy * oy);
  if (a < 1e-12) {
    o.x = fx; o.y = fy; o.z = fz;
    return;
  }
  const ca = Math.cos(a), s = Math.sin(a) / a;
  const tx = rx * ox + ux * oy, ty = uy * oy, tz = rz * ox + uz * oy;
  o.x = fx * ca + tx * s;
  o.y = fy * ca + ty * s;
  o.z = fz * ca + tz * s;
}

// ============================================================================
// Recoil
// ============================================================================

export interface RecoilKick {
  pitch: number;
  yaw: number;
}

/** Shots per knot of the horizontal drift curve (lower = twitchier pattern). */
const H_PATTERN_PERIOD = 4;
/** Horizontal pattern ramps in over the first shots so a spray starts mostly vertical. */
const H_PATTERN_RAMP = 3;
/** Per-shot horizontal jitter as a fraction of `recoil.horizontal`. */
export const RECOIL_JITTER_FRAC = 0.25;
const SALT_H_KNOT = 0x7a11;
const SALT_H_BIAS = 0x3b1a;
const SALT_JITTER = 0x1f3d;

/** FNV-1a string hash; weapon ids seed their own learnable pattern. */
function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Per-weapon pattern seed plus consistent drift bias (same side every spray). */
const PATTERN_SEED: Record<string, number> = {};
const PATTERN_BIAS: Record<string, number> = {};
function patternSeed(id: WeaponId): number {
  let s = PATTERN_SEED[id];
  if (s === undefined) {
    s = strHash(id);
    PATTERN_SEED[id] = s;
    const side = hash32(s, SALT_H_BIAS) & 1 ? 1 : -1;
    PATTERN_BIAS[id] = side * (0.2 + 0.25 * hashFloat(s, SALT_H_BIAS, 1));
  }
  return s;
}

/**
 * Learnable horizontal recoil pattern in [-1, 1] for a spray index. Depends only on the weapon id
 * and the index: a smooth seeded walk (cubic-eased value noise) plus a per-weapon drift bias.
 */
export function recoilPattern(id: WeaponId, sprayIndex: number): number {
  const s = patternSeed(id);
  const i = Math.max(0, Math.floor(sprayIndex));
  const k = Math.floor(i / H_PATTERN_PERIOD);
  const f = (i - k * H_PATTERN_PERIOD) / H_PATTERN_PERIOD;
  const e = f * f * (3 - 2 * f);
  const a = hashFloat(s, k, SALT_H_KNOT) * 2 - 1;
  const b = hashFloat(s, k + 1, SALT_H_KNOT) * 2 - 1;
  const walk = a + (b - a) * e;
  const v = clamp(walk * 0.75 + PATTERN_BIAS[id], -1, 1);
  return v * Math.min(1, (i + 1) / H_PATTERN_RAMP);
}

/** Combined ADS / stance multiplier on recoil. */
export function recoilMul(w: WeaponDef, stance: Stance, ads: number): number {
  const r = w.recoil;
  const st = stance === 'crouch' ? r.crouchMul : stance === 'prone' ? r.proneMul : 1;
  return lerp(1, r.adsMul, saturate(ads)) * st;
}

/**
 * Recoil (radians) to add to the accumulated server recoil for this shot. Vertical climbs with the
 * spray index and plateaus; horizontal follows the learnable weapon pattern plus a small seeded
 * jitter (<= 25% of `recoil.horizontal`). Pass `out` to avoid allocating.
 */
export function recoilForShot(
  w: WeaponDef, sprayIndex: number, seed: number, stance: Stance, ads: number, out?: RecoilKick,
): RecoilKick {
  const r = w.recoil;
  const i = Math.max(0, Math.floor(sprayIndex));
  const growth = i === 0 ? r.firstShotMul : Math.min(r.verticalMaxMul, 1 + r.verticalGrowth * i);
  const mul = recoilMul(w, stance, ads);
  const jitter = (hashFloat(seed, SALT_JITTER) * 2 - 1) * RECOIL_JITTER_FRAC;
  const pitch = r.vertical * growth * mul;
  const yaw = r.horizontal * (recoilPattern(w.id, i) + jitter) * mul;
  if (out) {
    out.pitch = pitch;
    out.yaw = yaw;
    return out;
  }
  return { pitch, yaw };
}

/** Recovery rate (rad/s) with no weapon in hand. */
export const UNARMED_RECOVERY = 2.0;
/** Below this accumulated recoil magnitude (rad) recovery eases out exponentially. */
const RECOVERY_EASE = 0.02;
/** Minimum recovery speed fraction inside the ease zone so recoil settles in finite time. */
const RECOVERY_MIN_FRAC = 0.2;

/**
 * Recover accumulated recoil toward 0 along a straight line (pitch and yaw together).
 * Far from rest it moves at `recoil.recovery` rad/s, inside RECOVERY_EASE it eases out
 * exponentially, then finishes at a small constant speed. Integrated in closed form so the result
 * is independent of the step size (client frames and server ticks agree). No recovery while firing.
 */
export function recoverRecoil(
  w: WeaponDef | null, rp: number, ry: number, dt: number, firing: boolean, out?: RecoilKick,
): RecoilKick {
  const o = out ?? { pitch: 0, yaw: 0 };
  if ((firing && w) || !(dt > 0)) {
    o.pitch = rp;
    o.yaw = ry;
    return o;
  }
  const rate = w ? w.recoil.recovery : UNARMED_RECOVERY;
  const m0 = Math.sqrt(rp * rp + ry * ry);
  if (m0 < 1e-9 || rate <= 0) {
    o.pitch = m0 < 1e-9 ? 0 : rp;
    o.yaw = m0 < 1e-9 ? 0 : ry;
    return o;
  }
  let m = m0;
  let t = dt;
  // Linear region.
  if (m > RECOVERY_EASE) {
    const t1 = (m - RECOVERY_EASE) / rate;
    if (t <= t1) {
      m -= rate * t;
      t = 0;
    } else {
      m = RECOVERY_EASE;
      t -= t1;
    }
  }
  // Exponential ease region.
  const floor = RECOVERY_EASE * RECOVERY_MIN_FRAC;
  if (t > 0 && m > floor) {
    const lambda = rate / RECOVERY_EASE;
    const t2 = Math.log(m / floor) / lambda;
    if (t <= t2) {
      m *= Math.exp(-lambda * t);
      t = 0;
    } else {
      m = floor;
      t -= t2;
    }
  }
  // Constant-speed finish.
  if (t > 0) m = Math.max(0, m - rate * RECOVERY_MIN_FRAC * t);
  const k = m / m0;
  o.pitch = rp * k;
  o.yaw = ry * k;
  return o;
}

// ============================================================================
// Damage & armor
// ============================================================================

export interface DamageResult {
  /** Health damage after armor reduction. */
  health: number;
  /** Durability damage to the vest / helmet (the pre-reduction damage). */
  vestDmg: number;
  helmetDmg: number;
  /** Hit absorbed partially by a vest or helmet. */
  armorHit: boolean;
  /** That vest / helmet reaches 0 durability with this hit. */
  armorBroke: boolean;
}

/** Damage multiplier for distance: 1 until falloffStart, linear to falloffMinMul at falloffEnd. */
export function falloffMul(w: WeaponDef, distance: number): number {
  if (distance <= w.falloffStart) return 1;
  if (distance >= w.falloffEnd) return w.falloffMinMul;
  return lerp(1, w.falloffMinMul, (distance - w.falloffStart) / (w.falloffEnd - w.falloffStart));
}

export function partMultiplier(w: WeaponDef, part: HitPart): number {
  return part === 'head' ? w.headMul : part === 'limb' ? w.limbMul : 1;
}

const HELMET_REDUCTION = [0, GEAR.helmet1.reduction, GEAR.helmet2.reduction, GEAR.helmet3.reduction];
const VEST_REDUCTION = [0, GEAR.vest1.reduction, GEAR.vest2.reduction, GEAR.vest3.reduction];

/**
 * Damage of one bullet / pellet. Heads are protected by an intact helmet, bodies by an intact
 * vest, limbs are never reduced. Armor durability damage equals the pre-reduction damage.
 * Does not mutate `armor` (see applyArmorDamage). Pass `out` to avoid allocating.
 */
export function computeDamage(
  weapon: WeaponId, part: HitPart, distance: number, armor: ArmorState, out?: DamageResult,
): DamageResult {
  const w = WEAPONS[weapon];
  const raw = w.damage * partMultiplier(w, part) * falloffMul(w, Math.max(0, distance));
  const r = out ?? { health: 0, vestDmg: 0, helmetDmg: 0, armorHit: false, armorBroke: false };
  r.health = raw;
  r.vestDmg = 0;
  r.helmetDmg = 0;
  r.armorHit = false;
  r.armorBroke = false;
  if (part === 'head') {
    if (armor.helmet > 0 && armor.helmetHp > 0) {
      r.health = raw * (1 - HELMET_REDUCTION[armor.helmet]);
      r.helmetDmg = raw;
      r.armorHit = true;
      r.armorBroke = armor.helmetHp - raw <= 0;
    }
  } else if (part === 'body') {
    if (armor.vest > 0 && armor.vestHp > 0) {
      r.health = raw * (1 - VEST_REDUCTION[armor.vest]);
      r.vestDmg = raw;
      r.armorHit = true;
      r.armorBroke = armor.vestHp - raw <= 0;
    }
  }
  return r;
}

/** Apply a DamageResult's durability damage; broken gear is removed (level 0). */
export function applyArmorDamage(armor: ArmorState, r: DamageResult): void {
  if (r.helmetDmg > 0 && armor.helmet > 0) {
    armor.helmetHp = Math.max(0, armor.helmetHp - r.helmetDmg);
    if (armor.helmetHp <= 0) {
      armor.helmet = 0;
      armor.helmetHp = 0;
    }
  }
  if (r.vestDmg > 0 && armor.vest > 0) {
    armor.vestHp = Math.max(0, armor.vestHp - r.vestDmg);
    if (armor.vestHp <= 0) {
      armor.vest = 0;
      armor.vestHp = 0;
    }
  }
}

/**
 * Frag grenade damage at a distance from the explosion: THROWABLES.frag.damage falling off
 * linearly to 0 at its radius (line of sight / armor handling is up to the simulation).
 */
export function fragDamage(distance: number): number {
  const f = THROWABLES.frag;
  if (!(distance < f.radius)) return 0;
  return f.damage * (1 - Math.max(0, distance) / f.radius);
}
