// WebSocket transport to the Node game server (src/server). Messages are JSON text frames.

import type { ClientMessage } from '../../shared/protocol';
import { BaseTransport, isServerMessage } from './transport';

/** Connection attempts fail after this long without an open socket. */
export const WS_CONNECT_TIMEOUT_MS = 8000;

/** `ws(s)://<current host>/ws` — the Vite dev server proxies /ws to the game server. */
export function defaultWsUrl(): string {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc) throw new Error('WsTransport: no location available; pass an explicit url');
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}/ws`;
}

export class WsTransport extends BaseTransport {
  readonly kind = 'ws' as const;
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        console.warn('[net] dropped malformed server frame');
        return;
      }
      if (isServerMessage(parsed)) this.emitMessage(parsed);
    };
    ws.onclose = () => this.emitClose();
    ws.onerror = () => {
      // An error on an open socket is always followed by close; nothing else to do here.
    };
  }

  /**
   * Open a connection. Resolves once the socket is open; rejects on error, early close or after
   * `timeoutMs` (default 8 s).
   */
  static connect(url?: string, timeoutMs = WS_CONNECT_TIMEOUT_MS): Promise<WsTransport> {
    return new Promise<WsTransport>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url ?? defaultWsUrl());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let settled = false;
      const fail = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onopen = ws.onerror = ws.onclose = null;
        try {
          ws.close();
        } catch {
          // already closing
        }
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new WsTransport(ws));
      };
      ws.onerror = () => fail('error');
      ws.onclose = () => fail('closed');
    });
  }

  send(msg: ClientMessage): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Bytes queued in the socket but not yet sent (diagnostics). */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.ws.close(1000);
    } catch {
      // ignore: socket already gone
    }
    this.emitClose();
  }
}
