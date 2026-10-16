// Anti-cheat probes against the REAL server + REAL MatchRunner/GameSim (running in a match worker
// thread exactly like production), using raw WebSocket clients that behave like a modified game
// client.
//
// The match is started through the normal lobby flow (botFill off, two humans). The runner factory
// runs it on the training map (mode 'training', infinite ammo) so the cheating player stands on the
// ground with a gun within a second instead of riding the plane and parachuting for ~30 s; the
// anti-cheat paths under test (server validation, connection limits, the runner's input token
// bucket, one input per tick, server-side movement, fire cooldowns and interaction checks) are
// identical in every mode.
//
// Teleporting / flying / no-clip are impossible by construction: the protocol has no field for a
// position, velocity, health, ammo or hit. Clients only send intent (axes, aim, buttons, actions);
// unknown fields are stripped by validateClientMessage and positions are only ever produced by the
// server's own physics. The "teleport" probe below verifies that a crafted input carrying such
// fields is accepted as a plain input and has no effect.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { INTERACT_RANGE, MAX_MESSAGE_BYTES, MOVE_SPEED, PROTOCOL_VERSION } from '../src/shared/constants';
import { WEAPONS, fireInterval } from '../src/shared/items';
import type { ClientMessage, MatchInit, ServerMessage, Snapshot } from '../src/shared/protocol';
import { BTN, type ClientAction, type LootItem, type PlayerInput } from '../src/shared/types';
import { createWorkerRunnerFactory, startServer, type ServerHandle, type WorkerRunnerFactory } from '../src/server';

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Raw protocol client with snapshot / loot bookkeeping. */
class RawClient {
  readonly msgs: ServerMessage[] = [];
  readonly snaps: Snapshot[] = [];
  readonly lootAdded = new Map<number, LootItem>();
  readonly lootRemoved = new Set<number>();
  closeInfo: { code: number; reason: string } | null = null;
  clientId = '';
  init: MatchInit | null = null;
  seq = 0;
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ServerMessage;
      this.msgs.push(m);
      if (m.t === 'snap') {
        this.snaps.push(m.s);
        for (const l of m.s.lootAdd ?? []) this.lootAdded.set(l.id, l);
        for (const id of m.s.lootRemove ?? []) this.lootRemoved.add(id);
      } else if (m.t === 'matchInit') {
        this.init = m.init;
        for (const l of m.init.loot) this.lootAdded.set(l.id, l);
      }
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      this.wake();
    });
    ws.on('error', () => undefined);
  }

  static async connect(port: number, name: string): Promise<RawClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const c = new RawClient(ws);
    c.send({ t: 'hello', name, version: PROTOCOL_VERSION });
    c.clientId = (await c.wait('welcome')).clientId;
    return c;
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async until(cond: () => boolean, what: string, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!cond()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 100));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async wait<T extends ServerMessage['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true, timeout = 5000): Promise<Msg<T>> {
    let found: Msg<T> | undefined;
    await this.until(() => {
      found = this.msgs.find((m): m is Msg<T> => m.t === t && pred(m as Msg<T>));
      return found !== undefined;
    }, `'${t}'`, timeout);
    return found as Msg<T>;
  }

  errorCount(code: string): number {
    return this.msgs.filter((m) => m.t === 'error' && m.code === code).length;
  }

  get snap(): Snapshot {
    const s = this.snaps[this.snaps.length - 1];
    if (!s?.self) throw new Error('no snapshot with self state yet');
    return s;
  }

  /** Wait for a snapshot whose server time is at least `timeMs`. */
  async snapAt(timeMs: number, timeout = 8000): Promise<Snapshot> {
    await this.until(() => {
      const s = this.snaps[this.snaps.length - 1];
      return !!s && !!s.self && s.time >= timeMs;
    }, `snapshot at ${timeMs}`, timeout);
    return this.snap;
  }

  input(over: Partial<PlayerInput> = {}, actions?: ClientAction[]): PlayerInput {
    const i: PlayerInput = {
      seq: ++this.seq, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: -1, rt: this.snaps.at(-1)?.time ?? 0, ...over,
    };
    if (actions) i.actions = actions;
    return i;
  }

  /** Honest 30 Hz input stream for `ms`. */
  async drive(ms: number, over: Partial<PlayerInput> = {}): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      this.send({ t: 'input', inputs: [this.input(over)] });
      await sleep(33);
    }
  }

  async action(a: ClientAction, over: Partial<PlayerInput> = {}): Promise<void> {
    this.send({ t: 'input', inputs: [this.input(over, [a])] });
    await this.drive(250, over);
  }

  /** Repeat an action (e.g. rate-limited training `give`) until `pred` holds. */
  async actUntil(a: ClientAction, pred: () => boolean, what: string, over: Partial<PlayerInput> = {}): Promise<void> {
    for (let i = 0; i < 12 && !pred(); i++) {
      await this.action(a, over);
      await this.drive(150, over);
    }
    await this.until(pred, what, 2000);
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const distXZ = (a: [number, number, number], b: [number, number, number]): number => Math.hypot(a[0] - b[0], a[2] - b[2]);

let server: ServerHandle;
let workers: WorkerRunnerFactory;
let a: RawClient; // the cheater
let b: RawClient; // second human (needed to start without bot fill)

beforeAll(async () => {
  // The production path: the real MatchRunner + bot driver in a match worker thread.
  workers = createWorkerRunnerFactory();
  server = await startServer({
    port: 0,
    log: false,
    runnerFactory: (opts) => workers({ ...opts, config: { ...opts.config, mode: 'training', infiniteAmmo: true } }),
  });
  a = await RawClient.connect(server.port, 'Cheater');
  b = await RawClient.connect(server.port, 'Honest');
  a.send({ t: 'createLobby', settings: { name: 'probes', maxPlayers: 4, teamSize: 1, botFill: false, botDifficulty: 'easy', zoneSpeed: 1 } });
  const lobbyId = (await a.wait('lobbyState')).lobby.id;
  b.send({ t: 'joinLobby', id: lobbyId });
  await b.wait('lobbyState', (m) => m.lobby.members.length === 2);
  b.send({ t: 'ready', ready: true });
  await a.wait('lobbyState', (m) => m.lobby.members.some((x) => !x.isHost && x.ready));
  a.send({ t: 'startMatch' });
  await a.wait('matchInit', () => true, 20_000);
  await b.wait('matchInit', () => true, 20_000);
  expect(a.init?.config.botFill).toBe(false);
  // Settle: first snapshots with self state.
  await a.drive(400);
  await a.until(() => !!a.snaps.at(-1)?.self, 'self snapshot');
}, 40_000);

afterAll(async () => {
  a?.close();
  b?.close();
  await server?.close();
  await workers?.dispose();
});

describe('anti-cheat probes (real MatchRunner)', () => {
  it('crafted position / health fields are ignored (teleport impossible)', async () => {
    const before = a.snap.self!;
    const t0 = a.snap.time;
    for (let i = 0; i < 10; i++) {
      const forged: Record<string, unknown> = {
        ...a.input(),
        pos: [9999, 500, 9999], p: [9999, 500, 9999], x: 9999, y: 500, z: 9999,
        health: 1000, hp: 1000, ammo: { ammo_9mm: 999 }, ack: 1e9,
      };
      const msg: Record<string, unknown> = { t: 'input', inputs: [forged], pos: { x: 9999, y: 500, z: 9999 } };
      a.send(msg);
      await sleep(33);
    }
    const after = await a.snapAt(t0 + 300);
    expect(a.errorCount('net.badMessage')).toBe(0); // extra fields are stripped, not an error
    expect(Math.hypot(after.self!.pos[0] - before.pos[0], after.self!.pos[1] - before.pos[1], after.self!.pos[2] - before.pos[2])).toBeLessThan(1);
    expect(after.self!.health).toBeLessThanOrEqual(100);
    expect(after.self!.ammo.ammo_9mm).toBe(before.ammo.ammo_9mm);
  });

  it('pickup of loot out of interaction range is refused (in-range control succeeds)', async () => {
    await a.actUntil({ a: 'give', item: 'bandage' }, () => (a.snap.self!.items.bandage ?? 0) >= 1, 'bandage given');
    await a.actUntil({ a: 'give', item: 'bandage' }, () => (a.snap.self!.items.bandage ?? 0) >= 2, 'bandages given');
    const count0 = a.snap.self!.items.bandage;

    // Control: drop one and pick it up right where we stand -> works.
    const known = new Set(a.lootAdded.keys());
    await a.action({ a: 'drop', item: 'bandage', count: 1 });
    await a.until(() => [...a.lootAdded.values()].some((l) => !known.has(l.id) && l.item === 'bandage'), 'dropped loot');
    const near = [...a.lootAdded.values()].find((l) => !known.has(l.id) && l.item === 'bandage')!;
    await a.action({ a: 'pickup', id: near.id });
    await a.until(() => a.lootRemoved.has(near.id), 'in-range pickup');
    await a.until(() => a.snap.self!.items.bandage === count0, 'bandage back in inventory');

    // Drop again, run away, then try to pick it up from afar.
    const known2 = new Set(a.lootAdded.keys());
    await a.action({ a: 'drop', item: 'bandage', count: 1 });
    await a.until(() => [...a.lootAdded.values()].some((l) => !known2.has(l.id) && l.item === 'bandage'), 'dropped loot 2');
    const far = [...a.lootAdded.values()].find((l) => !known2.has(l.id) && l.item === 'bandage')!;
    await a.drive(2000, { mz: 1, buttons: BTN.SPRINT, yaw: 0 });
    await a.drive(300);
    const pos = a.snap.self!.pos;
    const d = Math.hypot(pos[0] - far.pos.x, pos[2] - far.pos.z);
    console.log(`[pickup] distance=${d.toFixed(2)}`);
    expect(d).toBeGreaterThan(INTERACT_RANGE + 1);
    const t0 = a.snap.time;
    for (let i = 0; i < 5; i++) await a.action({ a: 'pickup', id: far.id }, { buttons: BTN.INTERACT });
    await a.snapAt(t0 + 1000);
    expect(a.lootRemoved.has(far.id)).toBe(false);
    expect(a.snap.self!.items.bandage).toBe(count0 - 1);

    // A loot id from the other side of the map (if the map has ground loot) is refused as well.
    const me = a.snap.self!.pos;
    const remote = [...a.lootAdded.values()]
      .filter((l) => !a.lootRemoved.has(l.id))
      .sort((x, y) => Math.hypot(y.pos.x - me[0], y.pos.z - me[2]) - Math.hypot(x.pos.x - me[0], x.pos.z - me[2]))[0];
    if (remote && Math.hypot(remote.pos.x - me[0], remote.pos.z - me[2]) > INTERACT_RANGE + 5) {
      await a.action({ a: 'pickup', id: remote.id });
      await a.drive(500);
      expect(a.lootRemoved.has(remote.id)).toBe(false);
    }
  });

  it('speed hack: an input flood moves the player no faster than sprinting', async () => {
    // Honest warm-up so the flood starts from a steady sprint, then flood: 8 inputs per message
    // (the protocol maximum) every 10 ms = 800 inputs/s, ~27x the legitimate rate.
    await a.drive(600, { mz: 1, buttons: BTN.SPRINT, yaw: Math.PI });
    const s0 = a.snap;
    const p0 = s0.self!.pos;
    const ack0 = s0.self!.ack;
    const floodUntil = Date.now() + 2300;
    while (Date.now() < floodUntil) {
      const inputs: PlayerInput[] = [];
      for (let i = 0; i < 8; i++) inputs.push(a.input({ mz: 1, mx: 50, buttons: BTN.SPRINT, yaw: Math.PI }));
      a.send({ t: 'input', inputs });
      await sleep(10);
    }
    const s1 = await a.snapAt(s0.time + 2000);
    const elapsed = (s1.time - s0.time) / 1000;
    const moved = distXZ(p0, s1.self!.pos);
    const allowed = MOVE_SPEED.sprint * elapsed + 0.5;
    expect(elapsed).toBeGreaterThanOrEqual(2);
    expect(moved).toBeLessThanOrEqual(allowed);
    expect(moved).toBeGreaterThan(MOVE_SPEED.walk * 0.5 * elapsed); // the inputs were applied (not frozen)
    // Flooded inputs were processed (acked) - just never faster than one per tick.
    expect(s1.self!.ack).toBeGreaterThan(ack0);
    console.log(`[speed] moved=${moved.toFixed(2)} allowed=${allowed.toFixed(2)} elapsed=${elapsed.toFixed(2)}`);
    // The flood stayed under the connection limit: still connected, merely rate limited inside the runner.
    expect(a.closeInfo).toBeNull();
    await a.drive(300);
  });

  it('fire-rate spam (FIRE toggled every input) never exceeds the weapon rpm', async () => {
    await a.actUntil({ a: 'give', item: 'pistol' }, () => a.snap.self!.weapons[2]?.id === 'pistol', 'pistol given');
    await a.actUntil({ a: 'give', item: 'ammo_9mm' }, () => a.snap.self!.ammo.ammo_9mm > 0, '9mm given');
    await a.drive(800, { slot: 2, pitch: 0.7 }); // draw, aim at the sky
    const s0 = a.snap;
    const shots0 = s0.self!.stats.shotsFired;
    const spamUntil = Date.now() + 3000;
    let fire = true;
    while (Date.now() < spamUntil) {
      const inputs: PlayerInput[] = [];
      for (let i = 0; i < 8; i++) {
        inputs.push(a.input({ slot: 2, pitch: 0.7, buttons: fire ? BTN.FIRE : 0 }));
        fire = !fire;
      }
      a.send({ t: 'input', inputs });
      await sleep(12);
    }
    const s1 = await a.snapAt(s0.time + 2500);
    const elapsed = (s1.time - s0.time) / 1000;
    const shots = s1.self!.stats.shotsFired - shots0;
    const budget = Math.floor(elapsed / fireInterval(WEAPONS.pistol)) + 1;
    console.log(`[fire] shots=${shots} budget=${budget} elapsed=${elapsed.toFixed(2)}`);
    expect(shots).toBeGreaterThanOrEqual(3); // it did fire
    expect(shots).toBeLessThanOrEqual(budget);
    await a.drive(200, { slot: 2 });
  });

  it('NaN / Infinity / wrong types / unknown messages and actions are rejected', async () => {
    const before = a.errorCount('net.badMessage');
    const base = JSON.stringify(a.input()).slice(0, -1);
    a.sendRaw(`{"t":"input","inputs":[${base},"yaw":NaN}]}`);
    a.sendRaw(`{"t":"input","inputs":[${base},"mx":1e999}]}`);
    const nullPitch: Record<string, unknown> = { ...a.input(), pitch: null };
    a.send({ t: 'input', inputs: [nullPitch] } as Record<string, unknown>);
    a.send({ t: 'input', inputs: [a.input({}, [{ a: 'teleport', x: 1 } as unknown as ClientAction])] });
    const badStance: Record<string, unknown> = { ...a.input(), stance: 7 };
    a.send({ t: 'input', inputs: [badStance] } as Record<string, unknown>);
    a.send({ t: 'setHealth', value: 100 });
    await a.until(() => a.errorCount('net.badMessage') >= before + 6, 'badMessage errors');
    expect(a.closeInfo).toBeNull();
    const s = await a.snapAt(a.snap.time + 200);
    for (const v of [...s.self!.pos, ...s.self!.vel, s.self!.health]) expect(Number.isFinite(v)).toBe(true);
  });

  it('spamming invalid messages gets the connection kicked', async () => {
    for (let i = 0; i < 12; i++) a.sendRaw('{"t":"input","inputs":[{"seq":NaN}]}');
    await a.wait('error', (m) => m.code === 'net.kicked');
    await a.until(() => a.closeInfo !== null, 'kick close');
    expect(a.closeInfo!.code).toBe(4001);
  });

  it('an oversized payload closes the connection', async () => {
    b.sendRaw(JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_MESSAGE_BYTES) }));
    await b.until(() => b.closeInfo !== null, 'oversize close');
    expect(b.closeInfo!.code).toBe(1009);
  });
});
