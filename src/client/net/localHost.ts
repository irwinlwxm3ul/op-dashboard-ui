// Offline match host: one MatchRunner with a single human client (the local player) plus bots,
// driven by a timing loop. Pure (no Worker APIs) so the single-player path can be tested in Node;
// localWorker.ts wires it to postMessage.

import { MAX_MESSAGE_BYTES } from '../../shared/constants';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { createBotDriver } from '../../shared/bots';
import { MatchRunner } from '../../shared/sim';
import type { MatchConfig, MatchResults } from '../../shared/types';
import { validateClientMessage } from '../../shared/validate';

export const LOCAL_CLIENT_ID = 'local';
/** Runner update cadence; the runner's fixed-step accumulator turns this into 30 Hz ticks. */
export const LOCAL_LOOP_INTERVAL_MS = 4;
/** Keep ticking this long after the match ended so the final snapshots / banners flow. */
const POST_MATCH_MS = 10_000;

export interface LocalHostOptions {
  /** Deliver a server message to the client. */
  post(msg: ServerMessage): void;
  /** Monotonic clock (ms). */
  now?: () => number;
  /** Start the periodic loop automatically (false in tests that call tick() themselves). */
  autoLoop?: boolean;
}

export class LocalMatchHost {
  private runner: MatchRunner | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private endedAt = -1;
  private lastErrorLog = -Infinity;
  private readonly post: (msg: ServerMessage) => void;
  private readonly now: () => number;
  private readonly autoLoop: boolean;

  constructor(opts: LocalHostOptions) {
    this.post = opts.post;
    this.now = opts.now ?? (() => performance.now());
    this.autoLoop = opts.autoLoop ?? true;
  }

  get running(): boolean {
    return this.runner !== null;
  }

  get matchRunner(): MatchRunner | null {
    return this.runner;
  }

  /** Handle a raw message from the client (validated exactly like the network server does). */
  receive(data: unknown): void {
    if (typeof data === 'string' && data.length > MAX_MESSAGE_BYTES) return;
    const msg = validateClientMessage(data);
    if (msg) this.handle(msg);
  }

  /** Advance the match to the current time (called by the loop). */
  tick(): void {
    const r = this.runner;
    if (!r) return;
    const now = this.now();
    try {
      r.update(now);
    } catch (err) {
      // A sim bug must not silently freeze the match; log (rate limited) and keep going.
      if (now - this.lastErrorLog > 1000) {
        this.lastErrorLog = now;
        console.error('[local] match update failed', err);
      }
    }
    if (this.endedAt < 0 && r.isOver()) this.endedAt = now;
    if (this.endedAt >= 0 && now - this.endedAt > POST_MATCH_MS) this.stop();
  }

  stop(): void {
    if (this.loop !== null) clearInterval(this.loop);
    this.loop = null;
    this.runner = null;
    this.endedAt = -1;
  }

  private start(config: MatchConfig, name: string): void {
    this.stop();
    const r = new MatchRunner({
      config,
      clients: [{ id: LOCAL_CLIENT_ID, name, team: null, send: this.post }],
      botDriverFactory: createBotDriver,
      onEnd: (results: MatchResults) => this.post({ t: 'matchOver', results }),
    });
    this.runner = r;
    r.start(this.now());
    if (this.autoLoop) this.loop = setInterval(() => this.tick(), LOCAL_LOOP_INTERVAL_MS);
  }

  private handle(msg: ClientMessage): void {
    switch (msg.t) {
      case 'startLocal':
        this.start(msg.config, msg.name);
        return;
      case 'input':
      case 'ping':
        this.runner?.handleMessage(LOCAL_CLIENT_ID, msg);
        return;
      case 'leaveMatch':
        this.runner?.handleMessage(LOCAL_CLIENT_ID, msg);
        this.stop();
        this.post({ t: 'backToLobby' });
        return;
      default:
        // Lobby traffic has no meaning offline.
        return;
    }
  }
}
