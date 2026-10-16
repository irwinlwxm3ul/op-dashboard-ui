// Client/server clock synchronisation and the smoothly advancing render (interpolation) clock.
// Pure classes (no DOM) so they can be unit tested in Node with simulated latency.
//
// Server time = the simulation clock in ms (Snapshot.time, pong.s). Estimation combines:
//  * ping/pong: offset = s + rtt/2 - receiveTime, taken from the sample with the lowest RTT among
//    the recent ones (min-filter: the least-queued round trip is the most symmetric one);
//  * snapshot arrivals: a snapshot stamped T cannot arrive before the server reached T, so
//    T - arrivalTime is a hard lower bound for the offset (also corrects the tick quantisation
//    of pong.s and gives an estimate before the first pong).

import { INTERP_DELAY_MS } from '../../shared/constants';

export const PING_INTERVAL_MS = 2000;
/** Quick pings right after joining so the estimate converges within a second. */
const FAST_PING_COUNT = 4;
const FAST_PING_INTERVAL_MS = 250;
/** Number of recent pongs considered by the min-RTT filter. */
const PONG_WINDOW = 10;
/** Number of recent snapshot lower bounds kept (~2 s at 20 Hz). */
const BOUND_WINDOW = 40;
/** Offset corrections larger than this are applied instantly instead of slewed. */
const OFFSET_SNAP_MS = 250;
/** Fraction of the remaining offset error corrected per observation. */
const OFFSET_SLEW = 0.1;
/** Extra interpolation delay allowed for jittery connections (ms). */
const MAX_JITTER_DELAY_MS = 80;

export class ClockSync {
  /** Estimated server time minus local time (ms). */
  offset = 0;
  /** Smoothed round trip time (ms); 0 until the first pong. */
  rtt = 0;
  /** Mean absolute deviation of snapshot arrival lateness (ms). */
  jitter = 0;
  /** True once any timing observation has been made. */
  synced = false;
  pongCount = 0;

  private readonly pongRtt = new Float64Array(PONG_WINDOW);
  private readonly pongOffset = new Float64Array(PONG_WINDOW);
  private pongHead = 0;
  private readonly bounds = new Float64Array(BOUND_WINDOW);
  private boundHead = 0;
  private boundCount = 0;
  private pingsSent = 0;
  private nextPingAt = -Infinity;
  private latenessMean = 0;
  private latenessInit = false;

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
    this.pongHead++;
    this.pongCount++;
    this.rtt = this.pongCount === 1 ? rtt : this.rtt + (rtt - this.rtt) * 0.25;
    this.adjust(this.targetOffset());
  }

  /** A snapshot stamped `serverMs` arrived at local time `now`. */
  onSnapshot(serverMs: number, now: number): void {
    if (!Number.isFinite(serverMs)) return;
    this.bounds[this.boundHead % BOUND_WINDOW] = serverMs - now;
    this.boundHead++;
    this.boundCount = Math.min(BOUND_WINDOW, this.boundCount + 1);
    const target = this.targetOffset();
    this.adjust(target);
    // Jitter: spread of the (estimated) one-way delay of snapshots.
    const lateness = now + target - serverMs;
    if (!this.latenessInit) {
      this.latenessInit = true;
      this.latenessMean = lateness;
    } else {
      this.latenessMean += (lateness - this.latenessMean) * 0.05;
      this.jitter += (Math.abs(lateness - this.latenessMean) - this.jitter) * 0.1;
    }
  }

  /** Estimated current server time (ms). */
  serverNow(now: number): number {
    return now + this.offset;
  }

  /** Interpolation delay (ms): the nominal delay plus a little headroom for jitter. */
  interpDelay(): number {
    return INTERP_DELAY_MS + Math.min(MAX_JITTER_DELAY_MS, Math.max(0, this.jitter * 2 - 4));
  }

  /** Best current estimate of the offset from all observations. */
  targetOffset(): number {
    let best = -Infinity;
    const n = Math.min(this.pongCount, PONG_WINDOW);
    if (n > 0) {
      let minRtt = Infinity;
      for (let i = 0; i < n; i++) {
        if (this.pongRtt[i] < minRtt) {
          minRtt = this.pongRtt[i];
          best = this.pongOffset[i];
        }
      }
    }
    for (let i = 0; i < this.boundCount; i++) if (this.bounds[i] > best) best = this.bounds[i];
    return best === -Infinity ? this.offset : best;
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

/** Snap the render clock when it is this far from its target (ms). */
const RENDER_SNAP_MS = 300;
/** Max relative speed-up / slow-down used to converge on the target. */
const RENDER_MAX_WARP = 0.12;
/** Error (ms) at which the max warp is reached. */
const RENDER_WARP_RANGE_MS = 60;

/**
 * Render time advances with real time and is gently time-warped (±12 %) toward its target
 * (estimated server time minus interpolation delay), so interpolation never jumps.
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
    const warp = Math.max(-RENDER_MAX_WARP, Math.min(RENDER_MAX_WARP, (err / RENDER_WARP_RANGE_MS) * RENDER_MAX_WARP));
    this.time += dtMs * (1 + warp);
    return this.time;
  }

  reset(): void {
    this.initialized = false;
  }
}
