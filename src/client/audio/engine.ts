// WebAudio engine: buses, listener, voice management and every sound trigger.
//
// Graph:  one-shots ─► world (duck) ─► sfx ─┐
//         hitmarkers / hurt / tinnitus ─► sfx ├─► mix ─► compressor ─► limiter ─► master ─► out
//         menu sounds ───────────────────► ui ─┘
//
// One-shots are pre-rendered AudioBuffers played through a BufferSource (+ per-layer gain, one
// optional low-pass, one gain, one optional StereoPanner). At most MAX_VOICES play at once; when
// full, the quietest (distance- and age-weighted) voice is faded out, or the new sound is dropped
// if it would be the quietest itself.

import type { SurfaceMaterial, Vec3, WeaponSoundKind } from '../../shared/types';
import { SoundBank, type VarSet } from './bank';
import { EngineManager, type EngineSoundHandle, type LoopHost, WindLoop, ZoneLoop } from './loops';
import { createSampleSet, loadSamples, type SampleSet } from './samples';
import {
  type Falloff, type ListenerState, type Spatial, createSpatial, finiteOr, nearFarMix, spatialize, volumeCurve,
} from './spatial';
import { type OfflineCtor, crackleBuffer, mulberry32, noiseBuffer } from './synth/dsp';
import { HARD_STEP, stepClassFor } from './synth/footsteps';
import { GUN_GAIN, GUN_RANGE } from './synth/gunshots';
import { impactClassFor } from './synth/impacts';
import { type ReloadPhase, healSoundFor } from './synth/mechanical';
import type { HitmarkerKind, UiSoundName } from './synth/ui';

export interface AudioSettings { master: number; sfx: number; ui: number; }

/** Maximum concurrently playing one-shots. */
export const MAX_VOICES = 40;
/** Below this linear gain a one-shot is not worth a voice. */
const MIN_GAIN = 0.0015;
/** Filters above this cutoff are skipped (inaudible difference, saves a node). */
const FILTER_SKIP_HZ = 16500;
/** Pre-compressor trim leaving headroom for overlapping sounds. */
const MIX_HEADROOM = 0.8;

const GUN_REF = 10;
const GUN_ROLLOFF = 0.5;
const LOCAL_GUN_BOOST = 1.12;
const IMPACT_FALLOFF: Falloff = { ref: 3, rolloff: 1, range: 95 };
const CRACK_FALLOFF: Falloff = { ref: 2, rolloff: 1, range: 25 };
const STEP_FALLOFF: Falloff = { ref: 2, rolloff: 0.9, range: 35 };
const LAND_FALLOFF: Falloff = { ref: 2, rolloff: 0.9, range: 45 };
const EXPLOSION_FALLOFF: Falloff = { ref: 15, rolloff: 0.5, range: 1600 };
/** Blasts closer than this duck the world and ring the ears. */
const BLAST_DEAFEN_DIST = 15;

const HITMARKER_GAIN: Record<HitmarkerKind, number> = { body: 0.5, head: 0.6, armor: 0.5, knock: 0.65, kill: 0.75 };
const UI_GAIN: Record<UiSoundName, number> = {
  click: 0.32, hover: 0.12, ready: 0.42, start: 0.5, countdown: 0.42, error: 0.38, zone: 0.5, win: 0.6, lose: 0.55,
};
const UI_MIN_INTERVAL: Partial<Record<UiSoundName, number>> = { hover: 0.035, click: 0.02 };

interface Voice {
  srcs: AudioBufferSourceNode[];
  gains: GainNode[];
  filter: BiquadFilterNode | null;
  out: GainNode | null;
  panner: StereoPannerNode | null;
  level: number;
  start: number;
  end: number;
}

type CtxCtor = new (opts?: AudioContextOptions) => AudioContext;

function audioContextCtor(): CtxCtor | null {
  const g = globalThis as unknown as { AudioContext?: CtxCtor; webkitAudioContext?: CtxCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function offlineCtor(): OfflineCtor | null {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

const rand1 = (amount: number): number => 1 + (Math.random() * 2 - 1) * amount;
const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const validPos = (p: Vec3 | null | undefined): p is Vec3 =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private initPromise: Promise<void> | null = null;
  private mix: GainNode | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private world: GainNode | null = null;
  private host: LoopHost | null = null;

  private settings: AudioSettings = { master: 0.8, sfx: 0.9, ui: 0.7 };
  private readonly listener: ListenerState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private readonly bank = new SoundBank();
  private readonly samples: SampleSet = createSampleSet();
  private readonly wind = new WindLoop();
  private readonly zone = new ZoneLoop();
  private readonly engines = new EngineManager();

  private readonly voices: Voice[] = [];
  private readonly dying: Voice[] = [];
  private readonly pool: Voice[] = [];
  // Layer builder scratch (avoids per-sound allocations of layer descriptors).
  private readonly layerBuf: (AudioBuffer | null)[] = [null, null, null, null];
  private readonly layerGain = [1, 1, 1, 1];
  private readonly layerFiltered = [true, true, true, true];
  private nLayers = 0;
  private readonly sp: Spatial = createSpatial();
  private readonly mixW = { near: 1, far: 0 };
  private readonly falloff: Falloff = { ref: GUN_REF, rolloff: GUN_ROLLOFF, range: 500 };
  private readonly lastUi: Partial<Record<UiSoundName, number>> = {};
  private stepSide = 1;
  private unlockBound = false;

  // ------------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------------

  init(): Promise<void> {
    if (this.initPromise) {
      this.resume();
      return this.initPromise;
    }
    const Ctor = audioContextCtor();
    const Offline = offlineCtor();
    if (!Ctor) {
      this.initPromise = Promise.resolve();
      return this.initPromise;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      try {
        ctx = new Ctor();
      } catch {
        this.initPromise = Promise.resolve();
        return this.initPromise;
      }
    }
    this.ctx = ctx;
    this.buildGraph(ctx);
    this.resume();
    this.bindUnlock();
    void loadSamples(ctx, this.samples);
    this.initPromise = Offline
      ? this.bank.renderAll(Offline, ctx.sampleRate).catch((e) => { console.warn('[audio] synthesis failed', e); })
      : Promise.resolve();
    return this.initPromise;
  }

  private buildGraph(ctx: AudioContext): void {
    // Gentle glue compression (keeps the near/far and local/remote dynamics readable), then a
    // fast limiter so dozens of overlapping shots and blasts never clip.
    const mix = ctx.createGain();
    mix.gain.value = MIX_HEADROOM;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.06;
    const master = ctx.createGain();
    mix.connect(comp);
    comp.connect(limiter);
    limiter.connect(master);
    master.connect(ctx.destination);
    const sfx = ctx.createGain();
    sfx.connect(mix);
    const ui = ctx.createGain();
    ui.connect(mix);
    const world = ctx.createGain();
    world.connect(sfx);
    this.mix = mix;
    this.master = master;
    this.sfx = sfx;
    this.uiBus = ui;
    this.world = world;
    this.applySettings(true);
    const rand = mulberry32(0xa11d10);
    this.host = {
      ctx,
      noise: noiseBuffer(ctx, 3, 'white', 2, rand),
      crackle: crackleBuffer(ctx, 2.5, 38, 0, rand),
      bus: world,
      listener: this.listener,
    };
  }

  private resume(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      // Never awaited: outside a user gesture the promise may stay pending until one happens.
      void ctx.resume().catch(() => undefined);
    } catch { /* ignore */ }
  }

  /** Browsers suspend contexts created without a gesture; resume on the next interaction. */
  private bindUnlock(): void {
    if (this.unlockBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this.unlockBound = true;
    const unlock = () => this.resume();
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  /** True when one-shots can be scheduled (context exists and is running). */
  private get live(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // ------------------------------------------------------------------------------------------
  // Settings / listener / per-frame
  // ------------------------------------------------------------------------------------------

  setSettings(s: AudioSettings): void {
    if (!s) return;
    this.settings = {
      master: clamp01(finiteOr(s.master, this.settings.master)),
      sfx: clamp01(finiteOr(s.sfx, this.settings.sfx)),
      ui: clamp01(finiteOr(s.ui, this.settings.ui)),
    };
    this.applySettings(false);
  }

  private applySettings(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.sfx || !this.uiBus) return;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number) => {
      if (immediate) p.value = v;
      else p.setTargetAtTime(v, t, 0.03);
    };
    set(this.master.gain, volumeCurve(this.settings.master));
    set(this.sfx.gain, volumeCurve(this.settings.sfx));
    set(this.uiBus.gain, volumeCurve(this.settings.ui));
  }

  setListener(pos: Vec3, yaw: number, pitch: number): void {
    if (validPos(pos)) {
      this.listener.x = pos.x;
      this.listener.y = pos.y;
      this.listener.z = pos.z;
    }
    if (Number.isFinite(yaw)) this.listener.yaw = yaw;
    if (Number.isFinite(pitch)) this.listener.pitch = pitch;
  }

  update(dt: number): void {
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    const host = this.live ? this.host : null;
    this.wind.update(host, d);
    this.zone.update(host, d);
    this.engines.update(host, d);
    if (this.ctx) this.sweep(this.ctx.currentTime);
  }

  setWind(intensity: number): void {
    this.wind.set(finiteOr(intensity, 0));
  }

  setZoneProximity(insideBlue: boolean, intensity: number): void {
    this.zone.set(!!insideBlue, finiteOr(intensity, 0));
  }

  engine(id: number): EngineSoundHandle {
    return this.engines.get(id);
  }

  // ------------------------------------------------------------------------------------------
  // Voice management
  // ------------------------------------------------------------------------------------------

  private layer(buf: AudioBuffer | null, gain = 1, filtered = true): void {
    if (!buf || !(gain > 0) || this.nLayers >= this.layerBuf.length) return;
    const i = this.nLayers++;
    this.layerBuf[i] = buf;
    this.layerGain[i] = gain;
    this.layerFiltered[i] = filtered;
  }

  /**
   * Start a voice from the layers queued with layer(). `pan` NaN = no panner; `cutoff` 0 = no
   * filter. `priority` scales the level used for voice stealing (local / UI sounds win).
   */
  private emit(bus: AudioNode | null, gain: number, pan: number, cutoff: number, delay: number, rate: number, priority: number): void {
    const n = this.nLayers;
    this.nLayers = 0;
    const ctx = this.ctx;
    if (n === 0 || !ctx || !bus || !(gain > MIN_GAIN)) return clearLayers(this.layerBuf);
    const now = ctx.currentTime;
    const level = gain * priority;
    this.sweep(now);
    if (this.voices.length >= MAX_VOICES && !this.steal(level, now)) return clearLayers(this.layerBuf);

    const v = this.pool.pop() ?? { srcs: [], gains: [], filter: null, out: null, panner: null, level: 0, start: 0, end: 0 };
    const out = ctx.createGain();
    out.gain.value = gain;
    v.out = out;
    if (Number.isFinite(pan) && Math.abs(pan) > 0.01) {
      const pv = Math.max(-1, Math.min(1, pan));
      const p = ctx.createStereoPanner();
      p.pan.value = pv;
      out.connect(p);
      p.connect(bus);
      v.panner = p;
      // A StereoPanner balances stereo input by folding one channel into the other (+6 dB on the
      // near side at full pan); keep stereo layers at constant power like mono ones.
      let stereo = false;
      for (let i = 0; i < n; i++) if (this.layerBuf[i]!.numberOfChannels > 1) stereo = true;
      if (stereo) out.gain.value = gain / Math.sqrt(1 + Math.sin(Math.abs(pv) * Math.PI * 0.5));
    } else {
      out.connect(bus);
    }
    let filterIn: AudioNode = out;
    if (cutoff > 0 && cutoff < FILTER_SKIP_HZ) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = Math.max(80, cutoff);
      f.Q.value = 0.5;
      f.connect(out);
      v.filter = f;
      filterIn = f;
    }
    const r = Number.isFinite(rate) && rate > 0.25 ? rate : 1;
    const when = now + (delay > 0 ? delay : 0);
    let end = when;
    for (let i = 0; i < n; i++) {
      const buf = this.layerBuf[i]!;
      this.layerBuf[i] = null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = r;
      const target = this.layerFiltered[i] ? filterIn : out;
      if (this.layerGain[i] !== 1) {
        const g = ctx.createGain();
        g.gain.value = this.layerGain[i];
        src.connect(g);
        g.connect(target);
        v.gains.push(g);
      } else {
        src.connect(target);
      }
      src.start(when);
      v.srcs.push(src);
      const e = when + buf.duration / r;
      if (e > end) end = e;
    }
    v.level = level;
    v.start = when;
    v.end = end;
    this.voices.push(v);
  }

  /** Perceived level now: full until it starts, then decaying with its length (tails are quiet). */
  private voiceLevel(v: Voice, now: number): number {
    if (now <= v.start) return v.level;
    const dur = Math.max(0.05, v.end - v.start);
    return v.level * Math.exp(-(now - v.start) / (0.18 * dur));
  }

  private steal(level: number, now: number): boolean {
    let qi = -1, ql = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const l = this.voiceLevel(this.voices[i], now);
      if (l < ql) { ql = l; qi = i; }
    }
    if (qi < 0 || ql >= level) return false;
    const v = this.voices[qi];
    this.voices[qi] = this.voices[this.voices.length - 1];
    this.voices.pop();
    if (v.out) {
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setValueAtTime(v.out.gain.value, now);
      v.out.gain.linearRampToValueAtTime(0, now + 0.03);
    }
    for (const s of v.srcs) {
      try { s.stop(now + 0.04); } catch { /* already stopped */ }
    }
    v.end = now + 0.05;
    this.dying.push(v);
    return true;
  }

  /** Disconnect and recycle finished voices. */
  private sweep(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (now > v.end + 0.05) {
        this.voices[i] = this.voices[this.voices.length - 1];
        this.voices.pop();
        this.recycle(v);
      }
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      if (now > v.end + 0.02) {
        this.dying[i] = this.dying[this.dying.length - 1];
        this.dying.pop();
        this.recycle(v);
      }
    }
  }

  private recycle(v: Voice): void {
    for (const s of v.srcs) disconnect(s);
    for (const g of v.gains) disconnect(g);
    disconnect(v.filter);
    disconnect(v.out);
    disconnect(v.panner);
    v.srcs.length = 0;
    v.gains.length = 0;
    v.filter = null;
    v.out = null;
    v.panner = null;
    this.pool.push(v);
  }

  /** Active one-shot count (diagnostics / tests). */
  get voiceCount(): number { return this.voices.length; }

  // ------------------------------------------------------------------------------------------
  // Weapons
  // ------------------------------------------------------------------------------------------

  gunshot(kind: WeaponSoundKind, pos: Vec3, local: boolean): void {
    if (!this.live) return;
    const near = this.bank.gunNear[kind];
    if (!near) return;
    const base = GUN_GAIN[kind];
    if (local || !validPos(pos)) {
      this.layer(near.pick());
      this.layer(this.bank.action[kind].pick(), 0.45, false);
      this.emit(this.world, base * LOCAL_GUN_BOOST, NaN, 0, 0, rand1(0.025), 3);
      return;
    }
    const f = this.falloff;
    f.ref = GUN_REF;
    f.rolloff = GUN_ROLLOFF;
    f.range = GUN_RANGE[kind];
    const sp = spatialize(this.listener, pos, f, this.sp);
    if (sp.gain * base < MIN_GAIN) return;
    const w = nearFarMix(sp.dist, 20, 170, this.mixW);
    const farSet = this.bank.gunFar[kind];
    if (w.far > 0.03 && farSet.ready) {
      if (w.near > 0.03) this.layer(near.pick(), w.near);
      this.layer(farSet.pick(), w.far);
    } else {
      this.layer(near.pick());
    }
    this.emit(this.world, base * sp.gain, sp.pan, sp.cutoff, sp.delay, rand1(0.04), 1);
  }

  dryFire(): void {
    if (!this.live) return;
    this.layer(this.bank.dryFire.pick());
    this.emit(this.world, 0.45, NaN, 0, 0, rand1(0.03), 3);
  }

  reload(kind: WeaponSoundKind, phase: ReloadPhase): void {
    if (!this.live) return;
    const set = this.bank.reload[kind]?.[phase];
    if (!set) return;
    this.layer(set.pick());
    this.emit(this.world, 0.5, NaN, 0, 0, rand1(0.03), 3);
  }

  weaponSwitch(): void {
    if (!this.live) return;
    const sample = this.samples.weaponChange;
    if (sample) this.layer(sample, 0.55);
    else this.layer(this.bank.weaponSwitch.pick());
    this.emit(this.world, 0.5, NaN, 0, 0, rand1(0.03), 3);
  }

  // ------------------------------------------------------------------------------------------
  // World
  // ------------------------------------------------------------------------------------------

  impact(material: string, pos: Vec3): void {
    if (!this.live || !validPos(pos)) return;
    const cls = impactClassFor(String(material));
    const sp = spatialize(this.listener, pos, IMPACT_FALLOFF, this.sp);
    if (sp.gain < 0.004) return;
    this.layer(this.bank.impact[cls].pick());
    const g = cls === 'flesh' ? 0.75 : cls === 'metal' ? 0.5 : 0.6;
    this.emit(this.world, g * sp.gain, sp.pan, sp.cutoff, sp.delay, rand1(0.06), 1);
    const ricochetChance = cls === 'hard' ? 0.3 : cls === 'metal' ? 0.2 : 0;
    if (ricochetChance > 0 && Math.random() < ricochetChance && sp.dist < 70) {
      this.layer(this.bank.ricochet.pick());
      this.emit(this.world, 0.32 * sp.gain, sp.pan, sp.cutoff, sp.delay + 0.01 + Math.random() * 0.04, rand1(0.08), 1);
    }
  }

  bulletCrack(pos: Vec3): void {
    if (!this.live || !validPos(pos)) return;
    const sp = spatialize(this.listener, pos, CRACK_FALLOFF, this.sp);
    if (sp.gain < 0.01) return;
    this.layer(this.bank.bulletCrack.pick());
    this.emit(this.world, 0.7 * sp.gain, sp.pan, 0, 0, rand1(0.05), 2);
  }

  footstep(material: SurfaceMaterial, pos: Vec3, local: boolean, intensity: number): void {
    if (!this.live) return;
    const i = clamp01(finiteOr(intensity, 0.6));
    const cls = stepClassFor(material);
    const set = this.bank.step[cls];
    const shoe = HARD_STEP[cls] && this.samples.steps.length
      ? this.samples.steps[(Math.random() * this.samples.steps.length) | 0] : null;
    // Sprinting is louder and slightly brighter / faster; crouch-walking soft and dull.
    const loud = 0.3 + 0.7 * i;
    const rate = (0.95 + 0.1 * i) * rand1(0.04);
    if (local || !validPos(pos)) {
      this.layer(set.pick());
      if (shoe) this.layer(shoe, 0.35);
      this.stepSide = -this.stepSide;
      const cutoff = i < 0.45 ? 2500 + i * 9000 : 0;
      this.emit(this.world, 0.3 * loud, this.stepSide * 0.06, cutoff, 0, rate, 2);
      return;
    }
    const sp = spatialize(this.listener, pos, STEP_FALLOFF, this.sp);
    if (sp.gain * loud < 0.004) return;
    this.layer(set.pick());
    if (shoe) this.layer(shoe, 0.35);
    const cutoff = Math.min(sp.cutoff, i < 0.45 ? 2500 + i * 9000 : 20000);
    this.emit(this.world, 0.8 * loud * sp.gain, sp.pan, cutoff, sp.delay, rate, 1.2);
  }

  jump(local: boolean, pos: Vec3): void {
    if (!this.live) return;
    const kenney = this.samples.jump;
    const buf = kenney.length ? kenney[(Math.random() * kenney.length) | 0] : this.bank.jump.pick();
    const g = kenney.length ? 0.22 : 0.3;
    if (local || !validPos(pos)) {
      this.layer(buf);
      this.emit(this.world, g, NaN, 0, 0, rand1(0.04), 2);
      return;
    }
    const sp = spatialize(this.listener, pos, STEP_FALLOFF, this.sp);
    this.layer(buf);
    this.emit(this.world, g * 1.4 * sp.gain, sp.pan, sp.cutoff, sp.delay, rand1(0.05), 1);
  }

  land(intensity: number, pos: Vec3, local: boolean): void {
    if (!this.live) return;
    const i = clamp01(finiteOr(intensity, 0.5));
    if (this.samples.land) this.layer(this.samples.land, 0.5 * (0.4 + 0.6 * i));
    this.layer(this.bank.land.pick(), 0.15 + 0.85 * i);
    const rate = (1.05 - 0.15 * i) * rand1(0.03);
    if (local || !validPos(pos)) {
      this.emit(this.world, 0.6, NaN, 0, 0, rate, 2);
      return;
    }
    const sp = spatialize(this.listener, pos, LAND_FALLOFF, this.sp);
    this.emit(this.world, 0.75 * sp.gain, sp.pan, sp.cutoff, sp.delay, rate, 1);
  }

  explosion(pos: Vec3): void {
    if (!this.live || !validPos(pos)) return;
    const sp = spatialize(this.listener, pos, EXPLOSION_FALLOFF, this.sp);
    if (sp.gain < MIN_GAIN) return;
    const w = nearFarMix(sp.dist, 40, 300, this.mixW);
    const farSet = this.bank.explosionFar;
    if (w.far > 0.03 && farSet.ready) {
      if (w.near > 0.03) this.layer(this.bank.explosionNear.pick(), w.near);
      this.layer(farSet.pick(), w.far);
    } else {
      this.layer(this.bank.explosionNear.pick());
    }
    if (this.samples.explosion && w.near > 0.1) this.layer(this.samples.explosion, 0.4 * w.near);
    this.emit(this.world, 1.0 * sp.gain, sp.pan, sp.cutoff, sp.delay, rand1(0.05), 4);
    if (sp.dist < BLAST_DEAFEN_DIST) this.deafen(1 - sp.dist / BLAST_DEAFEN_DIST, sp.delay);
  }

  /** Close blast: duck the world bus and ring the ears for a moment. */
  private deafen(k: number, delay: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.world) return;
    const t = ctx.currentTime + delay;
    const g = this.world.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.setValueAtTime(g.value, t + 0.03);
    g.linearRampToValueAtTime(1 - 0.75 * k, t + 0.08);
    g.setTargetAtTime(1, t + 0.5, 0.9);
    this.layer(this.bank.tinnitus.pick());
    this.emit(this.sfx, 0.22 * k, NaN, 0, delay, rand1(0.03), 4);
  }

  // ------------------------------------------------------------------------------------------
  // Player feedback (non-spatial)
  // ------------------------------------------------------------------------------------------

  hitmarker(kind: HitmarkerKind): void {
    if (!this.live) return;
    const set = this.bank.hitmarker[kind];
    if (!set) return;
    this.layer(set.pick());
    // Tiny pitch jitter only on the frequent ones; head / kill stay iconic.
    const rate = kind === 'body' || kind === 'armor' ? rand1(0.015) : 1;
    this.emit(this.sfx, HITMARKER_GAIN[kind], NaN, 0, 0, rate, 5);
  }

  hurt(amount: number): void {
    if (!this.live) return;
    const a = clamp01(finiteOr(amount, 20) / 40);
    if (this.samples.hurt) this.layer(this.samples.hurt, 0.35 + 0.35 * a);
    this.layer(this.bank.hurtThud.pick(), 0.3 + 0.7 * a);
    this.emit(this.sfx, 0.7, NaN, 0, 0, rand1(0.06), 4);
  }

  armorBreak(): void {
    if (!this.live) return;
    this.layer(this.bank.armorBreak.pick());
    this.emit(this.sfx, 0.6, NaN, 0, 0, rand1(0.04), 4);
  }

  heal(item: string): void {
    if (!this.live) return;
    this.layer(this.bank.heal[healSoundFor(String(item))].pick());
    this.emit(this.world, 0.5, NaN, 0, 0, rand1(0.03), 2);
  }

  pickup(): void {
    if (!this.live) return;
    this.layer(this.bank.pickup.pick());
    this.emit(this.world, 0.42, NaN, 0, 0, rand1(0.06), 2);
  }

  ui(name: UiSoundName): void {
    if (!this.live || !this.ctx) return;
    const set: VarSet | undefined = this.bank.ui[name];
    if (!set) return;
    const minGap = UI_MIN_INTERVAL[name];
    if (minGap !== undefined) {
      const now = this.ctx.currentTime;
      const last = this.lastUi[name];
      if (last !== undefined && now - last < minGap) return;
      this.lastUi[name] = now;
    }
    this.layer(set.pick());
    this.emit(this.uiBus, UI_GAIN[name], NaN, 0, 0, 1, 6);
  }
}

function disconnect(n: AudioNode | null): void {
  if (!n) return;
  try { n.disconnect(); } catch { /* already disconnected */ }
}

function clearLayers(bufs: (AudioBuffer | null)[]): void {
  for (let i = 0; i < bufs.length; i++) bufs[i] = null;
}
