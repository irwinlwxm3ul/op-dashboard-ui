// Artificial network latency (LAG_MS) for one direction of one connection.
// Items are delivered after `lagMs` (+ optional random jitter) in strict FIFO order: an item is
// never delivered before an item queued earlier, so jitter cannot reorder messages (like TCP).

export class LagQueue<T> {
  private readonly dues: number[] = [];
  private readonly values: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDue = 0;
  private disposed = false;

  constructor(
    private readonly lagMs: number,
    private readonly jitterMs: number,
    private readonly deliver: (value: T) => void,
  ) {}

  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    if (this.disposed) return;
    const now = performance.now();
    // Server-side network emulation only (never gameplay), so Math.random is fine here.
    let due = now + this.lagMs + (this.jitterMs > 0 ? Math.random() * this.jitterMs : 0);
    if (due < this.lastDue) due = this.lastDue;
    this.lastDue = due;
    this.dues.push(due);
    this.values.push(value);
    if (this.timer === null) this.schedule(now);
  }

  /** Drop everything still queued and stop the timer. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dues.length = 0;
    this.values.length = 0;
  }

  private schedule(now: number): void {
    if (this.dues.length === 0) return;
    const wait = Math.max(0, Math.ceil(this.dues[0] - now));
    this.timer = setTimeout(this.flush, wait);
  }

  private readonly flush = (): void => {
    this.timer = null;
    if (this.disposed) return;
    const now = performance.now();
    let n = 0;
    while (n < this.dues.length && this.dues[n] <= now) n++;
    if (n > 0) {
      const ready = this.values.splice(0, n);
      this.dues.splice(0, n);
      for (const v of ready) {
        if (this.disposed) return;
        this.deliver(v);
      }
    }
    if (!this.disposed && this.timer === null) this.schedule(performance.now());
  };
}
