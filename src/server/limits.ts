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
  /** Maximum lobbies hosted from one address. */
  maxLobbiesPerIp: number;
  /** Maximum concurrent WebSocket connections. */
  maxConnections: number;
  /** Maximum concurrent WebSocket connections from one address. */
  maxConnectionsPerIp: number;
  /** Sockets that have not sent a valid hello within this time are closed (ms). */
  helloTimeoutMs: number;
  /** Maximum concurrently running matches (each one is a worker thread with its own world). */
  maxMatches: number;
  /** Maximum concurrently running matches started from one address. */
  maxMatchesPerIp: number;
  /** Match start budget per connection / per address: burst, refilled by one every interval. */
  matchStartBurst: number;
  matchStartBurstPerIp: number;
  matchStartIntervalMs: number;
  /** A lobby must exist this long before its match starts; earlier starts are deferred (ms). */
  minLobbyAgeMs: number;
  /** Heartbeat: ws ping interval and the silence after which a connection is terminated. */
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  /** RTT probe interval for clients in a match (lag-compensation bound; ms). */
  rttProbeMs: number;
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
  maxLobbiesPerIp: 3,
  maxConnections: 2000,
  maxConnectionsPerIp: 16,
  helloTimeoutMs: 8000,
  maxMatches: 50,
  maxMatchesPerIp: 2,
  matchStartBurst: 3,
  matchStartBurstPerIp: 5,
  matchStartIntervalMs: 30_000,
  minLobbyAgeMs: 3000,
  heartbeatMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  rttProbeMs: 2000,
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
    this.refill(now);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Whether `cost` tokens are available, without taking them. */
  has(now: number, cost = 1): boolean {
    this.refill(now);
    return this.tokens >= cost;
  }

  /** True when the bucket is back at its burst size (an idle bucket can be discarded). */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.burst;
  }

  private refill(now: number): void {
    const elapsed = now - this.last;
    this.last = now;
    if (elapsed > 0) this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSec) / 1000);
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
