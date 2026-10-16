// Dynamic resolution controller (pure logic, no WebGL). Fed one timing sample per frame, it keeps
// the scene render target between `minScale` and `maxScale` of the configured resolution so the
// frame fits a 60 FPS budget on weak GPUs.
//
// Two signal kinds:
//  * 'gpu'   - GPU time per frame from EXT_disjoint_timer_query_webgl2. Headroom is measurable, so
//              the controller can both shrink and grow with clear thresholds.
//  * 'frame' - wall-clock frame interval (fallback). Vsync hides headroom (a fine frame and a
//              barely-fine frame both read ~16.7 ms), so growth is a cautious probe with
//              exponential back-off, and a shrink that does not speed anything up is treated as
//              CPU-bound and reverted.
//
// Anti-oscillation: median-of-5 spike filter + EMA, asymmetric thresholds with a quadratic cost
// model (cost ~ scale^2), sustain windows before acting, minimum spacing between changes, a
// settle period after each change, and a growing cooldown for increases whenever an increase is
// followed by a quick decrease.

export type TimingSignal = 'gpu' | 'frame';

export interface DynamicResolutionOptions {
  minScale: number;
  maxScale: number;
  /** Quantisation / increase step. */
  step: number;
  targetFps: number;
}

export const DEFAULT_DRS_OPTIONS: Readonly<DynamicResolutionOptions> = {
  minScale: 0.6,
  maxScale: 1,
  step: 0.05,
  targetFps: 60,
};

const MEDIAN_N = 5;
const EMA_TAU_MS = 350;
const SETTLE_MS = 450;
const MIN_CHANGE_SPACING_MS = 1000;
const BASE_INCREASE_COOLDOWN_MS = 3000;
const MAX_INCREASE_COOLDOWN_MS = 60000;
const THRASH_WINDOW_MS = 6000;
const CPU_PROBE_MS = 1500;
const CPU_BOUND_BLOCK_MS = 20000;
const MAX_CPU_BOUND_BLOCK_MS = 160000;
/** After this many increases that had to be undone, frame-time mode only grows on clear headroom. */
const MAX_FAILED_INCREASES = 2;
/** Samples above this are hitches (tab switch, loading, GC storm), not load. */
const MAX_SAMPLE_MS = 1000;

export class DynamicResolution {
  private opts: DynamicResolutionOptions;
  private _scale: number;
  private _enabled = true;
  private readonly ring = new Float64Array(MEDIAN_N);
  private readonly sorted = new Float64Array(MEDIAN_N);
  private ringCount = 0;
  private ringPos = 0;
  private ema = -1;
  private lastSampleAt = -1;
  private overSince = -1;
  private underSince = -1;
  private lastChangeAt = -Infinity;
  private lastIncreaseAt = -Infinity;
  private increaseFrom = -1;
  private increaseCooldown = BASE_INCREASE_COOLDOWN_MS;
  private settleUntil = -Infinity;
  private decreaseBlockedUntil = -Infinity;
  private probeFrom = -1;
  private probeEma = -1;
  private probeAt = -1;
  private cpuBlock = CPU_BOUND_BLOCK_MS;
  private failedIncreases = 0;
  /** Number of scale changes so far (diagnostics / tests). */
  changes = 0;

  constructor(opts: Partial<DynamicResolutionOptions> = {}) {
    this.opts = { ...DEFAULT_DRS_OPTIONS, ...opts };
    this._scale = this.opts.maxScale;
  }

  get scale(): number {
    return this._scale;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Smoothed timing (ms) of the active signal, -1 before the first sample. */
  get smoothedMs(): number {
    return this.ema;
  }

  configure(opts: Partial<DynamicResolutionOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this._scale = Math.min(this.opts.maxScale, Math.max(this.opts.minScale, this._scale));
  }

  /** Disabled = full resolution. Returns true when the scale changed. */
  setEnabled(on: boolean): boolean {
    this._enabled = on;
    this.reset();
    return this.forceScale(this.opts.maxScale);
  }

  /** Forget history (quality preset changed, workload is different). Keeps the current scale. */
  reset(): void {
    this.ringCount = 0;
    this.ringPos = 0;
    this.ema = -1;
    this.lastSampleAt = -1;
    this.overSince = -1;
    this.underSince = -1;
    this.increaseCooldown = BASE_INCREASE_COOLDOWN_MS;
    this.decreaseBlockedUntil = -Infinity;
    this.probeFrom = -1;
    this.cpuBlock = CPU_BOUND_BLOCK_MS;
    this.failedIncreases = 0;
    this.increaseFrom = -1;
  }

  private forceScale(s: number): boolean {
    if (s === this._scale) return false;
    this._scale = s;
    this.changes++;
    return true;
  }

  private median(sample: number): number {
    this.ring[this.ringPos] = sample;
    this.ringPos = (this.ringPos + 1) % MEDIAN_N;
    if (this.ringCount < MEDIAN_N) this.ringCount++;
    const n = this.ringCount, a = this.sorted;
    for (let i = 0; i < n; i++) {
      const v = this.ring[i];
      let j = i - 1;
      while (j >= 0 && a[j] > v) {
        a[j + 1] = a[j];
        j--;
      }
      a[j + 1] = v;
    }
    return a[n >> 1];
  }

  private quantDown(s: number): number {
    const st = this.opts.step;
    return Math.max(this.opts.minScale, Math.floor(s / st + 1e-6) * st);
  }

  private setScale(s: number, now: number): boolean {
    const next = Math.round(Math.min(this.opts.maxScale, Math.max(this.opts.minScale, s)) * 1000) / 1000;
    if (next === this._scale) return false;
    this._scale = next;
    this.changes++;
    this.lastChangeAt = now;
    this.settleUntil = now + SETTLE_MS;
    this.overSince = -1;
    this.underSince = -1;
    return true;
  }

  /**
   * Feed one timing sample (ms) taken at `now` (ms, monotonic). Returns true when the scale
   * changed and the render target must be resized.
   */
  update(sampleMs: number, now: number, signal: TimingSignal): boolean {
    if (!this._enabled) return false;
    if (!(sampleMs > 0) || sampleMs > MAX_SAMPLE_MS) return false;
    const med = this.median(sampleMs);
    if (this.ema < 0) this.ema = med;
    else {
      const dt = this.lastSampleAt >= 0 ? Math.min(250, Math.max(1, now - this.lastSampleAt)) : 16;
      this.ema += (med - this.ema) * (1 - Math.exp(-dt / EMA_TAU_MS));
    }
    this.lastSampleAt = now;
    if (this.ringCount < MEDIAN_N || now < this.settleUntil) return false;

    const budget = 1000 / this.opts.targetFps;
    const gpu = signal === 'gpu';
    const high = gpu ? budget * 0.9 : budget * 1.1;
    const low = gpu ? budget * 0.6 : budget * 1.03;
    const ema = this.ema;

    // Frame-time mode: verify that the last decrease actually helped (else we are CPU-bound).
    if (!gpu && this.probeFrom >= 0 && now - this.probeAt >= CPU_PROBE_MS) {
      const gain = (this.probeEma - ema) / this.probeEma;
      const from = this.probeFrom;
      this.probeFrom = -1;
      if (gain < 0.04) {
        this.decreaseBlockedUntil = now + this.cpuBlock;
        this.cpuBlock = Math.min(MAX_CPU_BOUND_BLOCK_MS, this.cpuBlock * 2);
        return this.setScale(from, now);
      }
    }

    if (ema > high) {
      this.underSince = -1;
      if (this.overSince < 0) this.overSince = now;
      const sustained = now - this.overSince >= (gpu ? 500 : 700);
      if (
        sustained && this._scale > this.opts.minScale && now - this.lastChangeAt >= MIN_CHANGE_SPACING_MS &&
        now >= this.decreaseBlockedUntil && this.probeFrom < 0
      ) {
        // Cost ~ scale^2: aim at 80 % of the budget (GPU) / the budget (frame), 1-3 steps at a time.
        const target = gpu ? budget * 0.8 : budget;
        const ideal = this._scale * Math.sqrt(target / ema);
        let next = this.quantDown(Math.min(this._scale - this.opts.step, Math.max(this._scale - 3 * this.opts.step, ideal)));
        if (now - this.lastIncreaseAt < THRASH_WINDOW_MS && this.increaseFrom > 0) {
          // The last increase did not fit: go straight back to where it came from.
          next = this.increaseFrom;
          this.increaseFrom = -1;
          this.increaseCooldown = Math.min(MAX_INCREASE_COOLDOWN_MS, this.increaseCooldown * 2);
          this.failedIncreases++;
        }
        const from = this._scale;
        if (this.setScale(next, now)) {
          if (!gpu) {
            this.probeFrom = from;
            this.probeEma = ema;
            this.probeAt = now;
          }
          return true;
        }
      }
      return false;
    }

    if (ema < low) {
      this.overSince = -1;
      if (this.underSince < 0) this.underSince = now;
      const sustained = now - this.underSince >= (gpu ? 2500 : 4000);
      if (
        sustained && this._scale < this.opts.maxScale && now - this.lastIncreaseAt >= this.increaseCooldown &&
        now - this.lastChangeAt >= 2 * MIN_CHANGE_SPACING_MS
      ) {
        const next = Math.min(this.opts.maxScale, this._scale + this.opts.step);
        // GPU mode: only grow if the predicted cost stays clearly under the shrink threshold.
        if (gpu && ema * (next / this._scale) ** 2 > high * 0.85) return false;
        // Frame mode after repeated failed probes: only grow on unambiguous headroom (e.g. a
        // high-refresh display running well above 60 FPS).
        if (!gpu && this.failedIncreases >= MAX_FAILED_INCREASES && ema > budget * 0.85) return false;
        const from = this._scale;
        if (this.setScale(next, now)) {
          this.lastIncreaseAt = now;
          this.increaseFrom = from;
          return true;
        }
      }
      return false;
    }

    this.overSince = -1;
    this.underSince = -1;
    return false;
  }
}
