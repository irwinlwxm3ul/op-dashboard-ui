// One shared high-resolution loop ticking every running match. MatchRunner.update(now) is a
// fixed-step accumulator, so polling it every few milliseconds yields 30 Hz ticks with at most a
// few ms of jitter. The loop only runs while at least one match exists.

import type { MatchSession } from './Lobby';
import type { Logger } from './log';

export interface MatchLoopHost {
  /** The runner reports isOver() but never called onEnd. */
  onRunnerOver(session: MatchSession): void;
  /** The post-match linger period elapsed. */
  onLingerDone(session: MatchSession): void;
  /** The runner threw too often; the match must be aborted. */
  onRunnerFailed(session: MatchSession): void;
}

export interface MatchLoopOptions {
  intervalMs: number;
  /** How long a finished match keeps running so final snapshots flow (ms). */
  lingerMs: number;
  /** Interval of per-match tick stats logging (ms). */
  statsMs: number;
  /** Runner exceptions tolerated before the match is aborted. */
  maxErrors: number;
  log: Logger;
}

export class MatchLoop {
  private readonly sessions = new Set<MatchSession>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: MatchLoopHost,
    private readonly opts: MatchLoopOptions,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  add(session: MatchSession): void {
    this.sessions.add(session);
    if (this.timer === null) {
      this.timer = setInterval(this.tick, this.opts.intervalMs);
      this.statsTimer = setInterval(this.logStats, this.opts.statsMs);
    }
  }

  remove(session: MatchSession): void {
    this.sessions.delete(session);
    if (this.sessions.size === 0) this.stop();
  }

  dispose(): void {
    this.sessions.clear();
    this.stop();
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.timer = null;
    this.statsTimer = null;
  }

  /** Record a runner exception; returns true when the match should be aborted. */
  recordError(session: MatchSession, where: string, err: unknown): boolean {
    session.errors++;
    if (session.errors <= 3 || session.errors === this.opts.maxErrors) {
      this.opts.log.error(`match runner ${where} failed`, { lobby: session.lobby.id, errors: session.errors, err });
    }
    return session.errors >= this.opts.maxErrors;
  }

  private readonly tick = (): void => {
    const now = performance.now();
    // Deleting from a Set while iterating it is safe; host callbacks may remove sessions.
    for (const s of this.sessions) {
      const runner = s.runner;
      if (!runner || s.disposed) {
        this.sessions.delete(s);
        continue;
      }
      try {
        runner.update(now);
      } catch (err) {
        if (this.recordError(s, 'update', err)) {
          this.host.onRunnerFailed(s);
          continue;
        }
      }
      if (s.disposed) continue;
      if (s.endedAt < 0) {
        let over = false;
        try {
          over = runner.isOver();
        } catch {
          over = false;
        }
        // onEnd normally fires inside update(); this covers a runner that never calls it.
        if (over && s.endedAt < 0) this.host.onRunnerOver(s);
      } else if (now - s.endedAt >= this.opts.lingerMs) {
        this.host.onLingerDone(s);
      }
    }
    if (this.sessions.size === 0) this.stop();
  };

  private readonly logStats = (): void => {
    for (const s of this.sessions) {
      if (!s.runner || s.disposed) continue;
      try {
        const st = s.runner.stats();
        this.opts.log.info('match stats', {
          lobby: s.lobby.id,
          uptime: `${Math.round((performance.now() - s.startedAt) / 1000)}s`,
          tickMsAvg: Math.round(st.tickMsAvg * 100) / 100,
          tickMsMax: Math.round(st.tickMsMax * 100) / 100,
          players: st.players,
          bots: st.bots,
        });
      } catch (err) {
        this.opts.log.warn('match stats failed', { lobby: s.lobby.id, err });
      }
    }
  };
}
