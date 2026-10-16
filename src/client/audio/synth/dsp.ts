// Offline synthesis toolkit. Every procedural sound is described as a small WebAudio graph that is
// rendered once with an OfflineAudioContext into an AudioBuffer; at runtime one-shots are just
// BufferSources (cheap). The helpers below keep the recipes short and readable.
//
// All randomness is seeded (mulberry32) so a given variation always renders identically while the
// three variations of a sound differ.

export type Rand = () => number;

/** Small fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseColor = 'white' | 'pink' | 'brown';

/** Rendering context handed to a recipe. */
export interface Synth {
  readonly ctx: OfflineAudioContext;
  readonly sr: number;
  /** Rendered length (s). */
  readonly len: number;
  /** Destination input of the recipe (the context destination). */
  readonly out: AudioNode;
  readonly rand: Rand;
  /** Shared looping-free noise buffer of the full render length (cached per colour/channels). */
  noise(color: NoiseColor, channels?: 1 | 2): AudioBuffer;
}

export interface SoundSpec {
  /** Render length in seconds. */
  seconds: number;
  channels?: 1 | 2;
  /** Sample rate override (dark/far sounds render at 24 kHz to halve memory). */
  rate?: number;
  /** Normalise the rendered peak to this value (default 0.95). 0 disables normalisation. */
  peak?: number;
  build(s: Synth): void;
}

export type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export async function renderSpec(spec: SoundSpec, seed: number, defaultRate: number, Offline: OfflineCtor): Promise<AudioBuffer> {
  const sr = spec.rate ?? defaultRate;
  const channels = spec.channels ?? 1;
  const length = Math.max(1, Math.ceil(spec.seconds * sr));
  const ctx = new Offline(channels, length, sr);
  const rand = mulberry32(seed);
  const cache = new Map<string, AudioBuffer>();
  const s: Synth = {
    ctx,
    sr,
    len: spec.seconds,
    out: ctx.destination,
    rand,
    noise(color, ch = 1) {
      const key = color + ch;
      let b = cache.get(key);
      if (!b) {
        b = noiseBuffer(ctx, spec.seconds + 0.05, color, ch, rand);
        cache.set(key, b);
      }
      return b;
    },
  };
  spec.build(s);
  const buffer = await ctx.startRendering();
  finish(buffer, spec.peak ?? 0.95);
  return buffer;
}

/** Normalise the peak and apply a short fade-out so a truncated tail never clicks. */
export function finish(buffer: AudioBuffer, peak: number): void {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > max) max = a;
    }
  }
  const g = peak > 0 && max > 1e-6 ? peak / max : 1;
  const fade = Math.min(buffer.length, Math.floor(buffer.sampleRate * 0.012));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    if (g !== 1) for (let i = 0; i < d.length; i++) d[i] *= g;
    for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
  }
}

// ---------------------------------------------------------------------------------------------
// Buffers generated in JS
// ---------------------------------------------------------------------------------------------

/** Noise buffer: white, pink (Paul Kellet) or brown (leaky integrator). Independent per channel. */
export function noiseBuffer(ctx: BaseAudioContext, seconds: number, color: NoiseColor, channels: number, rand: Rand): AudioBuffer {
  const len = Math.max(1, Math.ceil(seconds * ctx.sampleRate));
  const b = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) fillNoise(b.getChannelData(c), color, rand);
  return b;
}

export function fillNoise(d: Float32Array, color: NoiseColor, rand: Rand): void {
  if (color === 'white') {
    for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
    return;
  }
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return;
  }
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = rand() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.5;
  }
}

/**
 * Smoothed random amplitude modulation baked into a buffer (rolling thunder / gusts / tearing):
 * multiplies `d` by (1 - depth/2) + depth * smoothNoise(rate Hz).
 */
export function applyRollingAM(d: Float32Array, sr: number, rate: number, depth: number, rand: Rand): void {
  const step = Math.max(1, Math.floor(sr / rate));
  let a = rand(), b = rand();
  for (let i = 0; i < d.length; i++) {
    const k = i % step;
    if (k === 0 && i > 0) { a = b; b = rand(); }
    const t = k / step;
    const s = t * t * (3 - 2 * t);
    const m = a + (b - a) * s;
    d[i] *= 1 - depth * 0.5 + depth * m;
  }
}

/**
 * Sparse impulse train (crackle / debris / grit / tearing fibres). `density` events per second,
 * optionally decaying with `decay` (s, 0 = constant). Each event is a tiny noise grain 0.2–1.5 ms.
 */
export function crackleBuffer(
  ctx: BaseAudioContext, seconds: number, density: number, decay: number, rand: Rand, channels = 1, start = 0,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.ceil(seconds * sr));
  const b = ctx.createBuffer(channels, len, sr);
  for (let c = 0; c < channels; c++) {
    const d = b.getChannelData(c);
    let t = start;
    while (t < seconds) {
      // Exponential inter-arrival times give a natural, non-periodic patter.
      t += -Math.log(1 - rand() * 0.999) / density;
      if (t >= seconds) break;
      const env = decay > 0 ? Math.exp(-(t - start) / decay) : 1;
      const amp = env * (0.25 + 0.75 * rand() * rand()) * (rand() < 0.5 ? -1 : 1);
      const i0 = Math.floor(t * sr);
      const glen = Math.max(2, Math.floor(sr * (0.0002 + rand() * 0.0013)));
      for (let k = 0; k < glen && i0 + k < len; k++) {
        d[i0 + k] += amp * (rand() * 2 - 1) * (1 - k / glen);
      }
    }
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------------------------

export const rr = (s: Synth, a: number, b: number): number => a + (b - a) * s.rand();
/** Multiplicative jitter: x * (1 ± amount). */
export const jit = (s: Synth, x: number, amount: number): number => x * (1 + (s.rand() * 2 - 1) * amount);

export function bq(s: Synth, type: BiquadFilterType, freq: number, q = 0.707, gainDb = 0): BiquadFilterNode {
  const f = s.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clampF(s, freq);
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function amp(s: Synth, value = 0): GainNode {
  const g = s.ctx.createGain();
  g.gain.value = value;
  return g;
}

/** Connect nodes in series and return the last one. */
export function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

const clampF = (s: Synth, f: number): number => Math.min(Math.max(f, 10), s.sr * 0.49);

/** Attack (linear) then exponential decay with time constant tau. */
export function envAD(p: AudioParam, t0: number, peak: number, attack: number, tau: number): void {
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, t0 + attack);
  p.setTargetAtTime(0, t0 + attack, tau);
}

/** Attack, hold, exponential decay. */
export function envAHD(p: AudioParam, t0: number, peak: number, attack: number, hold: number, tau: number): void {
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, t0 + attack);
  p.setValueAtTime(peak, t0 + attack + hold);
  p.setTargetAtTime(0, t0 + attack + hold, tau);
}

export function sweep(p: AudioParam, t0: number, from: number, to: number, time: number, exp = true): void {
  p.setValueAtTime(from, t0);
  if (exp && from > 0 && to > 0) p.exponentialRampToValueAtTime(to, t0 + time);
  else p.linearRampToValueAtTime(to, t0 + time);
}

export function play(s: Synth, buffer: AudioBuffer, t0: number, offset = 0, rate = 1): AudioBufferSourceNode {
  const src = s.ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  src.start(Math.max(0, t0), Math.max(0, offset));
  return src;
}

export interface FilterStage { type: BiquadFilterType; f: number; q?: number; to?: number; time?: number }

export interface NoiseHit {
  t: number;
  color?: NoiseColor;
  channels?: 1 | 2;
  filters?: FilterStage[];
  attack: number;
  tau: number;
  hold?: number;
  gain: number;
  dest?: AudioNode;
  /** Custom source buffer instead of the shared noise. */
  buffer?: AudioBuffer;
  rate?: number;
}

/** Filtered noise burst with an AD envelope. Filters may sweep (`to`, `time`). */
export function noiseHit(s: Synth, h: NoiseHit): GainNode {
  const buffer = h.buffer ?? s.noise(h.color ?? 'white', h.channels ?? 1);
  const maxOffset = Math.max(0, buffer.duration - (s.len - h.t) - 0.01);
  const src = play(s, buffer, h.t, h.buffer ? 0 : s.rand() * maxOffset, h.rate ?? 1);
  let node: AudioNode = src;
  if (h.filters) {
    for (const st of h.filters) {
      const f = bq(s, st.type, st.f, st.q ?? 0.707);
      if (st.to !== undefined) sweep(f.frequency, h.t, clampF(s, st.f), clampF(s, st.to), st.time ?? h.tau * 3);
      node.connect(f);
      node = f;
    }
  }
  const g = amp(s);
  if (h.hold) envAHD(g.gain, h.t, h.gain, h.attack, h.hold, h.tau);
  else envAD(g.gain, h.t, h.gain, h.attack, h.tau);
  node.connect(g);
  g.connect(h.dest ?? s.out);
  src.stop(Math.min(s.len, h.t + h.attack + (h.hold ?? 0) + h.tau * 9 + 0.01));
  return g;
}

export interface ToneHit {
  t: number;
  type?: OscillatorType;
  f: number;
  /** Optional pitch sweep target and duration. */
  fTo?: number;
  sweepTime?: number;
  detune?: number;
  attack: number;
  hold?: number;
  tau: number;
  gain: number;
  dest?: AudioNode;
}

export function tone(s: Synth, h: ToneHit): GainNode {
  const o = s.ctx.createOscillator();
  o.type = h.type ?? 'sine';
  if (h.fTo !== undefined) sweep(o.frequency, h.t, clampF(s, h.f), clampF(s, h.fTo), h.sweepTime ?? h.tau * 2);
  else o.frequency.value = clampF(s, h.f);
  if (h.detune) o.detune.value = h.detune;
  const g = amp(s);
  if (h.hold) envAHD(g.gain, h.t, h.gain, h.attack, h.hold, h.tau);
  else envAD(g.gain, h.t, h.gain, h.attack, h.tau);
  o.connect(g);
  g.connect(h.dest ?? s.out);
  o.start(h.t);
  o.stop(Math.min(s.len, h.t + h.attack + (h.hold ?? 0) + h.tau * 9 + 0.01));
  return g;
}

/** Modal ringing: a set of damped sine partials (metal, glass, wood, bells). */
export function modal(
  s: Synth, t: number, freqs: number[], taus: number[], amps: number[], gain: number, dest?: AudioNode, attack = 0.0006,
): void {
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= s.sr * 0.48) continue;
    tone(s, { t, f: freqs[i], attack, tau: taus[i % taus.length], gain: gain * amps[i % amps.length], dest });
  }
}

/** tanh soft clipper, normalised so an input of ±1 maps to ±1. Adds punch and audible harmonics. */
export function softClip(s: Synth, drive: number): WaveShaperNode {
  const ws = s.ctx.createWaveShaper();
  const n = 2048;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

/** Delayed, filtered copy of `input` (reflections / slapback). */
export function echoTap(s: Synth, input: AudioNode, time: number, gain: number, lowpass: number, dest?: AudioNode): void {
  const d = s.ctx.createDelay(Math.max(1, time + 0.1));
  d.delayTime.value = time;
  const lp = bq(s, 'lowpass', lowpass, 0.5);
  const g = amp(s, gain);
  input.connect(d);
  d.connect(lp);
  lp.connect(g);
  g.connect(dest ?? s.out);
}

/** Bus node (unity gain) used to group layers so they can share processing. */
export function bus(s: Synth, dest?: AudioNode, value = 1): GainNode {
  const g = amp(s, value);
  g.connect(dest ?? s.out);
  return g;
}
