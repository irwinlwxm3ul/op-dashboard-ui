// Client/server clock synchronisation and the smoothly advancing render (interpolation) clock.
// Pure classes (no DOM) so they can be unit tested in Node with simulated latency.
//
// Two estimates are kept (server time = the sim clock in ms, Snapshot.time / pong.s):
//
//  * Data clock (`dataNow`): the server time of the newest data that can have reached us. A
//    snapshot stamped T arriving at local time a gives the sample T - a; the windowed MAXIMUM over
//    the recent samples (the least delayed snapshot) is the data offset. Rendering is based on it:
//    renderTime = dataNow - interpDelay, so the interpolation buffer is the same at any ping. It
//    rises instantly and follows a server clock that steps BACK (the runner drops its backlog after
//    a stall) within the window, without trusting any single jittery sample.
//  * True clock (`serverNow`): ping/pong with a min-RTT filter, offset = s + rtt/2 - receiveTime,
//    never below the data clock. Used for timers and for estimating when an input reaches the
//    server. A discontinuity detector drops pre-step pongs when the data clock shows the server
//    clock went back, and requests a quick ping burst to re-measure.

import { INTERP_DELAY_MS } from '../../shared/constants';

export const PING_INTERVAL_MS = 2000;
/** Quick pings right after joining (and after a clock discontinuity) so the estimate converges fast. */
const FAST_PING_COUNT = 4;
const FAST_PING_INTERVAL_MS = 250;
/** Recent pongs considered by the min-RTT filter (count and age). */
const PONG_WINDOW = 10;
const PONG_MAX_AGE_MS = 10_000;
/** Snapshot arrival samples kept, and the window of the data-clock maximum. */
const BOUND_CAPACITY = 64;
const DATA_WINDOW_MS = 600;
/** True-offset corrections larger than this (ms) are applied instantly instead of slewed. */
const OFFSET_SNAP_MS = 250;
/** Fraction of the remaining true-offset error corrected per observation. */
const OFFSET_SLEW = 0.1;
/** The pong estimate must exceed the data evidence by this much (+ 2x jitter, bounded) ... */
const STEP_TOLERANCE_MS = 40;
/** ... for this long before it is considered a server clock step back. */
const STEP_CONFIRM_MS = 250;
/** Jitter bookkeeping: per-sample lateness cap and the jitter share of the step tolerance (ms). */
const JITTER_SAMPLE_CAP_MS = 60;
const STEP_JITTER_CAP_MS = 30;
/** Extra interpolation delay allowed for jittery connections (ms). */
const MAX_JITTER_DELAY_MS = 80;

export class ClockSync {
  /** Estimated true server time minus local time (ms). */
  offset = 0;
  /** Server time of the newest receivable data minus local time (ms). */
  dataOffset = 0;
  /** Smoothed round trip time (ms); 0 until the first pong. */
  rtt = 0;
  /** Mean lateness of snapshots relative to the fastest recent one (ms). */
  jitter = 0;
  /** True once any timing observation has been made. */
  synced = false;
  pongCount = 0;
  /** Number of detected server clock steps back (diagnostics). */
  discontinuities = 0;

  private readonly pongRtt = new Float64Array(PONG_WINDOW);
  private readonly pongOffset = new Float64Array(PONG_WINDOW);
  private readonly pongAt = new Float64Array(PONG_WINDOW);
  private pongHead = 0;
  private pongValid = 0;
  /** Lowest RTT seen recently (survives pong purges; RTT is unaffected by clock steps). */
  private rttFloor = Infinity;
  private readonly bound = new Float64Array(BOUND_CAPACITY);
  private readonly boundAt = new Float64Array(BOUND_CAPACITY);
  private boundHead = 0;
  private boundCount = 0;
  private dataSynced = false;
  private pingsSent = 0;
  private nextPingAt = -Infinity;
  private stepSince = -1;

  /** True when a ping should be sent now (schedules the next one). */
  shouldPing(now: number): boolean {
    if (now < this.nextPingAt) return false;
    this.pingsSent++;
    this.nextPingAt = now + (this.pingsSent < FAST_PING_COUNT ? FAST_PING_INTERVAL_MS : PING_INTERVAL_MS);
    return true;
  }

  /** Pong received: `sentAt` is the local time the ping was sent (echoed `c`), `serverMs` is `s`. */
  onPong(sentAt: number, serverMs: number, now: number): void {
    const rtt = Math.max(0, now - sentAt);
    if (!Number.isFinite(rtt) || !Number.isFinite(serverMs)) return;
    const i = this.pongHead % PONG_WINDOW;
    this.pongRtt[i] = rtt;
    this.pongOffset[i] = serverMs + rtt / 2 - now;
    this.pongAt[i] = now;
    this.pongHead++;
    this.pongValid = Math.min(PONG_WINDOW, this.pongValid + 1);
    this.pongCount++;
    this.rtt = this.pongCount === 1 ? rtt : this.rtt + (rtt - this.rtt) * 0.25;
    this.rttFloor = Math.min(this.rttFloor * 1.02 + 0.5, rtt); // slowly forgets an old minimum
    this.adjust(this.targetOffset(now));
  }

  /** A snapshot stamped `serverMs` arrived at local time `now`. */
  onSnapshot(serverMs: number, now: number): void {
    if (!Number.isFinite(serverMs)) return;
    const sample = serverMs - now;
    const i = this.boundHead % BOUND_CAPACITY;
    this.bound[i] = sample;
    this.boundAt[i] = now;
    this.boundHead++;
    this.boundCount = Math.min(BOUND_CAPACITY, this.boundCount + 1);

    // Data clock: maximum over the recent window (the least delayed snapshot).
    this.dataOffset = this.windowMax(now, DATA_WINDOW_MS, sample);
    if (!this.dataSynced) this.dataSynced = true;
    // Capped so a clock step (every sample in the window looks late) does not read as jitter.
    else this.jitter += (Math.min(JITTER_SAMPLE_CAP_MS, Math.max(0, this.dataOffset - sample)) - this.jitter) * 0.1;

    this.detectStep(now);
    this.adjust(this.targetOffset(now));
  }

  /** Estimated current true server time (ms). */
  serverNow(now: number): number {
    return now + this.offset;
  }

  /** Server time (ms) of the newest data that can have arrived by now. */
  dataNow(now: number): number {
    return now + this.dataOffset;
  }

  /** Interpolation delay (ms) behind the data clock: nominal delay plus headroom for jitter. */
  interpDelay(): number {
    return INTERP_DELAY_MS + Math.min(MAX_JITTER_DELAY_MS, Math.max(0, this.jitter * 2 - 4));
  }

  /** Best current estimate of the true offset from all observations. */
  targetOffset(now: number): number {
    let pongEst = -Infinity;
    let minRtt = Infinity;
    for (let i = 0; i < this.pongValid; i++) {
      if (now - this.pongAt[i] > PONG_MAX_AGE_MS) continue;
      if (this.pongRtt[i] < minRtt) {
        minRtt = this.pongRtt[i];
        pongEst = this.pongOffset[i];
      }
    }
    // The data clock is a hard lower bound (data cannot arrive before it was produced); without a
    // usable pong, half the best known RTT is the one-way estimate on top of it.
    const dataEst = this.dataSynced ? this.dataOffset + (Number.isFinite(this.rttFloor) ? this.rttFloor / 2 : 0) : -Infinity;
    const lower = this.dataSynced ? this.dataOffset : -Infinity;
    const best = pongEst > -Infinity ? Math.max(pongEst, lower) : dataEst;
    return best === -Infinity ? this.offset : best;
  }

  /**
   * Server clock stepped back (backlog dropped after a stall): the pongs measured before the step
   * keep the true estimate too high. Confirmed when the estimate stays clearly above what the data
   * clock allows for STEP_CONFIRM_MS; then the stale pongs are dropped and a ping burst requested.
   */
  private detectStep(now: number): void {
    if (this.pongValid === 0) {
      this.stepSince = -1;
      return;
    }
    const oneWay = Number.isFinite(this.rttFloor) ? this.rttFloor / 2 : 0;
    const excess = this.offset - (this.dataOffset + oneWay);
    if (excess <= STEP_TOLERANCE_MS + 2 * Math.min(this.jitter, STEP_JITTER_CAP_MS)) {
      this.stepSince = -1;
      return;
    }
    if (this.stepSince < 0) {
      this.stepSince = now;
      return;
    }
    if (now - this.stepSince < STEP_CONFIRM_MS) return;
    this.pongValid = 0;
    this.pongHead = 0;
    this.stepSince = -1;
    this.discontinuities++;
    this.pingsSent = 0;
    this.nextPingAt = -Infinity;
  }

  private windowMax(now: number, windowMs: number, fallback: number): number {
    let best = -Infinity;
    for (let i = 0; i < this.boundCount; i++) {
      if (now - this.boundAt[i] <= windowMs && this.bound[i] > best) best = this.bound[i];
    }
    return best === -Infinity ? fallback : best;
  }

  private adjust(target: number): void {
    if (!this.synced || Math.abs(target - this.offset) > OFFSET_SNAP_MS) {
      this.offset = target;
      this.synced = true;
    } else {
      this.offset += (target - this.offset) * OFFSET_SLEW;
    }
  }
}

/** Snap the render clock only for absurd errors (ms); anything smaller is slewed. */
const RENDER_SNAP_MS = 1000;
/** Gentle warp for small errors: ±12 % reached at 60 ms. */
const RENDER_SOFT_WARP = 0.12;
const RENDER_SOFT_RANGE_MS = 60;
/** Strong warp for large errors (clock steps): time runs at 0.5x .. 1.25x, reached at 300 ms. */
const RENDER_MAX_SLOW = 0.5;
const RENDER_MAX_FAST = 0.25;
const RENDER_HARD_RANGE_MS = 300;

/**
 * Render time advances with real time and is time-warped toward its target (data clock minus
 * interpolation delay): ±12 % for small errors, up to 2x slower / 1.25x faster for large ones, so
 * interpolation never jumps and never runs backwards. Only absurd errors (> 1 s) snap.
 */
export class RenderClock {
  time = 0;
  private initialized = false;

  update(dtMs: number, target: number): number {
    if (!this.initialized || Math.abs(target - this.time) > RENDER_SNAP_MS) {
      this.time = target;
      this.initialized = true;
      return this.time;
    }
    const err = target - (this.time + dtMs);
    const a = Math.abs(err);
    let warp: number;
    if (a <= RENDER_SOFT_RANGE_MS) {
      warp = (a / RENDER_SOFT_RANGE_MS) * RENDER_SOFT_WARP;
    } else {
      const k = Math.min(1, (a - RENDER_SOFT_RANGE_MS) / (RENDER_HARD_RANGE_MS - RENDER_SOFT_RANGE_MS));
      warp = RENDER_SOFT_WARP + k * ((err < 0 ? RENDER_MAX_SLOW : RENDER_MAX_FAST) - RENDER_SOFT_WARP);
    }
    let step = dtMs * (1 + (err < 0 ? -warp : warp));
    // Never overshoot the target within one step.
    if (err > 0 && this.time + step > target) step = Math.max(0, target - this.time);
    if (err < 0 && this.time + step < target) step = Math.max(0, target - this.time);
    this.time += step;
    return this.time;
  }

  reset(): void {
    this.initialized = false;
  }
}
