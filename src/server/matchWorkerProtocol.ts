// Messages between the main server thread and a match worker (src/server/matchWorker.ts).
// Everything is structured-cloned by postMessage; ClientMessages are validated on the main thread
// before they are forwarded.

import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { MatchConfig, MatchResults, TeamId } from '../shared/types';
import type { RunnerStats } from './runner';

export interface WorkerClientInit {
  id: string;
  name: string;
  team: TeamId | null;
}

/** Main thread -> worker. */
export type ToWorker =
  /** Build the MatchRunner (world generation happens here, off the main thread). */
  | { k: 'init'; config: MatchConfig; clients: WorkerClientInit[] }
  /** Start the match (matchInit to every client) and the worker's own fixed-step loop. */
  | { k: 'start' }
  | { k: 'msg'; id: string; msg: ClientMessage }
  | { k: 'remove'; id: string }
  | { k: 'stop' };

/** Worker -> main thread. */
export type FromWorker =
  /** Modules loaded; the worker accepts `init`. */
  | { k: 'ready' }
  /** Runner constructed (world generated) in `genMs`. */
  | { k: 'inited'; genMs: number }
  /** Outgoing ServerMessages batched per loop iteration: msgs[i] goes to client ids[i]. */
  | { k: 'out'; ids: string[]; msgs: ServerMessage[] }
  | { k: 'end'; results: MatchResults }
  | { k: 'stats'; stats: RunnerStats; over: boolean }
  /** Runner exception. Fatal errors end the match. */
  | { k: 'error'; message: string; fatal: boolean };
