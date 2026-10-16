// Pure spatialisation math (no WebAudio): distance attenuation, air absorption, stereo pan,
// propagation delay. Kept separate so it is unit-testable in Node and allocation free.

import { SPEED_OF_SOUND } from '../../shared/constants';
import type { Vec3 } from '../../shared/types';

export interface ListenerState {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
}

export interface Falloff {
  /** Distance (m) up to which the sound plays at full level. */
  ref: number;
  /** Inverse-distance rolloff factor. */
  rolloff: number;
  /** Distance (m) at which the sound has faded to silence. */
  range: number;
}

export interface Spatial {
  dist: number;
  /** Linear gain from distance attenuation (+ slight rear attenuation). */
  gain: number;
  /** Stereo pan -1 (left) .. 1 (right). */
  pan: number;
  /** Low-pass cutoff (Hz) from air absorption (+ rear head shadow). */
  cutoff: number;
  /** Propagation delay (s). */
  delay: number;
  /** -1 behind .. 1 in front. */
  front: number;
}

export const createSpatial = (): Spatial => ({ dist: 0, gain: 1, pan: 0, cutoff: 20000, delay: 0, front: 1 });

const NEAR_CUTOFF = 18000;
const FAR_CUTOFF = 700;
const FAR_CUTOFF_DIST = 800;
const MIN_CUTOFF = 380;
const PAN_WIDTH = 0.9;

/**
 * Inverse-distance law (WebAudio "inverse" model) with a smooth fade to silence over the last
 * 35 % of `range`, so a sound becomes inaudible exactly at its loudness range without popping.
 */
export function distanceGain(d: number, f: Falloff): number {
  if (!(d < f.range)) return 0;
  const g = d <= f.ref ? 1 : f.ref / (f.ref + f.rolloff * (d - f.ref));
  const fadeStart = f.range * 0.65;
  if (d <= fadeStart) return g;
  const x = (d - fadeStart) / (f.range - fadeStart);
  return g * (1 - x * x * (3 - 2 * x));
}

/** Air absorption: ~18 kHz near, ~700 Hz at 800 m (log-frequency curve, crisp at mid range). */
export function airCutoff(d: number): number {
  if (d <= 0) return NEAR_CUTOFF;
  const t = Math.pow(d / FAR_CUTOFF_DIST, 1.15);
  return Math.max(MIN_CUTOFF, NEAR_CUTOFF * Math.pow(FAR_CUTOFF / NEAR_CUTOFF, t));
}

/** Propagation delay for a sound emitted at distance d. */
export const soundDelay = (d: number): number => (d > 0 ? d / SPEED_OF_SOUND : 0);

/**
 * Full spatialisation of a source relative to the listener (yaw 0 faces -Z, positive yaw turns
 * left; right vector = (cos yaw, 0, -sin yaw)). Writes into `out` and returns it.
 */
export function spatialize(l: ListenerState, pos: Vec3, f: Falloff, out: Spatial): Spatial {
  const dx = pos.x - l.x, dy = pos.y - l.y, dz = pos.z - l.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out.dist = d;
  out.delay = soundDelay(d);
  if (d < 1e-3) {
    out.pan = 0;
    out.front = 1;
    out.gain = 1;
    out.cutoff = NEAR_CUTOFF;
    return out;
  }
  const inv = 1 / d;
  const cy = Math.cos(l.yaw), sy = Math.sin(l.yaw);
  const rightDot = (dx * cy - dz * sy) * inv;
  const fwdDot = (-dx * sy - dz * cy) * inv;
  // Sources very close to the head collapse toward the centre (no hard L/R jumps).
  const closeness = d < 1.5 ? d / 1.5 : 1;
  out.pan = clampPan(rightDot * PAN_WIDTH * closeness);
  out.front = fwdDot;
  const rear = fwdDot < 0 ? -fwdDot : 0;
  out.gain = distanceGain(d, f) * (1 - 0.15 * rear);
  // Head shadow: sources behind sound slightly darker.
  out.cutoff = airCutoff(d) * (1 - 0.4 * rear);
  return out;
}

const clampPan = (p: number): number => (p < -1 ? -1 : p > 1 ? 1 : p);

/** Equal-power crossfade weights between a near and a far variant over [d0, d1]. */
export function nearFarMix(d: number, d0: number, d1: number, out: { near: number; far: number }): { near: number; far: number } {
  const x = d <= d0 ? 0 : d >= d1 ? 1 : (d - d0) / (d1 - d0);
  const s = x * x * (3 - 2 * x);
  out.near = Math.cos(s * Math.PI * 0.5);
  out.far = Math.sin(s * Math.PI * 0.5);
  return out;
}

/** Perceptual volume curve for 0..1 settings sliders. */
export function volumeCurve(v: number): number {
  if (!(v > 0)) return 0;
  const c = v > 1 ? 1 : v;
  return c * c;
}

export const finiteOr = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);
