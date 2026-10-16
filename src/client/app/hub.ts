// Message hub over a Transport. The app controller listens to every message (lobby flow), while
// the per-match ClientGame gets a facade transport that replays the game messages received since
// `matchInit` so nothing is lost while the world is being generated and the scene is built.

import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import type { Transport } from '../net';

const GAME_MESSAGES: ReadonlySet<ServerMessage['t']> = new Set(['snap', 'pong', 'matchOver']);
const MAX_BUFFER = 400;

export class MessageHub {
  private listeners = new Set<(msg: ServerMessage) => void>();
  private closeListeners = new Set<() => void>();
  private buffer: ServerMessage[] = [];
  private buffering = false;
  private unsub: Array<() => void> = [];
  closed = false;

  constructor(readonly transport: Transport) {
    this.unsub.push(transport.onMessage((msg) => this.dispatch(msg)));
    transport.onClose(() => {
      this.closed = true;
      for (const cb of [...this.closeListeners]) cb();
    });
  }

  private dispatch(msg: ServerMessage): void {
    if (msg.t === 'matchInit') {
      // Start buffering game traffic for the ClientGame that is about to be created.
      this.buffer.length = 0;
      this.buffering = true;
    } else if (this.buffering && GAME_MESSAGES.has(msg.t)) {
      if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
      this.buffer.push(msg);
    }
    for (const cb of [...this.listeners]) cb(msg);
  }

  on(cb: (msg: ServerMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  send(msg: ClientMessage): void {
    if (!this.closed) this.transport.send(msg);
  }

  /** Wait for the next message matching `pred` (rejects on timeout / close). */
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { off(); offClose(); reject(new Error('timeout')); }, timeoutMs);
      const off = this.on((m) => {
        if (pred(m)) { clearTimeout(timer); off(); offClose(); resolve(m); }
      });
      const offClose = this.onClose(() => { clearTimeout(timer); off(); offClose(); reject(new Error('closed')); });
    });
  }

  /**
   * Transport facade for a ClientGame: forwards sends, and on subscription first replays buffered
   * game messages (received after matchInit) before delivering live ones.
   */
  gameTransport(): Transport {
    const hub = this;
    const subs: Array<() => void> = [];
    return {
      kind: this.transport.kind,
      send: (msg: ClientMessage) => hub.send(msg),
      onMessage(cb: (msg: ServerMessage) => void) {
        const replay = hub.buffer.splice(0);
        hub.buffering = false;
        for (const m of replay) cb(m);
        const off = hub.on((m) => { if (GAME_MESSAGES.has(m.t)) cb(m); });
        subs.push(off);
        return off;
      },
      onClose(cb: () => void) {
        const off = hub.onClose(cb);
        subs.push(off);
        return off;
      },
      close() {
        // The game never closes the shared connection; it only detaches its listeners.
        for (const s of subs.splice(0)) s();
      },
    } as Transport;
  }

  dispose(): void {
    for (const u of this.unsub.splice(0)) u();
    this.listeners.clear();
    this.closeListeners.clear();
    this.buffer.length = 0;
  }
}
