// HTTP + WebSocket game server: wires connections to the lobby manager, serves /healthz and (in
// production) the built client from dist/.

import { existsSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_SERVER_PORT, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../shared/constants';
import type { ClientMessage } from '../shared/protocol';
import { CLOSE_CODES, ClientConnection } from './Connection';
import { DEFAULT_LIMITS, type ServerLimits } from './limits';
import { createLogger, type Logger } from './log';
import { LobbyManager } from './LobbyManager';
import { loadDefaultRunnerFactory, type RunnerFactory } from './runner';
import { serveStatic } from './static';

export interface StartServerOptions {
  /** TCP port; 0 picks a random free port. Default DEFAULT_SERVER_PORT. */
  port?: number;
  /** Bind address (default: all interfaces). */
  host?: string;
  /** Artificial one-way latency added to both directions of every connection (ms). */
  lagMs?: number;
  /** Extra random one-way latency 0..jitterMs (order preserving). */
  jitterMs?: number;
  /** Console logging (default true). */
  log?: boolean;
  /** Match runner factory (default: real MatchRunner + bot driver). Tests inject fakes. */
  runnerFactory?: RunnerFactory;
  /**
   * Directory with the built client. Default: dist/ when NODE_ENV=production, otherwise static
   * serving is off (Vite serves the client in development). null disables it explicitly.
   */
  staticDir?: string | null;
  /** How long a finished match keeps streaming before everyone returns to the lobby (ms, default 8000). */
  matchLingerMs?: number;
  /** Shared match loop interval (ms, default 4). */
  loopIntervalMs?: number;
  /** Per-match tick stats logging interval (ms, default 30000). */
  statsIntervalMs?: number;
  limits?: Partial<ServerLimits>;
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

const DEFAULT_DIST_DIR = fileURLToPath(new URL('../../dist/', import.meta.url));

function resolveStaticDir(opt: string | null | undefined, log: Logger): string | null {
  if (opt === null) return null;
  const dir = opt ?? (process.env.NODE_ENV === 'production' ? DEFAULT_DIST_DIR : null);
  if (dir === null) return null;
  if (!existsSync(dir)) {
    log.warn('static directory not found, client files will not be served', { dir });
    return null;
  }
  return dir;
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const log = createLogger(opts.log ?? true);
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const lagMs = Math.max(0, Math.min(5000, opts.lagMs ?? 0));
  const jitterMs = Math.max(0, Math.min(5000, opts.jitterMs ?? 0));
  const runnerFactory = opts.runnerFactory ?? (await loadDefaultRunnerFactory());
  const staticDir = resolveStaticDir(opts.staticDir, log);
  const startedAt = performance.now();

  const conns = new Set<ClientConnection>();
  const manager = new LobbyManager({
    limits,
    log,
    runnerFactory,
    matchLingerMs: opts.matchLingerMs ?? 8000,
    loopIntervalMs: opts.loopIntervalMs ?? 4,
    statsIntervalMs: opts.statsIntervalMs ?? 30_000,
    *browsingClients() {
      for (const c of conns) if (c.isOpen && c.name !== null && c.lobbyId === null) yield c;
    },
  });

  const helloCount = (): number => {
    let n = 0;
    for (const c of conns) if (c.name !== null) n++;
    return n;
  };

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  const onMessage = (conn: ClientConnection, msg: ClientMessage): void => {
    if (msg.t === 'hello') {
      const renamed = conn.name !== null && conn.name !== msg.name;
      conn.name = msg.name;
      conn.send({ t: 'welcome', clientId: conn.id, version: PROTOCOL_VERSION });
      const lobby = manager.lobbyOf(conn);
      if (lobby) {
        if (renamed) {
          lobby.broadcastState();
          manager.markListDirty();
        }
      } else {
        manager.sendListTo(conn);
      }
      return;
    }
    if (conn.name === null) {
      // Must say hello (with a matching protocol version) first.
      conn.reject('net.badMessage');
      return;
    }
    switch (msg.t) {
      case 'listLobbies':
        manager.sendListTo(conn);
        break;
      case 'createLobby':
        if (conn.allowLobbyOp()) manager.create(conn, msg.settings);
        break;
      case 'joinLobby':
        if (conn.allowLobbyOp()) manager.join(conn, msg.id);
        break;
      case 'leaveLobby':
        if (conn.allowLobbyOp()) manager.leave(conn, false);
        break;
      case 'lobbySettings':
        if (conn.allowLobbyOp()) manager.updateSettings(conn, msg.settings);
        break;
      case 'setTeam':
        if (conn.allowLobbyOp()) manager.setTeam(conn, msg.team);
        break;
      case 'ready':
        if (conn.allowLobbyOp()) manager.setReady(conn, msg.ready);
        break;
      case 'startMatch':
        if (conn.allowLobbyOp()) manager.startMatch(conn);
        break;
      case 'chat':
        if (conn.allowChat()) manager.chat(conn, msg.text);
        break;
      case 'input':
      case 'ping':
        manager.routeMatchMessage(conn, msg);
        break;
      case 'leaveMatch':
        manager.leaveMatch(conn);
        break;
      case 'startLocal':
        // Worker-only message (already rejected while decoding).
        conn.reject('net.badMessage');
        break;
    }
  };

  const onClose = (conn: ClientConnection): void => {
    conns.delete(conn);
    if (conn.lobbyId) manager.leave(conn, true);
    log.info('client disconnected', { client: conn.id, clients: conns.size });
  };

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];
    if (pathOnly === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        lobbies: manager.lobbyCount,
        players: helloCount(),
        matches: manager.matchCount,
        uptime: Math.round((performance.now() - startedAt) / 1000),
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (staticDir) {
      serveStatic(req, res, staticDir).catch((err: unknown) => {
        log.error('static file error', { url, err });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };

  const httpServer = http.createServer(handleHttp);
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  wss.on('error', (err) => log.error('websocket server error', { err }));

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (conns.size >= limits.maxConnections) {
      ws.close(CLOSE_CODES.serverFull, 'server full');
      return;
    }
    const conn = new ClientConnection(ws, ip, { lagMs, jitterMs, limits, log, onMessage, onClose });
    conns.add(conn);
    log.info('client connected', { client: conn.id, ip, clients: conns.size });
  });

  const heartbeat = setInterval(() => {
    const now = performance.now();
    for (const c of conns) c.heartbeat(now);
    manager.refreshPings();
  }, limits.heartbeatMs);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      clearInterval(heartbeat);
      manager.dispose();
      reject(err);
    };
    httpServer.once('error', onError);
    httpServer.listen(opts.port ?? DEFAULT_SERVER_PORT, opts.host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  httpServer.on('error', (err) => log.error('http server error', { err }));

  const port = (httpServer.address() as AddressInfo).port;
  log.info('server listening', {
    port,
    ws: '/ws',
    lagMs,
    jitterMs,
    static: staticDir ?? 'off',
    protocol: PROTOCOL_VERSION,
  });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearInterval(heartbeat);
      manager.dispose();
      // Stop accepting, then close every client with "going away" and give the close handshake a
      // moment before cutting the remaining sockets.
      const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      for (const ws of wss.clients) ws.close(CLOSE_CODES.shutdown, 'server shutdown');
      const deadline = performance.now() + 1000;
      while (wss.clients.size > 0 && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      httpServer.closeAllConnections();
      await httpClosed;
      log.info('server stopped');
    })();
    return closing;
  };

  return { port, close };
}
