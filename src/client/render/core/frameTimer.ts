// Exponential moving average of the frame interval (for the F3 stats overlay).

export class FrameTimer {
  private last = -1;
  private avgMs = 16.7;
  /** Smoothing time constant in milliseconds (~0.5 s window). */
  constructor(private readonly tauMs = 500) {}

  /** Call once per rendered frame with a monotonic timestamp in ms. */
  tick(nowMs: number): void {
    if (this.last >= 0) {
      // Ignore huge gaps (tab hidden, breakpoint) so the average recovers instantly.
      const dt = Math.min(1000, Math.max(0, nowMs - this.last));
      const k = 1 - Math.exp(-dt / this.tauMs);
      this.avgMs += (dt - this.avgMs) * k;
    }
    this.last = nowMs;
  }

  get frameMs(): number {
    return this.avgMs;
  }

  get fps(): number {
    return this.avgMs > 0 ? 1000 / this.avgMs : 0;
  }
}
