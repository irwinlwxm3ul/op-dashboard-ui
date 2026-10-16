// The server's view of a match runner. The real implementation is MatchRunner from src/shared/sim
// (driven by bots from src/shared/bots); tests inject a fake through startServer({ runnerFactory }).

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
}

export interface RunnerStats {
  tickMsAvg: number;
  tickMsMax: number;
  players: number;
  bots: number;
}

/** Subset of the MatchRunner contract (ARCHITECTURE.md Stage B) the server relies on. */
export interface MatchRunnerLike {
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
 * Build the production runner factory: the real MatchRunner with the bot driver. Loaded lazily so
 * that tests using a fake runner never import the simulation.
 */
export async function loadDefaultRunnerFactory(): Promise<RunnerFactory> {
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
