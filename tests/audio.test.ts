import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audio } from '../src/client/audio';
import { VarSet } from '../src/client/audio/bank';
import { AudioEngine, MAX_VOICES } from '../src/client/audio/engine';
import { MAX_ACTIVE_ENGINES } from '../src/client/audio/loops';
import {
  airCutoff, createSpatial, distanceGain, nearFarMix, soundDelay, spatialize, volumeCurve,
} from '../src/client/audio/spatial';
import { stepClassFor } from '../src/client/audio/synth/footsteps';
import { impactClassFor } from '../src/client/audio/synth/impacts';
import { healSoundFor } from '../src/client/audio/synth/mechanical';
import { SPEED_OF_SOUND } from '../src/shared/constants';
import type { SurfaceMaterial, WeaponSoundKind } from '../src/shared/types';

const KINDS: WeaponSoundKind[] = ['pistol', 'smg', 'rifle', 'shotgun', 'dmr', 'sniper'];
const SURFACES: SurfaceMaterial[] = ['grass', 'dirt', 'rock', 'sand', 'road', 'wood', 'concrete', 'metal', 'water', 'snow'];
const P = { x: 12, y: 1, z: -30 };

/** Calls every public method once (also with hostile input). */
function exerciseAll(a: typeof audio | AudioEngine): void {
  a.setSettings({ master: 0.8, sfx: 1, ui: 0.5 });
  a.setListener({ x: 0, y: 1.6, z: 0 }, 0.4, -0.1);
  for (const k of KINDS) {
    a.gunshot(k, P, true);
    a.gunshot(k, P, false);
    a.gunshot(k, { x: 400, y: 0, z: 600 }, false);
    for (const ph of ['out', 'in', 'bolt', 'shell'] as const) a.reload(k, ph);
  }
  a.dryFire();
  a.weaponSwitch();
  for (const m of [...SURFACES, 'flesh', 'armor', 'unknown']) a.impact(m, P);
  a.bulletCrack({ x: 0.5, y: 1.6, z: -1 });
  for (const m of SURFACES) {
    a.footstep(m, P, true, 1);
    a.footstep(m, { x: 3, y: 0, z: 4 }, false, 0.3);
  }
  a.jump(true, P);
  a.jump(false, P);
  a.land(1, P, true);
  a.land(0.2, { x: 5, y: 0, z: 5 }, false);
  for (const h of ['body', 'head', 'armor', 'knock', 'kill'] as const) a.hitmarker(h);
  a.hurt(35);
  a.armorBreak();
  a.explosion({ x: 2, y: 0, z: 2 });
  a.explosion({ x: 900, y: 0, z: 0 });
  for (const it of ['bandage', 'firstaid', 'medkit', 'energy', 'fuel', 'adrenaline']) a.heal(it);
  a.pickup();
  for (const u of ['click', 'hover', 'ready', 'start', 'countdown', 'error', 'zone', 'win', 'lose'] as const) a.ui(u);
  a.setWind(0.7);
  a.setZoneProximity(true, 0.5);
  const e = a.engine(1);
  e.update({ x: 10, y: 0, z: 10 }, 2500, 0.6, false);
  e.update({ x: 0, y: 0, z: 0 }, 0.4, 1, true);
  a.update(1 / 60);
  e.stop();
  a.setWind(0);
  a.setZoneProximity(false, 0);
  a.update(1 / 60);
  // Hostile input must be ignored, never throw.
  const bad = null as unknown as never;
  a.gunshot('laser' as WeaponSoundKind, { x: NaN, y: 0, z: 0 }, false);
  a.impact(bad, bad);
  a.footstep('lava' as SurfaceMaterial, bad, false, NaN);
  a.setListener(bad, NaN, Infinity);
  a.setSettings(bad);
  a.setSettings({ master: NaN, sfx: -3, ui: 9 });
  a.hitmarker('crit' as never);
  a.ui('nope' as never);
  a.reload('laser' as WeaponSoundKind, 'eject' as never);
  a.heal(bad);
  a.hurt(NaN);
  a.land(NaN, bad, false);
  a.engine(NaN).update(bad, NaN, NaN, false);
  a.update(NaN);
  a.update(-1);
}

describe('audio in Node (no AudioContext)', () => {
  it('has no WebAudio in this environment', () => {
    expect(typeof (globalThis as { AudioContext?: unknown }).AudioContext).toBe('undefined');
  });

  it('every method is a silent no-op before init()', () => {
    expect(() => exerciseAll(audio)).not.toThrow();
  });

  it('init() resolves and is idempotent', async () => {
    await expect(audio.init()).resolves.toBeUndefined();
    await expect(audio.init()).resolves.toBeUndefined();
  });

  it('every method is a silent no-op after init()', () => {
    expect(() => exerciseAll(audio)).not.toThrow();
  });

  it('engine handles are stable per vehicle id until stopped', () => {
    const a = audio.engine(42);
    expect(audio.engine(42)).toBe(a);
    a.update({ x: 0, y: 0, z: 0 }, 3000, 0.5, true);
    a.stop();
    a.stop();
    const b = audio.engine(42);
    expect(b).not.toBe(a);
    expect(() => b.update({ x: 1, y: 2, z: 3 }, 1000, 0, false)).not.toThrow();
    b.stop();
  });
});

describe('spatial math', () => {
  const L = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  const F = { ref: 10, rolloff: 0.5, range: 800 };

  it('distance gain: full inside ref, monotonic falloff, silent at range', () => {
    expect(distanceGain(0, F)).toBe(1);
    expect(distanceGain(10, F)).toBe(1);
    let prev = 1;
    for (let d = 15; d < 800; d += 15) {
      const g = distanceGain(d, F);
      expect(g).toBeLessThanOrEqual(prev);
      expect(g).toBeGreaterThanOrEqual(0);
      prev = g;
    }
    expect(distanceGain(100, F)).toBeCloseTo(10 / (10 + 0.5 * 90), 6);
    expect(distanceGain(800, F)).toBe(0);
    expect(distanceGain(5000, F)).toBe(0);
    expect(distanceGain(NaN, F)).toBe(0);
  });

  it('air absorption: ~18 kHz near, ~700 Hz at 800 m', () => {
    expect(airCutoff(0)).toBe(18000);
    expect(airCutoff(800)).toBeCloseTo(700, 0);
    expect(airCutoff(100)).toBeGreaterThan(10000);
    expect(airCutoff(400)).toBeLessThan(airCutoff(200));
    expect(airCutoff(5000)).toBeGreaterThanOrEqual(380);
  });

  it('propagation delay uses the speed of sound', () => {
    expect(soundDelay(SPEED_OF_SOUND)).toBeCloseTo(1, 9);
    expect(soundDelay(0)).toBe(0);
    const s = spatialize(L, { x: 0, y: 0, z: -686 }, F, createSpatial());
    expect(s.delay).toBeCloseTo(686 / SPEED_OF_SOUND, 9);
  });

  it('pans with the listener yaw (yaw 0 faces -Z, +X is right, positive yaw turns left)', () => {
    const s = createSpatial();
    expect(spatialize(L, { x: 20, y: 0, z: 0 }, F, s).pan).toBeGreaterThan(0.6);
    expect(spatialize(L, { x: -20, y: 0, z: 0 }, F, s).pan).toBeLessThan(-0.6);
    const ahead = spatialize(L, { x: 0, y: 0, z: -20 }, F, s);
    expect(Math.abs(ahead.pan)).toBeLessThan(1e-9);
    expect(ahead.front).toBeCloseTo(1, 9);
    // Turned 90° left we face -X: a source at -X is straight ahead, one at -Z is on the right.
    const left = { ...L, yaw: Math.PI / 2 };
    expect(spatialize(left, { x: -20, y: 0, z: 0 }, F, s).front).toBeCloseTo(1, 9);
    expect(spatialize(left, { x: 0, y: 0, z: -20 }, F, s).pan).toBeGreaterThan(0.6);
    // Behind: slightly quieter and darker than the same source in front.
    const front = spatialize(L, { x: 0, y: 0, z: -50 }, F, createSpatial());
    const back = spatialize(L, { x: 0, y: 0, z: 50 }, F, createSpatial());
    expect(back.gain).toBeLessThan(front.gain);
    expect(back.cutoff).toBeLessThan(front.cutoff);
  });

  it('near/far crossfade is equal power', () => {
    const w = { near: 0, far: 0 };
    expect(nearFarMix(5, 20, 170, w)).toEqual({ near: 1, far: 0 });
    nearFarMix(500, 20, 170, w);
    expect(w.near).toBeCloseTo(0, 9);
    expect(w.far).toBeCloseTo(1, 9);
    nearFarMix(95, 20, 170, w);
    expect(w.near * w.near + w.far * w.far).toBeCloseTo(1, 9);
  });

  it('volume curve clamps and is perceptual', () => {
    expect(volumeCurve(0)).toBe(0);
    expect(volumeCurve(1)).toBe(1);
    expect(volumeCurve(2)).toBe(1);
    expect(volumeCurve(-1)).toBe(0);
    expect(volumeCurve(NaN)).toBe(0);
    expect(volumeCurve(0.5)).toBeCloseTo(0.25, 9);
  });
});

describe('sound selection', () => {
  it('maps materials to impact / footstep classes', () => {
    expect(impactClassFor('metal')).toBe('metal');
    expect(impactClassFor('concrete')).toBe('hard');
    expect(impactClassFor('road')).toBe('hard');
    expect(impactClassFor('flesh')).toBe('flesh');
    expect(impactClassFor('armor')).toBe('armor');
    expect(impactClassFor('water')).toBe('water');
    expect(impactClassFor('???')).toBe('dirt');
    expect(stepClassFor('grass')).toBe('grass');
    expect(stepClassFor('sand')).toBe('crunch');
    expect(stepClassFor('road')).toBe('hard');
    expect(stepClassFor('wood')).toBe('wood');
    expect(healSoundFor('bandage')).toBe('bandage');
    expect(healSoundFor('fuel')).toBe('fuel');
    expect(healSoundFor('adrenaline')).toBe('syringe');
  });

  it('variation sets never repeat the same buffer twice in a row', () => {
    const v = new VarSet();
    expect(v.pick()).toBeNull();
    const bufs = [{}, {}, {}] as unknown as AudioBuffer[];
    v.bufs.push(...bufs);
    let last = v.pick();
    const seen = new Set<AudioBuffer | null>([last]);
    for (let i = 0; i < 300; i++) {
      const b = v.pick();
      expect(b).not.toBe(last);
      seen.add(b);
      last = b;
    }
    expect(seen.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Minimal fake WebAudio so the real engine paths (graph building, offline rendering, voice
// limiting, loop lifecycles) run in Node.
// ---------------------------------------------------------------------------------------------

class FakeParam {
  value = 0;
  setValueAtTime(v: number) { this.check(v); return this; }
  linearRampToValueAtTime(v: number) { this.check(v); return this; }
  exponentialRampToValueAtTime(v: number) { this.check(v); if (v <= 0) throw new RangeError('exp ramp to <= 0'); return this; }
  setTargetAtTime(v: number, _t: number, tau: number) { this.check(v); this.check(tau); return this; }
  cancelScheduledValues() { return this; }
  private check(v: number) { if (!Number.isFinite(v)) throw new TypeError('non-finite AudioParam value'); }
}

class FakeNode {
  gain = new FakeParam(); frequency = new FakeParam(); Q = new FakeParam(); detune = new FakeParam();
  pan = new FakeParam(); playbackRate = new FakeParam(); delayTime = new FakeParam();
  threshold = new FakeParam(); knee = new FakeParam(); ratio = new FakeParam(); attack = new FakeParam(); release = new FakeParam();
  buffer: FakeBuffer | null = null; loop = false; type = ''; curve: Float32Array | null = null; oversample = 'none';
  connect<T>(n: T): T { return n; }
  disconnect() { /* nothing to release */ }
  start(when = 0) { if (!Number.isFinite(when) || when < 0) throw new RangeError('bad start time'); }
  stop(when = 0) { if (!Number.isFinite(when)) throw new RangeError('bad stop time'); }
}

class FakeBuffer {
  readonly data: Float32Array[] = [];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    for (let c = 0; c < numberOfChannels; c++) this.data.push(new Float32Array(length));
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(c: number) { return this.data[c]; }
}

class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  state = 'running';
  destination = new FakeNode();
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createStereoPanner() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createWaveShaper() { return new FakeNode(); }
  createDelay() { return new FakeNode(); }
  createBuffer(ch: number, len: number, sr: number) { return new FakeBuffer(ch, len, sr); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  decodeAudioData() { return Promise.reject(new Error('no codecs in tests')); }
}

class FakeOffline extends FakeContext {
  constructor(private readonly ch: number, private readonly len: number, sr: number) {
    super();
    this.sampleRate = sr;
  }
  startRendering() {
    const b = new FakeBuffer(this.ch, this.len, this.sampleRate);
    b.data[0][0] = 0.5;  // non-silent so normalisation runs
    return Promise.resolve(b);
  }
}

describe('engine with a fake WebAudio implementation', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { AudioContext: g.AudioContext, OfflineAudioContext: g.OfflineAudioContext, fetch: g.fetch };
  let engine: AudioEngine;
  let ctx: FakeContext;

  beforeAll(async () => {
    g.AudioContext = FakeContext;
    g.OfflineAudioContext = FakeOffline;
    g.fetch = () => Promise.reject(new Error('offline'));   // samples fail -> synthesized fallbacks
    engine = new AudioEngine();
    exerciseAll(engine);                                      // before init: no-op
    await engine.init();
    ctx = (engine as unknown as { ctx: FakeContext }).ctx;
  });

  afterAll(() => {
    g.AudioContext = saved.AudioContext;
    g.OfflineAudioContext = saved.OfflineAudioContext;
    g.fetch = saved.fetch;
  });

  it('renders the whole bank at init', () => {
    const bank = (engine as unknown as { bank: { done: number; total: number } }).bank;
    expect(bank.total).toBeGreaterThan(150);
    expect(bank.done).toBe(bank.total);
  });

  it('every method works after init without throwing', () => {
    expect(() => exerciseAll(engine)).not.toThrow();
    expect(engine.voiceCount).toBeGreaterThan(0);
  });

  it(`limits concurrent one-shots to ${MAX_VOICES}, keeping the loudest`, () => {
    ctx.currentTime += 60;
    engine.update(1 / 60);
    expect(engine.voiceCount).toBe(0);
    engine.setListener({ x: 0, y: 0, z: 0 }, 0, 0);
    for (let i = 0; i < 120; i++) engine.gunshot('rifle', { x: 0, y: 0, z: -(30 + i * 5) }, false);
    expect(engine.voiceCount).toBe(MAX_VOICES);
    // A local shot is louder than any remote one: it steals a voice instead of being dropped.
    const voices = (engine as unknown as { voices: { level: number }[] }).voices;
    engine.gunshot('rifle', { x: 0, y: 0, z: 0 }, true);
    expect(engine.voiceCount).toBe(MAX_VOICES);
    expect(Math.max(...voices.map((v) => v.level))).toBeGreaterThan(0.8);
    // Finished voices are released and their nodes disconnected.
    ctx.currentTime += 60;
    engine.update(1 / 60);
    expect(engine.voiceCount).toBe(0);
  });

  it('delays remote shots by distance / speed of sound', () => {
    ctx.currentTime += 60;
    engine.update(1 / 60);
    engine.setListener({ x: 0, y: 0, z: 0 }, 0, 0);
    engine.gunshot('sniper', { x: 0, y: 0, z: -686 }, false);
    const v = (engine as unknown as { voices: { start: number }[] }).voices[0];
    expect(v.start - ctx.currentTime).toBeCloseTo(2, 6);
    engine.gunshot('sniper', { x: 0, y: 0, z: 0 }, true);
    const local = (engine as unknown as { voices: { start: number }[] }).voices[1];
    expect(local.start).toBe(ctx.currentTime);
  });

  it('caps running engine loops and releases stopped / stale ones', () => {
    const handles = [];
    for (let i = 0; i < MAX_ACTIVE_ENGINES + 6; i++) handles.push(engine.engine(1000 + i));
    for (let f = 0; f < 5; f++) {
      handles.forEach((h, i) => h.update({ x: 4 + i * 2, y: 0, z: 0 }, 2500, 0.7, false));
      engine.update(1 / 60);
    }
    const mgr = (engine as unknown as { engines: { list: { active: boolean }[] } }).engines;
    expect(mgr.list.filter((e) => e.active).length).toBe(MAX_ACTIVE_ENGINES);
    const before = mgr.list.length;
    handles[0].stop();
    expect(mgr.list.length).toBe(before - 1);
    expect(engine.engine(1000)).not.toBe(handles[0]);
    // No more updates from the owners: engines fade out, then are forgotten.
    for (let f = 0; f < 60 * 20; f++) engine.update(1 / 60);
    expect(mgr.list.length).toBe(0);
  });

  it('wind and zone loops start when audible and release when silent', () => {
    const wind = (engine as unknown as { wind: { n: unknown } }).wind;
    const zone = (engine as unknown as { zone: { n: unknown } }).zone;
    engine.setWind(1);
    engine.setZoneProximity(true, 1);
    for (let f = 0; f < 30; f++) engine.update(1 / 60);
    expect(wind.n).not.toBeNull();
    expect(zone.n).not.toBeNull();
    engine.setWind(0);
    engine.setZoneProximity(false, 0);
    for (let f = 0; f < 60 * 8; f++) engine.update(1 / 60);
    expect(wind.n).toBeNull();
    expect(zone.n).toBeNull();
  });

  it('releases loops when the game stops calling update(dt)', async () => {
    const wind = (engine as unknown as { wind: { n: unknown } }).wind;
    engine.setWind(1);
    for (let f = 0; f < 30; f++) engine.update(1 / 60);
    expect(wind.n).not.toBeNull();
    ctx.currentTime += 5;                                     // audio clock runs on, no update() calls
    await new Promise((r) => setTimeout(r, 700));
    expect(wind.n).toBeNull();
    engine.update(1 / 60);                                    // the game loop comes back: wind resumes
    expect(wind.n).not.toBeNull();
    engine.setWind(0);
    for (let f = 0; f < 60 * 8; f++) engine.update(1 / 60);
    expect(wind.n).toBeNull();
  });

  it('skips one-shots while the context is suspended', () => {
    ctx.currentTime += 60;
    engine.update(1 / 60);
    ctx.state = 'suspended';
    engine.gunshot('pistol', P, true);
    engine.ui('click');
    expect(engine.voiceCount).toBe(0);
    ctx.state = 'running';
    engine.gunshot('pistol', P, true);
    expect(engine.voiceCount).toBe(1);
  });
});
