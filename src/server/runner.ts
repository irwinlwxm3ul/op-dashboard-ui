// The server's view of a match runner. Production runs MatchRunner from src/shared/sim (driven by
// bots from src/shared/bots) inside a worker thread per match (workerRunner.ts); it can also run
// in-process; tests inject a fake through startServer({ runnerFactory }).

import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { MatchConfig, MatchResults, TeamId } from '../shared/types';

export interface RunnerClient {
  id: string;
  name: string;
  team: TeamId | null;
  send(msg: ServerMessage): void;
}

export interface RunnerOptions {
  config: MatchConfig;
  clients: RunnerClient[];
  onEnd: (results: MatchResults) => void;
  /**
   * Asynchronous fatal failure (e.g. a match worker crashed). The server aborts the match and
   * returns the lobby to waiting. In-process runners report failures by throwing instead.
   */
  onError?: (err: Error) => void;
}

export interface RunnerStats {
  tickMsAvg: number;
  tickMsMax: number;
  players: number;
  bots: number;
}

/** Subset of the MatchRunner contract (ARCHITECTURE.md Stage B) the server relies on. */
export interface MatchRunnerLike {
  /** True when the runner ticks itself (worker thread); update() is then a no-op. */
  readonly selfTicking?: boolean;
  start(nowMs: number): void;
  update(nowMs: number): void;
  handleMessage(clientId: string, msg: ClientMessage): void;
  removeClient(clientId: string): void;
  isOver(): boolean;
  stats(): RunnerStats;
  /** Optional cleanup hook; called once when the server discards the runner. */
  dispose?(): void;
}

export type RunnerFactory = (opts: RunnerOptions) => MatchRunnerLike;

/**
 * In-process runner factory: the real MatchRunner with the bot driver on the main thread (ticked
 * by the shared MatchLoop). Used when match workers are disabled (MATCH_WORKERS=0). Loaded lazily
 * so that tests using a fake runner never import the simulation.
 */
export async function loadInProcessRunnerFactory(): Promise<RunnerFactory> {
  const [{ MatchRunner }, { createBotDriver }] = await Promise.all([
    import('../shared/sim/index'),
    import('../shared/bots/index'),
  ]);
  return (opts) =>
    new MatchRunner({
      config: opts.config,
      clients: opts.clients,
      botDriverFactory: createBotDriver,
      onEnd: opts.onEnd,
    });
}
