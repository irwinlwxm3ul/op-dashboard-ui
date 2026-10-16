// Bullet impacts by material, ricochets, the supersonic near-miss crack, armor break and explosions.

import {
  type SoundSpec, type Synth, amp, applyRollingAM, bq, chain, crackleBuffer, echoTap, jit, modal, noiseBuffer,
  noiseHit, play, rr, softClip, sweep, tone,
} from './dsp';
import { metalClick, thunk } from './gunshots';

export type ImpactClass = 'soft' | 'dirt' | 'hard' | 'metal' | 'wood' | 'water' | 'flesh' | 'armor';
export const IMPACT_CLASSES: readonly ImpactClass[] = ['soft', 'dirt', 'hard', 'metal', 'wood', 'water', 'flesh', 'armor'];

/** Maps the simulation material (SurfaceMaterial | 'flesh' | 'armor') to an impact sound class. */
export function impactClassFor(material: string): ImpactClass {
  switch (material) {
    case 'grass': case 'snow': return 'soft';
    case 'dirt': case 'sand': return 'dirt';
    case 'rock': case 'road': case 'concrete': return 'hard';
    case 'metal': return 'metal';
    case 'wood': return 'wood';
    case 'water': return 'water';
    case 'flesh': return 'flesh';
    case 'armor': return 'armor';
    default: return 'dirt';
  }
}

/** Debris patter / grit: a band-passed decaying crackle. */
function debris(s: Synth, t: number, dur: number, density: number, band: number, gain: number, dest?: AudioNode): void {
  const b = crackleBuffer(s.ctx, dur, density, dur * 0.35, s.rand);
  noiseHit(s, {
    t, buffer: b, attack: 0.001, hold: dur * 0.6, tau: dur * 0.2, gain,
    filters: [{ type: 'bandpass', f: band, q: 0.8 }, { type: 'lowpass', f: band * 2, q: 0.6 }], dest,
  });
}

function impact(cls: ImpactClass, s: Synth): void {
  const t = 0.002;
  switch (cls) {
    case 'soft':
      noiseHit(s, { t, color: 'pink', attack: 0.001, tau: 0.03, gain: 1, filters: [{ type: 'lowpass', f: jit(s, 650, 0.15), q: 0.9 }] });
      noiseHit(s, { t, attack: 0.002, tau: 0.02, gain: 0.25, filters: [{ type: 'bandpass', f: 2600, q: 0.7 }] });
      debris(s, t + 0.005, 0.12, 260, 1900, 0.25);
      break;
    case 'dirt':
      noiseHit(s, { t, color: 'pink', attack: 0.0008, tau: 0.035, gain: 1, filters: [{ type: 'lowpass', f: jit(s, 900, 0.15), q: 1 }] });
      thunk(s, t, 110, 0.03, 0.5);
      debris(s, t + 0.01, 0.26, 420, jit(s, 2600, 0.2), 0.55);
      break;
    case 'hard':
      // Sharp crack + chips flying off.
      noiseHit(s, { t, attack: 0.0002, tau: 0.005, gain: 1.0, filters: [{ type: 'bandpass', f: jit(s, 2600, 0.15), q: 0.9 }] });
      noiseHit(s, { t, attack: 0.0006, tau: 0.025, gain: 0.9, filters: [{ type: 'bandpass', f: jit(s, 1300, 0.15), q: 1.2 }] });
      thunk(s, t, 160, 0.025, 0.5);
      debris(s, t + 0.004, 0.22, 700, jit(s, 3000, 0.2), 0.35);
      break;
    case 'metal': {
      const b = jit(s, 1900, 0.15);
      noiseHit(s, { t, attack: 0.0002, tau: 0.003, gain: 0.8, filters: [{ type: 'highpass', f: 2500 }] });
      modal(s, t, [b, b * 1.61, b * 2.48, b * 3.52, b * 4.7], [0.38, 0.22, 0.13, 0.08, 0.05], [1, 0.7, 0.5, 0.35, 0.2], 0.55);
      break;
    }
    case 'wood': {
      const b = jit(s, 420, 0.12);
      noiseHit(s, { t, attack: 0.0004, tau: 0.008, gain: 0.8, filters: [{ type: 'bandpass', f: 1300, q: 1 }] });
      modal(s, t, [b, b * 2.3, b * 3.9], [0.05, 0.03, 0.02], [1, 0.6, 0.35], 0.8);
      debris(s, t + 0.006, 0.1, 500, 2200, 0.25);                // splinters
      break;
    }
    case 'water':
      noiseHit(s, {
        t, color: 'white', attack: 0.003, tau: 0.07, gain: 1,
        filters: [{ type: 'bandpass', f: 2600, q: 0.9, to: 650, time: 0.18 }],
      });
      for (let i = 0; i < 4; i++) {                                // bubbles
        const tb = t + 0.03 + s.rand() * 0.18;
        const f0 = rr(s, 380, 900);
        tone(s, { t: tb, f: f0, fTo: f0 * rr(s, 1.6, 2.2), sweepTime: 0.03, attack: 0.002, tau: 0.018, gain: rr(s, 0.12, 0.25) });
      }
      noiseHit(s, { t: t + 0.06, color: 'pink', attack: 0.04, tau: 0.08, gain: 0.35, filters: [{ type: 'lowpass', f: 900 }] });
      break;
    case 'flesh':
      // Wet thud: dull low body + a short squelch.
      thunk(s, t, 95, 0.045, 1.0);
      noiseHit(s, { t, color: 'pink', attack: 0.001, tau: 0.04, gain: 0.8, filters: [{ type: 'lowpass', f: 420, q: 1.2 }] });
      noiseHit(s, {
        t: t + 0.008, attack: 0.004, tau: 0.03, gain: 0.35,
        filters: [{ type: 'bandpass', f: jit(s, 900, 0.2), q: 3.5, to: 520, time: 0.06 }],
      });
      break;
    case 'armor': {
      const b = jit(s, 820, 0.1);
      noiseHit(s, { t, attack: 0.0003, tau: 0.006, gain: 0.8, filters: [{ type: 'bandpass', f: 2600, q: 0.8 }] });
      modal(s, t, [b, b * 1.6, b * 2.5], [0.09, 0.06, 0.04], [1, 0.6, 0.4], 0.6);
      thunk(s, t, 140, 0.03, 0.6);
      break;
    }
  }
}

export function impactSpec(cls: ImpactClass): SoundSpec {
  const seconds = cls === 'metal' ? 0.75 : cls === 'water' ? 0.5 : cls === 'dirt' || cls === 'hard' ? 0.34 : 0.28;
  return { seconds, build: (s) => impact(cls, s) };
}

/** Ricochet whine: a descending, slightly warbling whistle. */
export function ricochetSpec(): SoundSpec {
  return {
    seconds: 0.5,
    build: (s) => {
      const f0 = rr(s, 2900, 4200);
      const g = amp(s, 1);
      g.connect(s.out);
      tone(s, { t: 0.004, f: f0, fTo: f0 * rr(s, 0.35, 0.5), sweepTime: 0.3, attack: 0.006, hold: 0.08, tau: 0.08, gain: 0.5, dest: g });
      noiseHit(s, {
        t: 0.004, attack: 0.01, hold: 0.06, tau: 0.08, gain: 0.5,
        filters: [{ type: 'bandpass', f: f0, q: 9, to: f0 * 0.45, time: 0.3 }], dest: g,
      });
      const lfo = s.ctx.createOscillator();                       // tumble warble
      lfo.frequency.value = rr(s, 28, 45);
      const depth = amp(s, 0.35);
      chain(lfo, depth);
      depth.connect(g.gain);
      lfo.start(0);
      lfo.stop(0.5);
    },
  };
}

/** Near-miss: N-wave crack (supersonic shock) + turbulent whizz with a doppler fall. */
export function bulletCrackSpec(): SoundSpec {
  return {
    seconds: 0.42,
    build: (s) => {
      const sr = s.sr;
      const nLen = Math.max(4, Math.floor(sr * rr(s, 0.0005, 0.0008)));
      const nb = s.ctx.createBuffer(1, nLen + 4, sr);
      const d = nb.getChannelData(0);
      for (let i = 0; i < nLen; i++) d[i] = 1 - (2 * i) / (nLen - 1);  // N-wave: +1 -> -1
      const crack = play(s, nb, 0.004);
      const hp = bq(s, 'highpass', 900, 0.7);
      const cg = amp(s, 0.8);
      chain(crack, hp, cg, s.out);
      noiseHit(s, { t: 0.004, attack: 0.0002, tau: 0.004, gain: 1.1, filters: [{ type: 'highpass', f: 2600 }] });
      noiseHit(s, {
        t: 0.008, attack: 0.008, tau: 0.075, gain: 1.2,
        filters: [{ type: 'bandpass', f: rr(s, 5200, 6200), q: 5, to: rr(s, 1600, 2100), time: 0.18 }],
      });
      // Ground reflection of the crack.
      const refl = amp(s, 1);
      cg.connect(refl);
      echoTap(s, refl, rr(s, 0.035, 0.06), 0.3, 3500);
    },
  };
}

/** Glassy armor-plate shatter: crack, shard tinkles, a low knock. */
export function armorBreakSpec(): SoundSpec {
  return {
    seconds: 0.8,
    build: (s) => {
      noiseHit(s, { t: 0.002, attack: 0.0002, tau: 0.006, gain: 1, filters: [{ type: 'highpass', f: 1800 }] });
      noiseHit(s, { t: 0.002, attack: 0.0005, tau: 0.03, gain: 0.5, filters: [{ type: 'bandpass', f: 1500, q: 1 }] });
      const crk = crackleBuffer(s.ctx, 0.25, 1600, 0.06, s.rand);
      noiseHit(s, {
        t: 0.002, buffer: crk, attack: 0.001, hold: 0.1, tau: 0.05, gain: 0.8,
        filters: [{ type: 'highpass', f: 2200 }, { type: 'lowpass', f: 8000 }],
      });
      for (let i = 0; i < 10; i++) {
        const t = 0.004 + s.rand() * s.rand() * 0.3;
        tone(s, { t, f: rr(s, 2200, 7000), attack: 0.0005, tau: rr(s, 0.02, 0.18), gain: rr(s, 0.08, 0.22) });
      }
      thunk(s, 0.002, 150, 0.04, 0.5);
      metalClick(s, 0.004, 1100, 0.4, 0.04);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------------------------

function rollingBuffer(s: Synth, seconds: number, color: 'pink' | 'brown', channels: 1 | 2, depth: number): AudioBuffer {
  const b = noiseBuffer(s.ctx, seconds, color, channels, s.rand);
  for (let c = 0; c < channels; c++) {
    applyRollingAM(b.getChannelData(c), s.sr, rr(s, 2, 4), depth, s.rand);
    applyRollingAM(b.getChannelData(c), s.sr, rr(s, 8, 12), depth * 0.5, s.rand);
  }
  return b;
}

export function explosionNearSpec(): SoundSpec {
  return {
    seconds: 3.6,
    channels: 2,
    build: (s) => {
      const t = 0.002;
      const punch = amp(s, 0.7);
      chain(punch, softClip(s, 3.2), s.out);
      // Blast crack.
      noiseHit(s, { t, attack: 0.0004, tau: 0.02, gain: 1.0, filters: [{ type: 'highpass', f: 900 }], dest: punch });
      // Body: brown noise, cutoff falling as the fireball expands.
      noiseHit(s, {
        t, color: 'brown', channels: 2, attack: 0.003, tau: jit(s, 0.2, 0.1), gain: 1.3,
        filters: [{ type: 'lowpass', f: 2400, q: 0.7, to: 320, time: 0.4 }], dest: punch,
      });
      // Sub thump.
      tone(s, { t, f: jit(s, 78, 0.06), fTo: 27, sweepTime: 0.4, attack: 0.003, tau: 0.3, gain: 1.4, dest: punch });
      // Falling debris (stereo).
      const deb = crackleBuffer(s.ctx, 1.6, 700, 0.5, s.rand, 2, 0.05);
      noiseHit(s, {
        t: t + 0.05, buffer: deb, attack: 0.02, hold: 0.5, tau: 0.35, gain: 0.32,
        filters: [{ type: 'bandpass', f: 2400, q: 0.6 }],
      });
      // Long rolling tail (stereo).
      const tail = play(s, rollingBuffer(s, s.len, 'brown', 2, 0.7), t);
      const lp = bq(s, 'lowpass', 650, 0.6);
      sweep(lp.frequency, t + 0.1, 650, 220, 2.2);
      const tg = amp(s);
      tg.gain.setValueAtTime(0, t);
      tg.gain.linearRampToValueAtTime(0.85, t + 0.12);
      tg.gain.setTargetAtTime(0, t + 0.12, jit(s, 0.95, 0.1));
      chain(tail, lp, tg, s.out);
      const refl = amp(s, 1);
      punch.connect(refl);
      echoTap(s, refl, jit(s, 0.36, 0.15), 0.3, 900);
      echoTap(s, refl, jit(s, 0.82, 0.15), 0.18, 600);
    },
  };
}

export function explosionFarSpec(): SoundSpec {
  return {
    seconds: 4.4,
    rate: 24000,
    build: (s) => {
      const t = 0.002;
      const punch = amp(s, 0.7);
      chain(punch, softClip(s, 2.5), s.out);
      noiseHit(s, {
        t, color: 'brown', attack: 0.01, tau: 0.38, gain: 1.2,
        filters: [{ type: 'lowpass', f: 700, q: 0.7, to: 240, time: 0.8 }], dest: punch,
      });
      tone(s, { t, f: 62, fTo: 26, sweepTime: 0.5, attack: 0.006, tau: 0.4, gain: 1.1, dest: punch });
      const tail = play(s, rollingBuffer(s, s.len, 'brown', 1, 0.9), t);
      const lp = bq(s, 'lowpass', 420, 0.6);
      sweep(lp.frequency, t + 0.1, 420, 160, 2.6);
      const tg = amp(s);
      tg.gain.setValueAtTime(0, t);
      tg.gain.linearRampToValueAtTime(1.0, t + 0.2);
      tg.gain.setTargetAtTime(0, t + 0.2, 1.3);
      chain(tail, lp, tg, s.out);
      const refl = amp(s, 1);
      punch.connect(refl);
      echoTap(s, refl, jit(s, 0.45, 0.15), 0.4, 500);
      echoTap(s, refl, jit(s, 1.05, 0.15), 0.26, 400);
      echoTap(s, refl, jit(s, 1.8, 0.15), 0.14, 320);
    },
  };
}

/** Ear ringing after a very close blast (two slightly detuned high sines beating). */
export function tinnitusSpec(): SoundSpec {
  return {
    seconds: 4.2,
    rate: 24000,
    build: (s) => {
      const f = rr(s, 3900, 4400);
      tone(s, { t: 0.05, f, attack: 0.08, hold: 0.5, tau: 1.0, gain: 0.6 });
      tone(s, { t: 0.05, f: f * 1.006, attack: 0.08, hold: 0.5, tau: 0.9, gain: 0.4 });
    },
  };
}
