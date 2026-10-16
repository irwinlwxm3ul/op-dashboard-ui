// Hitmarkers (non-spatial combat feedback) and menu / HUD sounds.

import { type SoundSpec, type Synth, amp, bq, chain, envAHD, modal, noiseHit, tone } from './dsp';

export type HitmarkerKind = 'body' | 'head' | 'armor' | 'knock' | 'kill';
export const HITMARKER_KINDS: readonly HitmarkerKind[] = ['body', 'head', 'armor', 'knock', 'kill'];

export type UiSoundName = 'click' | 'hover' | 'ready' | 'start' | 'countdown' | 'error' | 'zone' | 'win' | 'lose';
export const UI_SOUND_NAMES: readonly UiSoundName[] = ['click', 'hover', 'ready', 'start', 'countdown', 'error', 'zone', 'win', 'lose'];

/** Crisp tick: band-passed noise click on top of a short sine blip. */
function tick(s: Synth, t: number, f: number, gain: number, dest?: AudioNode): void {
  noiseHit(s, { t, attack: 0.0002, tau: 0.0025, gain, filters: [{ type: 'bandpass', f: f * 1.6, q: 1.4 }], dest });
  tone(s, { t, f, attack: 0.0005, tau: 0.01, gain: gain * 0.6, dest });
  tone(s, { t, f: f * 0.58, attack: 0.0005, tau: 0.006, gain: gain * 0.3, dest });
}

/** Bell-like tone (inharmonic partials of a struck bar). */
function bell(s: Synth, t: number, f: number, gain: number, decay: number, dest?: AudioNode): void {
  modal(s, t, [f, f * 2.76, f * 5.4, f * 8.93], [decay, decay * 0.45, decay * 0.22, decay * 0.1], [1, 0.45, 0.22, 0.1], gain, dest, 0.001);
}

/** Soft brass-ish note: detuned saws through an enveloped low-pass. */
function brass(s: Synth, t: number, f: number, dur: number, gain: number): void {
  const lp = bq(s, 'lowpass', f * 2, 1.2);
  lp.frequency.setValueAtTime(f * 1.5, t);
  lp.frequency.linearRampToValueAtTime(f * 6, t + 0.05);
  lp.frequency.setTargetAtTime(f * 3.2, t + 0.05, 0.15);
  const g = amp(s);
  envAHD(g.gain, t, gain, 0.025, dur, 0.12);
  chain(lp, g, s.out);
  for (const det of [-7, 6]) {
    const o = s.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.detune.value = det;
    o.connect(lp);
    o.start(t);
    o.stop(Math.min(s.len, t + dur + 1.2));
  }
  tone(s, { t, f, attack: 0.02, hold: dur, tau: 0.15, gain: gain * 0.5 });
}

function hitmarker(kind: HitmarkerKind, s: Synth): void {
  const t = 0.002;
  switch (kind) {
    case 'body':
      tick(s, t, 3100, 1.0);
      break;
    case 'head':
      // Bright metallic "ding" over the tick.
      tick(s, t, 3600, 0.8);
      modal(s, t, [2950, 4720, 7080, 9430], [0.24, 0.15, 0.09, 0.05], [1, 0.6, 0.35, 0.2], 0.55, undefined, 0.0008);
      break;
    case 'armor': {
      // Duller: low-passed tick + low-mid clank.
      const lp = bq(s, 'lowpass', 3200, 0.7);
      lp.connect(s.out);
      tick(s, t, 2100, 0.9, lp);
      modal(s, t, [820, 1310, 2050], [0.07, 0.05, 0.035], [1, 0.6, 0.35], 0.5, lp);
      break;
    }
    case 'knock':
      // Deeper double tick with weight.
      tick(s, t, 1500, 1.0);
      tone(s, { t, f: 190, fTo: 120, sweepTime: 0.05, attack: 0.001, tau: 0.03, gain: 0.5 });
      tick(s, t + 0.075, 1650, 0.95);
      tone(s, { t: t + 0.075, f: 200, fTo: 125, sweepTime: 0.05, attack: 0.001, tau: 0.03, gain: 0.45 });
      break;
    case 'kill':
      // Layered confirm: tick + rising two-note chime + sub "thoom" + shimmer.
      tick(s, t, 3100, 0.8);
      tone(s, { t, f: 115, fTo: 58, sweepTime: 0.12, attack: 0.002, tau: 0.1, gain: 0.55 });
      bell(s, t + 0.01, 1318.5, 0.5, 0.42);
      bell(s, t + 0.085, 1975.5, 0.55, 0.55);
      tone(s, { t: t + 0.09, f: 3951, attack: 0.01, tau: 0.25, gain: 0.08 });
      break;
  }
}

export function hitmarkerSpec(kind: HitmarkerKind): SoundSpec {
  const seconds = kind === 'kill' ? 1.2 : kind === 'head' ? 0.6 : kind === 'knock' ? 0.3 : 0.16;
  return { seconds, build: (s) => hitmarker(kind, s) };
}

function uiSound(name: UiSoundName, s: Synth): void {
  const t = 0.002;
  switch (name) {
    case 'click':
      tone(s, { t, f: 1650, fTo: 1400, sweepTime: 0.02, attack: 0.0008, tau: 0.016, gain: 0.8 });
      noiseHit(s, { t, attack: 0.0002, tau: 0.002, gain: 0.5, filters: [{ type: 'bandpass', f: 4200, q: 1.2 }] });
      break;
    case 'hover':
      tone(s, { t, f: 2400, fTo: 2650, sweepTime: 0.02, attack: 0.002, tau: 0.012, gain: 1 });
      break;
    case 'ready':
      tone(s, { t, type: 'triangle', f: 659.3, attack: 0.004, hold: 0.04, tau: 0.06, gain: 0.7 });
      tone(s, { t: t + 0.09, type: 'triangle', f: 987.8, attack: 0.004, hold: 0.06, tau: 0.1, gain: 0.8 });
      tone(s, { t: t + 0.09, f: 1975.5, attack: 0.004, tau: 0.08, gain: 0.15 });
      break;
    case 'start': {
      const notes = [523.3, 659.3, 784, 1046.5];
      notes.forEach((f, i) => {
        tone(s, { t: t + i * 0.065, type: 'triangle', f, attack: 0.004, hold: 0.05, tau: i === 3 ? 0.25 : 0.08, gain: 0.6 });
        tone(s, { t: t + i * 0.065, type: 'square', f, attack: 0.004, hold: 0.03, tau: 0.05, gain: 0.08 });
      });
      noiseHit(s, {
        t, color: 'pink', attack: 0.15, tau: 0.12, gain: 0.35,
        filters: [{ type: 'bandpass', f: 600, q: 1.2, to: 3200, time: 0.3 }],
      });
      break;
    }
    case 'countdown':
      tone(s, { t, f: 880, attack: 0.003, hold: 0.09, tau: 0.025, gain: 0.8 });
      tone(s, { t, f: 1760, attack: 0.003, hold: 0.09, tau: 0.02, gain: 0.2 });
      break;
    case 'error': {
      const lp = bq(s, 'lowpass', 1300, 0.8);
      lp.connect(s.out);
      for (const t0 of [t, t + 0.12]) {
        tone(s, { t: t0, type: 'square', f: 150, attack: 0.003, hold: 0.08, tau: 0.015, gain: 0.5, dest: lp });
        tone(s, { t: t0, type: 'square', f: 155.5, attack: 0.003, hold: 0.08, tau: 0.015, gain: 0.5, dest: lp });
      }
      break;
    }
    case 'zone': {
      // Siren-ish warning: two wails with a slow tremolo.
      const o = s.ctx.createOscillator();
      o.type = 'sawtooth';
      const o2 = s.ctx.createOscillator();
      o2.type = 'sine';
      const p1 = o.frequency, p2 = o2.frequency;
      for (const p of [p1, p2]) {
        p.setValueAtTime(540, t);
        p.linearRampToValueAtTime(830, t + 0.35);
        p.linearRampToValueAtTime(540, t + 0.7);
        p.linearRampToValueAtTime(830, t + 1.05);
        p.linearRampToValueAtTime(560, t + 1.45);
      }
      const lp = bq(s, 'lowpass', 1900, 0.9);
      const g = amp(s);
      envAHD(g.gain, t, 0.5, 0.06, 1.2, 0.12);
      const og = amp(s, 0.6);
      chain(o, lp, og, g, s.out);
      o2.connect(g);
      const trem = s.ctx.createOscillator();
      trem.frequency.value = 9;
      const td = amp(s, 0.18);
      chain(trem, td);
      td.connect(og.gain);
      for (const n of [o, o2, trem]) { n.start(t); n.stop(s.len); }
      break;
    }
    case 'win': {
      brass(s, t, 392, 0.09, 0.32);
      brass(s, t + 0.13, 523.3, 0.09, 0.32);
      brass(s, t + 0.26, 659.3, 0.09, 0.34);
      for (const f of [523.3, 659.3, 784, 1046.5]) brass(s, t + 0.4, f, 1.0, 0.22);
      tone(s, { t: t + 0.4, f: 98, fTo: 80, sweepTime: 0.2, attack: 0.002, tau: 0.3, gain: 0.6 });   // timpani
      noiseHit(s, { t: t + 0.4, color: 'pink', attack: 0.002, tau: 0.08, gain: 0.25, filters: [{ type: 'lowpass', f: 600 }] });
      modal(s, t + 0.42, [2093, 3136, 4186], [0.8, 0.6, 0.4], [1, 0.6, 0.4], 0.05);                // shimmer
      break;
    }
    case 'lose': {
      brass(s, t, 392, 0.22, 0.3);
      brass(s, t + 0.3, 311.1, 0.22, 0.3);
      for (const f of [261.6, 311.1, 196]) brass(s, t + 0.6, f, 0.8, 0.22);
      tone(s, { t: t + 0.6, f: 65.4, attack: 0.05, hold: 0.6, tau: 0.4, gain: 0.35 });
      break;
    }
  }
}

export function uiSpec(name: UiSoundName): SoundSpec {
  const seconds: Record<UiSoundName, number> = {
    click: 0.09, hover: 0.06, ready: 0.42, start: 0.85, countdown: 0.2, error: 0.3, zone: 1.65, win: 2.6, lose: 2.2,
  };
  return { seconds: seconds[name], build: (s) => uiSound(name, s) };
}
