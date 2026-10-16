// Procedural gunshots. Each shot is four layers rendered offline:
//   1. transient  – a very short high-passed noise click (the supersonic/muzzle "snap"),
//   2. body       – band/low-passed noise with a fast decay; its colour gives each weapon character,
//   3. thump      – a sine sweep ~120 -> 40 Hz pushed through a soft clipper (chest punch),
//   4. tail       – long low-passed, slowly rolling noise (outdoor reverb) + terrain echo taps.
// "near" variants are stereo (decorrelated tail) and used for the local player and close shooters;
// "far" variants are mono, dark, tail-heavy and are cross-faded in with distance at runtime.

import type { WeaponSoundKind } from '../../../shared/types';
import {
  type SoundSpec, type Synth, amp, applyRollingAM, bq, chain, echoTap, jit, modal, noiseBuffer, noiseHit, play, rr,
  softClip, sweep, tone,
} from './dsp';

export const WEAPON_SOUND_KINDS: readonly WeaponSoundKind[] = ['pistol', 'smg', 'rifle', 'shotgun', 'dmr', 'sniper'];

interface GunProfile {
  clickHp: number; clickTau: number; clickGain: number;
  bodyBp: number; bodyQ: number; bodyLp: number; bodyTau: number; bodyGain: number;
  lowF: number; lowGain: number;
  thumpFrom: number; thumpTo: number; thumpSweep: number; thumpTau: number; thumpGain: number;
  tailLp: number; tailTau: number; tailGain: number; rolling: number;
  /** Terrain reflections (slapback for snipers). */
  echoes: readonly (readonly [time: number, gain: number])[];
  drive: number;
  seconds: number;
}

/** Character per weapon kind (see module spec): pistol snappy, smg tight, rifle full crack,
 *  shotgun boomy, dmr / sniper heavy crack with a long rolling tail. */
export const GUN_PROFILES: Record<WeaponSoundKind, GunProfile> = {
  pistol: {
    clickHp: 3600, clickTau: 0.0014, clickGain: 0.9,
    bodyBp: 1700, bodyQ: 0.9, bodyLp: 7500, bodyTau: 0.02, bodyGain: 0.85,
    lowF: 480, lowGain: 0.53,
    thumpFrom: 130, thumpTo: 52, thumpSweep: 0.07, thumpTau: 0.032, thumpGain: 0.55,
    tailLp: 1700, tailTau: 0.26, tailGain: 1.0, rolling: 0.15,
    echoes: [[0.11, 0.08]],
    drive: 2.2, seconds: 0.95,
  },
  smg: {
    clickHp: 4200, clickTau: 0.0011, clickGain: 0.85,
    bodyBp: 1350, bodyQ: 1.05, bodyLp: 6800, bodyTau: 0.015, bodyGain: 0.8,
    lowF: 400, lowGain: 0.45,
    thumpFrom: 122, thumpTo: 50, thumpSweep: 0.05, thumpTau: 0.026, thumpGain: 0.5,
    tailLp: 1450, tailTau: 0.2, tailGain: 0.85, rolling: 0.15,
    echoes: [[0.1, 0.06]],
    drive: 2.4, seconds: 0.72,
  },
  rifle: {
    clickHp: 3000, clickTau: 0.0019, clickGain: 1.0,
    bodyBp: 1150, bodyQ: 0.62, bodyLp: 9500, bodyTau: 0.03, bodyGain: 0.95,
    lowF: 310, lowGain: 0.65,
    thumpFrom: 120, thumpTo: 42, thumpSweep: 0.09, thumpTau: 0.048, thumpGain: 0.72,
    tailLp: 1350, tailTau: 0.4, tailGain: 1.4, rolling: 0.3,
    echoes: [[0.14, 0.1], [0.34, 0.06]],
    drive: 2.6, seconds: 1.4,
  },
  shotgun: {
    clickHp: 2400, clickTau: 0.0024, clickGain: 0.78,
    bodyBp: 720, bodyQ: 0.5, bodyLp: 3600, bodyTau: 0.055, bodyGain: 1.0,
    lowF: 170, lowGain: 1.0,
    thumpFrom: 112, thumpTo: 38, thumpSweep: 0.13, thumpTau: 0.08, thumpGain: 1.0,
    tailLp: 950, tailTau: 0.42, tailGain: 1.5, rolling: 0.35,
    echoes: [[0.16, 0.12], [0.39, 0.07]],
    drive: 3.0, seconds: 1.5,
  },
  dmr: {
    clickHp: 2800, clickTau: 0.0022, clickGain: 1.0,
    bodyBp: 1000, bodyQ: 0.6, bodyLp: 10000, bodyTau: 0.04, bodyGain: 1.0,
    lowF: 270, lowGain: 0.78,
    thumpFrom: 120, thumpTo: 40, thumpSweep: 0.11, thumpTau: 0.064, thumpGain: 0.86,
    tailLp: 1150, tailTau: 0.52, tailGain: 1.44, rolling: 0.55,
    echoes: [[0.2, 0.14], [0.47, 0.09], [0.86, 0.05]],
    drive: 2.8, seconds: 2.2,
  },
  sniper: {
    clickHp: 2500, clickTau: 0.0028, clickGain: 1.0,
    bodyBp: 900, bodyQ: 0.55, bodyLp: 10500, bodyTau: 0.05, bodyGain: 1.0,
    lowF: 230, lowGain: 0.9,
    thumpFrom: 120, thumpTo: 37, thumpSweep: 0.13, thumpTau: 0.08, thumpGain: 1.0,
    tailLp: 1050, tailTau: 0.72, tailGain: 1.68, rolling: 0.7,
    // Strong slapback off the terrain, then progressively darker/later reflections.
    echoes: [[0.24, 0.3], [0.55, 0.16], [0.96, 0.09], [1.42, 0.05]],
    drive: 3.0, seconds: 2.8,
  },
};

/** Playback loudness per kind (buffers are peak-normalised). */
export const GUN_GAIN: Record<WeaponSoundKind, number> = {
  pistol: 0.62, smg: 0.6, rifle: 0.8, shotgun: 0.9, dmr: 0.92, sniper: 1.0,
};

/** Distance (m) at which a shot of this kind has faded to silence. */
export const GUN_RANGE: Record<WeaponSoundKind, number> = {
  pistol: 380, smg: 420, rifle: 750, shotgun: 520, dmr: 950, sniper: 1150,
};

/** Rolling, decorrelated tail noise baked in JS (cheaper than modulating in the graph). */
function tailNoise(s: Synth, seconds: number, channels: 1 | 2, rolling: number): AudioBuffer {
  const b = noiseBuffer(s.ctx, seconds, 'pink', channels, s.rand);
  if (rolling > 0) {
    for (let c = 0; c < channels; c++) {
      // Two modulation rates: slow swells plus faster "rumble" flutter.
      applyRollingAM(b.getChannelData(c), s.sr, rr(s, 3, 5), rolling, s.rand);
      applyRollingAM(b.getChannelData(c), s.sr, rr(s, 9, 14), rolling * 0.5, s.rand);
    }
  }
  return b;
}

function nearShot(kind: WeaponSoundKind, s: Synth): void {
  const p = GUN_PROFILES[kind];
  const t = 0.002;
  // Punchy layers share a soft clipper; the tail and reflections stay clean behind it.
  const clip = softClip(s, jit(s, p.drive, 0.1));
  const punch = amp(s, 0.8);
  chain(punch, clip, s.out);

  // 1. Transient click.
  noiseHit(s, {
    t, color: 'white', attack: 0.0002, tau: jit(s, p.clickTau, 0.15), gain: p.clickGain * 1.3,
    filters: [{ type: 'highpass', f: jit(s, p.clickHp, 0.1), q: 0.8 }], dest: punch,
  });
  // 2. Body: band-passed crack whose centre drops (crack -> boom), plus a low-mid weight band.
  const bodyF = jit(s, p.bodyBp, 0.08);
  noiseHit(s, {
    t, color: 'white', attack: 0.0006, tau: jit(s, p.bodyTau, 0.12), gain: p.bodyGain,
    filters: [
      { type: 'bandpass', f: bodyF, q: p.bodyQ, to: bodyF * 0.55, time: p.bodyTau * 4 },
      { type: 'lowpass', f: p.bodyLp, q: 0.5 },
    ],
    dest: punch,
  });
  noiseHit(s, {
    t: t + 0.001, color: 'pink', attack: 0.0015, tau: p.bodyTau * 1.7, gain: p.lowGain,
    filters: [{ type: 'bandpass', f: jit(s, p.lowF, 0.1), q: 1.1 }], dest: punch,
  });
  // 3. Low thump.
  tone(s, {
    t, f: jit(s, p.thumpFrom, 0.05), fTo: jit(s, p.thumpTo, 0.05), sweepTime: p.thumpSweep,
    attack: 0.0018, tau: jit(s, p.thumpTau, 0.1), gain: p.thumpGain, dest: punch,
  });

  // 4. Outdoor tail (stereo, decorrelated, darkening over time).
  const tailBuf = tailNoise(s, p.seconds, 2, p.rolling);
  const src = play(s, tailBuf, t);
  const lp = bq(s, 'lowpass', jit(s, p.tailLp, 0.1), 0.6);
  sweep(lp.frequency, t + 0.03, p.tailLp, p.tailLp * 0.45, p.tailTau * 3);
  const hp = bq(s, 'highpass', 70, 0.7);
  const tg = amp(s);
  tg.gain.setValueAtTime(0, t);
  tg.gain.linearRampToValueAtTime(p.tailGain, t + 0.03);
  tg.gain.setTargetAtTime(0, t + 0.03, jit(s, p.tailTau, 0.12));
  chain(src, lp, hp, tg, s.out);

  // Reflections: delayed, darker copies of the body.
  if (p.echoes.length) {
    const refl = amp(s, 1);
    punch.connect(refl);
    for (const [time, g] of p.echoes) echoTap(s, refl, jit(s, time, 0.12), g, 2400 - time * 900);
  }
}

function farShot(kind: WeaponSoundKind, s: Synth): void {
  const p = GUN_PROFILES[kind];
  const t = 0.002;
  const clip = softClip(s, 2);
  const punch = amp(s, 0.7);
  chain(punch, clip, s.out);
  // Distant shots lose the crack: a muffled, longer boom.
  noiseHit(s, {
    t, color: 'white', attack: 0.002, tau: p.bodyTau * 1.9, gain: p.bodyGain * 0.9,
    filters: [{ type: 'lowpass', f: 1700, q: 0.7 }, { type: 'highpass', f: 90 }], dest: punch,
  });
  noiseHit(s, {
    t, color: 'brown', attack: 0.004, tau: p.bodyTau * 3, gain: p.lowGain * 1.1,
    filters: [{ type: 'lowpass', f: 520, q: 0.8 }], dest: punch,
  });
  tone(s, {
    t, f: p.thumpFrom * 0.85, fTo: p.thumpTo, sweepTime: p.thumpSweep * 1.4,
    attack: 0.004, tau: p.thumpTau * 1.5, gain: p.thumpGain * 0.65, dest: punch,
  });
  // Emphasised rolling tail (the dominant part of a far-away report).
  const rolling = Math.min(1, p.rolling + 0.35);
  const tailBuf = tailNoise(s, s.len, 1, rolling);
  const src = play(s, tailBuf, t);
  const lp = bq(s, 'lowpass', p.tailLp * 0.7, 0.7);
  sweep(lp.frequency, t + 0.05, p.tailLp * 0.7, p.tailLp * 0.32, p.tailTau * 4);
  const tg = amp(s);
  tg.gain.setValueAtTime(0, t);
  tg.gain.linearRampToValueAtTime(p.tailGain * 0.75, t + 0.06);
  tg.gain.setTargetAtTime(0, t + 0.06, p.tailTau * 1.55);
  chain(src, lp, tg, s.out);
  // Long terrain reflections ("thunder roll").
  const refl = amp(s, 1);
  punch.connect(refl);
  const base = kind === 'sniper' || kind === 'dmr' ? 1 : 0.7;
  echoTap(s, refl, jit(s, 0.32, 0.15), 0.32 * base, 900);
  echoTap(s, refl, jit(s, 0.74, 0.15), 0.22 * base, 700);
  echoTap(s, refl, jit(s, 1.25, 0.15), 0.13 * base, 520);
}

export function gunNearSpec(kind: WeaponSoundKind): SoundSpec {
  return { seconds: GUN_PROFILES[kind].seconds, channels: 2, build: (s) => nearShot(kind, s) };
}

export function gunFarSpec(kind: WeaponSoundKind): SoundSpec {
  return { seconds: GUN_PROFILES[kind].seconds * 1.35 + 0.4, channels: 1, rate: 24000, build: (s) => farShot(kind, s) };
}

// ---------------------------------------------------------------------------------------------
// Mechanical action layer (local player only): slide / bolt carrier / recoil rattle.
// ---------------------------------------------------------------------------------------------

/** Generic metallic click: short band-passed noise tick + damped inharmonic partials. */
export function metalClick(s: Synth, t: number, base: number, gain: number, decay: number, dest?: AudioNode): void {
  const b = jit(s, base, 0.06);
  noiseHit(s, {
    t, attack: 0.0002, tau: 0.0012, gain: gain * 0.9,
    filters: [{ type: 'bandpass', f: b * 1.6, q: 1.6 }], dest,
  });
  modal(s, t, [b, b * 1.52, b * 2.27, b * 3.11], [decay, decay * 0.8, decay * 0.55, decay * 0.4],
    [1, 0.7, 0.45, 0.25], gain * 0.35, dest);
}

/** Dull mechanical thunk (body/stock/magazine seating). */
export function thunk(s: Synth, t: number, freq: number, tau: number, gain: number, dest?: AudioNode): void {
  tone(s, { t, f: freq * 1.8, fTo: freq, sweepTime: tau, attack: 0.001, tau, gain: gain * 0.8, dest });
  noiseHit(s, {
    t, attack: 0.0006, tau: tau * 0.6, gain: gain * 0.6,
    filters: [{ type: 'lowpass', f: freq * 5, q: 0.8 }], dest,
  });
}

/** Sliding metal-on-metal scrape. */
export function scrape(s: Synth, t: number, dur: number, from: number, to: number, gain: number, dest?: AudioNode): void {
  noiseHit(s, {
    t, attack: dur * 0.35, hold: dur * 0.35, tau: dur * 0.15, gain,
    filters: [{ type: 'bandpass', f: from, q: 2.4, to, time: dur }], dest,
  });
}

function actionLayer(kind: WeaponSoundKind, s: Synth): void {
  const t = 0.002;
  switch (kind) {
    case 'pistol':
      metalClick(s, t, 3300, 0.8, 0.022);
      metalClick(s, t + 0.034, 2900, 1.0, 0.03);
      break;
    case 'smg':
      metalClick(s, t, 2600, 0.9, 0.018);
      metalClick(s, t + 0.024, 2300, 0.7, 0.022);
      break;
    case 'rifle':
      metalClick(s, t, 2200, 0.9, 0.025);
      tone(s, { t: t + 0.01, f: 1150, fTo: 1050, sweepTime: 0.06, attack: 0.002, tau: 0.03, gain: 0.12 }); // buffer spring
      metalClick(s, t + 0.045, 1900, 1.0, 0.035);
      break;
    case 'shotgun':
      modal(s, t, [1750, 2860, 4100], [0.07, 0.05, 0.03], [1, 0.6, 0.3], 0.35);
      thunk(s, t, 140, 0.05, 0.8);
      break;
    case 'dmr':
      metalClick(s, t, 2000, 0.9, 0.03);
      metalClick(s, t + 0.05, 1750, 1.0, 0.04);
      thunk(s, t, 180, 0.04, 0.4);
      break;
    case 'sniper':
      modal(s, t, [1200, 2060, 3300], [0.09, 0.06, 0.04], [1, 0.6, 0.35], 0.4);
      thunk(s, t, 120, 0.06, 0.9);
      break;
  }
}

export function actionSpec(kind: WeaponSoundKind): SoundSpec {
  return { seconds: 0.22, build: (s) => actionLayer(kind, s) };
}

/** Weight factor per kind for reload / mechanical sounds: lighter guns ring higher. */
export const MECH_PITCH: Record<WeaponSoundKind, number> = {
  pistol: 1.25, smg: 1.1, rifle: 1.0, shotgun: 0.88, dmr: 0.95, sniper: 0.85,
};
