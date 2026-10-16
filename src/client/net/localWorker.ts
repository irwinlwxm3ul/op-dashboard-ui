/// <reference lib="webworker" />
// Module Web Worker hosting an offline match (LocalMatchHost: MatchRunner + bots). Speaks the
// network protocol with the main thread via postMessage, so single-player exercises exactly the
// same netcode path as online play and never blocks rendering.

import type { ServerMessage } from '../../shared/protocol';
import { LocalMatchHost } from './localHost';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const host = new LocalMatchHost({
  post: (msg: ServerMessage) => scope.postMessage(msg),
});

scope.onmessage = (ev: MessageEvent) => {
  try {
    // In-match message errors are caught and logged inside the host (the worker stays alive).
    host.receive(ev.data);
  } catch (err) {
    // Only a failure to start the match gets here. It is fatal for this offline session: rethrow
    // so the main thread receives the worker 'error' event and the transport reports the close.
    console.error('[local] failed to start the offline match', err);
    host.stop();
    throw err;
  }
};
