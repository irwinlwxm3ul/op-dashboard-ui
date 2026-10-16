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
    host.receive(ev.data);
  } catch (err) {
    // Failing to start a match is fatal for this worker: the main thread sees the error event.
    console.error('[local] message handling failed', err);
    host.stop();
    throw err;
  }
};
