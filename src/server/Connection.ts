// One WebSocket client connection: decoding + validation of inbound messages, per-connection rate
// limiting and abuse kicks, artificial latency (LAG_MS) in both directions, heartbeats and
// back-pressure protection. Game/lobby semantics live in GameServer / LobbyManager.

import { randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../shared/constants';
import type { ClientMessage, LobbyErrorCode, ServerMessage } from '../shared/protocol';
import { sanitizeName, validateClientMessage } from '../shared/validate';
import { LagQueue } from './LagQueue';
import { TokenBucket, WindowCounter, type ServerLimits } from './limits';
import type { Logger } from './log';

/** Application close codes (4000-4999 are free for applications). */
export const CLOSE_CODES = {
  versionMismatch: 4000,
  kicked: 4001,
  serverFull: 4002,
  slowConsumer: 4003,
  shutdown: 1001,
} as const;

export type DecodeResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; code: LobbyErrorCode; fatal: boolean };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Parse and validate one raw text frame. Never throws. `startLocal` is a worker-only message and
 * is rejected by the network server.
 */
export function decodeClientMessage(text: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: 'net.badMessage', fatal: false };
  }
  if (isObj(raw) && raw.t === 'hello') {
    if (raw.version !== PROTOCOL_VERSION) return { ok: false, code: 'net.versionMismatch', fatal: true };
    if (sanitizeName(raw.name) === null) return { ok: false, code: 'lobby.nameInvalid', fatal: false };
  }
  const msg = validateClientMessage(raw);
  if (!msg || msg.t === 'startLocal') return { ok: false, code: 'net.badMessage', fatal: false };
  return { ok: true, msg };
}

type Outbound = string | { close: number; reason: string };

export interface ConnectionOptions {
  lagMs: number;
  jitterMs: number;
  limits: ServerLimits;
  log: Logger;
  onMessage(conn: ClientConnection, msg: ClientMessage): void;
  onClose(conn: ClientConnection): void;
}

export class ClientConnection {
  readonly id: string = randomUUID();
  /** Display name, set by `hello`. Null until the client said hello. */
  name: string | null = null;
  /** Lobby this client is a member of. */
  lobbyId: string | null = null;
  /** True while the client is in the running match view of its lobby (receives match traffic). */
  inMatch = false;
  /** Smoothed round trip time in ms (WebSocket ping/pong incl. artificial latency). */
  ping = 0;
  readonly connectedAt = performance.now();

  private closing = false;
  private closed = false;
  private lastPong: number;
  private pingSentAt = 0;
  private lastRateError = -Infinity;
  private readonly msgBucket: TokenBucket;
  private readonly lobbyOpBucket: TokenBucket;
  private readonly chatBucket: TokenBucket;
  private readonly invalid: WindowCounter;
  private readonly abuse: WindowCounter;
  private readonly outQ: LagQueue<Outbound> | null;
  private readonly inQ: LagQueue<ClientMessage> | null;

  constructor(
    private readonly ws: WebSocket,
    readonly ip: string,
    private readonly opts: ConnectionOptions,
  ) {
    const now = performance.now();
    const l = opts.limits;
    this.lastPong = now;
    this.msgBucket = new TokenBucket(l.msgRate, l.msgBurst, now);
    this.lobbyOpBucket = new TokenBucket(l.lobbyOpRate, l.lobbyOpBurst, now);
    this.chatBucket = new TokenBucket(l.chatRate, l.chatBurst, now);
    this.invalid = new WindowCounter(l.invalidMessages, l.invalidWindowMs);
    this.abuse = new WindowCounter(l.abuseDrops, l.abuseWindowMs);
    if (opts.lagMs > 0 || opts.jitterMs > 0) {
      this.outQ = new LagQueue<Outbound>(opts.lagMs, opts.jitterMs, (o) => this.writeNow(o));
      this.inQ = new LagQueue<ClientMessage>(opts.lagMs, opts.jitterMs, (m) => this.dispatch(m));
    } else {
      this.outQ = null;
      this.inQ = null;
    }

    ws.on('message', (data, isBinary) => this.receive(data, isBinary));
    ws.on('pong', () => {
      const t = performance.now();
      this.lastPong = t;
      if (this.pingSentAt > 0) {
        const rtt = t - this.pingSentAt + 2 * opts.lagMs;
        this.ping = this.ping === 0 ? rtt : this.ping * 0.6 + rtt * 0.4;
        this.pingSentAt = 0;
      }
    });
    ws.on('close', () => this.handleClosed());
    // Errors (e.g. maxPayload exceeded, protocol violations) are followed by 'close'.
    ws.on('error', (err) => opts.log.warn('socket error', { client: this.id, err: err.message }));
  }

  get isOpen(): boolean {
    return !this.closed && !this.closing;
  }

  /** Display rounded ping for lobby member lists. */
  get pingMs(): number {
    return Math.round(this.ping);
  }

  send(msg: ServerMessage): void {
    if (!this.isOpen) return;
    // Serialise immediately: callers may mutate/reuse the object after send returns.
    this.sendRaw(JSON.stringify(msg));
  }

  /** Send an already serialised ServerMessage (used for broadcasts: serialise once). */
  sendRaw(data: string): void {
    if (!this.isOpen) return;
    if (this.outQ) this.outQ.push(data);
    else this.writeNow(data);
  }

  sendError(code: LobbyErrorCode): void {
    this.send({ t: 'error', code });
  }

  /** Lobby operation budget (create/join/settings/...); sends net.rateLimited when exhausted. */
  allowLobbyOp(): boolean {
    if (this.lobbyOpBucket.take(performance.now())) return true;
    this.rateLimited();
    return false;
  }

  /** Chat budget; sends net.rateLimited when exhausted. */
  allowChat(): boolean {
    if (this.chatBucket.take(performance.now())) return true;
    this.rateLimited();
    return false;
  }

  /**
   * Reject a message that was well-formed JSON but not acceptable (e.g. before hello). Counts
   * towards the invalid-message kick threshold.
   */
  reject(code: LobbyErrorCode): void {
    this.sendError(code);
    if (this.invalid.hit(performance.now())) this.kick('invalid messages');
  }

  /** Close gracefully after everything already queued has been sent. */
  close(code: number, reason: string): void {
    if (!this.isOpen) return;
    this.closing = true;
    this.inQ?.dispose();
    if (this.outQ) this.outQ.push({ close: code, reason });
    else this.writeNow({ close: code, reason });
  }

  kick(why: string): void {
    if (!this.isOpen) return;
    this.opts.log.warn('kicking client', { client: this.id, ip: this.ip, why });
    this.sendError('net.kicked');
    this.close(CLOSE_CODES.kicked, 'net.kicked');
  }

  /** Hard close without handshake. */
  terminate(): void {
    this.closing = true;
    this.ws.terminate();
    this.handleClosed();
  }

  /**
   * Heartbeat step: terminate dead peers, otherwise send a protocol ping.
   * Returns false when the connection was terminated.
   */
  heartbeat(now: number): boolean {
    if (this.closed) return false;
    if (now - this.lastPong > this.opts.limits.heartbeatTimeoutMs) {
      this.opts.log.info('heartbeat timeout', { client: this.id });
      this.terminate();
      return false;
    }
    try {
      this.pingSentAt = now;
      this.ws.ping();
    } catch {
      this.terminate();
      return false;
    }
    return true;
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (!this.isOpen) return;
    const now = performance.now();
    if (!this.msgBucket.take(now)) {
      this.rateLimited();
      if (this.abuse.hit(now)) this.kick('message flood');
      return;
    }
    if (isBinary) {
      this.reject('net.badMessage');
      return;
    }
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
    const res = decodeClientMessage(text);
    if (!res.ok) {
      if (res.fatal) {
        this.sendError(res.code);
        this.close(CLOSE_CODES.versionMismatch, res.code);
      } else {
        this.reject(res.code);
      }
      return;
    }
    if (this.inQ) this.inQ.push(res.msg);
    else this.dispatch(res.msg);
  }

  private dispatch(msg: ClientMessage): void {
    if (!this.isOpen) return;
    try {
      this.opts.onMessage(this, msg);
    } catch (err) {
      this.opts.log.error('message handler failed', { client: this.id, t: msg.t, err });
    }
  }

  private rateLimited(): void {
    const now = performance.now();
    // Tell the client at most once per second so a flood is not amplified.
    if (now - this.lastRateError >= 1000) {
      this.lastRateError = now;
      this.sendError('net.rateLimited');
    }
  }

  private writeNow(o: Outbound): void {
    if (this.closed) return;
    const ws = this.ws;
    if (ws.readyState !== ws.OPEN) return;
    if (typeof o === 'string') {
      if (ws.bufferedAmount > this.opts.limits.maxBufferedBytes) {
        this.opts.log.warn('slow consumer, dropping connection', { client: this.id, buffered: ws.bufferedAmount });
        this.closing = true;
        ws.terminate();
        return;
      }
      ws.send(o);
    } else {
      ws.close(o.close, o.reason);
    }
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.inQ?.dispose();
    this.outQ?.dispose();
    try {
      this.opts.onClose(this);
    } catch (err) {
      this.opts.log.error('close handler failed', { client: this.id, err });
    }
  }
}
