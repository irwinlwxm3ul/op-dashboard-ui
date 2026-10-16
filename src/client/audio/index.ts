// Public audio API (see ARCHITECTURE.md). A singleton `audio` backed by the WebAudio engine.
//
// Every method is safe to call at any time: before init(), in Node / headless environments
// without AudioContext, with garbage input. Nothing here ever throws; an unexpected engine error
// is reported once per method with console.warn and the call becomes a no-op.

import type { SurfaceMaterial, Vec3, WeaponSoundKind } from '../../shared/types';
import { AudioEngine, type AudioSettings } from './engine';
import type { EngineSoundHandle } from './loops';
import type { ReloadPhase } from './synth/mechanical';
import type { HitmarkerKind, UiSoundName } from './synth/ui';

export type { AudioSettings } from './engine';
export type { EngineSoundHandle } from './loops';
export type { ReloadPhase } from './synth/mechanical';
export type { HitmarkerKind, UiSoundName } from './synth/ui';

const engine = new AudioEngine();
const warned = new Set<string>();

function report(method: string, err: unknown): void {
  if (warned.has(method)) return;
  warned.add(method);
  try { console.warn(`[audio] ${method} failed`, err); } catch { /* no console */ }
}

const wrappers = new WeakMap<EngineSoundHandle, EngineSoundHandle>();

/** Handle wrapper so a broken engine graph can never throw into game code (cached per handle). */
function safeHandle(h: EngineSoundHandle | null): EngineSoundHandle {
  const cached = h ? wrappers.get(h) : undefined;
  if (cached) return cached;
  const w: EngineSoundHandle = {
    update(pos, rpm, throttle, local) {
      try { h?.update(pos, rpm, throttle, local); } catch (e) { report('engine.update', e); }
    },
    stop() {
      try { h?.stop(); } catch (e) { report('engine.stop', e); }
    },
  };
  if (h) wrappers.set(h, w);
  return w;
}

export const audio = {
  /** Create the AudioContext and pre-render the synthesized bank. Call from a user gesture; idempotent. */
  init(): Promise<void> {
    try {
      return engine.init().catch((e) => { report('init', e); });
    } catch (e) {
      report('init', e);
      return Promise.resolve();
    }
  },
  setSettings(s: AudioSettings): void {
    try { engine.setSettings(s); } catch (e) { report('setSettings', e); }
  },
  setListener(pos: Vec3, yaw: number, pitch: number): void {
    try { engine.setListener(pos, yaw, pitch); } catch (e) { report('setListener', e); }
  },
  /** Distance delay (speed of sound), air-absorption muffling, near/far variants, pitch variation. */
  gunshot(kind: WeaponSoundKind, pos: Vec3, local: boolean): void {
    try { engine.gunshot(kind, pos, local); } catch (e) { report('gunshot', e); }
  },
  dryFire(): void {
    try { engine.dryFire(); } catch (e) { report('dryFire', e); }
  },
  reload(kind: WeaponSoundKind, phase: ReloadPhase): void {
    try { engine.reload(kind, phase); } catch (e) { report('reload', e); }
  },
  weaponSwitch(): void {
    try { engine.weaponSwitch(); } catch (e) { report('weaponSwitch', e); }
  },
  /** material: SurfaceMaterial | 'flesh' | 'armor' (unknown strings fall back to dirt). */
  impact(material: string, pos: Vec3): void {
    try { engine.impact(material, pos); } catch (e) { report('impact', e); }
  },
  /** Near-miss supersonic snap at the bullet's closest point to the listener. */
  bulletCrack(pos: Vec3): void {
    try { engine.bulletCrack(pos); } catch (e) { report('bulletCrack', e); }
  },
  /** intensity 0..1: crouch ~0.3, walk ~0.6, sprint 1. */
  footstep(material: SurfaceMaterial, pos: Vec3, local: boolean, intensity: number): void {
    try { engine.footstep(material, pos, local, intensity); } catch (e) { report('footstep', e); }
  },
  jump(local: boolean, pos: Vec3): void {
    try { engine.jump(local, pos); } catch (e) { report('jump', e); }
  },
  /** intensity 0..1 (scaled from landing speed). */
  land(intensity: number, pos: Vec3, local: boolean): void {
    try { engine.land(intensity, pos, local); } catch (e) { report('land', e); }
  },
  hitmarker(kind: HitmarkerKind): void {
    try { engine.hitmarker(kind); } catch (e) { report('hitmarker', e); }
  },
  /** amount: damage taken (HP). */
  hurt(amount: number): void {
    try { engine.hurt(amount); } catch (e) { report('hurt', e); }
  },
  armorBreak(): void {
    try { engine.armorBreak(); } catch (e) { report('armorBreak', e); }
  },
  explosion(pos: Vec3): void {
    try { engine.explosion(pos); } catch (e) { report('explosion', e); }
  },
  /** item: ConsumableId ('bandage' | 'firstaid' | 'medkit' | 'energy' | 'fuel'); others play a syringe click. */
  heal(item: string): void {
    try { engine.heal(item); } catch (e) { report('heal', e); }
  },
  pickup(): void {
    try { engine.pickup(); } catch (e) { report('pickup', e); }
  },
  ui(name: UiSoundName): void {
    try { engine.ui(name); } catch (e) { report('ui', e); }
  },
  /** Freefall / parachute wind, 0..1. */
  setWind(intensity: number): void {
    try { engine.setWind(intensity); } catch (e) { report('setWind', e); }
  },
  /** insideBlue: listener is outside the safe circle (in the blue). intensity 0..1 (depth / wall proximity). */
  setZoneProximity(insideBlue: boolean, intensity: number): void {
    try { engine.setZoneProximity(insideBlue, intensity); } catch (e) { report('setZoneProximity', e); }
  },
  /**
   * Engine loop for vehicle `id` (the same handle is returned for the same id until stop()).
   * update(pos, rpm, throttle, local) every frame; rpm is real engine RPM (idle ~900, 0 = off).
   */
  engine(id: number): EngineSoundHandle {
    try { return safeHandle(engine.engine(id)); } catch (e) { report('engine', e); return safeHandle(null); }
  },
  /** Per-frame: loop smoothing (wind, zone, engines) and voice cleanup. */
  update(dt: number): void {
    try { engine.update(dt); } catch (e) { report('update', e); }
  },
};

export type Audio = typeof audio;
