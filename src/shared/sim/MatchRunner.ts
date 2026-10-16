// MatchRunner: wraps a GameSim behind the network protocol. Used by the Node server (one per
// lobby) and by the single-player Web Worker. Fixed-step accumulator, bot driver, per-client
// input rate limiting, event routing by audience and interest-managed snapshots.

import {
  INPUT_BURST, INPUT_RATE_SLACK, RELEVANCE_BANDS, SNAPSHOT_RATE, TICK_DT, TICK_MS, TICK_RATE,
} from '../constants';
import type {
  ClientMessage, MatchInit, NetPlayer, NetProjectile, NetVehicle, RosterEntry, ServerMessage, Snapshot,
} from '../protocol';
import type { EntityId, GameEvent, LootItem, MatchConfig, MatchResults, PlayerState, TeamId, Vec3 } from '../types';
import { sanitizeInput } from '../validate';
import { teamsInGame } from './combat';
import { GameSim } from './GameSim';
import { netPlayer, netProjectile, netVehicle, selfState } from './snapshot';
import {
  COMBAT_RELEVANCE_TIME, DEAD_VISIBLE_TIME, MAX_CATCHUP_TICKS, PROJECTILE_RELEVANCE,
} from './tuning';
import type { BotDriver, SimEvent, SimView } from './view';

export interface RunnerClient {
  id: string;
  name: string;
  team: TeamId | null;
  send(msg: ServerMessage): void;
}

export interface MatchRunnerOptions {
  config: MatchConfig;
  clients: RunnerClient[];
  botDriverFactory?: (sim: SimView) => BotDriver;
  onEnd?: (results: MatchResults) => void;
}

interface ClientEntry {
  c: RunnerClient;
  playerId: EntityId | null;
  /** Input token bucket. */
  tokens: number;
  lastSeq: number;
  /** Events routed to this client since its last snapshot. */
  outbox: GameEvent[];
  /** Other player id -> sim time of the last damage exchanged with this client's player. */
  combat: Map<EntityId, number>;
  /** Dead players already reported in `gone`. */
  gone: Set<EntityId>;
  view: Vec3;
  hasView: boolean;
  /** Snapshots sent to this client (the first one carries every entity). */
  sent: number;
}

const SNAP_INTERVAL_MS = 1000 / SNAPSHOT_RATE;
/** Parked (sleeping) vehicles never change: refresh them every 2 s only (clients keep them 10 s). */
const SLEEPING_VEHICLE_EVERY = 40;
const TIMING_WINDOW = 300;

function now(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : 0;
}

/** Longest the plane waits for slow clients to finish loading (ms). */
export const LOAD_HOLD_MAX_MS = 15000;

export class MatchRunner {
  private loaded = new Set<string>();
  private holdUntil = 0;
  readonly sim: GameSim;
  private readonly entries = new Map<string, ClientEntry>();
  private readonly entryList: ClientEntry[] = [];
  private readonly botDriverFactory?: (sim: SimView) => BotDriver;
  private readonly onEnd?: (results: MatchResults) => void;
  private driver: BotDriver | null = null;
  private started = false;
  private endFired = false;
  private lastNow = 0;
  private acc = 0;
  private snapAcc = 0;
  private snapCount = 0;
  private readonly pendingAdd = new Map<EntityId, LootItem>();
  private pendingRemove: EntityId[] = [];
  private readonly tickTimes = new Float64Array(TIMING_WINDOW);
  private tickTimeCount = 0;
  private tickTimeIdx = 0;
  // Per-snapshot caches (shared between clients).
  private readonly npPublic = new Map<EntityId, NetPlayer>();
  private readonly npTeam = new Map<EntityId, NetPlayer>();
  private readonly nvCache = new Map<EntityId, NetVehicle>();
  private readonly projCache: NetProjectile[] = [];

  constructor(opts: MatchRunnerOptions) {
    this.sim = new GameSim(opts.config);
    this.botDriverFactory = opts.botDriverFactory;
    this.onEnd = opts.onEnd;
    for (const c of opts.clients) {
      if (this.entries.has(c.id)) continue;
      const e: ClientEntry = {
        c, playerId: null, tokens: INPUT_BURST, lastSeq: -1, outbox: [], combat: new Map(), gone: new Set(),
        view: { x: 0, y: 0, z: 0 }, hasView: false, sent: 0,
      };
      this.entries.set(c.id, e);
      this.entryList.push(e);
    }
  }

  /** Add players, fill bots, start the sim and send matchInit (+ a first snapshot) to everyone. */
  start(nowMs: number): void {
    if (this.started) return;
    this.started = true;
    const sim = this.sim;
    for (const e of this.entryList) {
      const id = sim.addPlayer({ name: e.c.name, isBot: false, team: e.c.team ?? undefined });
      e.playerId = id >= 0 ? id : null;
    }
    if (sim.config.botFill) sim.fillBots();
    if (this.botDriverFactory) this.driver = this.botDriverFactory(sim);
    // Battle royale: park the plane until every client has built its scene, so nobody loses
    // flight time to loading (bounded by LOAD_HOLD_MAX_MS so one slow client can't stall a match).
    sim.holdPlane = sim.config.mode === 'br' && this.entryList.length > 0;
    sim.start();
    this.holdUntil = nowMs + LOAD_HOLD_MAX_MS;
    this.lastNow = nowMs;
    this.acc = 0;
    this.snapAcc = 0;
    this.routeEvents(sim.drainEvents());
    this.collectLoot();
    const roster: RosterEntry[] = sim.playerList.map((p) => ({ id: p.id, name: p.name, team: p.team, isBot: p.isBot }));
    const loot = Array.from(sim.loot.values());
    for (const e of this.entryList) {
      const p = e.playerId !== null ? sim.players.get(e.playerId) : undefined;
      const init: MatchInit = {
        config: { ...sim.config },
        you: e.playerId,
        team: p ? p.team : 0,
        roster,
        loot,
        time: sim.time * 1000,
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
      };
      e.c.send({ t: 'matchInit', init });
    }
    this.sendSnapshots();
  }

  /** Release a held plane once all clients reported 'loaded' (or the hold timed out). */
  private checkHold(nowMs: number): void {
    if (!this.sim.isPlaneHeld) return;
    let all = true;
    for (const e of this.entryList) if (!this.loaded.has(e.c.id)) { all = false; break; }
    if (all || nowMs >= this.holdUntil) this.sim.releasePlane();
  }

  /** Advance the fixed-step simulation to `nowMs` and send due snapshots. */
  update(nowMs: number): void {
    if (!this.started) return;
    this.checkHold(nowMs);
    let elapsed = nowMs - this.lastNow;
    this.lastNow = nowMs;
    if (!(elapsed > 0)) elapsed = 0;
    this.acc += elapsed;
    let ticks = 0;
    let snapDue = false;
    let endedNow = false;
    const sim = this.sim;
    while (this.acc >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
      this.acc -= TICK_MS;
      ticks++;
      const t0 = now();
      if (this.driver) this.driver.update(TICK_DT);
      sim.step();
      this.recordTiming(now() - t0);
      this.routeEvents(sim.drainEvents());
      this.collectLoot();
      for (const e of this.entryList) {
        e.tokens = Math.min(INPUT_BURST, e.tokens + INPUT_RATE_SLACK);
      }
      this.snapAcc += TICK_MS;
      if (this.snapAcc >= SNAP_INTERVAL_MS - 1e-6) {
        this.snapAcc -= SNAP_INTERVAL_MS;
        snapDue = true;
      }
      if (!this.endFired && sim.isOver()) {
        this.endFired = true;
        endedNow = true;
        snapDue = true;
      }
    }
    // Too far behind (stalled host): drop the backlog instead of spiralling.
    if (this.acc >= TICK_MS) this.acc %= TICK_MS;
    if (snapDue) this.sendSnapshots();
    if (endedNow && this.onEnd) this.onEnd(sim.results());
  }

  handleMessage(clientId: string, msg: ClientMessage): void {
    const e = this.entries.get(clientId);
    if (!e || !msg) return;
    switch (msg.t) {
      case 'input': {
        if (e.playerId === null || !Array.isArray(msg.inputs)) return;
        for (const raw of msg.inputs) {
          const inp = sanitizeInput(raw);
          if (!inp || inp.seq <= e.lastSeq) continue;
          if (e.tokens < 1) break;
          e.tokens -= 1;
          e.lastSeq = inp.seq;
          this.sim.queueInput(e.playerId, inp);
        }
        break;
      }
      case 'ping':
        if (typeof msg.c === 'number' && Number.isFinite(msg.c)) {
          e.c.send({ t: 'pong', c: msg.c, s: this.sim.time * 1000 + this.acc });
        }
        break;
      case 'loaded':
        this.loaded.add(clientId);
        break;
      case 'leaveMatch':
        this.removeClient(clientId);
        break;
      default:
        break;
    }
  }

  /** Client left / disconnected: a bot takes over its player; it receives nothing more. */
  removeClient(clientId: string): void {
    const e = this.entries.get(clientId);
    if (!e) return;
    this.entries.delete(clientId);
    const i = this.entryList.indexOf(e);
    if (i >= 0) this.entryList.splice(i, 1);
    if (e.playerId !== null) {
      this.sim.removePlayer(e.playerId);
      if (this.driver && this.driver.onPlayerRemoved) this.driver.onPlayerRemoved(e.playerId);
    }
  }

  isOver(): boolean {
    return this.sim.isOver();
  }

  /** Tick timing over the last TIMING_WINDOW ticks (~10 s), player and bot counts. */
  stats(): { tickMsAvg: number; tickMsMax: number; players: number; bots: number } {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < this.tickTimeCount; i++) {
      const t = this.tickTimes[i];
      sum += t;
      if (t > max) max = t;
    }
    let bots = 0;
    for (const p of this.sim.playerList) if (p.isBot) bots++;
    const r = {
      tickMsAvg: this.tickTimeCount > 0 ? sum / this.tickTimeCount : 0,
      tickMsMax: max,
      players: this.sim.players.size,
      bots,
    };
    return r;
  }

  // ===========================================================================================

  private recordTiming(ms: number): void {
    this.tickTimes[this.tickTimeIdx] = ms;
    this.tickTimeIdx = (this.tickTimeIdx + 1) % TIMING_WINDOW;
    if (this.tickTimeCount < TIMING_WINDOW) this.tickTimeCount++;
  }

  private collectLoot(): void {
    const d = this.sim.drainLootDelta();
    for (const it of d.added) this.pendingAdd.set(it.id, it);
    for (const id of d.removed) {
      if (this.pendingAdd.has(id)) this.pendingAdd.delete(id);
      else this.pendingRemove.push(id);
    }
  }

  /** Viewpoint of a client: its player, or the spectated player while dead. */
  private updateView(e: ClientEntry): void {
    e.hasView = false;
    if (e.playerId === null) return;
    const sim = this.sim;
    let p = sim.players.get(e.playerId);
    if (!p) return;
    if (p.life === 'dead' && p.spectating !== null) p = sim.players.get(p.spectating) ?? p;
    e.view.x = p.pos.x; e.view.y = p.pos.y; e.view.z = p.pos.z;
    e.hasView = true;
  }

  private routeEvents(events: SimEvent[]): void {
    if (events.length === 0) return;
    const list = this.entryList;
    for (const e of list) this.updateView(e);
    const t = this.sim.time;
    for (const se of events) {
      const ev = se.ev;
      if (ev.type === 'hit') this.noteCombat(ev.attacker, ev.victim, t);
      for (const e of list) {
        if (se.to) {
          if (e.playerId === null || se.to.indexOf(e.playerId) < 0) continue;
        } else if (se.pos && se.range !== undefined && e.hasView) {
          const dx = se.pos.x - e.view.x, dy = se.pos.y - e.view.y, dz = se.pos.z - e.view.z;
          if (dx * dx + dy * dy + dz * dz > se.range * se.range) continue;
        }
        e.outbox.push(ev);
      }
    }
  }

  private noteCombat(a: EntityId, v: EntityId, t: number): void {
    for (const e of this.entryList) {
      if (e.playerId === a) e.combat.set(v, t);
      else if (e.playerId === v) e.combat.set(a, t);
    }
  }

  private bandEvery(dx: number, dy: number, dz: number): number {
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    for (const b of RELEVANCE_BANDS) if (d <= b.maxDist) return b.every;
    return RELEVANCE_BANDS[RELEVANCE_BANDS.length - 1].every;
  }

  private sendSnapshots(): void {
    const sim = this.sim;
    this.snapCount++;
    const n = this.snapCount;
    const time = sim.time;
    // Shared per-snapshot encodings.
    this.npPublic.clear();
    this.npTeam.clear();
    this.nvCache.clear();
    this.projCache.length = 0;
    for (const pr of sim.projList) this.projCache.push(netProjectile(pr));
    let alive = 0;
    for (const p of sim.playerList) if (p.life !== 'dead') alive++;
    const teamsAlive = teamsInGame(sim);
    const lootAdd = this.pendingAdd.size > 0 ? Array.from(this.pendingAdd.values()) : undefined;
    const lootRemove = this.pendingRemove.length > 0 ? this.pendingRemove : undefined;
    this.pendingAdd.clear();
    this.pendingRemove = [];
    const zone = { ...sim.zone };
    zone.cx = Math.round(zone.cx * 100) / 100;
    zone.cz = Math.round(zone.cz * 100) / 100;
    zone.r = Math.round(zone.r * 100) / 100;
    zone.nx = Math.round(zone.nx * 100) / 100;
    zone.nz = Math.round(zone.nz * 100) / 100;
    zone.timer = Math.round(zone.timer * 100) / 100;
    const plane = sim.plane && (sim.phase === 'plane' || sim.plane.active)
      ? { ...sim.plane, start: { ...sim.plane.start }, end: { ...sim.plane.end } }
      : null;

    for (const e of this.entryList) {
      this.updateView(e);
      const me = e.playerId !== null ? sim.players.get(e.playerId) ?? null : null;
      const full = e.sent === 0;
      e.sent++;
      const vx = e.hasView ? e.view.x : 0, vy = e.hasView ? e.view.y : 0, vz = e.hasView ? e.view.z : 0;
      const players: NetPlayer[] = [];
      let gone: EntityId[] | undefined;
      for (const p of sim.playerList) {
        if (p.life === 'dead' && p !== me && time - p.stats.deathTime > DEAD_VISIBLE_TIME) {
          if (!e.gone.has(p.id)) {
            e.gone.add(p.id);
            (gone ??= []).push(p.id);
          }
          continue;
        }
        if (p.life !== 'dead' && e.gone.has(p.id)) e.gone.delete(p.id);
        const mate = me !== null && p.team === me.team;
        let always = full || p === me || mate;
        if (!always && me) {
          const lt = e.combat.get(p.id);
          always = lt !== undefined && time - lt <= COMBAT_RELEVANCE_TIME;
        }
        if (!always) {
          const every = p.mode === 'plane'
            ? RELEVANCE_BANDS[RELEVANCE_BANDS.length - 1].every
            : this.bandEvery(p.pos.x - vx, p.pos.y - vy, p.pos.z - vz);
          if ((n + p.id) % every !== 0) continue;
        }
        players.push(this.encodePlayer(p, mate));
      }
      const vehicles: NetVehicle[] = [];
      for (const v of sim.vehicleList) {
        const mine = me !== null && me.vehicleId === v.id;
        if (!mine && !full) {
          const vrt = sim.vrtById.get(v.id);
          const every = vrt && vrt.asleep
            ? SLEEPING_VEHICLE_EVERY
            : this.bandEvery(v.pos.x - vx, v.pos.y - vy, v.pos.z - vz);
          if ((n + v.id) % every !== 0) continue;
        }
        let nv = this.nvCache.get(v.id);
        if (!nv) {
          nv = netVehicle(v);
          this.nvCache.set(v.id, nv);
        }
        vehicles.push(nv);
      }
      const projectiles: NetProjectile[] = [];
      const pr2 = PROJECTILE_RELEVANCE * PROJECTILE_RELEVANCE;
      for (const np of this.projCache) {
        const dx = np.p[0] - vx, dy = np.p[1] - vy, dz = np.p[2] - vz;
        if (!e.hasView || dx * dx + dy * dy + dz * dz <= pr2) projectiles.push(np);
      }
      const s: Snapshot = {
        tick: sim.tick,
        time: Math.round(time * 1000 * 1000) / 1000,
        phase: sim.phase,
        alive,
        teamsAlive,
        zone,
        plane,
        players,
        vehicles,
        projectiles,
        self: me ? selfState(me) : null,
        events: e.outbox,
      };
      if (gone) s.gone = gone;
      if (lootAdd) s.lootAdd = lootAdd;
      if (lootRemove) s.lootRemove = lootRemove;
      e.outbox = [];
      e.c.send({ t: 'snap', s });
    }
  }

  private encodePlayer(p: PlayerState, withHp: boolean): NetPlayer {
    const cache = withHp ? this.npTeam : this.npPublic;
    let np = cache.get(p.id);
    if (!np) {
      np = netPlayer(this.sim, p, withHp);
      cache.set(p.id, np);
    }
    return np;
  }
}
