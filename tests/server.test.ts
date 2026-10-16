// Game server integration tests: real HTTP/WebSocket server on a random port, real ws clients,
// and a fake match runner (the simulation is tested elsewhere).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../src/shared/constants';
import type { ClientMessage, LobbySettings, LobbyState, ServerMessage } from '../src/shared/protocol';
import type { MatchResults, PlayerInput } from '../src/shared/types';
import { startServer, type MatchRunnerLike, type RunnerOptions, type ServerHandle } from '../src/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

class TestClient {
  readonly msgs: ServerMessage[] = [];
  private readonly consumed = new Set<number>();
  private waiters: (() => void)[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  clientId = '';

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.msgs.push(JSON.parse(String(data)) as ServerMessage);
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      this.wake();
    });
    ws.on('error', () => undefined);
  }

  static async connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const c = new TestClient(ws);
    clients.push(c);
    return c;
  }

  static async hello(port: number, name: string): Promise<TestClient> {
    const c = await TestClient.connect(port);
    c.send({ t: 'hello', name, version: PROTOCOL_VERSION });
    c.clientId = (await c.next('welcome')).clientId;
    return c;
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private find<T extends ServerMessage['t']>(t: T, pred: (m: Msg<T>) => boolean): number {
    for (let i = 0; i < this.msgs.length; i++) {
      if (this.consumed.has(i)) continue;
      const m = this.msgs[i];
      if (m.t === t && pred(m as Msg<T>)) return i;
    }
    return -1;
  }

  /** Wait for (and consume) the first unconsumed message of type `t` matching `pred`. */
  async next<T extends ServerMessage['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true, timeout = 3000): Promise<Msg<T>> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const i = this.find(t, pred);
      if (i >= 0) {
        this.consumed.add(i);
        return this.msgs[i] as Msg<T>;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for '${t}' (got: ${this.msgs.map((m) => m.t).join(',')})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async error(code: string, timeout = 3000): Promise<void> {
    await this.next('error', (m) => m.code === code, timeout);
  }

  /** Assert that no unconsumed message of type `t` (matching pred) arrives within `ms`. */
  async none<T extends ServerMessage['t']>(t: T, ms: number, pred: (m: Msg<T>) => boolean = () => true): Promise<void> {
    await sleep(ms);
    expect(this.find(t, pred)).toBe(-1);
  }

  async closed(timeout = 3000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeout;
    while (!this.closeInfo) {
      if (Date.now() > deadline) throw new Error('timeout waiting for close');
      await sleep(10);
    }
    return this.closeInfo;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const settings = (over: Partial<LobbySettings> = {}): LobbySettings => ({
  name: 'Test lobby',
  maxPlayers: 8,
  teamSize: 1,
  botFill: true,
  botDifficulty: 'normal',
  zoneSpeed: 1,
  ...over,
});

class FakeRunner implements MatchRunnerLike {
  readonly messages: { clientId: string; msg: ClientMessage }[] = [];
  readonly removed: string[] = [];
  started = false;
  updates = 0;
  over = false;
  disposed = false;

  constructor(readonly opts: RunnerOptions) {}

  start(nowMs: number): void {
    this.started = true;
    for (const c of this.opts.clients) {
      c.send({
        t: 'matchInit',
        init: {
          config: this.opts.config,
          you: 1,
          team: c.team ?? 0,
          roster: [],
          loot: [],
          time: nowMs,
          tickRate: 30,
          snapshotRate: 20,
        },
      });
    }
  }
  update(): void {
    this.updates++;
  }
  handleMessage(clientId: string, msg: ClientMessage): void {
    this.messages.push({ clientId, msg });
    if (msg.t === 'ping') this.opts.clients.find((c) => c.id === clientId)?.send({ t: 'pong', c: msg.c, s: 42 });
  }
  removeClient(clientId: string): void {
    this.removed.push(clientId);
  }
  isOver(): boolean {
    return this.over;
  }
  stats() {
    return { tickMsAvg: 0, tickMsMax: 0, players: this.opts.clients.length, bots: 0 };
  }
  dispose(): void {
    this.disposed = true;
  }
  end(results: MatchResults): void {
    this.over = true;
    this.opts.onEnd(results);
  }
}

const RESULTS: MatchResults = { winnerTeam: 0, duration: 123, players: [] };

const clients: TestClient[] = [];
const runners: FakeRunner[] = [];
let server: ServerHandle;
let port = 0;

async function healthz(p = port): Promise<{ ok: boolean; lobbies: number; players: number; uptime: number }> {
  const res = await fetch(`http://127.0.0.1:${p}/healthz`);
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; lobbies: number; players: number; uptime: number };
}

/** Create a lobby with A as host and the given clients joined (ready = false). */
async function lobbyWith(host: TestClient, others: TestClient[], over: Partial<LobbySettings> = {}): Promise<LobbyState> {
  host.send({ t: 'createLobby', settings: settings(over) });
  let state = (await host.next('lobbyState')).lobby;
  for (const [i, o] of others.entries()) {
    o.send({ t: 'joinLobby', id: state.id });
    await o.next('lobbyState', (m) => m.lobby.id === state.id);
    state = (await host.next('lobbyState', (m) => m.lobby.members.length === i + 2)).lobby;
  }
  return state;
}

async function startedMatch(host: TestClient, others: TestClient[], over: Partial<LobbySettings> = {}): Promise<FakeRunner> {
  await lobbyWith(host, others, over);
  for (const o of others) {
    o.send({ t: 'ready', ready: true });
    await host.next('lobbyState', (m) => m.lobby.members.some((x) => x.clientId === o.clientId && x.ready));
  }
  const before = runners.length;
  host.send({ t: 'startMatch' });
  await host.next('matchInit');
  for (const o of others) await o.next('matchInit');
  expect(runners.length).toBe(before + 1);
  return runners[runners.length - 1];
}

beforeAll(async () => {
  server = await startServer({
    port: 0,
    log: false,
    matchLingerMs: 150,
    runnerFactory: (opts) => {
      const r = new FakeRunner(opts);
      runners.push(r);
      return r;
    },
  });
  port = server.port;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await sleep(30);
});

afterAll(async () => {
  await server?.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connection handshake', () => {
  it('serves /healthz', async () => {
    const h = await healthz();
    expect(h.ok).toBe(true);
    expect(typeof h.lobbies).toBe('number');
    expect(typeof h.players).toBe('number');
    expect(typeof h.uptime).toBe('number');
  });

  it('requires hello first and rejects a protocol version mismatch', async () => {
    const c = await TestClient.connect(port);
    c.send({ t: 'listLobbies' });
    await c.error('net.badMessage');
    c.send({ t: 'hello', name: 'Old', version: PROTOCOL_VERSION + 99 });
    await c.error('net.versionMismatch');
    const info = await c.closed();
    expect(info.code).toBe(4000);
  });

  it('rejects unusable names and welcomes valid ones with a lobby list', async () => {
    const c = await TestClient.connect(port);
    c.send({ t: 'hello', name: ' \u0000​ ', version: PROTOCOL_VERSION });
    await c.error('lobby.nameInvalid');
    c.send({ t: 'hello', name: '  Neo\u0007  ', version: PROTOCOL_VERSION });
    const w = await c.next('welcome');
    expect(w.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.version).toBe(PROTOCOL_VERSION);
    await c.next('lobbyList');
    const h = await healthz();
    expect(h.players).toBeGreaterThanOrEqual(1);
  });
});

describe('lobbies', () => {
  it('create / list / join / full / notFound', async () => {
    const a = await TestClient.hello(port, 'Alpha');
    const b = await TestClient.hello(port, 'Bravo');
    const c = await TestClient.hello(port, 'Charlie');
    a.send({ t: 'createLobby', settings: settings({ name: '  My​  Lobby ', maxPlayers: 2 }) });
    const st = (await a.next('lobbyState')).lobby;
    expect(st.settings.name).toBe('My Lobby');
    expect(st.hostId).toBe(a.clientId);
    expect(st.status).toBe('waiting');
    expect(st.countdown).toBe(-1);
    expect(st.teamCount).toBe(2);
    expect(st.members).toEqual([{ clientId: a.clientId, name: 'Alpha', team: 0, ready: false, isHost: true, ping: expect.any(Number) }]);

    // Browsing clients get a pushed list update; explicit requests are answered too.
    await c.next('lobbyList', (m) => m.lobbies.some((l) => l.id === st.id));
    b.send({ t: 'listLobbies' });
    const list = await b.next('lobbyList', (m) => m.lobbies.some((l) => l.id === st.id));
    expect(list.lobbies[0]).toEqual({ id: st.id, name: 'My Lobby', host: 'Alpha', players: 1, maxPlayers: 2, teamSize: 1, status: 'waiting' });

    b.send({ t: 'joinLobby', id: st.id });
    const sb = (await b.next('lobbyState')).lobby;
    expect(sb.members.map((m) => [m.name, m.team, m.isHost])).toEqual([['Alpha', 0, true], ['Bravo', 1, false]]);
    await a.next('lobbyState', (m) => m.lobby.members.length === 2);

    c.send({ t: 'joinLobby', id: st.id });
    await c.error('lobby.full');
    c.send({ t: 'joinLobby', id: 'nope' });
    await c.error('lobby.notFound');
    await c.next('lobbyList', (m) => m.lobbies.some((l) => l.id === st.id && l.players === 2));
  });

  it('lists newest first and hides lobbies once everyone left', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    const watcher = await TestClient.hello(port, 'W');
    a.send({ t: 'createLobby', settings: settings({ name: 'first' }) });
    const first = (await a.next('lobbyState')).lobby.id;
    b.send({ t: 'createLobby', settings: settings({ name: 'second' }) });
    const second = (await b.next('lobbyState')).lobby.id;
    watcher.send({ t: 'listLobbies' });
    const l = await watcher.next('lobbyList', (m) => m.lobbies.some((x) => x.id === second));
    const ids = l.lobbies.map((x) => x.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));

    const lobbiesBefore = (await healthz()).lobbies;
    a.send({ t: 'leaveLobby' });
    await a.next('lobbyLeft');
    await a.next('lobbyList');
    await watcher.next('lobbyList', (m) => !m.lobbies.some((x) => x.id === first));
    expect((await healthz()).lobbies).toBe(lobbiesBefore - 1);
  });

  it('teams: auto-assignment, teamFull, invalid team, refit on settings change', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    const c = await TestClient.hello(port, 'C');
    const st = await lobbyWith(a, [b, c], { teamSize: 2, maxPlayers: 4 });
    expect(st.teamCount).toBe(2);
    // Teams fill in order: A and B together, C on team 1.
    expect(st.members.map((m) => m.team)).toEqual([0, 0, 1]);

    c.send({ t: 'setTeam', team: 0 });
    await c.error('lobby.teamFull');
    c.send({ t: 'setTeam', team: 2 });
    await c.error('lobby.badSettings');
    b.send({ t: 'setTeam', team: 1 });
    const s2 = (await a.next('lobbyState', (m) => m.lobby.members[1].team === 1)).lobby;
    expect(s2.members.map((m) => m.team)).toEqual([0, 1, 1]);

    // Cannot shrink below the humans in the room (kick-free).
    a.send({ t: 'lobbySettings', settings: settings({ teamSize: 2, maxPlayers: 2 }) });
    await a.error('lobby.badSettings');

    // Solo: everyone needs an own team; members keep their team when possible.
    a.send({ t: 'lobbySettings', settings: settings({ name: 'solo now', teamSize: 1, maxPlayers: 4 }) });
    const s3 = (await b.next('lobbyState', (m) => m.lobby.settings.teamSize === 1)).lobby;
    expect(s3.teamCount).toBe(4);
    expect(s3.settings.name).toBe('solo now');
    expect(s3.members.map((m) => m.team)).toEqual([0, 1, 2]);
  });

  it('host-only settings and start; ready requirements', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    await lobbyWith(a, [b], { botFill: false });
    b.send({ t: 'lobbySettings', settings: settings() });
    await b.error('lobby.notHost');
    b.send({ t: 'startMatch' });
    await b.error('lobby.notHost');
    a.send({ t: 'startMatch' });
    await a.error('lobby.notReady');

    // Alone without bot fill: cannot start.
    b.send({ t: 'leaveLobby' });
    await b.next('lobbyLeft');
    await a.next('lobbyState', (m) => m.lobby.members.length === 1);
    a.send({ t: 'startMatch' });
    await a.error('lobby.notReady');
  });

  it('chat is broadcast within the lobby and sanitised', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    const outsider = await TestClient.hello(port, 'O');
    await lobbyWith(a, [b]);
    b.send({ t: 'chat', text: '  hi\u0007 ‮  there​ ' });
    const ca = await a.next('chat');
    expect(ca).toEqual({ t: 'chat', from: 'B', text: 'hi there' });
    expect(await b.next('chat')).toEqual(ca);
    await outsider.none('chat', 100);
    b.send({ t: 'chat', text: 'x'.repeat(500) });
    expect((await a.next('chat')).text.length).toBe(140);
    outsider.send({ t: 'chat', text: 'hello?' });
    await outsider.error('lobby.notFound');
  });

  it('migrates the host to the oldest member', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    const c = await TestClient.hello(port, 'C');
    await lobbyWith(a, [b, c]);
    a.send({ t: 'leaveLobby' });
    await a.next('lobbyLeft');
    const sc = (await c.next('lobbyState', (m) => m.lobby.members.length === 2)).lobby;
    expect(sc.hostId).toBe(b.clientId);
    expect(sc.members.find((m) => m.isHost)?.name).toBe('B');
    // Disconnect migrates as well.
    b.close();
    const sc2 = (await c.next('lobbyState', (m) => m.lobby.members.length === 1)).lobby;
    expect(sc2.hostId).toBe(c.clientId);
  });

  it('answers ping with pong outside of a match', async () => {
    const a = await TestClient.hello(port, 'A');
    a.send({ t: 'ping', c: 1234.5 });
    const p = await a.next('pong');
    expect(p.c).toBe(1234.5);
    expect(typeof p.s).toBe('number');
  });
});

describe('matches', () => {
  it('start creates the runner with the lobby config and teams, routes input, ends back in the lobby', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    const d = await TestClient.hello(port, 'D');
    const runner = await startedMatch(a, [b], { teamSize: 2, maxPlayers: 6, botFill: true, botDifficulty: 'hard', zoneSpeed: 0.5 });
    const cfg = runner.opts.config;
    expect(cfg).toEqual({
      mode: 'br', seed: expect.any(Number), maxPlayers: 6, teamSize: 2, botFill: true,
      botDifficulty: 'hard', zoneSpeed: 0.5, infiniteAmmo: false,
    });
    expect(Number.isInteger(cfg.seed) && cfg.seed >= 0 && cfg.seed < 2 ** 32).toBe(true);
    expect(runner.opts.clients.map((c) => [c.id, c.name, c.team])).toEqual([[a.clientId, 'A', 0], [b.clientId, 'B', 0]]);
    expect(runner.started).toBe(true);
    // The room learnt it is in game before matchInit.
    const inGame = await a.next('lobbyState', (m) => m.lobby.status === 'in_game');
    expect(inGame.lobby.id).toBeTruthy();
    const lobbyId = inGame.lobby.id;

    // Joining a running lobby is refused; the list shows it in game.
    d.send({ t: 'joinLobby', id: lobbyId });
    await d.error('lobby.inGame');
    d.send({ t: 'listLobbies' });
    const l = await d.next('lobbyList', (m) => m.lobbies.some((x) => x.id === lobbyId));
    expect(l.lobbies.find((x) => x.id === lobbyId)?.status).toBe('in_game');

    // In-match messages reach the runner; lobby actions are refused while in game.
    const input: PlayerInput = { seq: 1, mx: 0, mz: 1, yaw: 0, pitch: 0, buttons: 1, stance: 0, slot: -1, rt: 0 };
    a.send({ t: 'input', inputs: [input] });
    a.send({ t: 'ping', c: 7 });
    expect((await a.next('pong')).s).toBe(42);
    expect(runner.messages.map((m) => [m.clientId, m.msg.t])).toEqual([[a.clientId, 'input'], [a.clientId, 'ping']]);
    expect(runner.messages[0].msg).toEqual({ t: 'input', inputs: [input] });
    b.send({ t: 'ready', ready: false });
    await b.error('lobby.inGame');
    await sleep(30);
    expect(runner.updates).toBeGreaterThan(0);

    runner.end(RESULTS);
    expect((await a.next('matchOver')).results).toEqual(RESULTS);
    expect((await b.next('matchOver')).results).toEqual(RESULTS);
    await a.next('backToLobby');
    await b.next('backToLobby');
    const back = (await a.next('lobbyState', (m) => m.lobby.status === 'waiting')).lobby;
    expect(back.members.every((m) => !m.ready)).toBe(true);
    expect(back.members).toHaveLength(2);
    await b.next('lobbyState', (m) => m.lobby.status === 'waiting');
    expect(runner.disposed).toBe(true);
    // Late inputs after the match are dropped silently (no error).
    a.send({ t: 'input', inputs: [input] });
    await a.none('error', 80);
  });

  it('leaveMatch returns the client to the room while the match continues; abandoning ends it', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    const runner = await startedMatch(a, [b]);
    b.send({ t: 'leaveMatch' });
    await b.next('backToLobby');
    const sb = (await b.next('lobbyState', (m) => m.lobby.status === 'in_game')).lobby;
    expect(sb.members).toHaveLength(2);
    expect(runner.messages.some((m) => m.clientId === b.clientId && m.msg.t === 'leaveMatch')).toBe(true);
    expect(runner.disposed).toBe(false);
    // b no longer receives match traffic; inputs from b are not routed any more.
    b.send({ t: 'input', inputs: [{ seq: 1, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: -1, rt: 0 }] });
    await sleep(50);
    expect(runner.messages.filter((m) => m.clientId === b.clientId && m.msg.t === 'input')).toHaveLength(0);

    // The last human leaving the match view ends it: room back to waiting.
    a.send({ t: 'leaveMatch' });
    await a.next('backToLobby');
    await b.next('lobbyState', (m) => m.lobby.status === 'waiting');
    expect(runner.disposed).toBe(true);
  });

  it('disconnect during a match hands the player to a bot and cleans up the lobby', async () => {
    const a = await TestClient.hello(port, 'A');
    const b = await TestClient.hello(port, 'B');
    const lobbiesBefore = (await healthz()).lobbies;
    const runner = await startedMatch(a, [b]);
    expect((await healthz()).lobbies).toBe(lobbiesBefore + 1);
    b.close();
    await sleep(80);
    expect(runner.removed).toEqual([b.clientId]);
    runner.end(RESULTS);
    await a.next('matchOver');
    const back = (await a.next('lobbyState', (m) => m.lobby.status === 'waiting')).lobby;
    expect(back.members.map((m) => m.clientId)).toEqual([a.clientId]);
    expect(back.hostId).toBe(a.clientId);

    // Last member gone during a match: runner disposed and lobby deleted.
    const c = await TestClient.hello(port, 'C');
    const runner2 = await startedMatch(c, []);
    c.close();
    await sleep(80);
    expect(runner2.removed).toEqual([c.clientId]);
    expect(runner2.disposed).toBe(true);
    a.close();
    await sleep(80);
    expect((await healthz()).lobbies).toBe(lobbiesBefore);
  });
});

describe('abuse protection', () => {
  it('kicks after repeated invalid messages', async () => {
    const c = await TestClient.hello(port, 'Spam');
    const bad = [
      '{"t":"input","inputs":[{"seq":1,"mx":NaN}]}',
      '{"t":"input","inputs":[{"seq":1,"mx":1e999,"mz":0,"yaw":0,"pitch":0,"buttons":0,"stance":0,"slot":-1,"rt":0}]}',
      '{"t":"teleport","x":1}',
      '{"t":"chat","text":42}',
      'not json',
      '[]',
      '{"t":"startLocal","config":{},"name":"x"}',
      '{"t":"input","inputs":[]}',
      '{"t":"joinLobby","id":""}',
      '{"t":"setTeam","team":-1}',
    ];
    for (const m of bad) c.sendRaw(m);
    await c.error('net.badMessage');
    await c.error('net.kicked');
    const info = await c.closed();
    expect(info.code).toBe(4001);
    expect(c.msgs.filter((m) => m.t === 'error' && m.code === 'net.badMessage').length).toBe(10);
  });

  it('closes connections sending oversized payloads', async () => {
    const c = await TestClient.hello(port, 'Big');
    c.sendRaw(JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_MESSAGE_BYTES + 100) }));
    const info = await c.closed();
    expect(info.code).toBe(1009);
  });
});

describe('servers with custom options', () => {
  it('rate limits message floods and kicks persistent abusers', async () => {
    const s = await startServer({
      port: 0,
      log: false,
      runnerFactory: (o) => new FakeRunner(o),
      limits: { msgRate: 10, msgBurst: 10, abuseDrops: 30, abuseWindowMs: 10_000 },
    });
    try {
      const c = await TestClient.hello(s.port, 'Flood');
      for (let i = 0; i < 20; i++) c.send({ t: 'ping', c: i });
      await c.error('net.rateLimited');
      expect(c.closeInfo).toBeNull();
      for (let i = 0; i < 60; i++) c.send({ t: 'ping', c: i });
      await c.error('net.kicked');
      expect((await c.closed()).code).toBe(4001);
    } finally {
      await s.close();
    }
  });

  it('LAG_MS delays both directions (ping round trip >= 2x lag) and keeps order', async () => {
    const lag = 80;
    const s = await startServer({ port: 0, log: false, lagMs: lag, runnerFactory: (o) => new FakeRunner(o) });
    try {
      const c = await TestClient.hello(s.port, 'Laggy');
      const t0 = performance.now();
      c.send({ t: 'ping', c: 1 });
      await c.next('pong', (m) => m.c === 1);
      const rtt = performance.now() - t0;
      expect(rtt).toBeGreaterThanOrEqual(2 * lag);
      expect(rtt).toBeLessThan(2 * lag + 250);
      for (let i = 2; i < 12; i++) c.send({ t: 'ping', c: i });
      await c.next('pong', (m) => m.c === 11);
      const order = c.msgs.filter((m): m is Msg<'pong'> => m.t === 'pong').map((m) => m.c);
      expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      await s.close();
    }
  });

  it('serves the built client with content types, SPA fallback, caching and traversal protection', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dz-static-'));
    mkdirSync(path.join(dir, 'assets', 'sounds'), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>dz</title>');
    writeFileSync(path.join(dir, 'assets', 'index-Ab12_xYz.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'assets', 'sounds', 'impact-concrete.ogg'), 'OggS');
    writeFileSync(path.join(path.dirname(dir), 'dz-secret.txt'), 'secret');
    const s = await startServer({ port: 0, log: false, staticDir: dir, runnerFactory: (o) => new FakeRunner(o) });
    const get = (p: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: s.port, path: p, headers }, (res) => {
          let body = '';
          res.on('data', (d) => (body += String(d)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
      });
    try {
      const root = await get('/');
      expect(root.status).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.headers['cache-control']).toBe('no-cache');

      const js = await get('/assets/index-Ab12_xYz.js');
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toContain('text/javascript');
      expect(js.headers['cache-control']).toContain('immutable');
      const again = await get('/assets/index-Ab12_xYz.js', { 'If-None-Match': String(js.headers.etag) });
      expect(again.status).toBe(304);

      const snd = await get('/assets/sounds/impact-concrete.ogg');
      expect(snd.headers['content-type']).toBe('audio/ogg');
      expect(snd.headers['cache-control']).not.toContain('immutable');

      const spa = await get('/lobby/abc');
      expect(spa.status).toBe(200);
      expect(spa.body).toContain('<title>dz</title>');
      expect((await get('/missing.js')).status).toBe(404);

      for (const p of ['/../dz-secret.txt', '/%2e%2e/dz-secret.txt', '/assets/..%2f..%2fdz-secret.txt', '/%00', '/..\\dz-secret.txt']) {
        const r = await get(p);
        expect(r.body).not.toContain('secret');
      }
      const hz = await get('/healthz');
      expect(JSON.parse(hz.body).ok).toBe(true);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(path.join(path.dirname(dir), 'dz-secret.txt'), { force: true });
    }
  });
});
