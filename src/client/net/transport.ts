// Transport abstraction shared by the WebSocket client and the single-player Web Worker. Both
// speak exactly the same protocol (src/shared/protocol.ts), so the ClientGame netcode path is
// identical online and offline.

import type { ClientMessage, ServerMessage } from '../../shared/protocol';

export type TransportKind = 'local' | 'ws';

export interface Transport {
  readonly kind: TransportKind;
  /** Send a message to the server / local worker. Silently dropped once closed. */
  send(msg: ClientMessage): void;
  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(cb: (msg: ServerMessage) => void): () => void;
  /** Called once when the connection closes (either side). Returns an unsubscribe function. */
  onClose(cb: () => void): () => void;
  close(): void;
}

/** Listener bookkeeping shared by the concrete transports. */
export abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;
  private readonly messageListeners = new Set<(msg: ServerMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closedFlag = false;

  get closed(): boolean {
    return this.closedFlag;
  }

  abstract send(msg: ClientMessage): void;
  abstract close(): void;

  onMessage(cb: (msg: ServerMessage) => void): () => void {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  onClose(cb: () => void): () => void {
    if (this.closedFlag) {
      // Late subscribers still learn that the transport is gone.
      queueMicrotask(cb);
      return () => undefined;
    }
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  /** Deliver one inbound message to every listener; a throwing listener never blocks the others. */
  protected emitMessage(msg: ServerMessage): void {
    if (this.closedFlag) return;
    for (const cb of this.messageListeners) {
      try {
        cb(msg);
      } catch (err) {
        console.error('[net] message listener failed', err);
      }
    }
  }

  /** Mark closed and notify close listeners exactly once. */
  protected emitClose(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const cb of this.closeListeners) {
      try {
        cb();
      } catch (err) {
        console.error('[net] close listener failed', err);
      }
    }
    this.closeListeners.clear();
    this.messageListeners.clear();
  }
}

/** Shape check for a decoded server message (the server is trusted, this only guards against garbage). */
export function isServerMessage(x: unknown): x is ServerMessage {
  return typeof x === 'object' && x !== null && typeof (x as { t?: unknown }).t === 'string';
}
