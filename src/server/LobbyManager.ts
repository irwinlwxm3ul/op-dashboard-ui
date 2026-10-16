// All lobbies of the server plus their matches: create/list/join/leave, settings, teams, ready,
// start, chat, routing of in-match messages to the lobby's MatchRunner and the post-match return
// to the lobby room.

import { randomBytes, randomInt } from 'node:crypto';
import type { ClientMessage, LobbySettings, LobbySummary, ServerMessage } from '../shared/protocol';
import type { MatchConfig, MatchResults, TeamId } from '../shared/types';
import { Lobby, type LobbyClient, type MatchSession } from './Lobby';
import type { ServerLimits } from './limits';
import type { Logger } from './log';
import { MatchLoop, type MatchLoopHost } from './MatchLoop';
import type { RunnerClient, RunnerFactory } from './runner';

export interface LobbyManagerOptions {
  limits: ServerLimits;
  log: Logger;
  runnerFactory: RunnerFactory;
  /** Post-match linger before returning everyone to the lobby room (ms). */
  matchLingerMs: number;
  loopIntervalMs: number;
  statsIntervalMs: number;
  /** Clients that said hello and are not in a lobby (receive pushed lobby list updates). */
  browsingClients(): Iterable<LobbyClient>;
}

const MAX_RUNNER_ERRORS = 20;

export class LobbyManager implements MatchLoopHost {
  private readonly lobbies = new Map<string, Lobby>();
  private readonly loop: MatchLoop;
  private seq = 0;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private lastListSent = -Infinity;

  constructor(private readonly opts: LobbyManagerOptions) {
    this.loop = new MatchLoop(this, {
      intervalMs: opts.loopIntervalMs,
      idleIntervalMs: 50,
      lingerMs: opts.matchLingerMs,
      statsMs: opts.statsIntervalMs,
      maxErrors: MAX_RUNNER_ERRORS,
      log: opts.log,
    });
  }

  get lobbyCount(): number {
    return this.lobbies.size;
  }

  get matchCount(): number {
    return this.loop.size;
  }

  get(id: string): Lobby | undefined {
    return this.lobbies.get(id);
  }

  lobbyOf(client: LobbyClient): Lobby | null {
    return client.lobbyId ? (this.lobbies.get(client.lobbyId) ?? null) : null;
  }

  // ---------------------------------------------------------------------------
  // Lobby list
  // ---------------------------------------------------------------------------

  /** Summaries, newest first; only waiting / in-game lobbies with members. */
  list(): LobbySummary[] {
    const ls: Lobby[] = [];
    for (const l of this.lobbies.values()) {
      if (l.size > 0 && (l.status === 'waiting' || l.status === 'in_game')) ls.push(l);
    }
    ls.sort((a, b) => b.seq - a.seq);
    return ls.map((l) => l.toSummary());
  }

  sendListTo(client: LobbyClient): void {
    client.send({ t: 'lobbyList', lobbies: this.list() });
  }

  /** Schedule a (throttled) lobby list push to every browsing client. */
  markListDirty(): void {
    if (this.listTimer !== null) return;
    const wait = Math.max(0, this.lastListSent + this.opts.limits.lobbyListThrottleMs - performance.now());
    this.listTimer = setTimeout(this.pushList, wait);
  }

  private readonly pushList = (): void => {
    this.listTimer = null;
    this.lastListSent = performance.now();
    let data: string | null = null;
    for (const c of this.opts.browsingClients()) {
      data ??= JSON.stringify({ t: 'lobbyList', lobbies: this.list() } satisfies ServerMessage);
      c.sendRaw(data);
    }
  };

  // ---------------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------------

  create(client: LobbyClient, settings: LobbySettings): void {
    if (this.lobbies.size >= this.opts.limits.maxLobbies) {
      client.send({ t: 'error', code: 'lobby.full' });
      return;
    }
    if (client.lobbyId) this.leave(client, false);
    let id = newLobbyId();
    while (this.lobbies.has(id)) id = newLobbyId();
    const lobby = new Lobby(id, ++this.seq, settings, client);
    this.lobbies.set(id, lobby);
    this.opts.log.info('lobby created', { lobby: id, host: client.id, maxPlayers: settings.maxPlayers, teamSize: settings.teamSize });
    lobby.broadcastState();
    this.markListDirty();
  }

  join(client: LobbyClient, id: string): void {
    if (client.lobbyId === id) {
      const own = this.lobbies.get(id);
      if (own) {
        own.sendStateTo(client);
        return;
      }
    }
    const lobby = this.lobbies.get(id);
    if (!lobby) {
      client.send({ t: 'error', code: 'lobby.notFound' });
      return;
    }
    const err = lobby.canJoin();
    if (err) {
      client.send({ t: 'error', code: err });
      return;
    }
    if (client.lobbyId) this.leave(client, false);
    const addErr = lobby.add(client);
    if (addErr) {
      client.send({ t: 'error', code: addErr });
      return;
    }
    lobby.broadcastState();
    this.markListDirty();
  }

  /**
   * Remove a client from its lobby (explicit leave or disconnect). During a match the runner hands
   * the player to a bot. Empty lobbies are deleted; the host migrates to the oldest member.
   */
  leave(client: LobbyClient, disconnected: boolean): void {
    const lobby = this.lobbyOf(client);
    if (!lobby) {
      client.lobbyId = null;
      if (!disconnected) client.send({ t: 'lobbyLeft' });
      return;
    }
    const session = lobby.match;
    if (session && client.inMatch && session.runner && !session.disposed) {
      try {
        session.runner.removeClient(client.id);
      } catch (err) {
        this.loop.recordError(session, 'removeClient', err);
      }
    }
    lobby.remove(client.id);
    if (!disconnected) {
      client.send({ t: 'lobbyLeft' });
      this.sendListTo(client);
    }
    if (lobby.size === 0) {
      this.deleteLobby(lobby);
    } else if (!this.endIfAbandoned(lobby)) {
      lobby.broadcastState();
    }
    this.markListDirty();
  }

  // ---------------------------------------------------------------------------
  // Room actions
  // ---------------------------------------------------------------------------

  updateSettings(client: LobbyClient, settings: LobbySettings): void {
    const lobby = this.requireLobby(client);
    if (!lobby) return;
    const err = lobby.applySettings(client.id, settings);
    if (err) {
      client.send({ t: 'error', code: err });
      return;
    }
    lobby.broadcastState();
    this.markListDirty();
  }

  setTeam(client: LobbyClient, team: TeamId): void {
    const lobby = this.requireLobby(client);
    if (!lobby) return;
    const err = lobby.setTeam(client.id, team);
    if (err) {
      client.send({ t: 'error', code: err });
      return;
    }
    lobby.broadcastState();
  }

  setReady(client: LobbyClient, ready: boolean): void {
    const lobby = this.requireLobby(client);
    if (!lobby) return;
    const err = lobby.setReady(client.id, ready);
    if (err) {
      client.send({ t: 'error', code: err });
      return;
    }
    lobby.broadcastState();
  }

  chat(client: LobbyClient, text: string): void {
    const lobby = this.requireLobby(client);
    if (!lobby) return;
    // Text was sanitised by validateClientMessage (control/bidi chars stripped, length capped).
    lobby.broadcast({ t: 'chat', from: client.name ?? '', text });
  }

  /** Push refreshed member pings to waiting rooms whose displayed pings changed. */
  refreshPings(): void {
    for (const lobby of this.lobbies.values()) {
      if (lobby.status === 'waiting' && lobby.pingsChanged()) lobby.broadcastState();
    }
  }

  // ---------------------------------------------------------------------------
  // Match lifecycle
  // ---------------------------------------------------------------------------

  startMatch(client: LobbyClient): void {
    const lobby = this.requireLobby(client);
    if (!lobby) return;
    const err = lobby.canStart(client.id);
    if (err) {
      client.send({ t: 'error', code: err });
      return;
    }
    const s = lobby.settings;
    const config: MatchConfig = {
      mode: 'br',
      seed: randomInt(0, 0x1_0000_0000),
      maxPlayers: s.maxPlayers,
      teamSize: s.teamSize,
      botFill: s.botFill,
      botDifficulty: s.botDifficulty,
      zoneSpeed: s.zoneSpeed,
      infiniteAmmo: false,
    };
    const session: MatchSession = {
      lobby,
      runner: null,
      startedAt: performance.now(),
      endedAt: -1,
      results: null,
      errors: 0,
      disposed: false,
    };
    const roster = lobby.roster();
    const clients: RunnerClient[] = roster.map(({ client: c, team }) => ({
      id: c.id,
      name: c.name ?? '',
      team,
      // Only deliver while the client is still in this match's view.
      send: (msg: ServerMessage) => {
        if (!session.disposed && c.inMatch && c.lobbyId === lobby.id) c.send(msg);
      },
    }));

    try {
      session.runner = this.opts.runnerFactory({
        config,
        clients,
        onEnd: (results) => this.onMatchEnd(session, results),
        onError: (err) => {
          this.opts.log.error('match runner failed', { lobby: lobby.id, err });
          this.onRunnerFailed(session);
        },
      });
    } catch (e) {
      this.opts.log.error('failed to create match runner', { lobby: lobby.id, err: e });
      client.send({ t: 'error', code: 'lobby.badSettings' });
      return;
    }

    lobby.match = session;
    lobby.status = 'in_game';
    // Tell the room the match is starting before members switch to the match view.
    lobby.broadcastState();
    for (const r of roster) r.client.inMatch = true;
    try {
      session.runner.start(performance.now());
    } catch (e) {
      this.opts.log.error('failed to start match', { lobby: lobby.id, err: e });
      this.finishMatch(session);
      client.send({ t: 'error', code: 'lobby.badSettings' });
      return;
    }
    this.loop.add(session);
    this.markListDirty();
    this.opts.log.info('match started', {
      lobby: lobby.id,
      humans: roster.length,
      maxPlayers: config.maxPlayers,
      teamSize: config.teamSize,
      botFill: config.botFill,
    });
  }

  /** input / ping: forwarded to the runner while in a match; ping is answered here otherwise. */
  routeMatchMessage(client: LobbyClient, msg: Extract<ClientMessage, { t: 'input' } | { t: 'ping' } | { t: 'loaded' }>): void {
    const lobby = this.lobbyOf(client);
    const session = lobby?.match;
    if (session && client.inMatch && session.runner && !session.disposed) {
      try {
        session.runner.handleMessage(client.id, msg);
      } catch (err) {
        if (this.loop.recordError(session, 'handleMessage', err)) this.onRunnerFailed(session);
      }
      return;
    }
    if (msg.t === 'ping') client.send({ t: 'pong', c: msg.c, s: Math.round(performance.now()) });
    // Inputs outside a match (e.g. still in flight after the match ended) are dropped silently.
  }

  /** The client leaves the running match and returns to the lobby room; the match continues. */
  leaveMatch(client: LobbyClient): void {
    const lobby = this.lobbyOf(client);
    if (!lobby) return;
    const session = lobby.match;
    if (session && client.inMatch && session.runner && !session.disposed) {
      try {
        session.runner.handleMessage(client.id, { t: 'leaveMatch' });
      } catch (err) {
        this.loop.recordError(session, 'leaveMatch', err);
      }
    }
    client.inMatch = false;
    client.send({ t: 'backToLobby' });
    lobby.sendStateTo(client);
    this.endIfAbandoned(lobby);
  }

  private onMatchEnd(session: MatchSession, results: MatchResults | null): void {
    if (session.disposed || session.endedAt >= 0) return;
    session.endedAt = performance.now();
    session.results = results;
    const lobby = session.lobby;
    if (results) {
      const data = JSON.stringify({ t: 'matchOver', results } satisfies ServerMessage);
      for (const c of lobby.clients()) if (c.inMatch) c.sendRaw(data);
    }
    this.opts.log.info('match ended', {
      lobby: lobby.id,
      winnerTeam: results?.winnerTeam ?? null,
      duration: results ? `${Math.round(results.duration)}s` : 'unknown',
    });
  }

  /** MatchLoopHost */
  onRunnerOver(session: MatchSession): void {
    this.onMatchEnd(session, null);
  }

  /** MatchLoopHost */
  onLingerDone(session: MatchSession): void {
    this.finishMatch(session);
  }

  /** MatchLoopHost */
  onRunnerFailed(session: MatchSession): void {
    if (session.disposed) return;
    this.opts.log.error('aborting match after repeated runner errors', { lobby: session.lobby.id });
    this.finishMatch(session);
  }

  /**
   * Tear the match down and return the room to `waiting`: ready flags reset, clients still in the
   * match view get backToLobby, everyone gets a fresh lobbyState.
   */
  private finishMatch(session: MatchSession): void {
    const lobby = session.lobby;
    this.disposeSession(session);
    if (!this.lobbies.has(lobby.id)) return;
    lobby.status = 'waiting';
    lobby.resetReady();
    const back = JSON.stringify({ t: 'backToLobby' } satisfies ServerMessage);
    for (const c of lobby.clients()) {
      if (c.inMatch) {
        c.inMatch = false;
        c.sendRaw(back);
      }
    }
    lobby.broadcastState();
    this.markListDirty();
  }

  /** End the match early when no member is left in the match view. Returns true if it ended. */
  private endIfAbandoned(lobby: Lobby): boolean {
    const session = lobby.match;
    if (!session || session.disposed) return false;
    for (const c of lobby.clients()) if (c.inMatch) return false;
    if (session.endedAt < 0) this.opts.log.info('match abandoned by all humans', { lobby: lobby.id });
    this.finishMatch(session);
    return true;
  }

  private disposeSession(session: MatchSession): void {
    if (session.disposed) return;
    session.disposed = true;
    this.loop.remove(session);
    const lobby = session.lobby;
    if (lobby.match === session) lobby.match = null;
    try {
      session.runner?.dispose?.();
    } catch (err) {
      this.opts.log.warn('runner dispose failed', { lobby: lobby.id, err });
    }
    session.runner = null;
  }

  private deleteLobby(lobby: Lobby): void {
    if (lobby.match) this.disposeSession(lobby.match);
    this.lobbies.delete(lobby.id);
    this.opts.log.info('lobby closed', { lobby: lobby.id });
  }

  private requireLobby(client: LobbyClient): Lobby | null {
    const lobby = this.lobbyOf(client);
    if (!lobby) client.send({ t: 'error', code: 'lobby.notFound' });
    return lobby;
  }

  /** Stop all matches and timers (server shutdown). */
  dispose(): void {
    for (const lobby of this.lobbies.values()) if (lobby.match) this.disposeSession(lobby.match);
    this.lobbies.clear();
    this.loop.dispose();
    if (this.listTimer !== null) clearTimeout(this.listTimer);
    this.listTimer = null;
  }
}

/** Short URL-safe lobby id (fits the 32 char joinLobby validation). */
function newLobbyId(): string {
  return randomBytes(6).toString('base64url');
}
