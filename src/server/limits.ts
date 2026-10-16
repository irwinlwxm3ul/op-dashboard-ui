// Rate limiting primitives and the server's tunable limits.

/** Tunable per-server limits. Every field can be overridden through startServer(opts.limits). */
export interface ServerLimits {
  /** Sustained messages per second per connection (all message types). */
  msgRate: number;
  /** Token bucket burst size for messages. */
  msgBurst: number;
  /** Rate-limited (dropped) messages within `abuseWindowMs` that get a connection kicked. */
  abuseDrops: number;
  abuseWindowMs: number;
  /** Invalid messages within `invalidWindowMs` that get a connection kicked. */
  invalidMessages: number;
  invalidWindowMs: number;
  /** Lobby operations (create/join/leave/settings/team/ready/start) per second, and burst. */
  lobbyOpRate: number;
  lobbyOpBurst: number;
  /** Chat messages per second, and burst. */
  chatRate: number;
  chatBurst: number;
  /** Maximum number of lobbies on this server. */
  maxLobbies: number;
  /** Maximum concurrent WebSocket connections. */
  maxConnections: number;
  /** Heartbeat: ws ping interval and the silence after which a connection is terminated. */
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  /** Outgoing bytes buffered on a socket before it is considered a dead/slow consumer. */
  maxBufferedBytes: number;
  /** Minimum interval between pushed lobby list updates to browsing clients. */
  lobbyListThrottleMs: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  msgRate: 60,
  msgBurst: 120,
  abuseDrops: 240,
  abuseWindowMs: 10_000,
  invalidMessages: 10,
  invalidWindowMs: 10_000,
  lobbyOpRate: 5,
  lobbyOpBurst: 20,
  chatRate: 1,
  chatBurst: 5,
  maxLobbies: 200,
  maxConnections: 2000,
  heartbeatMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxBufferedBytes: 4 * 1024 * 1024,
  lobbyListThrottleMs: 500,
};

/** Classic token bucket. Times are milliseconds from a monotonic clock. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** Take `cost` tokens if available. */
  take(now: number, cost = 1): boolean {
    const elapsed = now - this.last;
    this.last = now;
    if (elapsed > 0) this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSec) / 1000);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

/**
 * Detects `limit` events within a sliding time window using a ring buffer of the last `limit`
 * timestamps (exact, allocation free).
 */
export class WindowCounter {
  private readonly times: Float64Array;
  private head = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.times = new Float64Array(Math.max(1, limit));
  }

  /** Record one event at `now`; returns true when `limit` events happened within the window. */
  hit(now: number): boolean {
    const n = this.times.length;
    this.times[this.head] = now;
    this.head = (this.head + 1) % n;
    if (this.count < n) this.count++;
    if (this.count < n) return false;
    // After advancing, `head` points at the oldest of the last `n` events.
    return now - this.times[this.head] <= this.windowMs;
  }
}
