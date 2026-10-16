// PLAN.md §8 acceptance tests automated at the Node level with the real modules.
//
// Most tests drive real ClientGame instances (prediction, interpolation, interaction prompts,
// input controller, client event bus) against the real MatchRunner / GameSim (+ bot AI) over a
// JSON loopback that runs in virtual time with a configurable one-way latency per client. This is
// exactly the path the browser uses (the single-player worker and the game server both wrap the
// same MatchRunner), minus rendering. The online tests use the real ws server (startServer) with
// ClientGame + MessageHub over WsTransport, like the App.
//
// Instrumentation (documented per test): the harness records every simulation event server-side
// by wrapping GameSim.drainEvents (part of the sim contract) to measure flight times precisely,
// and a few tests perform server-side "test setup" edits on the authoritative state (teleporting
// players / a vehicle to a known spot, nearly emptying a fuel tank, keeping a lag-compensation
// dummy alive) where reaching that state by playing would take minutes of scripted walking.
//
// Acceptance test 10 (anti-cheat probes) is covered by tests/cheats.test.ts (raw sockets against
// the real server: speed-hack floods, fire-rate spam, far loot pickups, NaN aim).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/shared/constants';
import type { ClientMessage, LobbyState, MatchInit, ServerMessage } from '../../src/shared/protocol';
import type {
  ClientAction, EntityId, GameEvent, ItemId, LootItem, MatchConfig, PlayerState, Vec3, VehicleState, WeaponId,
} from '../../src/shared/types';
import { WEAPONS, fireInterval, sightDrop, simulateTrajectory } from '../../src/shared/items';
import { MatchRunner, TRAINING_TARGET_CENTER_HEIGHT } from '../../src/shared/sim';
import type { SimEvent } from '../../src/shared/sim';
import { createBotDriver } from '../../src/shared/bots';
import { validateClientMessage } from '../../src/shared/validate';
import { ClientGame, LocalSettingsStore } from '../../src/client/game';
import type { ClientEvent, FrameState, LocalPlayerView, PlayerView, TrainingTargetView } from '../../src/client/game/types';
import type { Transport } from '../../src/client/net';
import { WsTransport } from '../../src/client/net';
import { MessageHub } from '../../src/client/app/hub';
import { lodThresholds, selectLod } from '../../src/client/render/entities';
import { startServer } from '../../src/server';

// ---------------------------------------------------------------------------------------------
// Loopback harness (virtual time)
// ---------------------------------------------------------------------------------------------

/** The training ground the App starts (App.ts TRAINING_SEED): same layout as in the browser. */
const TRAINING_SEED = 20261016;
const TRAINING: MatchConfig = {
  mode: 'training', seed: TRAINING_SEED, maxPlayers: 4, teamSize: 1, botFill: false,
  botDifficulty: 'normal', zoneSpeed: 1, infiniteAmmo: true,
};
/** The server MatchLoop polls runners every few ms; the loopback does the same in virtual time. */
const RUNNER_STEP_MS = 4;

interface ClientSpec {
  id: string;
  name: string;
  team?: number | null;
  /** One-way latency in both directions (ms). */
  latencyMs?: number;
}

interface Rec<E> { t: number; ev: E }

/** Transport stub: the harness carries messages with latency. */
class LoopTransport implements Transport {
  readonly kind = 'ws' as const;
  readonly outbox: ClientMessage[] = [];
  private readonly listeners = new Set<(m: ServerMessage) => void>();
  send(m: ClientMessage): void { this.outbox.push(m); }
  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  onClose(): () => void { return () => undefined; }
  close(): void { this.listeners.clear(); }
  deliver(m: ServerMessage): void { for (const cb of [...this.listeners]) cb(m); }
}

class SimClient {
  game: ClientGame | null = null;
  init: MatchInit | null = null;
  readonly transport = new LoopTransport();
  /** Every client event (server GameEvents + local predicted events) with its delivery time (s). */
  readonly events: Rec<ClientEvent>[] = [];
  readonly latencyMs: number;
  constructor(readonly spec: ClientSpec) {
    this.latencyMs = spec.latencyMs ?? 0;
  }
  get g(): ClientGame {
    if (!this.game) throw new Error(`${this.spec.name}: no match yet`);
    return this.game;
  }
  get frame(): FrameState { return this.g.getFrame(); }
  get self(): LocalPlayerView {
    const s = this.frame.self;
    if (!s) throw new Error(`${this.spec.name}: no local player view`);
    return s;
  }
  get id(): EntityId {
    const id = this.init?.you;
    if (id === null || id === undefined) throw new Error(`${this.spec.name}: no player id`);
    return id;
  }
  /** Events of one type delivered after virtual time `since` (s). */
  evs<T extends ClientEvent['type']>(type: T, since = -Infinity): Rec<Extract<ClientEvent, { type: T }>>[] {
    return this.events.filter((e) => e.ev.type === type && e.t >= since) as Rec<Extract<ClientEvent, { type: T }>>[];
  }
  /** A key press (down this frame, up on the next call of `release`). */
  key(code: string, down: boolean): void {
    if (down) this.g.input.keyDown(code);
    else this.g.input.keyUp(code);
  }
}

/**
 * MatchRunner + N ClientGames in virtual time. Server -> client and client -> server messages are
 * JSON round-tripped (like the wire) and delivered after the client's one-way latency.
 */
class Harness {
  now = 1000;
  readonly runner: MatchRunner;
  readonly clients: SimClient[];
  /** Every simulation event, stamped with the sim time (s) of the tick that produced it. */
  readonly simEvents: Rec<GameEvent>[] = [];
  /** Hook run after every runner.update (test setup invariants). */
  afterUpdate: (() => void) | null = null;
  /** Called for every simulation event as it is drained (e.g. to snapshot server state). */
  onSimEvent: ((e: SimEvent, t: number) => void) | null = null;
  private readonly wire: { at: number; seq: number; fn: () => void }[] = [];
  private wireSeq = 0;
  private nextRunner: number;

  constructor(readonly config: MatchConfig, specs: ClientSpec[], opts: { bots?: boolean; frameMs?: number } = {}) {
    this.frameMs = opts.frameMs ?? 1000 / 60;
    this.clients = specs.map((s) => new SimClient(s));
    this.runner = new MatchRunner({
      config,
      clients: this.clients.map((c) => ({
        id: c.spec.id, name: c.spec.name, team: c.spec.team ?? null,
        send: (msg: ServerMessage) => this.toClient(c, msg),
      })),
      botDriverFactory: opts.bots ? createBotDriver : undefined,
    });
    // Tap the simulation's event stream (GameSim.drainEvents is part of the sim contract).
    const sim = this.runner.sim;
    const drain = sim.drainEvents.bind(sim);
    sim.drainEvents = (): SimEvent[] => {
      const list = drain();
      for (const e of list) {
        this.simEvents.push({ t: sim.time, ev: e.ev });
        this.onSimEvent?.(e, sim.time);
      }
      return list;
    };
    this.runner.start(this.now);
    this.nextRunner = this.now + RUNNER_STEP_MS;
  }

  frameMs: number;

  get sim(): MatchRunner['sim'] { return this.runner.sim; }
  get t(): number { return this.now / 1000; }

  /** Server-side events of one type since sim time `since`. */
  simEvs<T extends GameEvent['type']>(type: T, since = -Infinity): Rec<Extract<GameEvent, { type: T }>>[] {
    return this.simEvents.filter((e) => e.ev.type === type && e.t >= since) as Rec<Extract<GameEvent, { type: T }>>[];
  }

  player(id: EntityId): PlayerState {
    const p = this.sim.players.get(id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  private schedule(delay: number, fn: () => void): void {
    this.wire.push({ at: this.now + delay, seq: this.wireSeq++, fn });
  }

  private toClient(c: SimClient, msg: ServerMessage): void {
    const wireMsg = JSON.parse(JSON.stringify(msg)) as ServerMessage;
    this.schedule(c.latencyMs, () => {
      if (wireMsg.t === 'matchInit') {
        c.init = wireMsg.init;
        c.game = new ClientGame(c.transport, wireMsg.init, new LocalSettingsStore(null), {
          world: this.runner.sim.world, now: () => this.now,
        });
        c.game.events.onAny((ev) => c.events.push({ t: this.now / 1000, ev: structuredClone(ev) }));
        // Like the App: report that the scene is built (releases the parked plane).
        this.toServer(c, { t: 'loaded' });
      } else {
        c.transport.deliver(wireMsg);
      }
    });
  }

  private toServer(c: SimClient, msg: ClientMessage): void {
    const raw: unknown = JSON.parse(JSON.stringify(msg));
    this.schedule(c.latencyMs, () => {
      const v = validateClientMessage(raw);
      if (v) this.runner.handleMessage(c.spec.id, v);
    });
  }

  private stepTo(target: number): void {
    for (;;) {
      let wi = -1;
      for (let i = 0; i < this.wire.length; i++) {
        const w = this.wire[i];
        if (wi < 0 || w.at < this.wire[wi].at || (w.at === this.wire[wi].at && w.seq < this.wire[wi].seq)) wi = i;
      }
      const wAt = wi >= 0 ? this.wire[wi].at : Infinity;
      const next = Math.min(wAt, this.nextRunner);
      if (next > target) break;
      this.now = next;
      if (wi >= 0 && wAt <= this.nextRunner) {
        this.wire.splice(wi, 1)[0].fn();
      } else {
        this.runner.update(this.now);
        this.afterUpdate?.();
        this.nextRunner += RUNNER_STEP_MS;
      }
    }
    this.now = target;
  }

  /** One rendered frame on every client. */
  frame(): void {
    this.stepTo(this.now + this.frameMs);
    const dt = this.frameMs / 1000;
    for (const c of this.clients) {
      if (!c.game) continue;
      c.game.update(dt);
      for (const m of c.transport.outbox.splice(0)) this.toServer(c, m);
    }
  }

  /** Run for `ms` of virtual time; `each` runs before every frame. */
  run(ms: number, each?: () => void): void {
    const end = this.now + ms;
    while (this.now < end) {
      each?.();
      this.frame();
    }
  }

  /** Run until `pred` holds (checked before every frame) or `maxMs` elapsed. */
  until(pred: () => boolean, maxMs: number, each?: () => void): boolean {
    const end = this.now + maxMs;
    while (this.now < end) {
      if (pred()) return true;
      each?.();
      this.frame();
    }
    return pred();
  }
}

// ---------------------------------------------------------------------------------------------
// Player helpers (all through the real InputController / ClientGame API)
// ---------------------------------------------------------------------------------------------

/** yaw / pitch that look from `from` to `to` (yaw 0 faces -Z, positive yaw turns left). */
function anglesTo(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

function aimAt(c: SimClient, p: Vec3): void {
  const a = anglesTo(c.self.eye, p);
  c.g.input.setAim(a.yaw, a.pitch);
}

function tap(h: Harness, c: SimClient, code: string): void {
  c.key(code, true);
  h.frame();
  c.key(code, false);
}

/** Training ground: take an item from the rack (rate-limited server side). */
function give(h: Harness, c: SimClient, item: ItemId): void {
  c.g.queueAction({ a: 'give', item } satisfies ClientAction);
  h.run(300);
}

/** Give a weapon (+ ammo), select it and wait until it is drawn. */
function equip(h: Harness, c: SimClient, weapon: WeaponId): void {
  give(h, c, weapon);
  give(h, c, WEAPONS[weapon].ammo);
  const slot = c.self.weapons.findIndex((w) => w?.id === weapon);
  expect(slot, `${weapon} in a weapon slot`).toBeGreaterThanOrEqual(0);
  tap(h, c, `Digit${slot + 1}`);
  const ok = h.until(() => c.self.weapon === weapon && c.self.drawProgress < 0, 3000);
  expect(ok, `${weapon} drawn`).toBe(true);
}

function setAds(h: Harness, c: SimClient, on: boolean): void {
  c.g.input.mouseButton(2, on);
  h.until(() => (on ? c.self.ads >= 0.999 : c.self.ads <= 0.001), 2000);
}

/** One trigger pull (press for one frame). */
function pull(h: Harness, c: SimClient): void {
  c.g.input.mouseButton(0, true);
  h.frame();
  c.g.input.mouseButton(0, false);
}

/**
 * Static training target at `range`: its id and aim centre. The world layout stores the plate
 * centre; FrameState.trainingTargets carries the dummy's base (feet) position, which must agree.
 */
function trainingTarget(c: SimClient, range: number): { id: number; pos: Vec3 } {
  const t = c.frame.world.training?.targets.find((x) => x.kind === 'static' && x.range === range);
  if (!t) throw new Error(`no static training target at ${range} m`);
  const view: TrainingTargetView | undefined = c.frame.trainingTargets.find((x) => x.id === t.id);
  expect(view, 'target is part of the frame state').toBeDefined();
  expect(view!.pos.y + TRAINING_TARGET_CENTER_HEIGHT).toBeCloseTo(t.pos.y, 3);
  return { id: t.id, pos: { ...t.pos } };
}

/** Weapon ready to fire: drawn, not reloading, cooldown over, recoil settled. */
function waitReady(h: Harness, c: SimClient): void {
  const ok = h.until(() => {
    const s = c.self;
    return s.fireCooldown <= 1e-6 && s.reloadProgress < 0 && s.drawProgress < 0
      && Math.abs(s.recoilPitch) < 1e-4 && Math.abs(s.recoilYaw) < 1e-4;
  }, 4000);
  expect(ok, 'weapon ready').toBe(true);
}

interface ShotResult {
  /** Client time (s) of the predicted shot. */
  localAt: number;
  /** Sim time (s) of the authoritative shot. */
  shotAt: number;
  shot: Extract<GameEvent, { type: 'shot' }>;
  /** Server targetHit for `targetId` (if any) and its sim time. */
  hit: Rec<Extract<GameEvent, { type: 'targetHit' }>> | null;
  /** Client delivery time (s) of that targetHit. */
  hitSeenAt: number | null;
  impacts: Rec<Extract<GameEvent, { type: 'impact' }>>[];
}

/** Aim at `point`, fire one shot and collect what happened within `windowMs`. */
function shootAt(h: Harness, c: SimClient, point: Vec3, targetId: number, windowMs = 2000): ShotResult {
  waitReady(h, c);
  aimAt(c, point);
  h.run(100);
  aimAt(c, point);
  const t0 = h.t;
  const simT0 = h.sim.time;
  const shotsBefore = c.evs('localShot').length;
  pull(h, c);
  h.run(windowMs);
  const local = c.evs('localShot', t0);
  expect(local.length, 'one predicted shot').toBe(1);
  expect(c.evs('localShot').length).toBe(shotsBefore + 1);
  const shots = h.simEvs('shot', simT0).filter((e) => e.ev.shooter === c.id);
  expect(shots.length, 'one authoritative shot').toBe(1);
  const hit = h.simEvs('targetHit', simT0).find((e) => e.ev.target === targetId) ?? null;
  const seen = c.evs('targetHit', t0).find((e) => e.ev.target === targetId) ?? null;
  return {
    localAt: local[0].t,
    shotAt: shots[0].t,
    shot: shots[0].ev,
    hit,
    hitSeenAt: seen ? seen.t : null,
    impacts: h.simEvs('impact', simT0),
  };
}

const up = (p: Vec3, dy: number): Vec3 => ({ x: p.x, y: p.y + dy, z: p.z });
const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

// ---------------------------------------------------------------------------------------------
// 2. Training ground ballistics
// ---------------------------------------------------------------------------------------------

describe('AT2 training ground ballistics', () => {
  it('sniper: ~0.4 s flight at 300 m and drop at 500 m (needs holdover); AR hits instantly; head vs body read-out', () => {
    const h = new Harness(TRAINING, [{ id: 'shooter', name: 'Shooter', latencyMs: 30 }]);
    const c = h.clients[0];
    h.run(1000);
    expect(c.frame.phase).toBe('playing');
    expect(c.self.mode).toBe('ground');

    equip(h, c, 'sniper');
    setAds(h, c, true);
    const sniper = WEAPONS.sniper;

    // 300 m, aiming exactly at the centre: the bullet arrives ~0.4 s later, below the centre.
    const t300 = trainingTarget(c, 300);
    const r300 = shootAt(h, c, t300.pos, t300.id);
    expect(r300.shot.projectiles?.length, 'sniper fires a ballistic projectile').toBe(1);
    expect(c.evs('localShot').at(-1)!.ev.ballistic).toBe(true);
    expect(r300.hit, 'hit the 300 m plate').not.toBeNull();
    const tof300 = simulateTrajectory(sniper, distXZ(c.self.eye, t300.pos)).time;
    const flight300 = r300.hit!.t - r300.shotAt;
    expect(tof300).toBeGreaterThan(0.35);
    expect(flight300).toBeGreaterThan(tof300 - 0.04);
    expect(flight300).toBeLessThan(tof300 + 0.07);
    // What the player perceives: predicted shot -> server-confirmed read-out.
    expect(r300.hitSeenAt).not.toBeNull();
    const seen300 = r300.hitSeenAt! - r300.localAt;
    expect(seen300).toBeGreaterThan(0.35);
    expect(seen300).toBeLessThan(0.75);
    expect(r300.hit!.ev.distance).toBeGreaterThan(290);
    const imp300 = r300.impacts.find((e) => Math.abs(e.ev.pos.z - t300.pos.z) < 1.5 && e.ev.weapon === 'sniper');
    expect(imp300, 'impact on the 300 m plate').toBeDefined();
    expect(imp300!.ev.pos.y, 'bullet drop: hits below the point of aim').toBeLessThan(t300.pos.y - 0.25);

    // 500 m, aiming exactly at the centre: the drop makes it miss low.
    const t500 = trainingTarget(c, 500);
    const r500 = shootAt(h, c, t500.pos, t500.id);
    expect(r500.hit, 'no holdover at 500 m misses').toBeNull();
    const low = r500.impacts.filter((e) => e.ev.weapon === 'sniper');
    for (const e of low) expect(e.ev.pos.y).toBeLessThan(t500.pos.y - 0.9);

    // ... and holding over by the drop hits, ~0.69 s after the shot.
    const hold = sightDrop(sniper, distXZ(c.self.eye, t500.pos));
    expect(hold).toBeGreaterThan(1);
    const r500b = shootAt(h, c, up(t500.pos, hold), t500.id);
    expect(r500b.hit, 'holdover hits at 500 m').not.toBeNull();
    const tof500 = simulateTrajectory(sniper, distXZ(c.self.eye, t500.pos)).time;
    expect(r500b.hit!.t - r500b.shotAt).toBeGreaterThan(tof500 - 0.04);
    expect(r500b.hit!.t - r500b.shotAt).toBeLessThan(tof500 + 0.07);

    // AR at 100 m: hitscan, the read-out arrives one round trip later.
    setAds(h, c, false);
    equip(h, c, 'ar');
    setAds(h, c, true);
    const t100 = trainingTarget(c, 100);
    const rAr = shootAt(h, c, t100.pos, t100.id, 800);
    expect(rAr.shot.projectiles).toBeUndefined();
    expect(c.evs('localShot').at(-1)!.ev.ballistic).toBe(false);
    expect(rAr.hit, 'AR hits the 100 m plate').not.toBeNull();
    expect(rAr.hit!.t - rAr.shotAt, 'instant hit (same tick)').toBeLessThan(1e-6);
    expect(rAr.hitSeenAt! - rAr.localAt).toBeLessThan(0.25);

    // Damage read-out distinguishes head and body (25 m plate: centre vs top).
    const t25 = trainingTarget(c, 25);
    const body = shootAt(h, c, t25.pos, t25.id, 500);
    const head = shootAt(h, c, up(t25.pos, 0.72), t25.id, 500);
    expect(body.hit?.ev.part).toBe('body');
    expect(head.hit?.ev.part).toBe('head');
    expect(head.hit!.ev.damage).toBeGreaterThan(body.hit!.ev.damage * 1.5);
    // The read-out reaches the shooter's client.
    expect(c.evs('targetHit').some((e) => e.ev.part === 'head')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Game feel: AR cadence and recoil
// ---------------------------------------------------------------------------------------------

describe('AT3 game feel', () => {
  it('AR spray fires at the weapon rpm, recoil climbs in a repeatable pattern and recovers', () => {
    const h = new Harness(TRAINING, [{ id: 'sprayer', name: 'Sprayer', latencyMs: 40 }]);
    const c = h.clients[0];
    h.run(1000);
    equip(h, c, 'ar');
    const ar = WEAPONS.ar;
    // Server recoil after every authoritative shot of this player.
    const serverRecoil: number[] = [];
    h.onSimEvent = (e) => {
      if (e.ev.type === 'shot' && e.ev.shooter === c.id) serverRecoil.push(h.player(c.id).recoilPitch);
    };

    const spray = (): { times: number[]; recoil: number[]; peak: number; server: number[] } => {
      waitReady(h, c);
      const t25 = trainingTarget(c, 25);
      aimAt(c, up(t25.pos, -1.0)); // the ground in front of the plate
      h.run(100);
      serverRecoil.length = 0;
      const t0 = h.t;
      const recoil: number[] = [];
      c.g.input.mouseButton(0, true);
      h.until(() => c.evs('localShot', t0).length >= ar.magSize, 5000, () => recoil.push(c.self.recoilPitch));
      c.g.input.mouseButton(0, false);
      const times = c.evs('localShot', t0).map((e) => e.t);
      h.run(300);
      const server = serverRecoil.slice();
      return { times, recoil, peak: Math.max(...recoil, c.self.recoilPitch), server };
    };

    const a = spray();
    expect(a.times.length).toBe(ar.magSize);
    const interval = (a.times[a.times.length - 1] - a.times[0]) / (a.times.length - 1);
    expect(interval).toBeGreaterThan(fireInterval(ar) - 0.006);
    expect(interval).toBeLessThan(fireInterval(ar) + 0.006);
    expect(60 / interval).toBeGreaterThan(ar.rpm * 0.93);
    expect(60 / interval).toBeLessThan(ar.rpm * 1.07);
    // Every predicted shot is confirmed by the server.
    expect(a.server.length).toBe(ar.magSize);
    // Recoil climbs during the spray (no recovery while firing) ...
    console.log('RECOIL', a.recoil.map((v) => v.toFixed(4)).join(' '), 'SERVER', a.server.map((v) => v.toFixed(4)).join(' '));
    for (let i = 1; i < a.recoil.length; i++) expect(a.recoil[i]).toBeGreaterThanOrEqual(a.recoil[i - 1] - 1e-4);
    expect(a.peak).toBeGreaterThan(0.15);
    // ... grows per shot early in the spray then plateaus (vertical pattern).
    const d = a.server.map((v, i) => (i === 0 ? v : v - a.server[i - 1]));
    expect(d[5]).toBeGreaterThan(d[1]);
    expect(Math.abs(d[25] - d[20])).toBeLessThan(1e-6);
    // ... and recovers after the trigger is released.
    h.until(() => c.self.recoilPitch < a.peak * 0.1, 2500);
    expect(c.self.recoilPitch).toBeLessThan(a.peak * 0.1);
    expect(h.player(c.id).recoilPitch).toBeLessThan(a.peak * 0.1);

    // A second spray follows the exact same vertical pattern (learnable).
    h.until(() => c.self.reloadProgress < 0 && (c.self.weapons.find((w) => w?.id === 'ar')?.mag ?? 0) === ar.magSize, 5000);
    const b = spray();
    expect(b.server.length).toBe(ar.magSize);
    for (let i = 0; i < 20; i++) expect(b.server[i]).toBeCloseTo(a.server[i], 9);
  });
});
