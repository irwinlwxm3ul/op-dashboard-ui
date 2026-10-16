// A lobby room: members, team slots, ready flags, host and settings. Pure state + rules; all
// network output goes through the LobbyClient interface (implemented by ClientConnection).

import type {
  LobbyErrorCode, LobbyMember, LobbySettings, LobbyState, LobbyStatus, LobbySummary, ServerMessage,
} from '../shared/protocol';
import type { MatchResults, TeamId } from '../shared/types';
import type { MatchRunnerLike } from './runner';

export interface LobbyClient {
  readonly id: string;
  readonly name: string | null;
  readonly pingMs: number;
  lobbyId: string | null;
  inMatch: boolean;
  send(msg: ServerMessage): void;
  sendRaw(data: string): void;
}

interface Member {
  client: LobbyClient;
  team: TeamId;
  ready: boolean;
}

/** A running (or lingering, after it ended) match of a lobby. */
export interface MatchSession {
  readonly lobby: Lobby;
  runner: MatchRunnerLike | null;
  readonly startedAt: number;
  /** performance.now() when the match ended (results known), or -1 while running. */
  endedAt: number;
  results: MatchResults | null;
  errors: number;
  disposed: boolean;
}

export const teamCountFor = (maxPlayers: number, teamSize: number): number => Math.ceil(maxPlayers / teamSize);

export class Lobby {
  settings: LobbySettings;
  hostId: string;
  status: LobbyStatus = 'waiting';
  match: MatchSession | null = null;
  /** Member pings at the last state broadcast (to push ping refreshes only when they change). */
  private pingSig = '';
  /** Insertion ordered: the first entry is the oldest member (host migration order). */
  private readonly members = new Map<string, Member>();

  constructor(
    readonly id: string,
    /** Monotonic creation sequence (newest first ordering in lobby lists). */
    readonly seq: number,
    settings: LobbySettings,
    host: LobbyClient,
  ) {
    this.settings = settings;
    this.hostId = host.id;
    this.members.set(host.id, { client: host, team: 0, ready: false });
    host.lobbyId = id;
  }

  get size(): number {
    return this.members.size;
  }

  get teamCount(): number {
    return teamCountFor(this.settings.maxPlayers, this.settings.teamSize);
  }

  has(clientId: string): boolean {
    return this.members.has(clientId);
  }

  isHost(clientId: string): boolean {
    return this.hostId === clientId;
  }

  clients(): LobbyClient[] {
    const out: LobbyClient[] = [];
    for (const m of this.members.values()) out.push(m.client);
    return out;
  }

  teamOf(clientId: string): TeamId | null {
    return this.members.get(clientId)?.team ?? null;
  }

  /** Members in join order with their team (used to build the match roster). */
  roster(): { client: LobbyClient; team: TeamId }[] {
    const out: { client: LobbyClient; team: TeamId }[] = [];
    for (const m of this.members.values()) out.push({ client: m.client, team: m.team });
    return out;
  }

  /** Check whether `client` may join right now. */
  canJoin(): LobbyErrorCode | null {
    if (this.status !== 'waiting') return 'lobby.inGame';
    if (this.members.size >= this.settings.maxPlayers) return 'lobby.full';
    return null;
  }

  add(client: LobbyClient): LobbyErrorCode | null {
    if (this.members.has(client.id)) return null;
    const err = this.canJoin();
    if (err) return err;
    const team = this.firstTeamWithRoom();
    if (team < 0) return 'lobby.full';
    this.members.set(client.id, { client, team, ready: false });
    client.lobbyId = this.id;
    return null;
  }

  /** Remove a member. Migrates the host to the oldest remaining member. */
  remove(clientId: string): { removed: boolean; hostChanged: boolean } {
    const m = this.members.get(clientId);
    if (!m) return { removed: false, hostChanged: false };
    this.members.delete(clientId);
    if (m.client.lobbyId === this.id) m.client.lobbyId = null;
    m.client.inMatch = false;
    let hostChanged = false;
    if (this.hostId === clientId) {
      const next = this.members.keys().next();
      if (!next.done) {
        this.hostId = next.value;
        hostChanged = true;
      }
    }
    return { removed: true, hostChanged };
  }

  applySettings(byId: string, settings: LobbySettings): LobbyErrorCode | null {
    if (!this.isHost(byId)) return 'lobby.notHost';
    if (this.status !== 'waiting') return 'lobby.inGame';
    // Kick-free: the player cap can never drop below the humans already in the room.
    if (settings.maxPlayers < this.members.size) return 'lobby.badSettings';
    const teamsChanged =
      settings.teamSize !== this.settings.teamSize || settings.maxPlayers !== this.settings.maxPlayers;
    this.settings = settings;
    if (teamsChanged) this.refitTeams();
    return null;
  }

  setTeam(clientId: string, team: TeamId): LobbyErrorCode | null {
    const m = this.members.get(clientId);
    if (!m) return 'lobby.notFound';
    if (this.status !== 'waiting') return 'lobby.inGame';
    if (team < 0 || team >= this.teamCount) return 'lobby.badSettings';
    if (m.team === team) return null;
    if (this.countTeam(team) >= this.settings.teamSize) return 'lobby.teamFull';
    m.team = team;
    return null;
  }

  setReady(clientId: string, ready: boolean): LobbyErrorCode | null {
    const m = this.members.get(clientId);
    if (!m) return 'lobby.notFound';
    if (this.status !== 'waiting') return 'lobby.inGame';
    m.ready = ready;
    return null;
  }

  /** Validate a start request by `byId`. */
  canStart(byId: string): LobbyErrorCode | null {
    if (!this.isHost(byId)) return 'lobby.notHost';
    if (this.status !== 'waiting') return 'lobby.inGame';
    for (const m of this.members.values()) {
      if (m.client.id !== this.hostId && !m.ready) return 'lobby.notReady';
    }
    if (!this.settings.botFill && this.members.size < 2) return 'lobby.notReady';
    return null;
  }

  resetReady(): void {
    for (const m of this.members.values()) m.ready = false;
  }

  toState(): LobbyState {
    const members: LobbyMember[] = [];
    for (const m of this.members.values()) {
      members.push({
        clientId: m.client.id,
        name: m.client.name ?? '',
        team: m.team,
        ready: m.ready,
        isHost: m.client.id === this.hostId,
        ping: m.client.pingMs,
      });
    }
    return {
      id: this.id,
      hostId: this.hostId,
      settings: { ...this.settings },
      members,
      status: this.status,
      countdown: -1,
      teamCount: this.teamCount,
    };
  }

  toSummary(): LobbySummary {
    const host = this.members.get(this.hostId);
    return {
      id: this.id,
      name: this.settings.name,
      host: host?.client.name ?? '',
      players: this.members.size,
      maxPlayers: this.settings.maxPlayers,
      teamSize: this.settings.teamSize,
      status: this.status,
    };
  }

  /**
   * Send the current lobbyState to members. Members inside the running match view are skipped
   * (they receive a fresh state when they return to the room).
   */
  broadcastState(): void {
    this.pingSig = this.currentPingSig();
    const data = JSON.stringify({ t: 'lobbyState', lobby: this.toState() } satisfies ServerMessage);
    for (const m of this.members.values()) if (!m.client.inMatch) m.client.sendRaw(data);
  }

  /** True when a member's displayed ping changed since the last broadcast. */
  pingsChanged(): boolean {
    return this.currentPingSig() !== this.pingSig;
  }

  sendStateTo(client: LobbyClient): void {
    client.send({ t: 'lobbyState', lobby: this.toState() });
  }

  /** Send to every member (including those in the match view). */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) m.client.sendRaw(data);
  }

  private currentPingSig(): string {
    let sig = '';
    for (const m of this.members.values()) sig += `${m.client.pingMs},`;
    return sig;
  }

  private countTeam(team: TeamId): number {
    let n = 0;
    for (const m of this.members.values()) if (m.team === team) n++;
    return n;
  }

  /** Lowest-index team with a free slot (fills teams so friends joining end up together). */
  private firstTeamWithRoom(): TeamId {
    const tc = this.teamCount;
    const cap = this.settings.teamSize;
    for (let t = 0; t < tc; t++) {
      if (this.countTeam(t) < cap) return t;
    }
    return -1;
  }

  /**
   * After a teamSize / maxPlayers change: keep every member on their team when it still exists and
   * has room (processed in join order), otherwise move them to the first team with room.
   * Total team capacity (teamCount * teamSize) >= maxPlayers >= members, so everyone fits.
   */
  private refitTeams(): void {
    const tc = this.teamCount;
    const cap = this.settings.teamSize;
    const counts = new Array<number>(tc).fill(0);
    const displaced: Member[] = [];
    for (const m of this.members.values()) {
      if (m.team >= 0 && m.team < tc && counts[m.team] < cap) counts[m.team]++;
      else displaced.push(m);
    }
    for (const m of displaced) {
      let t = 0;
      while (t < tc && counts[t] >= cap) t++;
      m.team = t;
      counts[t]++;
    }
  }
}
