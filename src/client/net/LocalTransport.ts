// Single-player / training transport: the authoritative MatchRunner (+ bots) runs in a module Web
// Worker (localWorker.ts) and talks to the main thread with the same protocol as the network
// server, so offline play exercises the full prediction / interpolation path without ever
// blocking rendering.

import type { ClientMessage } from '../../shared/protocol';
import type { MatchConfig } from '../../shared/types';
import { BaseTransport, isServerMessage } from './transport';

export class LocalTransport extends BaseTransport {
  readonly kind = 'local' as const;
  private readonly worker: Worker;

  constructor() {
    super();
    // This exact `new Worker(new URL(...), { type: 'module' })` form lets Vite bundle the worker.
    this.worker = new Worker(new URL('./localWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent) => {
      if (isServerMessage(ev.data)) this.emitMessage(ev.data);
    };
    // A worker 'error' only reaches us for fatal problems (module load failure, failing to start
    // the match): in-match errors are handled inside the worker. Either way the session is over.
    this.worker.onerror = (ev: ErrorEvent) => {
      console.error('[net] local match worker failed', ev.message || ev);
      this.close();
    };
    this.worker.onmessageerror = () => {
      console.error('[net] local match worker sent an undecodable message');
      this.close();
    };
  }

  /** Start an offline match with these settings (the worker replies with matchInit + snapshots). */
  start(config: MatchConfig, name: string): void {
    this.send({ t: 'startLocal', config, name });
  }

  send(msg: ClientMessage): void {
    if (this.closed) return;
    this.worker.postMessage(msg);
  }

  close(): void {
    if (this.closed) return;
    this.worker.terminate();
    this.emitClose();
  }
}
