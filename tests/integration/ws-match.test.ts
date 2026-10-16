// Real server + real MatchRunner + two raw WebSocket clients: lobby flow, match start, inputs,
// snapshots with acks, information hiding and returning to the lobby.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../src/shared/constants';
import type { ClientMessage, LobbyState, ServerMessage, Snapshot } from '../../src/shared/protocol';
import { SnapshotDecoder } from '../../src/shared/netcodec';
import { startServer } from '../../src/server';

class Client {
  /** When set, the client announces codec 'delta1' (like the real browser client) and decodes snapd. */
  constructor(readonly codec = false) {}
  private decoder = new SnapshotDecoder();
  ws!: WebSocket;
  msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  async open(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      let m = JSON.parse(String(data)) as ServerMessage;
      if (m.t === 'matchInit') this.decoder.reset();
      if (m.t === 'snapd') m = { t: 'snap', s: this.decoder.decode(m.d) };
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  wait<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeout = 15000) {
    const found = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
    if (found) return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeout);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>),
        resolve: (m) => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { t: T }>); },
      });
    });
  }
  lastSnap(): Snapshot | null {
    for (let i = this.msgs.length - 1; i >= 0; i--) { const m = this.msgs[i]; if (m.t === 'snap') return m.s; }
    return null;
  }
  close() { this.ws.close(); }
}

let server: { port: number; close(): Promise<void> };
let url = '';

beforeAll(async () => {
  server = await startServer({ port: 0, log: false });
  url = `ws://localhost:${server.port}/ws`;
});
afterAll(async () => { await server?.close(); });

describe('online match end to end', () => {
  it('two clients: lobby → match → snapshots/acks → leave → back to lobby', async () => {
    // A uses the production wire path (delta codec + permessage-deflate), B plain JSON snapshots.
    const a = new Client(true); const b = new Client(false);
    await a.open(url); await b.open(url);
    a.send({ t: 'hello', name: 'Alpha', version: PROTOCOL_VERSION, codec: 'delta1' });
    b.send({ t: 'hello', name: 'Bravo', version: PROTOCOL_VERSION });
    const wa = await a.wait('welcome'); await b.wait('welcome');

    a.send({ t: 'createLobby', settings: { name: 'e2e', maxPlayers: 8, teamSize: 2, botFill: true, botDifficulty: 'easy', zoneSpeed: 1 } });
    const created = await a.wait('lobbyState');
    const lobbyId = created.lobby.id;
    b.send({ t: 'listLobbies' });
    const list = await b.wait('lobbyList', (m) => m.lobbies.some((l) => l.id === lobbyId));
    expect(list.lobbies.find((l) => l.id === lobbyId)?.name).toBe('e2e');
    b.send({ t: 'joinLobby', id: lobbyId });
    await b.wait('lobbyState', (m) => m.lobby.members.length === 2);
    // Put both on team 0 (teammates), ready up, start.
    b.send({ t: 'setTeam', team: 0 });
    await a.wait('lobbyState', (m) => m.lobby.members.every((x) => x.team === 0));
    b.send({ t: 'ready', ready: true });
    await a.wait('lobbyState', (m) => m.lobby.members.some((x) => !x.isHost && x.ready));
    a.send({ t: 'startMatch' });
    const ia = await a.wait('matchInit');
    const ib = await b.wait('matchInit');
    expect(ia.init.team).toBe(ib.init.team);
    expect(ia.init.roster.length).toBe(8); // bots filled
    expect(ia.init.loot.length).toBeGreaterThan(100);

    // Both clients finished loading → the plane is released.
    a.send({ t: 'loaded' }); b.send({ t: 'loaded' });
    // Send inputs for ~1 s and check acks advance and self state arrives.
    const youA = ia.init.you!;
    for (let seq = 1; seq <= 30; seq++) {
      a.send({ t: 'input', inputs: [{ seq, mx: 0, mz: 1, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: -1, rt: 0, actions: seq === 25 ? [{ a: 'jump' }] : undefined }] });
      await new Promise((r) => setTimeout(r, 33));
    }
    await a.wait('snap', (m) => !!m.s.self && m.s.self.ack >= 20);
    const snap = a.lastSnap()!;
    expect(snap.self?.id).toBe(youA);
    // Information hiding: enemies never carry hp; teammates do.
    const teamA = ia.init.team;
    for (const p of snap.players) {
      if (p.team !== teamA) { expect(p.hp).toBeUndefined(); expect(p.dhp).toBeUndefined(); }
    }
    // No other player's inventory in the snapshot.
    expect(JSON.stringify(snap.players)).not.toContain('ammo');

    // The delta-decoded view on A agrees with B's plain view of the same entities (same server tick).
    const snapB = b.lastSnap()!;
    const nearestTick = (c: Client, tick: number) => {
      for (let i = c.msgs.length - 1; i >= 0; i--) { const m = c.msgs[i]; if (m.t === 'snap' && m.s.tick === tick) return m.s; }
      return null;
    };
    const aAtB = nearestTick(a, snapB.tick);
    if (aAtB) {
      for (const p of snapB.players) {
        const q = aAtB.players.find((x) => x.id === p.id);
        if (q) expect(q.p).toEqual(p.p);
      }
      expect(aAtB.zone).toEqual(snapB.zone);
    }
    // Leave match → back to lobby.
    a.send({ t: 'leaveMatch' });
    await a.wait('backToLobby');
    const ls = await a.wait('lobbyState', (m) => m.lobby.id === lobbyId);
    expect((ls.lobby as LobbyState).id).toBe(lobbyId);
    a.close(); b.close();
    expect(wa.clientId).toBeTruthy();
  }, 60000);
});
