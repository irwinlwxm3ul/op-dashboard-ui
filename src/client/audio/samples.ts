// Kenney CC0 samples (public/assets/sounds). Loaded lazily during init() with fetch +
// decodeAudioData; every failure is tolerated and the engine falls back to synthesized sounds.

export interface SampleSet {
  weaponChange: AudioBuffer | null;
  jump: AudioBuffer[];
  land: AudioBuffer | null;
  hurt: AudioBuffer | null;
  explosion: AudioBuffer | null;
  /** Individual footsteps sliced out of walking.ogg (shoe heel layer for hard surfaces). */
  steps: AudioBuffer[];
}

export const createSampleSet = (): SampleSet => ({
  weaponChange: null, jump: [], land: null, hurt: null, explosion: null, steps: [],
});

function baseUrl(): string {
  try {
    const b = import.meta.env?.BASE_URL;
    return typeof b === 'string' && b.length ? (b.endsWith('/') ? b : b + '/') : '/';
  } catch {
    return '/';
  }
}

/** decodeAudioData with both the promise and the legacy callback forms (older Safari). */
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function loadOne(ctx: BaseAudioContext, name: string): Promise<AudioBuffer | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const res = await fetch(`${baseUrl()}assets/sounds/${name}.ogg`);
    if (!res.ok) return null;
    const buf = await decode(ctx, await res.arrayBuffer());
    normalize(buf, 0.9);
    return buf;
  } catch {
    return null;
  }
}

/** Scale in place so the peak equals `peak` (the Kenney files vary from 0.12 to 1.7 peak). */
export function normalize(buf: AudioBuffer, peak: number): void {
  let max = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > max) max = a;
    }
  }
  if (max < 1e-5) return;
  const g = peak / max;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}

/**
 * Detect step onsets (5 ms peak envelope over a threshold, ≥ 0.2 s apart) and cut each step into
 * its own short buffer with a fade-in/out.
 */
export function sliceSteps(ctx: BaseAudioContext, src: AudioBuffer, maxSlices = 12): AudioBuffer[] {
  const sr = src.sampleRate;
  const win = Math.max(1, Math.floor(sr * 0.005));
  const chans: Float32Array[] = [];
  for (let c = 0; c < src.numberOfChannels; c++) chans.push(src.getChannelData(c));
  const nWin = Math.floor(src.length / win);
  const env = new Float32Array(nWin);
  let gmax = 0;
  for (let w = 0; w < nWin; w++) {
    let m = 0;
    for (const d of chans) for (let i = w * win, e = i + win; i < e; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
    env[w] = m;
    if (m > gmax) gmax = m;
  }
  if (gmax < 1e-4) return [];
  const thr = gmax * 0.15;
  const minGap = Math.floor(0.2 * sr / win);
  const onsets: number[] = [];
  let last = -minGap;
  for (let w = 0; w < nWin; w++) {
    if (env[w] > thr && w - last >= minGap) { onsets.push(w * win); last = w; }
  }
  const out: AudioBuffer[] = [];
  for (let k = 0; k < onsets.length && out.length < maxSlices; k++) {
    const start = Math.max(0, onsets[k] - Math.floor(sr * 0.004));
    const hardEnd = k + 1 < onsets.length ? onsets[k + 1] - Math.floor(sr * 0.01) : src.length;
    const end = Math.min(hardEnd, start + Math.floor(sr * 0.3), src.length);
    const len = end - start;
    if (len < sr * 0.04) continue;
    const b = ctx.createBuffer(src.numberOfChannels, len, sr);
    const fin = Math.floor(sr * 0.002), fout = Math.floor(sr * 0.04);
    for (let c = 0; c < src.numberOfChannels; c++) {
      const s = chans[c], d = b.getChannelData(c);
      for (let i = 0; i < len; i++) {
        let g = 1;
        if (i < fin) g = i / fin;
        else if (i > len - fout) g = (len - i) / fout;
        d[i] = s[start + i] * g;
      }
    }
    normalize(b, 0.9);
    out.push(b);
  }
  return out;
}

/** Load all samples in parallel into `set` (fields fill in as they arrive). Never rejects. */
export async function loadSamples(ctx: BaseAudioContext, set: SampleSet): Promise<void> {
  const tasks: Promise<void>[] = [
    loadOne(ctx, 'weapon_change').then((b) => { set.weaponChange = b; }),
    loadOne(ctx, 'land').then((b) => { set.land = b; }),
    loadOne(ctx, 'enemy_hurt').then((b) => { set.hurt = b; }),
    loadOne(ctx, 'enemy_destroy').then((b) => { set.explosion = b; }),
    ...['jump_a', 'jump_b', 'jump_c'].map((n) => loadOne(ctx, n).then((b) => { if (b) set.jump.push(b); })),
    loadOne(ctx, 'walking').then((b) => { if (b) set.steps = sliceSteps(ctx, b); }),
  ];
  await Promise.all(tasks.map((t) => t.catch(() => undefined)));
}
