// Weapon handling and item foley: reload phases, dry fire, weapon switch fallback, heals, pickups.

import type { WeaponSoundKind } from '../../../shared/types';
import { type SoundSpec, type Synth, crackleBuffer, jit, modal, noiseHit, applyRollingAM, noiseBuffer, rr, tone } from './dsp';
import { MECH_PITCH, metalClick, scrape, thunk } from './gunshots';

export type ReloadPhase = 'out' | 'in' | 'bolt' | 'shell';
export const RELOAD_PHASES: readonly ReloadPhase[] = ['out', 'in', 'bolt', 'shell'];

function reloadOut(s: Synth, k: number): void {
  metalClick(s, 0.002, 3900 * k, 0.55, 0.012);                // mag release button
  scrape(s, 0.03, 0.09, 1700 * k, 3100 * k, 0.5);             // mag sliding out of the well
  metalClick(s, 0.11, 1500 * k, 0.6, 0.028);                  // mag clears the receiver
  thunk(s, 0.11, 230 * k, 0.03, 0.4);
}

function reloadIn(s: Synth, k: number): void {
  scrape(s, 0.002, 0.065, 2600 * k, 1500 * k, 0.45);          // mag guided into the well
  thunk(s, 0.07, 180 * k, 0.04, 1.0);                          // seating slap
  metalClick(s, 0.07, 1900 * k, 1.0, 0.03);
  metalClick(s, 0.088, 4300 * k, 0.5, 0.01);                  // catch latches
}

function reloadBolt(s: Synth, kind: WeaponSoundKind, k: number): void {
  if (kind === 'shotgun') {
    // Pump: "ka" (back) ... "chunk" (forward) with wooden fore-end resonance.
    scrape(s, 0.002, 0.07, 1300, 2300, 0.5);
    metalClick(s, 0.06, 1350, 0.9, 0.03);
    modal(s, 0.06, [260, 610], [0.04, 0.03], [1, 0.6], 0.3);
    scrape(s, 0.15, 0.06, 2100, 1200, 0.45);
    metalClick(s, 0.2, 1150, 1.0, 0.035);
    thunk(s, 0.2, 160, 0.05, 0.8);
    return;
  }
  if (kind === 'sniper') {
    // Bolt action: handle up, back, forward, lock down.
    metalClick(s, 0.002, 3100, 0.6, 0.015);
    scrape(s, 0.06, 0.1, 1400, 2900, 0.55);
    metalClick(s, 0.16, 1900, 0.85, 0.03);
    scrape(s, 0.27, 0.09, 2700, 1500, 0.5);
    metalClick(s, 0.36, 1700, 1.0, 0.035);
    thunk(s, 0.36, 210, 0.035, 0.5);
    metalClick(s, 0.46, 2800, 0.7, 0.018);
    return;
  }
  // Charging handle: pull back, release, carrier slams home.
  metalClick(s, 0.002, 2600 * k, 0.6, 0.02);
  scrape(s, 0.01, 0.08, 1500 * k, 3200 * k, 0.5);
  metalClick(s, 0.17, 2000 * k, 1.0, 0.035);
  thunk(s, 0.17, 260 * k, 0.035, 0.6);
  modal(s, 0.17, [1180 * k, 1830 * k], [0.06, 0.04], [1, 0.5], 0.15);
}

function reloadShell(s: Synth, k: number): void {
  scrape(s, 0.002, 0.045, 3100 * k, 2000 * k, 0.4);           // shell slides past the lifter
  metalClick(s, 0.045, 2700 * k, 0.65, 0.016);                // brass rim click
  thunk(s, 0.05, 300 * k, 0.03, 0.55);                        // spring takes the round
}

export function reloadSpec(kind: WeaponSoundKind, phase: ReloadPhase): SoundSpec {
  const k = MECH_PITCH[kind];
  const seconds = phase === 'bolt' ? (kind === 'sniper' ? 0.62 : 0.4) : phase === 'shell' ? 0.22 : 0.32;
  return {
    seconds,
    build: (s) => {
      switch (phase) {
        case 'out': reloadOut(s, k); break;
        case 'in': reloadIn(s, k); break;
        case 'bolt': reloadBolt(s, kind, k); break;
        case 'shell': reloadShell(s, k); break;
      }
    },
  };
}

/** Hammer falling on an empty chamber: tiny, dry, unmistakable. */
export function dryFireSpec(): SoundSpec {
  return {
    seconds: 0.09,
    build: (s) => {
      metalClick(s, 0.002, jit(s, 3400, 0.05), 0.7, 0.008);   // trigger break
      metalClick(s, 0.012, jit(s, 2500, 0.05), 1.0, 0.012);   // hammer / striker
      thunk(s, 0.012, 420, 0.012, 0.25);
    },
  };
}

/** Fallback when weapon_change.ogg is unavailable: cloth swish + sling rattle + click. */
export function weaponSwitchSpec(): SoundSpec {
  return {
    seconds: 0.4,
    build: (s) => {
      noiseHit(s, {
        t: 0.002, color: 'pink', attack: 0.06, tau: 0.05, gain: 0.5,
        filters: [{ type: 'bandpass', f: 1400, q: 0.8, to: 2800, time: 0.12 }],
      });
      metalClick(s, 0.09, 4200, 0.25, 0.01);
      metalClick(s, 0.13, 3600, 0.2, 0.01);
      metalClick(s, 0.22, 2300, 0.8, 0.025);
      thunk(s, 0.22, 240, 0.03, 0.4);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Heals / items
// ---------------------------------------------------------------------------------------------

export type HealSound = 'bandage' | 'firstaid' | 'medkit' | 'energy' | 'syringe' | 'fuel';
export const HEAL_SOUNDS: readonly HealSound[] = ['bandage', 'firstaid', 'medkit', 'energy', 'syringe', 'fuel'];

export function healSoundFor(item: string): HealSound {
  switch (item) {
    case 'bandage': case 'firstaid': case 'medkit': case 'energy': case 'fuel': return item;
    default: return 'syringe';
  }
}

/** Fabric/tape tearing: dense crackle with a jittery envelope through a broad band-pass. */
function rip(s: Synth, t: number, dur: number, gain: number): void {
  const fibres = crackleBuffer(s.ctx, dur + 0.05, rr(s, 2600, 3600), 0, s.rand);
  applyRollingAM(fibres.getChannelData(0), s.sr, rr(s, 18, 30), 0.9, s.rand);
  noiseHit(s, {
    t, buffer: fibres, attack: 0.02, hold: dur * 0.65, tau: dur * 0.12, gain,
    filters: [{ type: 'bandpass', f: rr(s, 2200, 3000), q: 0.55 }, { type: 'highpass', f: 700 }, { type: 'lowpass', f: 5500, q: 0.6 }],
  });
  noiseHit(s, {
    t, color: 'pink', attack: 0.03, hold: dur * 0.55, tau: dur * 0.15, gain: gain * 0.25,
    filters: [{ type: 'bandpass', f: 1800, q: 0.7 }],
  });
}

export function healSpec(kind: HealSound): SoundSpec {
  switch (kind) {
    case 'bandage':
      return { seconds: 0.95, build: (s) => { rip(s, 0.002, 0.34, 1.0); rip(s, 0.46, 0.28, 0.85); } };
    case 'firstaid':
      return {
        seconds: 1.0,
        build: (s) => {
          metalClick(s, 0.002, 2100, 0.4, 0.012);           // plastic clasp
          rip(s, 0.12, 0.42, 1.0);
          noiseHit(s, { t: 0.64, color: 'pink', attack: 0.04, tau: 0.08, gain: 0.35, filters: [{ type: 'bandpass', f: 2400, q: 0.6 }] });
        },
      };
    case 'medkit':
      return {
        seconds: 1.05,
        build: (s) => {
          metalClick(s, 0.002, 2400, 0.8, 0.015);           // latch 1
          metalClick(s, 0.13, 2250, 0.8, 0.015);            // latch 2
          thunk(s, 0.22, 200, 0.05, 0.6);                   // lid opens
          rip(s, 0.36, 0.4, 0.9);
        },
      };
    case 'energy':
      return {
        seconds: 0.65,
        build: (s) => {
          metalClick(s, 0.002, 2900, 0.9, 0.012);           // tab crack
          noiseHit(s, {                                      // pssht
            t: 0.006, attack: 0.004, tau: 0.16, gain: 0.7,
            filters: [{ type: 'highpass', f: 2800, q: 0.7 }, { type: 'bandpass', f: 6200, q: 0.8, to: 4200, time: 0.3 }],
          });
          tone(s, { t: 0.02, f: 900, fTo: 700, sweepTime: 0.2, attack: 0.01, tau: 0.08, gain: 0.08 });
        },
      };
    case 'syringe':
      return {
        seconds: 0.55,
        build: (s) => {
          metalClick(s, 0.002, 3600, 0.35, 0.006);          // cap pop
          thunk(s, 0.002, 600, 0.015, 0.3);
          metalClick(s, 0.16, 2200, 0.9, 0.012);            // plunger click
          noiseHit(s, {                                      // tiny squirt
            t: 0.18, attack: 0.01, tau: 0.07, gain: 0.25,
            filters: [{ type: 'bandpass', f: 5200, q: 1.2, to: 3800, time: 0.15 }],
          });
        },
      };
    case 'fuel':
      return {
        seconds: 1.0,
        build: (s) => {
          metalClick(s, 0.002, 1900, 0.6, 0.02);            // cap
          for (let i = 0; i < 6; i++) {
            const t = 0.12 + i * rr(s, 0.11, 0.14);
            noiseHit(s, {                                    // glug: resonant falling cavity
              t, color: 'pink', attack: 0.008, tau: 0.04, gain: rr(s, 0.6, 0.9),
              filters: [{ type: 'bandpass', f: rr(s, 850, 1000), q: 7, to: rr(s, 380, 460), time: 0.07 }],
            });
            tone(s, { t: t + 0.01, f: rr(s, 170, 210), fTo: rr(s, 250, 300), sweepTime: 0.05, attack: 0.004, tau: 0.03, gain: 0.25 });
          }
        },
      };
  }
}

/** Pickup: short cloth rustle with a soft item settle. */
export function pickupSpec(): SoundSpec {
  return {
    seconds: 0.34,
    build: (s) => {
      const cloth = noiseBuffer(s.ctx, 0.36, 'pink', 1, s.rand);
      applyRollingAM(cloth.getChannelData(0), s.sr, rr(s, 14, 22), 1, s.rand);
      noiseHit(s, {
        t: 0.002, buffer: cloth, attack: 0.03, hold: 0.09, tau: 0.05, gain: 1,
        filters: [{ type: 'bandpass', f: rr(s, 1800, 2600), q: 0.6 }, { type: 'highpass', f: 500 }],
      });
      noiseHit(s, { t: 0.13, color: 'white', attack: 0.004, tau: 0.03, gain: 0.25, filters: [{ type: 'bandpass', f: 3800, q: 0.9 }] });
      thunk(s, 0.15, 170, 0.04, 0.35);
    },
  };
}
