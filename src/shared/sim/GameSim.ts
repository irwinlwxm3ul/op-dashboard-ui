// Authoritative game simulation (one match). Runs identically on the Node server and inside the
// single-player Web Worker. Implements SimView for the bot AI and the MatchRunner.
//
// Tick order (TICK_DT): plane -> players (input, actions, movement, weapons, healing, revive,
// bleed) -> projectiles -> vehicles (+ occupants follow) -> zone -> dead-player upkeep ->
// time advance -> lag-compensation history -> noise pruning -> player grid.
// Hitscan shots and projectile segments are tested against the hitbox history (newest sample =
// start of the tick), so results never depend on the order in which players are processed.

import { MAX_PLAYERS, PLANE_ALTITUDE, TICK_DT } from '../constants';
import { eyePosition, prepareRaycastWorld } from '../physics';
import { Rng, hash32 } from '../rng';
import type {
  EntityId, GameEvent, ItemId, LootItem, MatchConfig, MatchPhase, MatchResults, PlaneState, PlayerInput,
  PlayerResult, PlayerState, Projectile, TeamId, Vec3, VehicleState, WeaponId, HitPart, World, ZoneState,
  Hitbox,
} from '../types';
import { generateWorld } from '../world';
import { buildHitboxes } from '../physics';
import type { NoiseEvent, SimEvent, SimView } from './view';
import { jumpFromPlane } from './actions';
import { TraceScratch, cancelRevive, damageInfo, damagePlayer, pickSpectateTarget } from './combat';
import { PlayerGrid } from './grid';
import { HitboxHistory, createPose } from './lagcomp';
import { LootManager } from './loot';
import { generateBotName } from './names';
import { createPlane } from './plane';
import { updatePlayer } from './playerTick';
import type { PlayerRt } from './players';
import { createPlayerRt, createPlayerState, pushInput, resetInput } from './players';
import { updateProjectiles } from './projectiles';
import { createTrainingState, emitTargetHit, respawnPlayer } from './training';
import type { TrainingState } from './training';
import { NOISE_LIFETIME, PLANE_AUTO_EJECT } from './tuning';
import type { VehicleRt } from './vehiclesSim';
import { ejectFromVehicle, spawnVehicles, stepVehicles, syncOccupants } from './vehiclesSim';
import { ZoneController, createZone, outsideZone } from './zone';

export interface TeamInfo {
  id: TeamId;
  members: PlayerState[];
  eliminated: boolean;
  placement: number;
}

const ZONE_INFO = damageInfo(null, 'zone');

export class GameSim implements SimView {
  readonly config: MatchConfig;
  readonly world: World;
  /** Simulation time (s). */
  time = 0;
  tick = 0;
  phase: MatchPhase = 'waiting';
  readonly players = new Map<EntityId, PlayerState>();
  readonly vehicles = new Map<EntityId, VehicleState>();
  readonly loot: Map<EntityId, LootItem>;
  readonly projectiles = new Map<EntityId, Projectile>();
  readonly zone: ZoneState;
  plane: PlaneState | null = null;
  readonly noises: NoiseEvent[] = [];

  // ---- internals (used by the subsystem modules; not part of the public contract) ----
  readonly playerList: PlayerState[] = [];
  readonly rtList: PlayerRt[] = [];
  readonly rtById = new Map<EntityId, PlayerRt>();
  readonly teams: TeamInfo[] = [];
  readonly vehicleList: VehicleState[] = [];
  readonly vrtList: VehicleRt[] = [];
  readonly vrtById = new Map<EntityId, VehicleRt>();
  readonly projList: Projectile[] = [];
  readonly history = new HitboxHistory();
  readonly traceScratch = new TraceScratch();
  readonly training: TrainingState | null;
  readonly lootMgr: LootManager;
  /** Sim time the match started (plane / training start). */
  startTime = 0;
  /** Sim time the match ended (-1 while running). */
  endTime = -1;
  winnerTeam: TeamId | null = null;
  private started = false;
  private nextId = 1;
  private events: SimEvent[] = [];
  private readonly zoneCtl: ZoneController;
  private readonly playerGrid: PlayerGrid;
  private readonly rngPlane: Rng;
  private readonly rngNames: Rng;
  private readonly names = new Set<string>();
  private readonly nearScratch: PlayerState[] = [];
  private readonly rewindPose = createPose();

  constructor(config: MatchConfig) {
    this.config = { ...config };
    if (!(this.config.zoneSpeed > 0)) this.config.zoneSpeed = 1;
    this.config.maxPlayers = Math.max(1, Math.min(MAX_PLAYERS, Math.floor(this.config.maxPlayers) || 1));
    const kind = this.config.mode === 'training' ? 'training' : 'island';
    this.world = generateWorld(this.config.seed, kind);
    prepareRaycastWorld(this.world);
    const seed = this.config.seed >>> 0;
    this.rngPlane = new Rng(hash32(seed, 0x504c));
    this.rngNames = new Rng(hash32(seed, 0x4e4d));
    this.zone = createZone(this.world);
    this.zoneCtl = new ZoneController(this.zone, this.world, new Rng(hash32(seed, 0x5a4e)), this.config.zoneSpeed);
    if (this.config.mode === 'training') this.zoneCtl.disable();
    this.playerGrid = new PlayerGrid(this.world.half, 32);
    const teamCount = Math.ceil(this.config.maxPlayers / this.config.teamSize);
    for (let t = 0; t < teamCount; t++) this.teams.push({ id: t, members: [], eliminated: false, placement: 0 });
    this.training = this.config.mode === 'training' ? createTrainingState(this.world) : null;
    spawnVehicles(this, new Rng(hash32(seed, 0x5645)));
    this.lootMgr = new LootManager(this.world);
    this.loot = this.lootMgr.items;
    this.lootMgr.spawnInitial(this.world, new Rng(hash32(seed, 0x4c54)), () => this.allocId());
    // The initial loot reaches clients through MatchInit, not through the delta.
    this.lootMgr.clearDelta();
  }

  // ===========================================================================================
  // Public API
  // ===========================================================================================

  /** Add a player; returns its id or -1 (full, or a battle royale that already started). */
  addPlayer(init: { name: string; isBot: boolean; team?: TeamId }): EntityId {
    const training = this.config.mode === 'training';
    if (!training && (this.started || this.players.size >= this.config.maxPlayers)) return -1;
    const team = this.resolveTeam(init.team);
    if (team < 0) return -1;
    const id = this.allocId();
    let name = typeof init.name === 'string' ? init.name.trim() : '';
    if (!name) name = generateBotName(this.rngNames, this.names);
    this.names.add(name);
    const p = createPlayerState(id, name, team, !!init.isBot, { x: 0, y: PLANE_ALTITUDE, z: 0 }, 0);
    const rt = createPlayerRt(p, this.playerList.length);
    this.players.set(id, p);
    this.playerList.push(p);
    this.rtList.push(rt);
    this.rtById.set(id, rt);
    this.teams[team].members.push(p);
    this.history.addPlayer(id);
    if (training) {
      respawnPlayer(this, rt);
      p.stats.spawnTime = this.time;
    }
    this.playerGrid.rebuild(this.playerList);
    return id;
  }

  /** A human disconnected: a bot takes over so the squad is not left hanging. */
  removePlayer(id: EntityId): void {
    const rt = this.rtById.get(id);
    if (!rt) return;
    rt.p.connected = false;
    rt.p.isBot = true;
    resetInput(rt);
  }

  /** Fill the remaining slots with bots (teams that already have members first). */
  fillBots(): void {
    if (this.config.mode !== 'training' && this.started) return;
    const max = this.config.maxPlayers;
    const size = this.config.teamSize;
    while (this.players.size < max) {
      let team = -1;
      for (const t of this.teams) {
        if (t.members.length > 0 && t.members.length < size) { team = t.id; break; }
      }
      if (team < 0) {
        for (const t of this.teams) {
          if (t.members.length < size) { team = t.id; break; }
        }
      }
      if (team < 0) break;
      if (this.addPlayer({ name: generateBotName(this.rngNames, this.names), isBot: true, team }) < 0) break;
    }
  }

  /** waiting -> plane (battle royale) | playing (training). */
  /**
   * When set before start(), everyone boards a parked plane (not moving, zone timer not running)
   * until releasePlane() is called — the runner releases it once every client has loaded the world.
   */
  holdPlane = false;
  private planeHeld = false;

  /** Start the flight (and the zone timeline) after a held start. No-op otherwise. */
  releasePlane(): void {
    if (!this.planeHeld || !this.plane) return;
    this.planeHeld = false;
    this.plane.active = true;
    this.plane.startTime = this.time;
    this.zoneCtl.start();
    this.emit({ type: 'planeStart' });
    this.emitZone();
  }

  get isPlaneHeld(): boolean {
    return this.planeHeld;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startTime = this.time;
    if (this.config.mode === 'training') {
      this.phase = 'playing';
      this.emit({ type: 'matchStart' });
    } else {
      this.plane = createPlane(this.world, this.rngPlane, this.time);
      this.phase = 'plane';
      if (this.holdPlane) {
        this.planeHeld = true;
        this.plane.active = false;
      } else {
        this.zoneCtl.start();
      }
      for (const p of this.playerList) {
        p.mode = 'plane';
        p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
        p.pos.x = this.plane.start.x; p.pos.y = this.plane.altitude; p.pos.z = this.plane.start.z;
        p.yaw = Math.atan2(-(this.plane.end.x - this.plane.start.x), -(this.plane.end.z - this.plane.start.z));
        const rt = this.rtById.get(p.id)!;
        rt.last.yaw = p.yaw;
      }
      this.emit({ type: 'matchStart' });
      if (!this.planeHeld) {
        this.emit({ type: 'planeStart' });
        this.emitZone();
      }
    }
    this.history.record(this.time, this.playerList);
    this.playerGrid.rebuild(this.playerList);
  }

  /** Advance one TICK_DT. */
  step(): void {
    const dt = TICK_DT;
    if (!this.started) return;
    // Plane.
    const plane = this.plane;
    if (plane && plane.active) {
      plane.traveled += plane.speed * dt;
      if (plane.traveled >= plane.length) {
        plane.traveled = plane.length;
        plane.active = false;
      }
    }
    // Players.
    const rts = this.rtList;
    for (let i = 0; i < rts.length; i++) updatePlayer(this, rts[i], dt);
    // Auto-eject whoever is still aboard near the end of the flight.
    if (plane && this.phase === 'plane' && plane.traveled >= plane.length * PLANE_AUTO_EJECT) {
      for (const p of this.playerList) if (p.mode === 'plane' && p.life !== 'dead') jumpFromPlane(this, p);
    }
    updateProjectiles(this, dt);
    stepVehicles(this, dt);
    syncOccupants(this);
    this.updateZone(dt);
    this.upkeep(dt);
    if (this.phase === 'plane') {
      let aboard = false;
      for (const p of this.playerList) if (p.mode === 'plane' && p.life !== 'dead') { aboard = true; break; }
      if (!aboard) this.phase = 'playing';
    }
    this.time = Math.round((this.time + dt) * 1e6) / 1e6;
    this.tick++;
    this.history.record(this.time, this.playerList);
    this.pruneNoises();
    this.playerGrid.rebuild(this.playerList);
  }

  queueInput(id: EntityId, input: PlayerInput): void {
    const rt = this.rtById.get(id);
    if (rt) pushInput(rt, input);
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  drainLootDelta(): { added: LootItem[]; removed: EntityId[] } {
    return this.lootMgr.drainDelta();
  }

  isOver(): boolean {
    return this.phase === 'ended';
  }

  results(): MatchResults {
    const end = this.endTime >= 0 ? this.endTime : this.time;
    const players: PlayerResult[] = this.playerList.map((p) => {
      const placement = p.placement > 0 ? p.placement : this.phase === 'ended' ? 1 : 0;
      const died = p.life === 'dead' ? p.stats.deathTime : end;
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        isBot: p.isBot,
        placement,
        kills: p.stats.kills,
        knocks: p.stats.knocks,
        damage: Math.round(p.stats.damage),
        headshots: p.stats.headshots,
        revives: p.stats.revives,
        longestKill: Math.round(p.stats.longestKill * 10) / 10,
        survivalTime: Math.round(Math.max(0, died - this.startTime) * 10) / 10,
        accuracy: p.stats.shotsFired > 0 ? Math.round((p.stats.shotsHit / p.stats.shotsFired) * 1000) / 1000 : 0,
      };
    });
    players.sort((a, b) => (a.placement || 999) - (b.placement || 999) || b.kills - a.kills || a.id - b.id);
    return {
      winnerTeam: this.winnerTeam,
      duration: Math.round((end - this.startTime) * 10) / 10,
      players,
    };
  }

  /** Lag-compensation hitboxes of a player at sim time `timeSec`. */
  rewindHitboxes(id: EntityId, timeSec: number, out: Hitbox[] = []): Hitbox[] {
    if (!this.history.poseAt(id, timeSec, this.rewindPose)) {
      out.length = 0;
      return out;
    }
    return buildHitboxes(this.rewindPose, out);
  }

  // ---- SimView queries ----

  lootNear(x: number, z: number, radius: number, out: LootItem[]): LootItem[] {
    return this.lootMgr.near(x, z, radius, out);
  }

  playersNear(x: number, z: number, radius: number, out: PlayerState[]): PlayerState[] {
    return this.playerGrid.query(x, z, radius, out);
  }

  vehiclesNear(x: number, z: number, radius: number, out: VehicleState[]): VehicleState[] {
    out.length = 0;
    const r2 = radius * radius;
    for (const v of this.vehicleList) {
      const dx = v.pos.x - x, dz = v.pos.z - z;
      if (dx * dx + dz * dz <= r2) out.push(v);
    }
    return out;
  }

  eyePos(id: EntityId, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const p = this.players.get(id);
    if (!p) {
      out.x = 0; out.y = 0; out.z = 0;
      return out;
    }
    return eyePosition(p, p.lean, p.yaw, out);
  }

  sameTeam(a: EntityId, b: EntityId): boolean {
    const pa = this.players.get(a), pb = this.players.get(b);
    return !!pa && !!pb && pa.team === pb.team;
  }

  // ===========================================================================================
  // Internal helpers for the subsystem modules
  // ===========================================================================================

  allocId(): EntityId {
    return this.nextId++;
  }

  emit(ev: GameEvent, to?: EntityId[], pos?: Vec3, range?: number): void {
    const e: SimEvent = { ev };
    if (to) e.to = to;
    if (pos && range !== undefined) {
      e.pos = { x: pos.x, y: pos.y, z: pos.z };
      e.range = range;
    }
    this.events.push(e);
  }

  addNoise(pos: Vec3, source: EntityId, kind: NoiseEvent['kind'], radius: number): void {
    this.noises.push({ pos: { x: pos.x, y: pos.y, z: pos.z }, time: this.time, source, kind, radius });
  }

  /** Drop loot on the ground near `pos` (snapped to the walkable surface below refY + 0.6). */
  placeLoot(item: ItemId, count: number, pos: Vec3, refY: number, mag?: number): LootItem | null {
    if (!(count > 0)) return null;
    const g = this.world.groundAt(pos.x, pos.z, refY + 0.6);
    const y = Number.isFinite(g) && Math.abs(g - refY) < 2.5 ? Math.max(g, this.world.waterLevel) : refY;
    return this.lootMgr.add(this.allocId(), item, count, { x: pos.x, y: y + 0.05, z: pos.z }, mag);
  }

  /** Put loot exactly at `pos` (leftover stacks). */
  placeLootAt(item: ItemId, count: number, pos: Vec3, mag?: number): LootItem | null {
    if (!(count > 0)) return null;
    return this.lootMgr.add(this.allocId(), item, count, pos, mag);
  }

  removeLoot(id: EntityId): void {
    this.lootMgr.remove(id);
  }

  trainingTargetHit(shooter: PlayerState, target: number, weapon: WeaponId, part: HitPart, distance: number): void {
    emitTargetHit(this, shooter, target, weapon, part, distance);
  }

  cancelRevive(p: PlayerState): void {
    cancelRevive(this, p);
  }

  ejectPlayer(p: PlayerState): void {
    ejectFromVehicle(this, p, false);
  }

  endMatch(winner: TeamId | null): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.endTime = this.time;
    this.winnerTeam = winner;
    if (this.plane) this.plane.active = false;
    this.emit({ type: 'matchEnd', results: this.results() });
  }

  private resolveTeam(requested: TeamId | undefined): TeamId {
    const size = this.config.teamSize;
    if (requested !== undefined && Number.isInteger(requested) && requested >= 0 && requested < this.teams.length
      && this.teams[requested].members.length < size) return requested;
    for (const t of this.teams) if (t.members.length < size) return t.id;
    if (this.config.mode === 'training') {
      // Training always admits players: open a new team.
      const id = this.teams.length;
      this.teams.push({ id, members: [], eliminated: false, placement: 0 });
      return id;
    }
    return -1;
  }

  private emitZone(): void {
    const z = this.zone;
    this.emit({ type: 'zonePhase', phase: z.phase, stage: z.stage, timer: Math.round(z.timer * 10) / 10 });
  }

  private updateZone(dt: number): void {
    if (this.config.mode !== 'br' || this.phase === 'waiting' || this.phase === 'ended') return;
    if (this.zoneCtl.update(dt)) this.emitZone();
    const dps = this.zone.damagePerSec;
    if (!(dps > 0)) return;
    const amount = dps * dt;
    for (const p of this.playerList) {
      if (p.life === 'dead' || p.mode === 'plane') continue;
      if (!outsideZone(this.zone, p.pos.x, p.pos.z)) continue;
      ZONE_INFO.attacker = null;
      damagePlayer(this, p, amount, ZONE_INFO);
      if (this.isOver()) return;
    }
  }

  /** Dead players: spectate targets, training respawns. */
  private upkeep(dt: number): void {
    for (const rt of this.rtList) {
      const p = rt.p;
      if (p.life !== 'dead') continue;
      if (rt.respawnTimer > 0) {
        rt.respawnTimer -= dt;
        if (rt.respawnTimer <= 0 && this.config.mode === 'training') {
          respawnPlayer(this, rt);
          continue;
        }
      }
      if (p.spectating === null || this.players.get(p.spectating)?.life === 'dead') {
        p.spectating = pickSpectateTarget(this, p);
      }
    }
  }

  private pruneNoises(): void {
    const n = this.noises;
    let k = 0;
    while (k < n.length && this.time - n[k].time > NOISE_LIFETIME) k++;
    if (k > 0) n.splice(0, k);
  }
}
