// Client netcode tests (Node, no DOM): clock sync, interpolation / extrapolation, prediction +
// reconciliation against a simulated server, event bus, loot deltas, predicted shots, interaction
// prompts, settings and input. Uses stub transports and a small hand-made flat world.

import { describe, expect, it } from 'vitest';
import { MAX_EXTRAPOLATE_MS, MIN_CHUTE_DROP, TICK_DT, TICK_MS } from '../src/shared/constants';
import { WEAPONS, fireInterval, recoilForShot, shotDirections, spreadCone } from '../src/shared/items';
import type { ClientMessage, MatchInit, NetPlayer, SelfState, ServerMessage, Snapshot } from '../src/shared/protocol';
import { LIFE_CODES, MODE_CODES, PF } from '../src/shared/protocol';
import { hash32 } from '../src/shared/rng';
import type {
  GameEvent, LootItem, MatchConfig, PlayerInput, PlayerState, RockDef, TreeDef, Vec3, World, WorldBox, ZoneState,
} from '../src/shared/types';
import { STANCE_CODE } from '../src/shared/types';
import {
  ClientGame, ClockSync, EventBus, InputController, LocalSettingsStore, RenderClock, SampleRing, DEFAULT_KEYBINDS,
  createPredictRt, createPredictedPlayer, createTickEvents, interpolatePlayer, makeBracket, predictTick,
  resolveInteraction, interactionAction,
} from '../src/client/game';
import type { InteractionEnv, PredictEnv, StorageLike } from '../src/client/game';
import type { ClientEvent, Interaction, PlayerView, VehicleView } from '../src/client/game/types';
import type { Transport, TransportKind } from '../src/client/net';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorld(boxes: Omit<WorldBox, 'id' | 'kind' | 'color' | 'building' | 'blocksBullets' | 'material'>[] = []): World {
  const size = 512, half = 256, res = 3, cell = 256;
  const bx: WorldBox[] = boxes.map((b, i) => ({
    id: i, min: { ...b.min }, max: { ...b.max }, kind: 'wall', material: 'concrete', color: 0, building: -1, blocksBullets: true,
  }));
  const trees: TreeDef[] = [];
  const rocks: RockDef[] = [];
  const overlaps = (x0: number, z0: number, x1: number, z1: number, b: WorldBox) =>
    x0 <= b.max.x && x1 >= b.min.x && z0 <= b.max.z && z1 >= b.min.z;
  return {
    seed: 1, kind: 'island', size, half, res, cell, heights: new Float32Array(res * res), surface: new Uint8Array(res * res),
    waterLevel: -50, boxes: bx, buildings: [], trees, rocks, bushes: [], roads: [], towns: [], lootSpawns: [],
    vehicleSpawns: [], training: null,
    heightAt: () => 0,
    normalAt: (_x: number, _z: number, out: Vec3 = { x: 0, y: 1, z: 0 }) => {
      out.x = 0; out.y = 1; out.z = 0;
      return out;
    },
    surfaceAt: () => 'grass',
    groundAt(x: number, z: number, fromY = Infinity) {
      let g = 0;
      for (const b of bx) if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= fromY + 0.01 && b.max.y > g) g = b.max.y;
      return g;
    },
    inBounds: (x: number, z: number) => Math.abs(x) <= half && Math.abs(z) <= half,
    queryBoxes(minX, minZ, maxX, maxZ, out) {
      out.length = 0;
      for (const b of bx) if (overlaps(minX, minZ, maxX, maxZ, b)) out.push(b);
      return out;
    },
    queryTrees(_a, _b, _c, _d, out) { out.length = 0; return out; },
    queryRocks(_a, _b, _c, _d, out) { out.length = 0; return out; },
  };
}

const CONFIG: MatchConfig = {
  mode: 'br', seed: 7, maxPlayers: 8, teamSize: 2, botFill: false, botDifficulty: 'normal', zoneSpeed: 1, infiniteAmmo: false,
};
const SELF = 1, MATE = 2, ENEMY = 3;

function makeInit(loot: LootItem[] = []): MatchInit {
  return {
    config: CONFIG, you: SELF, team: 0,
    roster: [
      { id: SELF, name: 'Me', team: 0, isBot: false },
      { id: MATE, name: 'Mate', team: 0, isBot: true },
      { id: ENEMY, name: 'Enemy', team: 1, isBot: true },
    ],
    loot, time: 0, tickRate: 30, snapshotRate: 20,
  };
}

class StubTransport implements Transport {
  readonly sent: ClientMessage[] = [];
  private readonly listeners = new Set<(m: ServerMessage) => void>();
  constructor(readonly kind: TransportKind = 'ws') {}
  send(m: ClientMessage): void { this.sent.push(m); }
  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onClose(): () => void { return () => undefined; }
  close(): void { this.listeners.clear(); }
  deliver(m: ServerMessage): void { for (const cb of [...this.listeners]) cb(m); }
  /** Drain inputs sent since the last call. */
  takeInputs(): PlayerInput[] {
    const out: PlayerInput[] = [];
    for (const m of this.sent.splice(0)) if (m.t === 'input') out.push(...m.inputs);
    return out;
  }
}

const memorySettings = (): LocalSettingsStore => new LocalSettingsStore(null);

function zone(): ZoneState {
  return { phase: 0, stage: 'waiting', cx: 0, cz: 0, r: 500, nx: 0, nz: 0, nr: 300, timer: 60, stageTotal: 100, damagePerSec: 0.4 };
}

function snap(time: number, over: Partial<Snapshot> = {}): Snapshot {
  return {
    tick: Math.round(time / TICK_MS), time, phase: 'playing', alive: 3, teamsAlive: 2, zone: zone(), plane: null,
    players: [], vehicles: [], projectiles: [], self: null, events: [], ...over,
  };
}

function netPlayer(id: number, x: number, z: number, vx = 0, vz = 0, team = 1): NetPlayer {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { id, p: [r(x), 0, r(z)], v: [r(vx), 0, r(vz)], y: 0, pt: 0, s: 0, m: 3, l: 0, team, w: 'ar', f: 0, g: [0, 0, 0] };
}

/** Authoritative-looking player state for the fake server. */
function basePlayer(x = 0, z = 0): PlayerState {
  const p = createPredictedPlayer(selfFrom(null), 'Me', 0);
  p.pos.x = x; p.pos.z = z;
  p.mode = 'ground';
  p.onGround = true;
  return p;
}

function selfFrom(p: PlayerState | null, ack = 0): SelfState {
  if (!p) {
    return {
      id: SELF, ack, pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, airTime: 0, jumpBuffer: 0, fallSpeed: 0, stance: 0,
      mode: MODE_CODES.indexOf('ground'), life: 0, health: 100, boost: 0, downedHp: 0,
      armor: { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 }, weapons: [null, null, null], activeSlot: -1,
      ammo: { ammo_9mm: 0, ammo_556: 0, ammo_762: 0, ammo_12g: 0, ammo_300: 0 },
      items: { bandage: 0, firstaid: 0, medkit: 0, energy: 0, fuel: 0, frag: 0 }, capacity: [0, 50], fireCooldown: 0,
      reloadTimer: 0, reloadTotal: 0, drawTimer: 0, ads: 0, sprayCount: 0, bloom: 0, shotCounter: 0, recoilPitch: 0,
      recoilYaw: 0, use: null, revive: null, revivedBy: null, vehicleId: null, seat: -1, parachuteOpen: false, jumpY: 0,
      throwCooldown: 0,
      stats: { kills: 0, knocks: 0, damage: 0, headshots: 0, revives: 0, longestKill: 0, shotsFired: 0, shotsHit: 0, spawnTime: 0, deathTime: 0 },
      placement: 0, spectating: null, killerId: null,
    };
  }
  return {
    id: p.id, ack, pos: [p.pos.x, p.pos.y, p.pos.z], vel: [p.vel.x, p.vel.y, p.vel.z], onGround: p.onGround,
    airTime: p.airTime, jumpBuffer: p.jumpBuffer, fallSpeed: p.fallSpeed, stance: STANCE_CODE[p.stance],
    mode: MODE_CODES.indexOf(p.mode), life: LIFE_CODES.indexOf(p.life), health: p.health, boost: p.boost,
    downedHp: p.downedHp, armor: { ...p.armor },
    weapons: [p.weapons[0] && { ...p.weapons[0] }, p.weapons[1] && { ...p.weapons[1] }, p.weapons[2] && { ...p.weapons[2] }],
    activeSlot: p.activeSlot, ammo: { ...p.ammo }, items: { ...p.items }, capacity: [0, 50], fireCooldown: p.fireCooldown,
    reloadTimer: p.reloadTimer, reloadTotal: p.reloadTotal, drawTimer: p.drawTimer, ads: p.ads, sprayCount: p.sprayCount,
    bloom: p.bloom, shotCounter: p.shotCounter, recoilPitch: p.recoilPitch, recoilYaw: p.recoilYaw,
    use: p.use && { ...p.use }, revive: p.revive && { ...p.revive }, revivedBy: p.revivedBy, vehicleId: p.vehicleId,
    seat: p.seat, parachuteOpen: p.parachuteOpen, jumpY: p.jumpY, throwCooldown: p.throwCooldown, stats: { ...p.stats },
    placement: p.placement, spectating: p.spectating, killerId: p.killerId,
  };
}

/**
 * A simulated authoritative server: the same per-input rules (predictTick mirrors the sim's player
 * tick), one queued input per 30 Hz tick, 20 Hz snapshots, symmetric latency, answers pings.
 */
class Sim {
  now = 0;
  readonly serverOffset = 5000;
  readonly p: PlayerState;
  private readonly rt = createPredictRt();
  private readonly ev = createTickEvents();
  private readonly env: PredictEnv;
  private queue: PlayerInput[] = [];
  private lastButtons = 0;
  private ack = 0;
  private nextTick: number;
  private nextSnap: number;
  private simTime = 0;
  private readonly wire: { at: number; fn: () => void }[] = [];
  readonly transport = new StubTransport('ws');
  readonly game: ClientGame;
  remote: ((serverMs: number) => NetPlayer | null) | null = null;
  /** Hook to tamper with the authoritative state (misprediction tests). */
  beforeSnapshot: ((p: PlayerState) => void) | null = null;

  constructor(readonly world: World, readonly latencyMs: number, p: PlayerState = basePlayer()) {
    this.p = p;
    this.env = { world, config: CONFIG, time: 0, plane: null, planeTime: 0, seatVehicle: null, vehicle: null, others: [] };
    this.nextTick = this.now;
    this.nextSnap = this.now;
    this.game = new ClientGame(this.transport, makeInit(), memorySettings(), { world, now: () => this.now });
  }

  get serverMs(): number {
    return this.now + this.serverOffset;
  }

  private send(fn: () => void): void {
    this.wire.push({ at: this.now + this.latencyMs, fn });
  }

  /** Advance the shared clock by one 60 Hz frame. */
  frame(): void {
    const dtMs = 1000 / 60;
    const target = this.now + dtMs;
    while (true) {
      const nextEvent = Math.min(this.nextTick, this.nextSnap, ...this.wire.map((w) => w.at));
      if (nextEvent > target) break;
      this.now = nextEvent;
      for (let i = 0; i < this.wire.length; i++) {
        if (this.wire[i].at <= this.now) {
          const w = this.wire.splice(i, 1)[0];
          i--;
          w.fn();
        }
      }
      if (this.nextTick <= this.now) {
        this.serverTick();
        this.nextTick += TICK_MS;
      }
      if (this.nextSnap <= this.now) {
        this.serverSnapshot();
        this.nextSnap += 50;
      }
    }
    this.now = target;
    this.game.update(dtMs / 1000);
    for (const m of this.transport.sent.splice(0)) {
      if (m.t === 'input') {
        const inputs = m.inputs.map((i) => ({ ...i, actions: i.actions ? [...i.actions] : undefined }));
        this.send(() => this.queue.push(...inputs));
      } else if (m.t === 'ping') {
        const c = m.c;
        this.send(() => {
          const s = this.serverMs;
          this.send(() => this.transport.deliver({ t: 'pong', c, s }));
        });
      }
    }
  }

  private serverTick(): void {
    const input = this.queue.shift();
    if (!input) return;
    this.env.time = this.simTime;
    predictTick(this.p, this.rt, input, this.lastButtons, this.env, this.ev);
    this.lastButtons = input.buttons;
    this.ack = input.seq;
    this.simTime += TICK_DT;
  }

  private serverSnapshot(): void {
    this.beforeSnapshot?.(this.p);
    const t = this.serverMs;
    const r = this.remote?.(t);
    const s = snap(t, { self: selfFrom(this.p, this.ack), players: r ? [r] : [] });
    this.send(() => this.transport.deliver({ t: 'snap', s }));
  }

  run(frames: number, each?: (i: number) => void): void {
    for (let i = 0; i < frames; i++) {
      each?.(i);
      this.frame();
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------

describe('clock sync', () => {
  it('converges on the server clock with latency and jitter (min-RTT filter + snapshot bound)', () => {
    const cs = new ClockSync();
    const offset = 123_456.7;
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const oneWay = () => 40 + rand() * 25; // 40..65 ms with jitter
    type Ev = { at: number; run: () => void };
    const evs: Ev[] = [];
    let now = 0;
    for (let t = 0; t < 20_000; t += 50) {
      // Server snapshot produced at server time (t + offset) arrives one-way later.
      const serverT = t + offset;
      evs.push({ at: t + oneWay(), run: () => cs.onSnapshot(serverT, now) });
    }
    for (let t = 0; t < 20_000; t += 10) {
      evs.push({
        at: t,
        run: () => {
          if (!cs.shouldPing(now)) return;
          const c = now;
          const up = oneWay(), down = oneWay();
          // Pong carries the server tick time (quantised like the sim's tick clock is not, but harmless).
          const s = c + up + offset;
          evs.push({ at: c + up + down, run: () => cs.onPong(c, s, now) });
          evs.sort((a, b) => a.at - b.at);
        },
      });
    }
    evs.sort((a, b) => a.at - b.at);
    while (evs.length) {
      const e = evs.shift()!;
      now = e.at;
      e.run();
    }
    expect(Math.abs(cs.offset - offset)).toBeLessThan(8);
    expect(cs.discontinuities).toBe(0); // jitter alone never looks like a clock step
    expect(cs.rtt).toBeGreaterThan(80);
    expect(cs.rtt).toBeLessThan(130);
    expect(cs.interpDelay()).toBeGreaterThanOrEqual(100);
    expect(cs.interpDelay()).toBeLessThanOrEqual(180);
  });

  it.each([1, 3, 7, 11, 19, 42])('follows a server clock that steps back 300 ms within ~1 s, without overshoot or render time running backwards (seed %i)', (seed0) => {
    const cs = new ClockSync();
    const rc = new RenderClock();
    let seed = seed0;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const oneWay = () => 30 + rand() * 20; // 30..50 ms
    let serverOffset = 50_000; // server clock = local + serverOffset
    const STEP_AT = 10_000;
    type Ev = { at: number; run: () => void };
    const evs: Ev[] = [];
    const push = (e: Ev) => {
      let i = evs.length;
      while (i > 0 && evs[i - 1].at > e.at) i--;
      evs.splice(i, 0, e);
    };
    let now = 0;
    let nextSnap = 0, nextFrame = 0;
    const errAfter: { t: number; trueErr: number; dataErr: number }[] = [];
    let prevRender = -Infinity;
    let minStepRatio = Infinity;
    while (now < 16_000) {
      const t = Math.min(nextSnap, nextFrame, evs.length ? evs[0].at : Infinity);
      now = t;
      if (now >= STEP_AT && serverOffset === 50_000) serverOffset -= 300; // backlog dropped after a stall
      if (evs.length && evs[0].at === t) {
        evs.shift()!.run();
        continue;
      }
      if (t === nextSnap) {
        const stamp = now + serverOffset;
        push({ at: now + oneWay(), run: () => cs.onSnapshot(stamp, now) });
        nextSnap += 50;
        continue;
      }
      // 60 Hz frame: ping scheduling + render clock.
      nextFrame += 1000 / 60;
      if (cs.shouldPing(now)) {
        const c = now;
        const up = oneWay(), down = oneWay();
        push({
          at: c + up,
          run: () => {
            const s = now + serverOffset;
            push({ at: now + down, run: () => cs.onPong(c, s, now) });
          },
        });
      }
      const r = rc.update(1000 / 60, cs.dataNow(now) - cs.interpDelay());
      if (prevRender > -Infinity) minStepRatio = Math.min(minStepRatio, (r - prevRender) / (1000 / 60));
      prevRender = r;
      if (now >= STEP_AT) {
        // Data clock truth: server time of a minimally delayed snapshot.
        errAfter.push({ t: now - STEP_AT, trueErr: cs.offset - serverOffset, dataErr: cs.dataOffset - (serverOffset - 30) });
      }
    }
    // Before 1 s after the step both estimates have converged ...
    const late = errAfter.filter((e) => e.t > 1000);
    expect(Math.max(...late.map((e) => Math.abs(e.trueErr)))).toBeLessThan(25);
    expect(Math.max(...late.map((e) => Math.abs(e.dataErr)))).toBeLessThan(25);
    // ... never overshooting below the new clock ...
    expect(Math.min(...errAfter.map((e) => e.trueErr))).toBeGreaterThan(-25);
    expect(Math.min(...errAfter.map((e) => e.dataErr))).toBeGreaterThan(-25);
    expect(cs.discontinuities).toBeLessThanOrEqual(1); // never a false trigger
    // ... while render time slowed down (never ran backwards, never jumped) and caught up.
    expect(minStepRatio).toBeGreaterThanOrEqual(0.49);
    expect(Math.abs(rc.time - (cs.dataNow(now) - cs.interpDelay()))).toBeLessThan(10);
  });

  it('render clock advances smoothly and converges without jumps', () => {
    const rc = new RenderClock();
    rc.update(16, 1000);
    expect(rc.time).toBe(1000);
    let target = 1000;
    let prev = rc.time;
    // Target is 40 ms ahead of the clock (e.g. after an offset correction).
    target += 40;
    for (let i = 0; i < 120; i++) {
      target += 16;
      const t = rc.update(16, target);
      const step = t - prev;
      expect(step).toBeGreaterThan(16 * 0.85);
      expect(step).toBeLessThan(16 * 1.15);
      prev = t;
    }
    expect(Math.abs(rc.time - target)).toBeLessThan(2);
    // A large step back is slewed (time keeps moving forward at >= half speed), not snapped.
    const before = rc.time;
    target -= 300;
    let t2 = rc.time;
    for (let i = 0; i < 180; i++) {
      target += 16;
      const t = rc.update(16, target);
      expect(t - t2).toBeGreaterThanOrEqual(16 * 0.5 - 1e-9);
      if (i === 60) expect(Math.abs(t - target)).toBeLessThan(60); // the bulk is gone within ~1 s
      t2 = t;
    }
    expect(rc.time).toBeGreaterThan(before);
    expect(Math.abs(rc.time - target)).toBeLessThan(3);
    // An absurd discontinuity snaps.
    rc.update(16, target + 5000);
    expect(rc.time).toBe(target + 5000);
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe('interpolation', () => {
  it('blends samples at the render time and caps extrapolation', () => {
    const ring = new SampleRing<NetPlayer>(8);
    for (let t = 0; t <= 200; t += 50) ring.push(t, netPlayer(5, t / 10, 0, 100 / 10 * 0 + 10, 0));
    const br = makeBracket<NetPlayer>();
    const out = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, extrapolating: false };
    ring.bracket(125, br);
    interpolatePlayer(br, out);
    expect(out.pos.x).toBeCloseTo(12.5, 6);
    expect(out.extrapolating).toBe(false);
    ring.bracket(200 + 100, br);
    interpolatePlayer(br, out);
    expect(out.extrapolating).toBe(true);
    expect(out.pos.x).toBeCloseTo(20 + 10 * 0.1, 6);
    ring.bracket(200 + 1000, br);
    interpolatePlayer(br, out);
    expect(out.pos.x).toBeCloseTo(20 + 10 * (MAX_EXTRAPOLATE_MS / 1000), 6);
    // Out-of-order samples are ignored.
    expect(ring.push(100, netPlayer(5, 999, 0))).toBe(false);
  });

  it('renders remote players at renderTime, including low-rate players, and caps extrapolation', () => {
    const world = makeWorld();
    const sim = new Sim(world, 40);
    const v = 6; // m/s along +x, x(t) = v * (serverMs - 5000)/1000
    const xAt = (serverMs: number) => (v * (serverMs - sim.serverOffset)) / 1000;
    let n = 0;
    // Lower relevance rate: the enemy is only present in every 3rd snapshot.
    sim.remote = (t) => (n++ % 3 === 0 ? netPlayer(ENEMY, xAt(t), 0, v, 0) : null);
    let checked = 0;
    sim.run(180, (i) => {
      if (i < 60) return;
      const f = sim.game.getFrame();
      const e = f.players.get(ENEMY);
      if (!e) return;
      // Where the entity really was at the render time.
      expect(e.pos.x).toBeCloseTo(xAt(f.time), 1);
      expect(Math.abs(e.pos.x - xAt(f.time))).toBeLessThan(0.03);
      checked++;
    });
    expect(checked).toBeGreaterThan(100);
    const f = sim.game.getFrame();
    expect(f.players.get(ENEMY)!.isTeammate).toBe(false);
    expect(f.players.get(ENEMY)!.name).toBe('Enemy');

    // Stop updates for the enemy entirely: extrapolation stops after MAX_EXTRAPOLATE_MS.
    let lastT = 0;
    sim.remote = (t) => {
      if (lastT === 0) {
        lastT = t;
        return netPlayer(ENEMY, xAt(t), 0, v, 0);
      }
      return null;
    };
    sim.run(120);
    const e = sim.game.getFrame().players.get(ENEMY)!;
    const capX = Math.round(xAt(lastT) * 100) / 100 + v * (MAX_EXTRAPOLATE_MS / 1000);
    expect(e.pos.x).toBeCloseTo(capX, 2);
    expect(e.age).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Prediction & reconciliation
// ---------------------------------------------------------------------------

function armedPlayer(): PlayerState {
  const p = basePlayer();
  p.weapons[0] = { id: 'ar', mag: 30 };
  p.activeSlot = 0;
  p.ammo.ammo_556 = 90;
  return p;
}

describe('prediction and reconciliation', () => {
  it('predicts the same result as the server with 100 ms latency: no drift, no corrections', () => {
    const world = makeWorld([{ min: { x: 6, y: 0, z: -20 }, max: { x: 6.5, y: 3, z: 20 } }]);
    const sim = new Sim(world, 100, armedPlayer());
    const input = sim.game.input;
    sim.run(30); // first snapshots arrive, clock syncs
    expect(sim.game.getFrame().self).not.toBeNull();
    input.setAim(-Math.PI / 2, 0); // face +x (towards the wall)
    let maxCorrection = 0;
    sim.run(600, (i) => {
      // Walk, strafe, sprint, jump, crouch, turn and spray in a scripted pattern.
      if (i === 0) input.keyDown('KeyW');
      if (i === 40) input.keyDown('ShiftLeft');
      if (i === 80) input.keyDown('Space');
      if (i === 81) input.keyUp('Space');
      if (i === 120) { input.keyUp('ShiftLeft'); input.keyDown('KeyA'); }
      if (i === 160) input.mouseButton(0, true);
      if (i === 200) input.mouseButton(0, false);
      if (i === 220) input.keyDown('KeyC');
      if (i === 260) { input.keyUp('KeyA'); input.keyDown('KeyD'); }
      if (i === 300) input.keyDown('KeyC');
      if (i === 340) input.mouseButton(2, true);
      if (i === 400) input.mouseButton(2, false);
      if (i > 0 && i < 450) input.mouseMove(i % 50 < 25 ? 3 : -2, i % 70 < 35 ? 1 : -1);
      if (i === 450) { input.keyUp('KeyW'); input.keyUp('KeyD'); }
      if (i > 30) maxCorrection = Math.max(maxCorrection, sim.game.correction);
    });
    sim.run(60); // everything acknowledged
    // ~RTT / tick inputs are always in flight; nothing piles up.
    expect(sim.game.pendingInputs).toBeLessThan(12);
    const pred = sim.game.predictedState!;
    expect(pred.pos.x).toBeCloseTo(sim.p.pos.x, 9);
    expect(pred.pos.y).toBeCloseTo(sim.p.pos.y, 9);
    expect(pred.pos.z).toBeCloseTo(sim.p.pos.z, 9);
    expect(pred.weapons[0]!.mag).toBe(sim.p.weapons[0]!.mag);
    expect(pred.shotCounter).toBe(sim.p.shotCounter);
    expect(sim.p.shotCounter).toBeGreaterThan(5);
    expect(pred.recoilPitch).toBeCloseTo(sim.p.recoilPitch, 9);
    // The player actually moved (and was stopped by the wall at x = 6).
    expect(Math.hypot(sim.p.pos.x, sim.p.pos.z)).toBeGreaterThan(3);
    expect(sim.p.pos.x).toBeLessThan(6);
    expect(maxCorrection).toBeLessThan(1e-6);
    const f = sim.game.getFrame();
    expect(f.self!.pos.x).toBeCloseTo(sim.p.pos.x, 6);
  });

  it('smooths small corrections and snaps large ones (server teleport)', () => {
    const world = makeWorld();
    const sim = new Sim(world, 50);
    const input = sim.game.input;
    sim.run(40);
    input.keyDown('KeyW');
    sim.run(30);

    // Small authoritative nudge (0.6 m): rendered position must not jump.
    let nudge = true;
    sim.beforeSnapshot = (p) => {
      if (nudge) { p.pos.x += 0.6; nudge = false; }
    };
    let prev = { ...sim.game.getFrame().self!.pos };
    let maxStep = 0;
    sim.run(40, () => {
      const cur = sim.game.getFrame().self!.pos;
      maxStep = Math.max(maxStep, Math.abs(cur.x - prev.x));
      prev = { ...cur };
    });
    // Walking speed is 4.7 m/s (0.08 m per frame); a popped 0.6 m correction would exceed that.
    expect(maxStep).toBeLessThan(0.2);
    sim.beforeSnapshot = null;
    sim.run(30);
    expect(sim.game.correction).toBeLessThan(0.01);

    // Teleport by 10 m (> 2 m threshold): snaps.
    let tp = true;
    sim.beforeSnapshot = (p) => {
      if (tp) { p.pos.x += 10; tp = false; }
    };
    const before = sim.game.getFrame().self!.pos.x;
    let jumped = false;
    sim.run(30, () => {
      const x = sim.game.getFrame().self!.pos.x;
      if (x - before > 9) jumped = true;
    });
    expect(jumped).toBe(true);
    expect(sim.game.correction).toBe(0);
    input.keyUp('KeyW');
    sim.run(60);
    expect(sim.game.predictedState!.pos.x).toBeCloseTo(sim.p.pos.x, 9);
  });

  it('predicted shot directions equal the shared items functions (seed, spread, recoil)', () => {
    const world = makeWorld();
    const sim = new Sim(world, 30, armedPlayer());
    const shots: Extract<ClientEvent, { type: 'localShot' }>[] = [];
    sim.game.events.on('localShot', (e) => shots.push(e));
    const input = sim.game.input;
    sim.run(30);
    const yaw = 0.4, pitch = 0.05;
    input.setAim(yaw, pitch);
    input.mouseButton(0, true);
    sim.run(8);
    input.mouseButton(0, false);
    sim.run(30);
    expect(shots.length).toBeGreaterThanOrEqual(2);
    const w = WEAPONS.ar;
    // Shot 0: no recoil, no bloom, standing still.
    const cone0 = spreadCone(w, { ads: 0, speed: 0, airborne: false, stance: 'stand', bloom: 0 });
    const exp0 = shotDirections(w, yaw, pitch, cone0, hash32(SELF, 0));
    expect(shots[0].shotIndex).toBe(0);
    expect(shots[0].ballistic).toBe(false);
    for (let i = 0; i < exp0.length; i++) {
      expect(shots[0].dirs[i].x).toBeCloseTo(exp0[i].x, 12);
      expect(shots[0].dirs[i].y).toBeCloseTo(exp0[i].y, 12);
      expect(shots[0].dirs[i].z).toBeCloseTo(exp0[i].z, 12);
    }
    // Shot 1: aim includes the server recoil of shot 0, bloom decayed for the ticks in between.
    const k0 = recoilForShot(w, 0, hash32(SELF, 0), 'stand', 0);
    const ticks = Math.ceil(fireInterval(w) / TICK_DT - 1e-9);
    const bloom1 = Math.max(0, w.bloomPerShot - w.bloomRecovery * TICK_DT * ticks);
    const cone1 = spreadCone(w, { ads: 0, speed: 0, airborne: false, stance: 'stand', bloom: bloom1 });
    const exp1 = shotDirections(w, yaw + k0.yaw, pitch + k0.pitch, cone1, hash32(SELF, 1));
    expect(shots[1].shotIndex).toBe(1);
    expect(shots[1].dirs[0].x).toBeCloseTo(exp1[0].x, 12);
    expect(shots[1].dirs[0].y).toBeCloseTo(exp1[0].y, 12);
    expect(shots[1].dirs[0].z).toBeCloseTo(exp1[0].z, 12);
    // The camera recoil matches the authoritative recoil once everything is acknowledged.
    const f = sim.game.getFrame();
    expect(f.self!.recoilPitch).toBeCloseTo(sim.p.recoilPitch, 6);
    expect(f.self!.aimPitch).toBeCloseTo(pitch + sim.p.recoilPitch, 6);
  });

  it('does not lean through walls (leaned eye must be visible from the upright eye)', () => {
    const world = makeWorld([{ min: { x: 0.2, y: 0, z: -2 }, max: { x: 0.5, y: 3, z: 2 } }]);
    const env: PredictEnv = {
      world, config: CONFIG, time: 0, plane: null, planeTime: 0, seatVehicle: null, vehicle: null, others: [],
    };
    const ev = createTickEvents();
    const inp = (buttons: number): PlayerInput => ({ seq: 1, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons, stance: 0, slot: -1, rt: 0 });
    const right = basePlayer();
    predictTick(right, createPredictRt(), inp(1 << 7), 0, env, ev); // LEAN_R into the wall at +x
    expect(right.lean).toBe(0);
    const left = basePlayer();
    predictTick(left, createPredictRt(), inp(1 << 6), 0, env, ev); // LEAN_L into open space
    expect(left.lean).toBe(-1);
  });

  it('after the match ended only the aim is predicted', () => {
    const world = makeWorld();
    const env: PredictEnv = {
      world, config: CONFIG, time: 0, plane: null, planeTime: 0, seatVehicle: null, vehicle: null, others: [], ended: true,
    };
    const p = armedPlayer();
    p.use = { item: 'bandage', elapsed: 0, total: 4 };
    const ev = createTickEvents();
    for (let i = 1; i <= 10; i++) {
      predictTick(p, createPredictRt(), {
        seq: i, mx: 0, mz: 1, yaw: 0.5, pitch: 0.1, buttons: 1 | (1 << 3), stance: 0, slot: 0, rt: 0,
      }, 0, env, ev);
    }
    expect(p.pos.x).toBe(0);
    expect(p.pos.z).toBe(0);
    expect(p.yaw).toBe(0.5);
    expect(p.pitch).toBe(0.1);
    expect(p.shotCounter).toBe(0);
    expect(p.weapons[0]!.mag).toBe(30);
    expect(p.use!.elapsed).toBe(0);
  });

  it('predicts the plane jump and the chute with the server rules', () => {
    const world = makeWorld();
    const p = basePlayer();
    p.mode = 'plane';
    const env: PredictEnv = {
      world, config: CONFIG, time: 10, seatVehicle: null, vehicle: null, others: [], planeTime: 10,
      plane: { start: { x: -300, z: 0 }, end: { x: 300, z: 0 }, altitude: 320, speed: 70, startTime: 0, traveled: 200, length: 600, active: true },
    };
    const ev = createTickEvents();
    const rt = createPredictRt();
    const inp = (actions?: PlayerInput['actions']): PlayerInput => ({ seq: 1, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: -1, rt: 0, actions });
    predictTick(p, rt, inp([{ a: 'jump' }]), 0, env, ev);
    expect(ev.leftPlane).toBe(true);
    expect(p.mode).toBe('freefall');
    expect(p.pos.y).toBeLessThan(320);
    expect(p.jumpY).toBeGreaterThan(300);
    // Chute only after MIN_CHUTE_DROP below the jump height.
    predictTick(p, rt, inp([{ a: 'chute' }]), 0, env, ev);
    expect(p.parachuteOpen).toBe(false);
    p.pos.y = p.jumpY - MIN_CHUTE_DROP - 1;
    predictTick(p, rt, inp([{ a: 'chute' }]), 0, env, ev);
    expect(ev.chuteOpened).toBe(true);
    expect(p.mode).toBe('parachute');
  });
});

// ---------------------------------------------------------------------------
// Events & loot
// ---------------------------------------------------------------------------

describe('events and loot', () => {
  it('delivers each server event exactly once and in order across snapshots', () => {
    const t = new StubTransport();
    let now = 0;
    const game = new ClientGame(t, makeInit(), memorySettings(), { world: makeWorld(), now: () => now });
    const got: string[] = [];
    game.events.onAny((e) => {
      if (!e.type.startsWith('local')) got.push(`${e.type}:${'player' in e ? e.player : ''}`);
    });
    const typed: number[] = [];
    game.events.on('jump', (e) => typed.push(e.player));
    const ev = (player: number): GameEvent => ({ type: 'jump', player });
    t.deliver({ t: 'snap', s: snap(1000, { events: [ev(1), ev(2)] }) });
    now += 16; game.update(0.016);
    t.deliver({ t: 'snap', s: snap(1050, { events: [ev(3)] }) });
    t.deliver({ t: 'snap', s: snap(1100, { events: [ev(4), { type: 'land', player: 5, speed: 3 }] }) });
    // A stale / duplicated snapshot is ignored.
    t.deliver({ t: 'snap', s: snap(1050, { events: [ev(3)] }) });
    now += 16; game.update(0.016);
    now += 16; game.update(0.016);
    expect(got).toEqual(['jump:1', 'jump:2', 'jump:3', 'jump:4', 'land:5']);
    expect(typed).toEqual([1, 2, 3, 4]);
  });

  it('applies loot deltas in snapshot order', () => {
    const t = new StubTransport();
    const l = (id: number, x: number): LootItem => ({ id, item: 'bandage', count: 1, pos: { x, y: 0, z: 0 } });
    const game = new ClientGame(t, makeInit([l(10, 1), l(11, 2)]), memorySettings(), { world: makeWorld(), now: () => 0 });
    expect([...game.getFrame().loot.keys()].sort()).toEqual([10, 11]);
    t.deliver({ t: 'snap', s: snap(100, { lootAdd: [l(12, 3), l(13, 4)], lootRemove: [10] }) });
    t.deliver({ t: 'snap', s: snap(150, { lootRemove: [13] }) });
    game.update(0.016);
    expect([...game.getFrame().loot.keys()].sort()).toEqual([11, 12]);
  });

  it('records match results from matchOver', () => {
    const t = new StubTransport();
    const game = new ClientGame(t, makeInit(), memorySettings(), { world: makeWorld(), now: () => 0 });
    t.deliver({ t: 'matchOver', results: { winnerTeam: 0, duration: 100, players: [] } });
    game.update(0.016);
    expect(game.getFrame().results?.winnerTeam).toBe(0);
    game.dispose();
  });
});

// ---------------------------------------------------------------------------
// Interaction prompts
// ---------------------------------------------------------------------------

function view(id: number, pos: Vec3, over: Partial<PlayerView> = {}): PlayerView {
  return {
    id, name: `P${id}`, team: 0, isBot: false, isSelf: false, isTeammate: true, pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0,
    pitch: 0, stance: 'stand', mode: 'ground', life: 'alive', weapon: null, flags: 0, vehicleId: null, seat: -1, hp: 100,
    downedHp: null, gear: [0, 0, 0], age: 0, deadFor: -1, ...over,
  };
}

function vehicleView(id: number, pos: Vec3, over: Partial<VehicleView> = {}): VehicleView {
  return {
    id, type: 'uaz', pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, speed: 0, steer: 0, rpm: 0, hp: 1000,
    fuel: 50, seats: [null, null, null, null], destroyed: false, burning: false, predicted: false, ...over,
  };
}

describe('interaction prompt', () => {
  const world = makeWorld();
  const baseEnv = (over: Partial<InteractionEnv> = {}): InteractionEnv => ({
    world,
    self: {
      id: SELF, team: 0, pos: { x: 0, y: 0, z: 0 }, stance: 'stand', mode: 'ground', life: 'alive', vehicleId: null,
      seat: -1, parachuteOpen: false, jumpY: 0, items: { bandage: 0, firstaid: 0, medkit: 0, energy: 0, fuel: 0, frag: 0 },
    },
    eye: { x: 0, y: 1.62, z: 0 },
    look: { x: 0, y: 0, z: -1 },
    planePos: null,
    players: new Map(),
    vehicles: new Map(),
    nearbyLoot: [],
    training: null,
    ...over,
  });
  const out = (): Interaction => ({ kind: 'pickup', hold: false });
  const loot = (id: number, x: number, z: number): LootItem => ({ id, item: 'ar', count: 1, pos: { x, y: 0, z }, mag: 30 });

  it('plane -> jump only over the map; freefall -> chute after the minimum drop', () => {
    const e = baseEnv();
    e.self.mode = 'plane';
    e.planePos = { x: 0, y: 320, z: 0 };
    expect(resolveInteraction(e, out())?.kind).toBe('jump');
    e.planePos = { x: 900, y: 320, z: 0 };
    expect(resolveInteraction(e, out())).toBeNull();
    e.self.mode = 'freefall';
    e.self.jumpY = 300;
    e.self.pos = { x: 0, y: 295, z: 0 };
    expect(resolveInteraction(e, out())).toBeNull();
    e.self.pos = { x: 0, y: 300 - MIN_CHUTE_DROP - 1, z: 0 };
    const i = resolveInteraction(e, out())!;
    expect(i.kind).toBe('chute');
    expect(interactionAction(i)).toEqual({ a: 'chute' });
  });

  it('prefers the loot under the crosshair, then vehicles, then loot in view', () => {
    const v = vehicleView(50, { x: 3, y: 1, z: 0 });
    const aimed = loot(21, 0, -2.5); // straight ahead (look -z), a bit lower than the eye
    const near = loot(22, -0.8, -1); // nearer but off-crosshair
    const behind = loot(23, 0, 1.5); // behind the player
    const e = baseEnv({
      look: { x: 0, y: -1.62 / Math.hypot(1.62, 2.5), z: -2.5 / Math.hypot(1.62, 2.5) },
      nearbyLoot: [near, aimed, behind],
      vehicles: new Map([[50, v]]),
    });
    let i = resolveInteraction(e, out())!;
    expect(i.kind).toBe('pickup');
    expect(i.targetId).toBe(21);
    expect(interactionAction(i)).toEqual({ a: 'pickup', id: 21 });
    // Without an aimed item the vehicle wins over loose loot.
    e.nearbyLoot = [near, behind];
    i = resolveInteraction(e, out())!;
    expect(i.kind).toBe('enter');
    expect(i.targetId).toBe(50);
    expect(i.seat).toBe(0);
    expect(interactionAction(i)).toEqual({ a: 'enter', id: 50 });
    // No vehicle: nearest loot in view (not the one behind).
    e.vehicles = new Map();
    i = resolveInteraction(e, out())!;
    expect(i.targetId).toBe(22);
    // Occluded loot is not offered.
    e.lineOfSight = () => false;
    expect(resolveInteraction(e, out())).toBeNull();
  });

  it('revive downed teammates (hold), exit when seated, refuel an empty vehicle', () => {
    const mate = view(MATE, { x: 1.2, y: 0, z: 0 }, { life: 'downed' });
    const enemy = view(ENEMY, { x: 0.5, y: 0, z: 0 }, { life: 'downed', isTeammate: false, team: 1 });
    const e = baseEnv({ players: new Map([[MATE, mate], [ENEMY, enemy]]), nearbyLoot: [loot(30, 0, -1)] });
    const i = resolveInteraction(e, out())!;
    expect(i.kind).toBe('revive');
    expect(i.hold).toBe(true);
    expect(i.targetId).toBe(MATE);
    expect(i.name).toBe('P2');

    const seated = baseEnv({ vehicles: new Map([[50, vehicleView(50, { x: 0, y: 0, z: 0 })]]) });
    seated.self.mode = 'vehicle';
    seated.self.vehicleId = 50;
    seated.self.seat = 1;
    expect(resolveInteraction(seated, out())?.kind).toBe('exit');
    // A downed passenger can still get out (the sim allows it); a dead one cannot.
    seated.self.life = 'downed';
    expect(resolveInteraction(seated, out())?.kind).toBe('exit');
    seated.self.life = 'dead';
    expect(resolveInteraction(seated, out())).toBeNull();

    const empty = baseEnv({ vehicles: new Map([[51, vehicleView(51, { x: 2.5, y: 1, z: 0 }, { fuel: 0 })]]) });
    empty.self.items.fuel = 1;
    const r = resolveInteraction(empty, out())!;
    expect(r.kind).toBe('refuel');
    expect(interactionAction(r)).toEqual({ a: 'use', item: 'fuel' });
    // Dead / downed players get no prompt.
    empty.self.life = 'downed';
    expect(resolveInteraction(empty, out())).toBeNull();
  });

  it('mirrors the server line-of-sight rules for revive and vehicle entry', () => {
    const wallBetween = (a: Vec3, b: Vec3) => !((a.x < 0.6 && b.x > 0.6) || (a.x > 0.6 && b.x < 0.6)); // wall at x = 0.6
    const mate = view(MATE, { x: 1.2, y: 0, z: 0 }, { life: 'downed' });
    const e = baseEnv({ players: new Map([[MATE, mate]]), lineOfSight: wallBetween });
    expect(resolveInteraction(e, out())).toBeNull(); // downed teammate behind the wall
    const mate2 = view(MATE, { x: 0.3, y: 0, z: 1.2 }, { life: 'downed', flags: PF.BEING_REVIVED });
    e.players = new Map([[MATE, mate2]]);
    e.lineOfSight = () => true;
    expect(resolveInteraction(e, out())).toBeNull(); // somebody else is already reviving
    e.self.revive = { target: MATE };
    expect(resolveInteraction(e, out())?.kind).toBe('revive'); // ...unless that is us
    e.self.revive = null;
    e.players = new Map();
    // Vehicle entry needs line of sight (precise rule supplied by the game) and a live vehicle.
    const car = vehicleView(50, { x: 2.5, y: 1, z: 0 });
    e.vehicles = new Map([[50, car]]);
    e.vehicleVisible = () => false;
    expect(resolveInteraction(e, out())).toBeNull();
    e.vehicleVisible = () => true;
    expect(resolveInteraction(e, out())?.kind).toBe('enter');
    car.hp = 0; // burning wreck: cannot be entered
    expect(resolveInteraction(e, out())).toBeNull();
  });

  it('performInteraction queues the action into the next input', () => {
    const t = new StubTransport();
    let now = 0;
    const game = new ClientGame(t, makeInit([loot(40, 0, -1.5)]), memorySettings(), { world: makeWorld(), now: () => now });
    const self = selfFrom(basePlayer());
    t.deliver({ t: 'snap', s: snap(0, { self }) });
    game.input.setAim(0, -0.6);
    for (let i = 0; i < 6; i++) { now += 16.7; game.update(0.0167); }
    expect(game.getFrame().interaction?.kind).toBe('pickup');
    t.takeInputs();
    game.input.keyDown('KeyF');
    for (let i = 0; i < 4; i++) { now += 16.7; game.update(0.0167); }
    const inputs = t.takeInputs();
    expect(inputs.some((x) => x.actions?.some((a) => a.a === 'pickup' && a.id === 40))).toBe(true);
    expect(inputs.some((x) => (x.buttons & 32) !== 0)).toBe(true); // BTN.INTERACT while held
  });
});

// ---------------------------------------------------------------------------
// Settings & input
// ---------------------------------------------------------------------------

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
}

describe('settings store', () => {
  it('validates, persists, swaps conflicting binds and notifies', () => {
    const storage = new MemoryStorage();
    storage.setItem('dz.settings', JSON.stringify({ fov: 400, quality: 'insane', invertY: true, keybinds: { jump: 'KeyJ', reload: 42 } }));
    const s = new LocalSettingsStore(storage);
    expect(s.get().fov).toBe(100);
    expect(s.get().quality).toBe('medium');
    expect(s.get().invertY).toBe(true);
    expect(s.get().keybinds.jump).toBe('KeyJ');
    expect(s.get().keybinds.reload).toBe(DEFAULT_KEYBINDS.reload);
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.set({ mouseSensitivity: 2.5, playerName: '  Ace\u0007  ' });
    expect(s.get().playerName).toBe('Ace');
    expect(JSON.parse(storage.getItem('dz.settings')!).mouseSensitivity).toBe(2.5);
    s.setKey('reload', 'KeyF'); // F was interact -> interact gets R
    expect(s.get().keybinds.reload).toBe('KeyF');
    expect(s.get().keybinds.interact).toBe('KeyR');
    s.resetKeybinds();
    expect(s.get().keybinds).toEqual(DEFAULT_KEYBINDS);
    off();
    s.set({ fov: 90 });
    expect(calls).toBe(3);
    // Corrupted storage falls back to defaults.
    storage.setItem('dz.settings', '{nope');
    expect(new LocalSettingsStore(storage).get().fov).toBe(85);
    // No storage at all (Node / private mode) works in memory.
    expect(new LocalSettingsStore(null).get().cameraMode).toBe('tpp');
  });
});

describe('input controller', () => {
  it('maps keys to axes, buttons, stance and slots; jump is a one-tick pulse', () => {
    const settings = memorySettings();
    const ic = new InputController(settings);
    ic.setContext({
      mode: 'ground', life: 'alive', stance: 'stand', seat: -1, weapons: [{ id: 'ar', mag: 30 }, null, { id: 'pistol', mag: 15 }],
      activeSlot: -1, frags: 2, ads: 0, adsZoom: 1, scoped: false,
    });
    ic.keyDown('KeyW');
    ic.keyDown('KeyD');
    ic.keyDown('Space');
    let i = ic.sample(1, 0);
    expect(i.mz).toBe(1);
    expect(i.mx).toBe(1);
    expect(i.buttons & 4).toBe(4); // JUMP
    i = ic.sample(2, 0);
    expect(i.buttons & 4).toBe(0);
    ic.keyDown('KeyC'); // toggle crouch
    expect(ic.sample(3, 0).stance).toBe(1);
    ic.keyUp('KeyC');
    expect(ic.sample(4, 0).stance).toBe(1);
    ic.keyDown('KeyZ'); // prone
    expect(ic.sample(5, 0).stance).toBe(2);
    ic.keyDown('Space'); // stands up from prone instead of jumping
    i = ic.sample(6, 0);
    expect(i.stance).toBe(0);
    expect(i.buttons & 4).toBe(0);
    ic.keyDown('Digit2'); // empty slot: ignored
    expect(ic.sample(7, 0).slot).toBe(-1);
    ic.keyDown('Digit3');
    expect(ic.sample(8, 0).slot).toBe(2);
    expect(ic.slotRequestSeq).toBe(8);
    ic.wheel(1);
    expect(ic.sample(9, 0).slot).toBe(0);
    ic.keyDown('Digit7');
    expect(ic.sample(10, 0).actions).toEqual([{ a: 'use', item: 'bandage' }]);
    // Fire tap shorter than a tick still registers once.
    ic.mouseButton(0, true);
    ic.mouseButton(0, false);
    expect(ic.sample(11, 0).buttons & 1).toBe(1);
    expect(ic.sample(12, 0).buttons & 1).toBe(0);
    // Disabled input releases everything.
    ic.enabled = false;
    expect(ic.sample(13, 0).mz).toBe(0);
  });

  it('mouse look with sensitivity, invert, pitch clamp, ADS zoom scaling and free look', () => {
    const settings = memorySettings();
    const ic = new InputController(settings);
    ic.mouseMove(100, 0);
    expect(ic.yaw).toBeCloseTo(-0.22, 6);
    settings.set({ mouseSensitivity: 2, invertY: true });
    ic.mouseMove(0, 10);
    expect(ic.pitch).toBeCloseTo(0.044, 6);
    for (let k = 0; k < 100; k++) ic.mouseMove(0, -500);
    expect(ic.pitch).toBeCloseTo((-89 * Math.PI) / 180, 6);
    ic.setAim(0, 0);
    ic.setContext({
      mode: 'ground', life: 'alive', stance: 'stand', seat: -1, weapons: [{ id: 'sniper', mag: 5 }, null, null],
      activeSlot: 0, frags: 0, ads: 1, adsZoom: 0.125, scoped: true,
    });
    ic.mouseMove(100, 0);
    expect(ic.yaw).toBeCloseTo(-0.0022 * 2 * 0.125 * 100, 6);
    // Free look rotates only the camera and eases back after release.
    const yaw = ic.yaw;
    ic.keyDown('AltLeft');
    ic.mouseMove(200, 0);
    expect(ic.yaw).toBe(yaw);
    expect(ic.freeYaw).not.toBe(0);
    expect(ic.sample(1, 0).buttons & (1 << 10)).not.toBe(0);
    ic.keyUp('AltLeft');
    for (let k = 0; k < 120; k++) ic.update(1 / 60);
    expect(ic.freeYaw).toBe(0);
    expect(ic.freeLook).toBe(false);
  });

  it('vehicle context: seat keys, handbrake / boost buttons; UI edge events', () => {
    const ic = new InputController(memorySettings());
    ic.setContext({
      mode: 'vehicle', life: 'alive', stance: 'stand', seat: 0, weapons: [null, null, null], activeSlot: -1, frags: 0,
      ads: 0, adsZoom: 1, scoped: false,
    });
    ic.keyDown('Digit3');
    ic.keyDown('Space');
    ic.keyDown('ShiftLeft');
    const i = ic.sample(1, 0);
    expect(i.actions).toEqual([{ a: 'seat', seat: 2 }]);
    expect(i.buttons & (1 << 11)).not.toBe(0); // HANDBRAKE
    expect(i.buttons & (1 << 12)).not.toBe(0); // BOOST
    expect(i.buttons & 4).toBe(0); // no JUMP in a vehicle
    const seen: string[] = [];
    ic.on('toggleInventory', () => seen.push('inv'));
    ic.on('toggleCamera', () => seen.push('cam'));
    ic.on('toggleMap', () => seen.push('map'));
    ic.keyDown('Tab');
    ic.keyDown('KeyV');
    ic.enabled = false;
    ic.keyDown('KeyM'); // UI toggles still work with game input disabled
    expect(seen).toEqual(['inv', 'cam', 'map']);
    expect(ic.cameraMode).toBe('fpp');
  });
});

describe('event bus', () => {
  it('flushes queued events in order, including ones queued during the flush', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.onAny((e) => {
      seen.push(e.type);
      if (e.type === 'localJump') bus.push({ type: 'localLand', speed: 2 });
    });
    bus.push({ type: 'localJump' });
    bus.push({ type: 'localSnapshot' });
    bus.flush();
    bus.flush();
    expect(seen).toEqual(['localJump', 'localSnapshot', 'localLand']);
  });
});

// ---------------------------------------------------------------------------
// Parity with the real authoritative simulation
// ---------------------------------------------------------------------------

import { MatchRunner } from '../src/shared/sim';
import { generateWorld } from '../src/shared/world';
import { validateClientMessage } from '../src/shared/validate';

/** ClientGame <-> real MatchRunner over a JSON loopback with symmetric latency. */
class Loopback {
  now = 1000;
  game: ClientGame | null = null;
  readonly transport = new StubTransport('ws');
  readonly runner: MatchRunner;
  private readonly wire: { at: number; fn: () => void }[] = [];
  private nextRunner = this.now;

  constructor(readonly config: MatchConfig, readonly latencyMs: number) {
    this.runner = new MatchRunner({
      config,
      clients: [{
        id: 'c1', name: 'Tester', team: null,
        send: (msg) => {
          const wireMsg = JSON.parse(JSON.stringify(msg)) as ServerMessage;
          this.later(() => {
            if (wireMsg.t === 'matchInit') {
              this.game = new ClientGame(this.transport, wireMsg.init, memorySettings(), {
                world: generateWorld(config.seed, config.mode === 'training' ? 'training' : 'island'),
                now: () => this.now,
              });
            } else {
              this.transport.deliver(wireMsg);
            }
          });
        },
      }],
    });
    this.runner.start(this.now);
  }

  private later(fn: () => void): void {
    this.wire.push({ at: this.now + this.latencyMs, fn });
  }

  frame(): void {
    const target = this.now + 1000 / 60;
    while (true) {
      const next = Math.min(this.nextRunner, ...this.wire.map((w) => w.at));
      if (next > target) break;
      this.now = next;
      for (let i = 0; i < this.wire.length; i++) {
        if (this.wire[i].at <= this.now) {
          this.wire.splice(i, 1)[0].fn();
          i--;
        }
      }
      if (this.nextRunner <= this.now) {
        this.runner.update(this.now);
        this.nextRunner += 4;
      }
    }
    this.now = target;
    if (!this.game) return;
    this.game.update(1 / 60);
    for (const m of this.transport.sent.splice(0)) {
      const raw = JSON.parse(JSON.stringify(m));
      this.later(() => {
        const v = validateClientMessage(raw);
        if (v) this.runner.handleMessage('c1', v);
      });
    }
  }

  run(frames: number, each?: (i: number) => void): void {
    for (let i = 0; i < frames; i++) {
      each?.(i);
      this.frame();
    }
  }
}

describe('parity with the real GameSim', () => {
  it('predicts movement, stance, ADS and spraying without corrections (training ground, 60 ms latency)', () => {
    const lb = new Loopback({ ...CONFIG, mode: 'training', maxPlayers: 4, teamSize: 1, infiniteAmmo: true }, 60);
    lb.run(30);
    const game = lb.game!;
    expect(game).not.toBeNull();
    game.queueAction({ a: 'give', item: 'ar' });
    lb.run(20);
    const input = game.input;
    input.keyDown('Digit1');
    lb.run(60);
    expect(game.getFrame().self!.weapon).toBe('ar');

    // Item use cancelled by sprinting: the sim cancels the use BEFORE computing the speed multiplier.
    game.queueAction({ a: 'give', item: 'energy' });
    lb.run(20);
    game.queueAction({ a: 'use', item: 'energy' });
    const useCorr: number[] = [];
    let sawUse = false;
    lb.run(110, (i) => {
      if (i === 0) input.keyDown('KeyW');
      if (game.getFrame().self!.use) sawUse = true;
      if (i === 60) input.keyDown('ShiftLeft');
      if (i === 70) { input.keyUp('ShiftLeft'); input.keyUp('KeyW'); }
      if (i === 80) input.keyDown('KeyQ'); // lean while standing still
      if (i === 100) input.keyUp('KeyQ');
      useCorr.push(game.correction);
    });
    expect(sawUse).toBe(true);
    expect(game.getFrame().self!.use).toBeNull();
    expect(Math.max(...useCorr)).toBeLessThan(1e-6);

    const corrections: number[] = [];
    let shots = 0;
    game.events.on('localShot', () => shots++);
    lb.run(900, (i) => {
      if (i === 0) input.keyDown('KeyW');
      if (i === 60) input.keyDown('ShiftLeft');
      if (i === 120) input.keyDown('Space');
      if (i === 121) input.keyUp('Space');
      if (i === 180) { input.keyUp('ShiftLeft'); input.keyDown('KeyA'); }
      if (i === 240) input.mouseButton(0, true);
      if (i === 300) input.mouseButton(0, false);
      if (i === 330) input.keyDown('KeyC');
      if (i === 400) { input.keyUp('KeyA'); input.keyDown('KeyD'); }
      if (i === 460) input.keyDown('KeyC');
      if (i === 500) input.mouseButton(2, true);
      if (i === 520) input.mouseButton(0, true);
      if (i === 560) input.mouseButton(0, false);
      if (i === 600) input.mouseButton(2, false);
      if (i === 640) input.keyDown('KeyR');
      if (i === 641) input.keyUp('KeyR');
      if (i > 0 && i < 750) input.mouseMove(i % 60 < 30 ? 4 : -3, i % 90 < 45 ? 1 : -1);
      if (i === 750) { input.keyUp('KeyW'); input.keyUp('KeyD'); }
      corrections.push(game.correction);
    });
    const maxCorrection = Math.max(...corrections);
    expect(shots).toBeGreaterThan(10);
    // Prediction runs the same rules as the server: corrections stay at numerical noise.
    expect(maxCorrection).toBeLessThan(0.02);
    const sim = lb.runner.sim;
    const me = [...sim.players.values()].find((p) => !p.isBot)!;
    const pred = game.predictedState!;
    expect(pred.pos.x).toBeCloseTo(me.pos.x, 4);
    expect(pred.pos.z).toBeCloseTo(me.pos.z, 4);
    expect(pred.shotCounter).toBe(me.shotCounter);
    expect(pred.recoilPitch).toBeCloseTo(me.recoilPitch, 6);
    expect(pred.weapons[0]?.mag).toBe(me.weapons[0]?.mag);
  });

  it('predicts the plane jump, freefall, chute and landing on the island (BR, 60 ms latency)', () => {
    const lb = new Loopback({ ...CONFIG, mode: 'br', maxPlayers: 2, teamSize: 1, seed: 11 }, 60);
    lb.run(30);
    const game = lb.game!;
    const sim = lb.runner.sim;
    expect(game.getFrame().self?.mode).toBe('plane');
    expect(game.getFrame().planePos).not.toBeNull(); // visible even while parked for loading
    lb.runner.handleMessage('c1', { t: 'loaded' });
    // Wait until the plane is over the island, then jump.
    let guard = 0;
    while (game.getFrame().interaction?.kind !== 'jump' && guard++ < 2000) lb.frame();
    expect(game.getFrame().interaction?.kind).toBe('jump');
    const planeAtJump = { ...game.getFrame().planePos! };
    game.performInteraction();
    const modes = new Set<string>();
    const corrections: number[] = [];
    let chuteAsked = false;
    let landed = false;
    game.events.on('localLand', () => { landed = true; });
    for (let i = 0; i < 3000 && !(landed && i > 200); i++) {
      const self = game.getFrame().self!;
      if (i === 5) {
        // The predicted jump starts next to where the plane was drawn.
        expect(Math.hypot(self.pos.x - planeAtJump.x, self.pos.z - planeAtJump.z)).toBeLessThan(15);
      }
      if (self.mode === 'freefall' && i > 60 && !chuteAsked && game.getFrame().interaction?.kind === 'chute') {
        game.performInteraction();
        chuteAsked = true;
      }
      game.input.keyDown('KeyW');
      if (i % 120 === 0) game.input.mouseMove(40, 0);
      modes.add(self.mode);
      if (i > 3) corrections.push(game.correction);
      lb.frame();
    }
    game.input.keyUp('KeyW');
    lb.run(60);
    expect(modes.has('freefall')).toBe(true);
    expect(modes.has('parachute')).toBe(true);
    expect(landed).toBe(true);
    const me = [...sim.players.values()].find((p) => !p.isBot)!;
    expect(me.mode === 'ground' || me.mode === 'swim').toBe(true);
    expect(Math.max(...corrections)).toBeLessThan(0.05);
    expect(game.predictedState!.pos.x).toBeCloseTo(me.pos.x, 3);
    expect(game.predictedState!.pos.z).toBeCloseTo(me.pos.z, 3);
  });

  it('predicts the driven vehicle with stepVehicle (driver seat, 60 ms latency)', () => {
    const lb = new Loopback({ ...CONFIG, mode: 'training', maxPlayers: 4, teamSize: 1, infiniteAmmo: true }, 60);
    lb.run(30);
    const game = lb.game!;
    const sim = lb.runner.sim;
    const me = [...sim.players.values()].find((p) => !p.isBot)!;
    const car = [...sim.vehicles.values()].find((v) => v.type === 'buggy')!;
    // Server-side "teleport" next to the car (the client snaps to the authoritative position).
    me.pos.x = car.pos.x + 3;
    me.pos.z = car.pos.z;
    me.pos.y = sim.world.groundAt(me.pos.x, me.pos.z, car.pos.y + 2);
    me.vel.x = me.vel.y = me.vel.z = 0;
    lb.run(30);
    expect(game.getFrame().interaction?.kind).toBe('enter');
    game.performInteraction();
    lb.run(30);
    expect(game.getFrame().self!.vehicleId).toBe(car.id);
    expect(game.getFrame().self!.seat).toBe(0);
    expect(game.getFrame().vehicles.get(car.id)!.predicted).toBe(true);
    const input = game.input;
    input.setAim(car.yaw, 0);
    const vCorr: number[] = [];
    let maxSpeed = 0;
    lb.run(420, (i) => {
      if (i === 0) input.keyDown('KeyW');
      if (i === 150) input.keyDown('KeyD');
      if (i === 220) { input.keyUp('KeyD'); input.keyDown('KeyA'); }
      if (i === 300) { input.keyUp('KeyA'); input.keyUp('KeyW'); input.keyDown('KeyS'); }
      if (i > 5) vCorr.push(game.vehicleCorrection);
      maxSpeed = Math.max(maxSpeed, Math.abs(game.getFrame().vehicles.get(car.id)!.speed));
    });
    input.keyUp('KeyS');
    expect(maxSpeed).toBeGreaterThan(10);
    // The vehicle state on the wire is quantised (cm / mrad): corrections stay tiny and smooth.
    expect(Math.max(...vCorr)).toBeLessThan(0.1);
    const pv = game.predictedVehicle!;
    expect(Math.hypot(pv.pos.x - car.pos.x, pv.pos.z - car.pos.z)).toBeLessThan(car.vel.x ** 2 + car.vel.z ** 2 > 1 ? 3 : 0.1);
    // The rider is drawn at the driver seat of the predicted vehicle.
    const f = game.getFrame();
    expect(Math.hypot(f.self!.pos.x - f.vehicles.get(car.id)!.pos.x, f.self!.pos.z - f.vehicles.get(car.id)!.pos.z)).toBeLessThan(2);
  });
});


// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { LocalMatchHost } from '../src/client/net/localHost';
import { WsTransport } from '../src/client/net';

describe('single-player host (worker logic) end to end', () => {
  it('runs a local training match through the full protocol path', () => {
    let now = 0;
    const transport = new StubTransport('local');
    let game: ClientGame | null = null;
    const posted: string[] = [];
    const host = new LocalMatchHost({
      now: () => now,
      autoLoop: false,
      post: (m) => {
        posted.push(m.t);
        const msg = structuredClone(m);
        if (msg.t === 'matchInit') game = new ClientGame(transport, msg.init, memorySettings(), { now: () => now });
        else transport.deliver(msg);
      },
    });
    // Garbage is ignored exactly like on the server.
    host.receive({ t: 'input', inputs: [{ seq: Number.NaN }] });
    host.receive('{"t":"ping"');
    expect(host.running).toBe(false);
    host.receive({
      t: 'startLocal', name: 'Solo',
      config: { ...CONFIG, mode: 'training', maxPlayers: 4, teamSize: 1, botFill: true, infiniteAmmo: true },
    });
    expect(posted[0]).toBe('matchInit');
    host.receive({ t: 'loaded' }); // scene ready: forwarded to the runner (releases a held plane)
    const g = game as unknown as ClientGame;
    expect(g.world.kind).toBe('training');
    const step = (frames: number, each?: (i: number) => void) => {
      for (let i = 0; i < frames; i++) {
        each?.(i);
        now += 1000 / 60;
        host.tick();
        g.update(1 / 60);
        for (const m of transport.sent.splice(0)) host.receive(structuredClone(m));
      }
    };
    step(30);
    const start = { ...g.getFrame().self!.pos };
    expect(g.getFrame().phase).toBe('playing');
    g.input.keyDown('KeyW');
    let maxCorrection = 0;
    step(90, () => { maxCorrection = Math.max(maxCorrection, g.correction); });
    g.input.keyUp('KeyW');
    step(20);
    const f = g.getFrame();
    expect(Math.hypot(f.self!.pos.x - start.x, f.self!.pos.z - start.z)).toBeGreaterThan(3);
    expect(maxCorrection).toBeLessThan(0.01);
    expect(f.ping).toBe(0);
    expect(f.trainingTargets.length).toBeGreaterThan(0);
    expect(posted.filter((t) => t === 'pong').length).toBeGreaterThan(0);
    // An exception while handling in-match traffic is logged, never fatal for the worker.
    const runner = host.matchRunner!;
    const original = runner.handleMessage.bind(runner);
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      runner.handleMessage = () => { throw new Error('boom'); };
      expect(() => host.receive({ t: 'ping', c: 1 })).not.toThrow();
      expect(errors.length).toBe(1);
    } finally {
      runner.handleMessage = original;
      console.error = origError;
    }
    expect(host.running).toBe(true);
    host.receive({ t: 'leaveMatch' });
    expect(posted[posted.length - 1]).toBe('backToLobby');
    expect(host.running).toBe(false);
    g.dispose();
  });
});

describe('WsTransport', () => {
  it('connects, exchanges JSON messages and reports close', async () => {
    const wss = new WebSocketServer({ port: 0, path: '/ws' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    wss.on('connection', (sock) => {
      sock.on('message', (data) => {
        const msg = JSON.parse(String(data)) as ClientMessage;
        if (msg.t === 'ping') {
          sock.send(JSON.stringify({ t: 'pong', c: msg.c, s: 42 }));
          sock.send('not json');
          sock.send(JSON.stringify({ t: 'backToLobby' }));
        }
      });
    });
    try {
      const t = await WsTransport.connect(`ws://127.0.0.1:${port}/ws`);
      expect(t.kind).toBe('ws');
      const got: ServerMessage[] = [];
      t.onMessage((m) => got.push(m));
      const closed = new Promise<void>((r) => t.onClose(() => r()));
      t.send({ t: 'ping', c: 7 });
      await new Promise<void>((r) => {
        const iv = setInterval(() => { if (got.length >= 2) { clearInterval(iv); r(); } }, 5);
      });
      expect(got[0]).toEqual({ t: 'pong', c: 7, s: 42 });
      expect(got[1]).toEqual({ t: 'backToLobby' });
      for (const c of wss.clients) c.close();
      await closed;
      t.send({ t: 'ping', c: 8 }); // no-op once closed
      await expect(WsTransport.connect('ws://127.0.0.1:1/ws', 2000)).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
