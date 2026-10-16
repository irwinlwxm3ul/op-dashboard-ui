// Continuous sounds driven every frame from audio.update(dt): wind (freefall / parachute), the
// blue-zone electric hum, and vehicle engines. Node graphs are created lazily when a loop becomes
// audible and released after it has been silent for a moment, so idle loops cost nothing.

import type { Vec3 } from '../../shared/types';
import { type Falloff, type ListenerState, type Spatial, createSpatial, spatialize } from './spatial';

export interface LoopHost {
  readonly ctx: AudioContext;
  /** Looping stereo white noise. */
  readonly noise: AudioBuffer;
  /** Looping sparse electric crackle (mono). */
  readonly crackle: AudioBuffer;
  /** Destination bus (world / ducked). */
  readonly bus: AudioNode;
  readonly listener: ListenerState;
}

const damp = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);
const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const TAU_PARAM = 0.06;
/** Loop level below which it counts as silent, and how long it must stay silent to be released. */
const SILENT_LEVEL = 0.01;
const SILENT_RELEASE = 0.6;

/**
 * Applies smoothed parameter targets, skipping values that barely changed so per-frame updates do
 * not flood the AudioParam automation timelines.
 */
class ParamSetter {
  private readonly last: Float64Array;
  constructor(size: number) { this.last = new Float64Array(size).fill(NaN); }
  set(i: number, p: AudioParam, v: number, t: number, tau: number): void {
    const prev = this.last[i];
    if (Math.abs(v - prev) <= Math.max(1e-4, Math.abs(prev) * 0.004)) return;
    this.last[i] = v;
    p.setTargetAtTime(v, t, tau);
  }
  reset(): void { this.last.fill(NaN); }
}

function loopSource(host: LoopHost, buffer: AudioBuffer): AudioBufferSourceNode {
  const src = host.ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start(host.ctx.currentTime, Math.random() * buffer.duration);
  return src;
}

function biquad(ctx: AudioContext, type: BiquadFilterType, f: number, q: number): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

function gain(ctx: AudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

/** Stops sources and disconnects every node once a fade-out has finished. */
function release(ctx: AudioContext, out: GainNode, sources: AudioScheduledSourceNode[], nodes: AudioNode[], fade: number): void {
  const t = ctx.currentTime;
  out.gain.cancelScheduledValues(t);
  out.gain.setValueAtTime(out.gain.value, t);
  out.gain.linearRampToValueAtTime(0, t + fade);
  for (const s of sources) {
    try { s.stop(t + fade + 0.02); } catch { /* already stopped */ }
  }
  setTimeout(() => {
    for (const n of nodes) {
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
  }, (fade + 0.1) * 1000);
}

// ---------------------------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------------------------

interface WindNodes {
  src: AudioBufferSourceNode;
  body: BiquadFilterNode;
  rumbleG: GainNode;
  whistle: BiquadFilterNode; whistleG: GainNode;
  out: GainNode;
  all: AudioNode[];
}

/** Rushing air: noise through a slowly modulated band-pass, a low rumble and a gusty whistle. */
export class WindLoop {
  private target = 0;
  private level = 0;
  private gust = 0.5;
  private gustTarget = 0.5;
  private gustTimer = 0;
  private silent = 0;
  private n: WindNodes | null = null;
  private readonly ps = new ParamSetter(5);

  set(intensity: number): void { this.target = clamp01(intensity); }

  update(host: LoopHost | null, dt: number): void {
    this.level += (this.target - this.level) * damp(this.target > this.level ? 3.5 : 1.6, dt);
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTarget = Math.random();
      this.gustTimer = 0.5 + Math.random() * 1.5;
    }
    this.gust += (this.gustTarget - this.gust) * damp(1.3, dt);
    if (!host) return;
    if (!this.n) {
      if (this.level < SILENT_LEVEL) return;
      this.n = this.build(host);
    }
    const n = this.n, t = host.ctx.currentTime, L = this.level, g = this.gust, ps = this.ps;
    ps.set(0, n.out.gain, Math.pow(L, 0.8) * (0.6 + 0.4 * g) * 1.2, t, 0.08);
    ps.set(1, n.body.frequency, 300 + 950 * L + 380 * g, t, 0.12);
    ps.set(2, n.rumbleG.gain, 0.55 + 0.35 * g, t, 0.1);
    ps.set(3, n.whistle.frequency, 1500 + 1500 * g * L, t, 0.2);
    ps.set(4, n.whistleG.gain, 0.18 * L * L * g, t, 0.15);
    if (this.target === 0 && L < SILENT_LEVEL) {
      this.silent += dt;
      if (this.silent > SILENT_RELEASE) this.dispose(host.ctx);
    } else {
      this.silent = 0;
    }
  }

  private build(host: LoopHost): WindNodes {
    const ctx = host.ctx;
    const src = loopSource(host, host.noise);
    const body = biquad(ctx, 'bandpass', 600, 0.8);
    const bodyG = gain(ctx, 0.7);
    const rumble = biquad(ctx, 'lowpass', 170, 0.7);
    const rumbleG = gain(ctx, 0.6);
    const whistle = biquad(ctx, 'bandpass', 1800, 6);
    const whistleG = gain(ctx, 0);
    const out = gain(ctx, 0);
    src.connect(body); body.connect(bodyG); bodyG.connect(out);
    src.connect(rumble); rumble.connect(rumbleG); rumbleG.connect(out);
    src.connect(whistle); whistle.connect(whistleG); whistleG.connect(out);
    out.connect(host.bus);
    this.silent = 0;
    this.ps.reset();
    return { src, body, rumbleG, whistle, whistleG, out, all: [src, body, bodyG, rumble, rumbleG, whistle, whistleG, out] };
  }

  dispose(ctx: AudioContext): void {
    if (!this.n) return;
    release(ctx, this.n.out, [this.n.src], this.n.all, 0.2);
    this.n = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Blue zone
// ---------------------------------------------------------------------------------------------

interface ZoneNodes {
  srcs: AudioScheduledSourceNode[];
  humG: GainNode;
  crackG: GainNode;
  sizzleG: GainNode;
  out: GainNode;
  all: AudioNode[];
}

/** Electric hum + crackle while outside the safe zone (and faintly when close to the wall). */
export class ZoneLoop {
  private inside = false;
  private target = 0;
  private hum = 0;
  private crack = 0;
  private sizzle = 0;
  private spit = 1;
  private spitTimer = 0;
  private silent = 0;
  private n: ZoneNodes | null = null;
  private readonly ps = new ParamSetter(3);

  set(insideBlue: boolean, intensity: number): void {
    this.inside = insideBlue;
    this.target = clamp01(intensity);
  }

  update(host: LoopHost | null, dt: number): void {
    const i = this.target;
    const humT = this.inside ? 0.045 + 0.065 * i : 0.035 * i;
    const crackT = this.inside ? 0.13 + 0.23 * i : 0.06 * i;
    const sizzleT = this.inside ? 0.022 + 0.036 * i : 0.01 * i;
    const k = damp(this.inside ? 4 : 2, dt);
    this.hum += (humT - this.hum) * k;
    this.crack += (crackT - this.crack) * k;
    this.sizzle += (sizzleT - this.sizzle) * k;
    this.spitTimer -= dt;
    if (this.spitTimer <= 0) {
      // Irregular "spits" make the crackle feel alive rather than a static noise bed.
      this.spit = Math.random() < 0.25 ? 1.4 + Math.random() * 0.8 : 0.4 + Math.random() * 0.6;
      this.spitTimer = 0.05 + Math.random() * 0.35;
    }
    if (!host) return;
    const audible = this.hum + this.crack + this.sizzle > SILENT_LEVEL;
    if (!this.n) {
      if (!audible) return;
      this.n = this.build(host);
    }
    const n = this.n, t = host.ctx.currentTime, ps = this.ps;
    ps.set(0, n.humG.gain, this.hum, t, TAU_PARAM);
    ps.set(1, n.crackG.gain, this.crack * this.spit, t, 0.02);
    ps.set(2, n.sizzleG.gain, this.sizzle, t, TAU_PARAM);
    if (!audible) {
      this.silent += dt;
      if (this.silent > SILENT_RELEASE) this.dispose(host.ctx);
    } else {
      this.silent = 0;
    }
  }

  private build(host: LoopHost): ZoneNodes {
    const ctx = host.ctx;
    const out = gain(ctx, 1);
    out.connect(host.bus);
    // Mains-style hum: 60 Hz saw + slightly detuned 120 Hz square, low-passed, with tremolo.
    const h1 = ctx.createOscillator(); h1.type = 'sawtooth'; h1.frequency.value = 60;
    const h2 = ctx.createOscillator(); h2.type = 'square'; h2.frequency.value = 120.4;
    const h2g = gain(ctx, 0.35);
    const humLp = biquad(ctx, 'lowpass', 650, 1.4);
    const trem = gain(ctx, 1);
    const humG = gain(ctx, 0);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6.5;
    const lfoG = gain(ctx, 0.3);
    h1.connect(humLp); h2.connect(h2g); h2g.connect(humLp);
    humLp.connect(trem); trem.connect(humG); humG.connect(out);
    lfo.connect(lfoG); lfoG.connect(trem.gain);
    // Crackle.
    const cs = loopSource(host, host.crackle);
    const chp = biquad(ctx, 'highpass', 1800, 0.7);
    const crackG = gain(ctx, 0);
    cs.connect(chp); chp.connect(crackG); crackG.connect(out);
    // High sizzle.
    const ns = loopSource(host, host.noise);
    const sbp = biquad(ctx, 'bandpass', 5500, 1.5);
    const sizzleG = gain(ctx, 0);
    ns.connect(sbp); sbp.connect(sizzleG); sizzleG.connect(out);
    const t = ctx.currentTime;
    h1.start(t); h2.start(t); lfo.start(t);
    this.silent = 0;
    this.ps.reset();
    return {
      srcs: [h1, h2, lfo, cs, ns], humG, crackG, sizzleG, out,
      all: [h1, h2, h2g, humLp, trem, humG, lfo, lfoG, cs, chp, crackG, ns, sbp, sizzleG, out],
    };
  }

  dispose(ctx: AudioContext): void {
    if (!this.n) return;
    release(ctx, this.n.out, this.n.srcs, this.n.all, 0.25);
    this.n = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Vehicle engines
// ---------------------------------------------------------------------------------------------

export interface EngineSoundHandle {
  update(pos: Vec3, rpm: number, throttle: number, local: boolean): void;
  stop(): void;
}

const ENGINE_FALLOFF: Falloff = { ref: 5, rolloff: 0.8, range: 230 };
/** Engines beyond this many simultaneously running graphs: the farthest is released. */
export const MAX_ACTIVE_ENGINES = 8;
/** An engine whose handle has not been updated for this long fades out (vehicle left view). */
const ENGINE_STALE = 1.0;
/** ...and is forgotten entirely after this long. */
const ENGINE_FORGET = 15;
/** Matches the shared vehicle model (idle 900, red line ~6500; rpm 0 = engine off). */
const IDLE_RPM = 900;
const MAX_RPM = 6500;
/** Below this the engine is (nearly) stopped: the loop fades out while spinning down. */
const STALL_RPM = 120;
const RUN_RPM = 500;

interface EngineNodes {
  o1: OscillatorNode; o2: OscillatorNode; o3: OscillatorNode; lfo: OscillatorNode;
  noiseBp: BiquadFilterNode; noiseG: GainNode;
  lp: BiquadFilterNode;
  out: GainNode;
  pan: StereoPannerNode;
  srcs: AudioScheduledSourceNode[];
  all: AudioNode[];
}

/**
 * One vehicle engine: 3 detuned oscillators (saw / square sub / saw octave) through a low-pass with
 * a firing-rate amplitude flutter, plus band-passed intake/exhaust noise. Frequency follows rpm
 * (4-cylinder 4-stroke firing frequency = rpm / 30), level follows throttle and distance.
 */
export class EngineVoice implements EngineSoundHandle {
  readonly pos: Vec3 = { x: 0, y: 0, z: 0 };
  rpm = IDLE_RPM;
  throttle = 0;
  local = false;
  /** Engine-clock time of the last update() from the owner. */
  touched = 0;
  /** Smoothed values. */
  private sRpm = IDLE_RPM;
  private sThrottle = 0;
  private sGain = 0;
  /** First update snaps the smoothed values (no fake rev-up / idle blip on creation). */
  private fresh = true;
  private n: EngineNodes | null = null;
  private readonly sp: Spatial = createSpatial();
  private readonly ps = new ParamSetter(9);
  dist = 0;
  stopped = false;

  constructor(readonly id: number, private readonly mgr: EngineManager) {}

  get active(): boolean { return this.n !== null; }

  update(pos: Vec3, rpm: number, throttle: number, local: boolean): void {
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
      this.pos.x = pos.x; this.pos.y = pos.y; this.pos.z = pos.z;
    }
    if (Number.isFinite(rpm)) this.rpm = rpm < 0 ? 0 : rpm > 9000 ? 9000 : rpm;
    if (Number.isFinite(throttle)) this.throttle = clamp01(Math.abs(throttle));
    this.local = !!local;
    if (this.fresh) {
      this.fresh = false;
      this.sRpm = this.rpm;
      this.sThrottle = this.throttle;
    }
    this.touched = this.mgr.clock;
    if (this.stopped) {
      this.stopped = false;
      this.mgr.adopt(this);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.mgr.forget(this);
  }

  /** Per-frame smoothing and parameter application. */
  tick(host: LoopHost | null, dt: number, clock: number): void {
    const stale = clock - this.touched > ENGINE_STALE;
    this.sRpm += (this.rpm - this.sRpm) * damp(9, dt);
    this.sThrottle += (this.throttle - this.sThrottle) * damp(12, dt);
    let distGain = 1, pan = 0, cutoff = 20000;
    if (!this.local) {
      spatialize(host ? host.listener : ZERO_LISTENER, this.pos, ENGINE_FALLOFF, this.sp);
      distGain = this.sp.gain;
      pan = this.sp.pan;
      cutoff = this.sp.cutoff;
      this.dist = this.sp.dist;
    } else {
      this.dist = 0;
    }
    const rpmN = clamp01((this.sRpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM));
    // Spinning down after the engine is switched off (or out of fuel) fades to silence.
    const running = clamp01((this.sRpm - STALL_RPM) / (RUN_RPM - STALL_RPM));
    const level = stale ? 0
      : (0.3 + 0.5 * this.sThrottle + 0.18 * rpmN) * running * distGain * (this.local ? 0.75 : 1.1);
    this.sGain = level;
    if (!host) return;
    if (!this.n) {
      if (level < 0.004 || !this.mgr.canActivate(this)) return;
      this.n = this.build(host);
    }
    if (level < 0.002) {
      this.release(host.ctx);
      return;
    }
    const n = this.n, t = host.ctx.currentTime, ps = this.ps;
    const f = Math.max(4, this.sRpm / 30);
    ps.set(0, n.o1.frequency, f, t, 0.03);
    ps.set(1, n.o2.frequency, f * 0.5, t, 0.03);
    ps.set(2, n.o3.frequency, f * 2, t, 0.03);
    ps.set(3, n.lfo.frequency, f * 0.5, t, 0.03);
    ps.set(4, n.noiseBp.frequency, Math.min(8000, f * 3 + 200), t, 0.05);
    ps.set(5, n.noiseG.gain, 0.04 + 0.22 * this.sThrottle, t, TAU_PARAM);
    const lpF = Math.min(cutoff, 260 + 1700 * this.sThrottle + f * 3.5);
    ps.set(6, n.lp.frequency, Math.max(120, lpF), t, 0.05);
    ps.set(7, n.out.gain, level * 0.65, t, TAU_PARAM);
    ps.set(8, n.pan.pan, pan, t, 0.05);
  }

  /** Current output level estimate (used to pick which engines to keep running). */
  get level(): number { return this.sGain; }

  private build(host: LoopHost): EngineNodes {
    const ctx = host.ctx;
    const f = Math.max(4, this.sRpm / 30);
    const mk = (type: OscillatorType, freq: number, detune: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      return o;
    };
    const o1 = mk('sawtooth', f, 0), o2 = mk('square', f * 0.5, 8), o3 = mk('sawtooth', f * 2, -7);
    const g1 = gain(ctx, 0.5), g2 = gain(ctx, 0.38), g3 = gain(ctx, 0.14);
    const lp = biquad(ctx, 'lowpass', 400, 1.6);
    const am = gain(ctx, 0.75);
    const lfo = mk('sine', f * 0.5, 0);
    const lfoG = gain(ctx, 0.25);
    const ns = loopSource(host, host.noise);
    const noiseBp = biquad(ctx, 'bandpass', f * 3, 1.2);
    const noiseG = gain(ctx, 0.05);
    const out = gain(ctx, 0);
    const pan = ctx.createStereoPanner();
    o1.connect(g1); o2.connect(g2); o3.connect(g3);
    g1.connect(lp); g2.connect(lp); g3.connect(lp);
    ns.connect(noiseBp); noiseBp.connect(noiseG); noiseG.connect(lp);
    lp.connect(am); am.connect(out);
    lfo.connect(lfoG); lfoG.connect(am.gain);
    out.connect(pan); pan.connect(host.bus);
    const t = ctx.currentTime;
    o1.start(t); o2.start(t); o3.start(t); lfo.start(t);
    this.ps.reset();
    return {
      o1, o2, o3, lfo, noiseBp, noiseG, lp, out, pan,
      srcs: [o1, o2, o3, lfo, ns],
      all: [o1, o2, o3, g1, g2, g3, lp, am, lfo, lfoG, ns, noiseBp, noiseG, out, pan],
    };
  }

  release(ctx: AudioContext | null, fade = 0.12): void {
    if (!this.n) return;
    if (ctx) release(ctx, this.n.out, this.n.srcs, this.n.all, fade);
    this.n = null;
  }
}

const ZERO_LISTENER: ListenerState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };

/** Owns every engine handle; returns the same handle for the same vehicle id. */
export class EngineManager {
  clock = 0;
  private readonly list: EngineVoice[] = [];
  private readonly byId = new Map<number, EngineVoice>();
  private ctx: AudioContext | null = null;

  get(id: number): EngineVoice {
    let e = this.byId.get(id);
    if (!e) {
      e = new EngineVoice(id, this);
      e.touched = this.clock;
      this.adopt(e);
    }
    return e;
  }

  adopt(e: EngineVoice): void {
    if (this.byId.get(e.id) === e) return;
    const prev = this.byId.get(e.id);
    if (prev) this.forget(prev);
    this.byId.set(e.id, e);
    this.list.push(e);
  }

  forget(e: EngineVoice): void {
    e.release(this.ctx, 0.35);
    e.stopped = true;
    if (this.byId.get(e.id) === e) this.byId.delete(e.id);
    const i = this.list.indexOf(e);
    if (i >= 0) {
      this.list[i] = this.list[this.list.length - 1];
      this.list.pop();
    }
  }

  /** Allow a new engine graph only while under the cap (the quietest one is evicted otherwise). */
  canActivate(e: EngineVoice): boolean {
    let active = 0, quiet: EngineVoice | null = null;
    for (const o of this.list) {
      if (!o.active || o === e) continue;
      active++;
      if (!quiet || o.level < quiet.level) quiet = o;
    }
    if (active < MAX_ACTIVE_ENGINES) return true;
    if (quiet && quiet.level < e.level) {
      quiet.release(this.ctx);
      return true;
    }
    return false;
  }

  update(host: LoopHost | null, dt: number): void {
    this.clock += dt;
    // Keep the last context: stop() between frames must still be able to free running nodes.
    if (host) this.ctx = host.ctx;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (this.clock - e.touched > ENGINE_FORGET) {
        this.forget(e);
        continue;
      }
      e.tick(host, dt, this.clock);
    }
  }

  /** Free every running graph but keep the handles (they rebuild on their next update). */
  releaseAll(): void {
    for (const e of this.list) e.release(this.ctx);
  }
}
