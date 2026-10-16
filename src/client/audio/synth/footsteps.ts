// Footsteps per surface, jump / land fallbacks, body thuds.

import type { SurfaceMaterial } from '../../../shared/types';
import { type SoundSpec, type Synth, crackleBuffer, jit, modal, noiseHit, rr, tone } from './dsp';
import { metalClick, thunk } from './gunshots';

export type StepClass = 'grass' | 'crunch' | 'snow' | 'wood' | 'hard' | 'metal' | 'water';
export const STEP_CLASSES: readonly StepClass[] = ['grass', 'crunch', 'snow', 'wood', 'hard', 'metal', 'water'];

export function stepClassFor(m: SurfaceMaterial | string): StepClass {
  switch (m) {
    case 'grass': return 'grass';
    case 'dirt': case 'sand': return 'crunch';
    case 'snow': return 'snow';
    case 'wood': return 'wood';
    case 'rock': case 'road': case 'concrete': return 'hard';
    case 'metal': return 'metal';
    case 'water': return 'water';
    default: return 'crunch';
  }
}

/** Surfaces where a real shoe heel is clearly audible (the Kenney walking sample is layered in). */
export const HARD_STEP: Record<StepClass, boolean> = {
  grass: false, crunch: false, snow: false, wood: true, hard: true, metal: true, water: false,
};

/** Low heel impact common to most surfaces. */
function heel(s: Synth, t: number, gain: number, lp = 260): void {
  noiseHit(s, { t, color: 'pink', attack: 0.002, tau: 0.018, gain, filters: [{ type: 'lowpass', f: jit(s, lp, 0.15), q: 0.9 }] });
}

function grains(s: Synth, t: number, dur: number, density: number, band: number, q: number, gain: number): void {
  const b = crackleBuffer(s.ctx, dur, density, dur * 0.45, s.rand);
  noiseHit(s, { t, buffer: b, attack: 0.004, hold: dur * 0.5, tau: dur * 0.25, gain, filters: [{ type: 'bandpass', f: band, q }] });
}

function step(cls: StepClass, s: Synth): void {
  const t = 0.002;
  switch (cls) {
    case 'grass':
      heel(s, t, 0.45, 220);
      noiseHit(s, {                                             // blades brushing the boot
        t, color: 'white', attack: rr(s, 0.02, 0.035), tau: 0.05, gain: 0.55,
        filters: [{ type: 'highpass', f: 1800 }, { type: 'bandpass', f: jit(s, 4200, 0.2), q: 0.6 }],
      });
      grains(s, t + 0.01, 0.1, 260, 3000, 0.7, 0.25);
      break;
    case 'crunch':
      heel(s, t, 0.6);
      grains(s, t + 0.004, rr(s, 0.08, 0.11), rr(s, 650, 900), jit(s, 2500, 0.2), 0.8, 0.8);
      noiseHit(s, { t: t + 0.05, color: 'pink', attack: 0.01, tau: 0.03, gain: 0.2, filters: [{ type: 'bandpass', f: 1600, q: 0.7 }] });
      break;
    case 'snow':
      heel(s, t, 0.4, 200);
      grains(s, t + 0.01, rr(s, 0.12, 0.16), rr(s, 1000, 1300), jit(s, 1500, 0.2), 0.6, 0.85);
      break;
    case 'wood': {
      // Hollow knock: boards resonating over a cavity.
      heel(s, t, 0.7, 400);
      const b = jit(s, 165, 0.1);
      modal(s, t, [b, b * 2.15, b * 3.3], [0.07, 0.045, 0.03], [1, 0.55, 0.3], 0.55);
      noiseHit(s, { t, attack: 0.0006, tau: 0.008, gain: 0.35, filters: [{ type: 'bandpass', f: 1500, q: 1 }] });
      break;
    }
    case 'hard':
      heel(s, t, 0.5, 300);
      noiseHit(s, { t, attack: 0.0003, tau: 0.006, gain: 0.8, filters: [{ type: 'bandpass', f: jit(s, 2800, 0.15), q: 1.2 }] });
      noiseHit(s, {                                             // toe scuff
        t: t + rr(s, 0.045, 0.06), attack: 0.006, tau: 0.014, gain: 0.3,
        filters: [{ type: 'bandpass', f: jit(s, 3600, 0.15), q: 0.9 }],
      });
      grains(s, t + 0.003, 0.05, 300, 5000, 0.8, 0.15);
      break;
    case 'metal': {
      heel(s, t, 0.6, 320);
      const b = jit(s, 430, 0.1);
      modal(s, t, [b, b * 1.6, b * 2.63, b * 4.35], [0.16, 0.11, 0.07, 0.04], [1, 0.75, 0.5, 0.3], 0.35);
      metalClick(s, t, 2300, 0.25, 0.015);
      break;
    }
    case 'water':
      noiseHit(s, {
        t, color: 'white', attack: 0.01, tau: 0.06, gain: 0.8,
        filters: [{ type: 'bandpass', f: jit(s, 2100, 0.15), q: 0.8, to: 600, time: 0.16 }],
      });
      noiseHit(s, { t: t + 0.04, color: 'pink', attack: 0.03, tau: 0.07, gain: 0.45, filters: [{ type: 'lowpass', f: 700 }] });
      for (let i = 0; i < 3; i++) {
        const f0 = rr(s, 320, 760);
        tone(s, { t: t + 0.02 + s.rand() * 0.15, f: f0, fTo: f0 * 1.9, sweepTime: 0.025, attack: 0.002, tau: 0.015, gain: rr(s, 0.08, 0.16) });
      }
      break;
  }
}

export function stepSpec(cls: StepClass): SoundSpec {
  const seconds = cls === 'metal' ? 0.5 : cls === 'water' ? 0.42 : cls === 'snow' ? 0.3 : 0.26;
  return { seconds, build: (s) => step(cls, s) };
}

/** Fallback jump (Kenney jump_*.ogg unavailable): cloth whoosh + gear jingle. */
export function jumpSpec(): SoundSpec {
  return {
    seconds: 0.3,
    build: (s) => {
      noiseHit(s, {
        t: 0.002, color: 'pink', attack: 0.05, tau: 0.05, gain: 0.8,
        filters: [{ type: 'bandpass', f: 1100, q: 0.7, to: 2200, time: 0.1 }],
      });
      metalClick(s, 0.05, 4400, 0.18, 0.012);
      metalClick(s, 0.08, 3900, 0.14, 0.012);
      heel(s, 0.002, 0.35, 240);
    },
  };
}

/** Landing body thump: low sweep + dirt + gear rattle (scaled by intensity at runtime). */
export function landSpec(): SoundSpec {
  return {
    seconds: 0.45,
    build: (s) => {
      tone(s, { t: 0.002, f: 95, fTo: 34, sweepTime: 0.12, attack: 0.002, tau: 0.07, gain: 1 });
      noiseHit(s, { t: 0.002, color: 'pink', attack: 0.002, tau: 0.05, gain: 0.8, filters: [{ type: 'lowpass', f: 520, q: 0.8 }] });
      noiseHit(s, { t: 0.004, color: 'white', attack: 0.004, tau: 0.04, gain: 0.25, filters: [{ type: 'bandpass', f: 2200, q: 0.6 }] });
      for (let i = 0; i < 4; i++) metalClick(s, 0.02 + s.rand() * 0.12, rr(s, 2800, 4800), rr(s, 0.08, 0.16), 0.012);
    },
  };
}

/** Body hit thud under the hurt grunt. */
export function hurtThudSpec(): SoundSpec {
  return {
    seconds: 0.35,
    build: (s) => {
      thunk(s, 0.002, 70, 0.09, 1.0);
      noiseHit(s, { t: 0.002, color: 'pink', attack: 0.002, tau: 0.06, gain: 0.7, filters: [{ type: 'lowpass', f: 190, q: 1 }] });
      noiseHit(s, { t: 0.004, attack: 0.002, tau: 0.02, gain: 0.2, filters: [{ type: 'bandpass', f: 900, q: 1.5 }] });
    },
  };
}
