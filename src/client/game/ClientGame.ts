// ClientGame: owns one match on the client. Clock sync, snapshot buffering + interpolation of
// remote entities, prediction + reconciliation of the local player (and the vehicle they drive),
// predicted weapon feedback, loot bookkeeping, interaction prompts and the per-frame FrameState
// consumed by rendering / UI / audio / feel.
//
// Timeline: inputs are produced on fixed TICK_DT steps (one PlayerInput each) and predicted
// immediately; remote entities are drawn at `renderTime` = estimated server time - interpolation
// delay, which is also the `rt` sent with each input for lag compensation.

import { MAX_EXTRAPOLATE_MS, MAX_HEALTH, REVIVE_TIME, TICK_DT } from '../../shared/constants';
import { clamp, damp, lerp, lerpAngle } from '../../shared/math';
import type { MatchInit, NetPlayer, NetProjectile, NetVehicle, RosterEntry, SelfState, ServerMessage, Snapshot } from '../../shared/protocol';
import { LIFE_CODES, MODE_CODES, PF } from '../../shared/protocol';
import { eyePosition, lineOfSight } from '../../shared/physics';
import { trainingTargetPosition } from '../../shared/sim';
import { FISTS_DRAW_TIME, VEHICLE_SLEEP_SPEED } from '../../shared/sim/tuning';
import { BTN, STANCE_FROM_CODE } from '../../shared/types';
import type {
  ClientAction, EntityId, LifeState, LootItem, MatchResults, MovementMode, PlayerInput, PlayerState, SurfaceMaterial,
  TrainingTarget, Vec3, VehicleState, World, WorldBox, ZoneState,
} from '../../shared/types';
import { seatWorldPosition, stepVehicle, vehicleHitsPoint } from '../../shared/vehicles';
import type { VehicleStepEvents } from '../../shared/vehicles';
import { generateWorld } from '../../shared/world';
import { sanitizeAction, sanitizeInput, validateClientMessage } from '../../shared/validate';
import type { Transport } from '../net/transport';
import { ClockSync, RenderClock } from './clock';
import { EventBus } from './events';
import { InputController } from './input';
import type { InputContext } from './input';
import { interactionAction, resolveInteraction } from './interaction';
import type { InteractionEnv } from './interaction';
import {
  SampleRing, SmoothOffset, interpolatePlayer, interpolateProjectile, interpolateVehicle, makeBracket,
} from './interpolation';
import type { Bracket, PlayerInterp, VehicleInterp } from './interpolation';
import { LootIndex } from './lootIndex';
import {
  activeWeapon, applyNetVehicle, applySelfState, copyPredictRt, createPredictRt, createPredictedPlayer,
  createTickEvents, currentSpread, planePositionAt, predictTick, vehicleFromNet,
} from './predict';
import type { PredictEnv, PredictRt, TickEvents } from './predict';
import type {
  CameraInput, ClientGameApi, FrameState, Interaction, LocalPlayerView, PlayerView, ProjectileView,
  SettingsStore, TrainingTargetView, VehicleView,
} from './types';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** At most this many fixed ticks per frame (a long stall drops the backlog instead of spiralling). */
const MAX_TICKS_PER_FRAME = 5;
/** Unacknowledged inputs kept for replay (4 s). */
const MAX_PENDING = 120;
/** Inputs per network message (validate.ts limit). */
const MAX_INPUTS_PER_MESSAGE = 8;
/** Prediction errors larger than this (m) snap instead of being smoothed. */
export const SNAP_DISTANCE = 2;
/** Decay rate (1/s) of the visual prediction error offset (~100 ms to settle). */
const ERROR_DECAY = 14;
/** Decay rate (1/s) of the recoil correction toward the server recoil. */
const RECOIL_DECAY = 12;
/** Snapshot history kept for zone / phase interpolation. */
const SNAPSHOT_RING = 32;
const PLAYER_RING = 16;
const VEHICLE_RING = 16;
const PROJECTILE_RING = 8;
/** Remote entities not seen in a snapshot for this long (ms) are dropped. */
const STALE_MS = 10_000;
/** Largest jump absorbed by the extrapolation correction of remote entities (m). */
const REMOTE_SMOOTH_MAX = 3;
const REMOTE_SMOOTH_DECAY = 12;
/** Vehicles closer than this (m) to the driven one take part in its collision prediction. */
const OTHERS_RANGE = 40;
/** PF.FIRING duration after a predicted shot (s). */
const FIRING_FLAG_TIME = 0.2;

const MODE_LIST = MODE_CODES as readonly MovementMode[];
const LIFE_LIST = LIFE_CODES as readonly LifeState[];
const SCOPED = new Set(['x4', 'x8']);

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

interface RemotePlayer {
  ring: SampleRing<NetPlayer>;
  view: PlayerView;
  interp: PlayerInterp;
  offset: SmoothOffset;
  lastNewest: NetPlayer | undefined;
  lastNewestTime: number;
  wasExtrapolating: boolean;
  lastSeen: number;
  deadSince: number;
  rosterBot: boolean;
}

interface RemoteVehicle {
  ring: SampleRing<NetVehicle>;
  view: VehicleView;
  interp: VehicleInterp;
  offset: SmoothOffset;
  lastNewest: NetVehicle | undefined;
  lastNewestTime: number;
  wasExtrapolating: boolean;
  lastSeen: number;
  /** Render pose as a VehicleState (seat positions). */
  state: VehicleState;
}

interface RemoteProjectile {
  ring: SampleRing<NetProjectile>;
  view: ProjectileView;
  goneAt: number;
}

interface PendingInput {
  input: PlayerInput;
  /** Predicted sim time (s) at which the input is processed. */
  time: number;
  /** Client-only runtime state after predicting this input. */
  rt: PredictRt;
}

export interface ClientGameOptions {
  /** Pre-generated world (tests / caching); defaults to generateWorld(seed, kind). */
  world?: World;
  /** Monotonic clock in ms (tests); defaults to performance.now. */
  now?: () => number;
  /** Input controller (tests / replays); defaults to a new InputController. */
  input?: InputController;
}

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });

function defaultZone(): ZoneState {
  return { phase: 0, stage: 'pre', cx: 0, cz: 0, r: 1e5, nx: 0, nz: 0, nr: 1e5, timer: 0, stageTotal: 0, damagePerSec: 0 };
}

// ---------------------------------------------------------------------------
// ClientGame
// ---------------------------------------------------------------------------

export class ClientGame implements ClientGameApi {
  readonly init: MatchInit;
  readonly world: World;
  readonly events = new EventBus();
  readonly input: InputController;
  readonly clock = new ClockSync();

  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly unsubs: Array<() => void> = [];
  private disposed = false;

  private readonly renderClock = new RenderClock();
  private renderTime = 0;
  private serverNow = 0;

  // Snapshots & remote entities
  private readonly snapshots = new SampleRing<Snapshot>(SNAPSHOT_RING);
  private latest: Snapshot | null = null;
  private readonly remotePlayers = new Map<EntityId, RemotePlayer>();
  private readonly remoteVehicles = new Map<EntityId, RemoteVehicle>();
  private readonly remoteProjectiles = new Map<EntityId, RemoteProjectile>();
  private readonly playerViews = new Map<EntityId, PlayerView>();
  private readonly vehicleViews = new Map<EntityId, VehicleView>();
  private readonly projectileViews = new Map<EntityId, ProjectileView>();
  private readonly loot = new Map<EntityId, LootItem>();
  private readonly lootIndex = new LootIndex();
  private readonly roster = new Map<EntityId, RosterEntry>();
  private results: MatchResults | null = null;
  private selfNet: NetPlayer | null = null;
  private selfState: SelfState | null = null;

  // Prediction
  private predicted: PlayerState | null = null;
  private readonly rt: PredictRt = createPredictRt();
  private readonly pending: PendingInput[] = [];
  private readonly spareRt: PredictRt[] = [];
  private baselineSeq = -1;
  private readonly baselineRt: PredictRt = createPredictRt();
  private baselineButtons = 0;
  private baselineSlot: -1 | 0 | 1 | 2 = -1;
  private prevButtons = 0;
  private seq = 0;
  private tickAcc = 0;
  private predTime = -1;
  private readonly outbox: PlayerInput[] = [];
  private readonly tickEv: TickEvents = createTickEvents();
  private readonly replayEv: TickEvents = createTickEvents();
  private readonly env: PredictEnv;
  private readonly prevPos = v3();
  private readonly curPos = v3();
  private readonly errOffset = new SmoothOffset();
  private prevRecoilP = 0;
  private prevRecoilY = 0;
  private recoilOffP = 0;
  private recoilOffY = 0;
  private lastStance: PlayerState['stance'] = 'stand';
  private lastAdsOn = false;
  private lastShotAt = -1e9;
  private stride = 0;
  private lastActiveSlot: -1 | 0 | 1 | 2 = -1;
  // Driven vehicle prediction
  private predVehicle: VehicleState | null = null;
  private readonly prevVehPos = v3();
  private prevVehYaw = 0;
  private readonly vehOffset = new SmoothOffset();
  private vehYawOff = 0;
  private readonly othersScratch: VehicleState[] = [];
  private readonly othersPool: VehicleState[] = [];
  private readonly predOthers: VehicleState[] = [];
  private readonly otherVehEv: VehicleStepEvents = { crash: 0, crashPos: null, inWater: false };
  /** Server tick minus input seq (measured from snapshots); NaN until known. */
  private tickOffset = NaN;
  private readonly tickOffsets = new Float64Array(20);
  private tickOffsetHead = 0;

  // Interaction
  private interaction: Interaction | null = null;
  private readonly interactionObj: Interaction = { kind: 'pickup', hold: false };
  private readonly nearLoot: LootItem[] = [];
  private readonly lookDir = v3();
  private readonly eyeScratch = v3();
  private readonly interactionEnv: InteractionEnv;
  private readonly inputCtx: InputContext = {
    mode: 'ground', life: 'alive', stance: 'stand', seat: -1, weapons: [null, null, null], activeSlot: -1,
    frags: 0, ads: 0, adsZoom: 1, scoped: false,
  };

  // Frame
  private readonly frame: FrameState;
  private readonly selfView: LocalPlayerView;
  private readonly selfPlayerView: PlayerView;
  private readonly camera: CameraInput;
  private readonly zone: ZoneState = defaultZone();
  private readonly planePos = v3();
  private readonly trainingViews: TrainingTargetView[] = [];
  private readonly trainingDefs: TrainingTarget[] = [];

  // Scratch
  private readonly brP: Bracket<NetPlayer> = makeBracket();
  private readonly brV: Bracket<NetVehicle> = makeBracket();
  private readonly brJ: Bracket<NetProjectile> = makeBracket();
  private readonly brS: Bracket<Snapshot> = makeBracket();
  private readonly boxScratch: WorldBox[] = [];
  private readonly losFn = (a: Vec3, b: Vec3): boolean => lineOfSight(this.world, a, b);
  private readonly vehicleNearFn = (v: VehicleView, center: Vec3): boolean => {
    const r = this.remoteVehicles.get(v.id);
    return r !== undefined && vehicleHitsPoint(r.state, center, 1.25);
  };

  constructor(transport: Transport, init: MatchInit, settings: SettingsStore, opts: ClientGameOptions = {}) {
    this.transport = transport;
    this.init = init;
    this.now = opts.now ?? (() => performance.now());
    this.world = opts.world ?? generateWorld(init.config.seed, init.config.mode === 'training' ? 'training' : 'island');
    this.input = opts.input ?? new InputController(settings);
    this.input.onInteract = () => this.performInteraction();
    this.input.onDeadClick = () => this.spectateNext();

    for (const r of init.roster) this.roster.set(r.id, r);
    for (const l of init.loot) this.addLoot(l);
    const training = this.world.training;
    if (training) {
      this.input.setAim(training.spawnYaw, 0);
      for (const t of training.targets) {
        this.trainingDefs.push(t);
        this.trainingViews.push({ id: t.id, pos: { ...t.pos }, kind: t.kind, range: t.range });
      }
    }

    this.env = {
      world: this.world, config: init.config, time: 0, plane: null, planeTime: 0, seatVehicle: null,
      vehicle: null, others: this.predOthers,
    };
    this.interactionEnv = {
      world: this.world,
      self: createPredictedPlayerStub(),
      eye: this.eyeScratch,
      look: this.lookDir,
      planePos: null,
      players: this.playerViews,
      vehicles: this.vehicleViews,
      nearbyLoot: this.nearLoot,
      training: init.config.mode === 'training' ? this.world.training : null,
      lineOfSight: this.losFn,
      vehicleNear: this.vehicleNearFn,
    };

    const localName = init.you !== null ? this.roster.get(init.you)?.name ?? '' : '';
    this.camera = { yaw: this.input.yaw, pitch: 0, freeLook: false, mode: this.input.cameraMode };
    this.selfView = createLocalView(init.you ?? -1, localName, init.team);
    this.selfPlayerView = createPlayerView(init.you ?? -1, localName, init.team, false, true, true);
    this.frame = {
      time: 0, serverNow: 0, dt: 0, phase: 'waiting', config: init.config, world: this.world, roster: this.roster,
      localId: init.you, localTeam: init.team, viewTargetId: init.you, self: null, players: this.playerViews,
      vehicles: this.vehicleViews, projectiles: this.projectileViews, loot: this.loot, zone: this.zone, plane: null,
      planePos: null, alive: 0, teamsAlive: 0, ping: 0, interaction: null, results: null, camera: this.camera,
      trainingTargets: this.trainingViews,
    };

    // Subscribe last: the transport may synchronously replay messages buffered since matchInit.
    this.unsubs.push(transport.onMessage((msg) => this.handleMessage(msg)));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Base aim + predicted recoil (where bullets go). */
  get aimYaw(): number {
    return this.selfView.aimYaw;
  }

  get aimPitch(): number {
    return this.selfView.aimPitch;
  }

  /** Camera look direction (aim, plus free-look offsets). */
  get cameraYaw(): number {
    return this.camera.yaw;
  }

  get cameraPitch(): number {
    return this.camera.pitch;
  }

  /** Magnitude (m) of the prediction correction currently being smoothed out (diagnostics). */
  get correction(): number {
    return this.errOffset.length;
  }

  /** Magnitude (m) of the driven-vehicle correction being smoothed out (diagnostics). */
  get vehicleCorrection(): number {
    return this.vehOffset.length;
  }

  /** Locally predicted vehicle (when driving), read only. */
  get predictedVehicle(): Readonly<VehicleState> | null {
    return this.predVehicle;
  }

  /** Predicted local player state (read only; diagnostics / tests). */
  get predictedState(): Readonly<PlayerState> | null {
    return this.predicted;
  }

  /** Number of inputs not yet acknowledged by the server. */
  get pendingInputs(): number {
    return this.pending.length;
  }

  update(dt: number): void {
    if (this.disposed) return;
    if (!(dt >= 0) || !Number.isFinite(dt)) dt = 0;
    const now = this.now();
    if (this.clock.shouldPing(now)) this.transport.send({ t: 'ping', c: now });
    this.serverNow = this.clock.serverNow(now);
    this.renderTime = this.renderClock.update(dt * 1000, this.serverNow - this.clock.interpDelay());
    this.input.update(dt);

    // Fixed input ticks.
    if (this.init.you !== null) {
      this.tickAcc += dt;
      let n = 0;
      while (this.tickAcc >= TICK_DT && n < MAX_TICKS_PER_FRAME) {
        this.tickAcc -= TICK_DT;
        n++;
        this.runTick();
      }
      if (n === MAX_TICKS_PER_FRAME && this.tickAcc > TICK_DT) this.tickAcc = 0;
      this.flushOutbox();
    }

    this.buildFrame(dt);
    this.events.flush();
  }

  getFrame(): FrameState {
    return this.frame;
  }

  queueAction(a: ClientAction): void {
    this.input.queueAction(a);
  }

  performInteraction(): void {
    const i = this.interaction;
    if (!i) return;
    const a = interactionAction(i);
    if (a) this.input.queueAction(a);
  }

  /** While dead: switch the spectator camera to the next valid living player. */
  spectateNext(): void {
    const p = this.predicted;
    if (!p || p.life !== 'dead') return;
    // Server rule: teammates while any is alive, otherwise any living player.
    let teamAlive = false;
    for (const v of this.playerViews.values()) {
      if (!v.isSelf && v.isTeammate && v.life !== 'dead') { teamAlive = true; break; }
    }
    const cur = p.spectating ?? -1;
    let first = -1, next = -1;
    for (const v of this.playerViews.values()) {
      if (v.isSelf || v.life === 'dead' || (teamAlive && !v.isTeammate)) continue;
      if (first < 0 || v.id < first) first = v.id;
      if (v.id > cur && (next < 0 || v.id < next)) next = v.id;
    }
    const target = next >= 0 ? next : first;
    if (target >= 0 && target !== cur) this.input.queueAction({ a: 'spectate', id: target });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs.splice(0)) u();
    this.input.dispose();
    this.events.clear();
    this.remotePlayers.clear();
    this.remoteVehicles.clear();
    this.remoteProjectiles.clear();
    this.playerViews.clear();
    this.vehicleViews.clear();
    this.projectileViews.clear();
    this.snapshots.clear();
    this.pending.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  private handleMessage(msg: ServerMessage): void {
    if (this.disposed) return;
    switch (msg.t) {
      case 'snap':
        this.onSnapshot(msg.s);
        return;
      case 'pong':
        this.clock.onPong(msg.c, msg.s, this.now());
        return;
      case 'matchOver':
        this.results = msg.results;
        return;
      default:
        // Lobby / control traffic is handled by the app controller.
        return;
    }
  }

  private send(inputs: PlayerInput[]): void {
    const msg = { t: 'input' as const, inputs };
    // Defence against producing something the server would reject (and count against us).
    if (validateClientMessage(msg)) this.transport.send(msg);
  }

  private flushOutbox(): void {
    const out = this.outbox;
    while (out.length > 0) this.send(out.splice(0, MAX_INPUTS_PER_MESSAGE));
  }

  private onSnapshot(s: Snapshot): void {
    const now = this.now();
    this.clock.onSnapshot(s.time, now);
    if (this.latest && s.time < this.latest.time) return; // stale / reordered
    this.snapshots.push(s.time, s);
    this.latest = s;
    const selfId = this.init.you;

    // Players
    this.selfNet = null;
    for (const np of s.players) {
      if (np.id === selfId) {
        this.selfNet = np;
        continue;
      }
      let r = this.remotePlayers.get(np.id);
      if (!r) {
        r = this.createRemotePlayer(np);
        this.remotePlayers.set(np.id, r);
        this.playerViews.set(np.id, r.view);
      }
      r.ring.push(s.time, np);
      r.lastSeen = s.time;
    }
    if (s.gone) {
      for (const id of s.gone) {
        if (id === selfId) continue;
        this.remotePlayers.delete(id);
        this.playerViews.delete(id);
      }
    }

    // Vehicles
    for (const nv of s.vehicles) {
      let r = this.remoteVehicles.get(nv.id);
      if (!r) {
        r = this.createRemoteVehicle(nv);
        this.remoteVehicles.set(nv.id, r);
        this.vehicleViews.set(nv.id, r.view);
      }
      r.ring.push(s.time, nv);
      r.lastSeen = s.time;
    }

    // Projectiles (sent every snapshot while relevant: absence means it is gone)
    for (const np of s.projectiles) {
      let r = this.remoteProjectiles.get(np.id);
      if (!r) {
        r = {
          ring: new SampleRing<NetProjectile>(PROJECTILE_RING),
          view: { id: np.id, owner: np.o, kind: np.k, weapon: np.w, pos: v3(), vel: v3() },
          goneAt: Infinity,
        };
        this.remoteProjectiles.set(np.id, r);
      }
      r.ring.push(s.time, np);
      r.goneAt = Infinity;
    }
    for (const r of this.remoteProjectiles.values()) {
      if (r.goneAt === Infinity && r.ring.newestTime() < s.time) r.goneAt = s.time;
    }

    // Loot deltas (in snapshot order: additions, then removals)
    if (s.lootAdd) for (const l of s.lootAdd) this.addLoot(l);
    if (s.lootRemove) for (const id of s.lootRemove) this.removeLoot(id);

    // Events
    for (const ev of s.events) {
      if (ev.type === 'matchEnd') this.results = ev.results;
      this.events.push(ev);
    }

    if (s.self) this.reconcile(s.self, s);
    this.events.push({ type: 'localSnapshot' });
  }

  // ---------------------------------------------------------------------------
  // Prediction
  // ---------------------------------------------------------------------------

  private takeRt(src: PredictRt): PredictRt {
    return copyPredictRt(this.spareRt.pop() ?? createPredictRt(), src);
  }

  /** Estimated sim time (s) at which an input sent now is processed by the server (clock based). */
  private estimateInputTime(): number {
    return (this.clock.serverNow(this.now()) + this.clock.rtt / 2) / 1000 + TICK_DT;
  }

  /**
   * Sim time (s, start of the server tick) at which input `seq` is / was processed. Measured from
   * snapshots (tick - ack) once known, so plane jumps etc. are predicted at the exact server tick.
   */
  private inputTime(seq: number): number {
    if (Number.isFinite(this.tickOffset)) return (seq + this.tickOffset - 1) * TICK_DT;
    return this.estimateInputTime();
  }

  /** Track the seq -> server tick mapping (minimum over ~1 s filters input starvation hiccups). */
  private observeTickOffset(tick: number, ack: number): void {
    if (!(ack > 0) || !Number.isFinite(tick)) return;
    this.tickOffsets[this.tickOffsetHead % this.tickOffsets.length] = tick - ack;
    this.tickOffsetHead++;
    const n = Math.min(this.tickOffsetHead, this.tickOffsets.length);
    let k = Infinity;
    for (let i = 0; i < n; i++) if (this.tickOffsets[i] < k) k = this.tickOffsets[i];
    this.tickOffset = k;
  }

  private runTick(): void {
    this.predTime = this.inputTime(this.seq + 1);

    const p = this.predicted;
    if (p) this.refreshInputContext(p);
    this.seq++;
    const raw = this.input.sample(this.seq, Math.max(0, Math.round(this.renderTime)));
    // Normalise exactly like the server will (wrapped yaw, clamped axes) so prediction uses the
    // identical values. A malformed UI action is dropped on its own, never the whole tick.
    let input = sanitizeInput(raw);
    if (!input && raw.actions) {
      const ok: ClientAction[] = [];
      for (const a of raw.actions) {
        const sa = sanitizeAction(a);
        if (sa) ok.push(sa);
      }
      raw.actions = ok.length > 0 ? ok : undefined;
      input = sanitizeInput(raw);
    }
    if (!input) return;
    this.outbox.push(input);

    if (p) {
      this.prevPos.x = this.curPos.x; this.prevPos.y = this.curPos.y; this.prevPos.z = this.curPos.z;
      this.prevRecoilP = p.recoilPitch;
      this.prevRecoilY = p.recoilYaw;
      if (this.predVehicle) {
        this.prevVehPos.x = this.predVehicle.pos.x; this.prevVehPos.y = this.predVehicle.pos.y; this.prevVehPos.z = this.predVehicle.pos.z;
        this.prevVehYaw = this.predVehicle.yaw;
      }
      this.prepareEnv(p, this.predTime);
      predictTick(p, this.rt, input, this.prevButtons, this.env, this.tickEv);
      if (this.env.vehicle) this.stepOtherVehicles(this.env.vehicle);
      this.curPos.x = p.pos.x; this.curPos.y = p.pos.y; this.curPos.z = p.pos.z;
      this.emitTickEvents(p, input, this.tickEv);
      this.interaction = this.computeInteraction(p);
    }
    this.prevButtons = input.buttons;

    const entry: PendingInput = { input, time: this.predTime, rt: this.takeRt(this.rt) };
    this.pending.push(entry);
    if (this.pending.length > MAX_PENDING) {
      const old = this.pending.shift();
      if (old) this.spareRt.push(old.rt);
    }
  }

  private prepareEnv(p: PlayerState, time: number): void {
    const env = this.env;
    env.time = time;
    const s = this.latest;
    env.plane = s?.plane ?? null;
    env.planeTime = s ? s.time / 1000 : 0;
    env.seatVehicle = null;
    if (p.vehicleId !== null) {
      const rv = this.remoteVehicles.get(p.vehicleId);
      env.seatVehicle = this.predVehicle && this.predVehicle.id === p.vehicleId ? this.predVehicle.type : rv ? rv.state.type : null;
    }
    env.vehicle = this.predVehicle && p.vehicleId === this.predVehicle.id && p.seat === 0 ? this.predVehicle : null;
    // Other vehicles for driver-side collisions: persistent copies rebased at every reconcile
    // (stepVehicle pushes `others` around on contact; never hand it render objects).
    env.others = this.predOthers;
  }

  /**
   * Rebase the collision copies of vehicles near the driven one on their newest known states
   * (parked vehicles are only sent at a low rate, but they do not move).
   */
  private rebaseOthers(driven: VehicleState): void {
    const list = this.predOthers;
    list.length = 0;
    const vp = driven.pos;
    for (const r of this.remoteVehicles.values()) {
      const nv = r.ring.newest();
      if (!nv || nv.id === driven.id) continue;
      const dx = nv.p[0] - vp.x, dz = nv.p[2] - vp.z;
      if (dx * dx + dz * dz >= OTHERS_RANGE * OTHERS_RANGE) continue;
      let copy = this.othersPool[list.length];
      if (!copy) {
        copy = vehicleFromNet(nv);
        this.othersPool.push(copy);
      } else {
        applyNetVehicle(copy, nv);
      }
      copy.yawRate = 0;
      copy.throttle = 0;
      copy.onGround = true;
      list.push(copy);
    }
  }

  /** Driverless vehicles that were knocked into motion keep moving like on the server. */
  private stepOtherVehicles(driven: VehicleState): void {
    const list = this.predOthers;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.destroyed || o.seats[0] !== null) continue;
      const vsq = o.vel.x * o.vel.x + o.vel.y * o.vel.y + o.vel.z * o.vel.z;
      if (vsq <= VEHICLE_SLEEP_SPEED * VEHICLE_SLEEP_SPEED) continue;
      const others = this.othersScratch;
      others.length = 0;
      others.push(driven);
      for (let k = 0; k < list.length; k++) if (k !== i) others.push(list[k]);
      stepVehicle(o, null, TICK_DT, this.world, others, this.otherVehEv);
    }
  }

  private refreshInputContext(p: PlayerState): void {
    const c = this.inputCtx;
    const w = activeWeapon(p);
    c.mode = p.mode;
    c.life = p.life;
    c.stance = p.stance;
    c.seat = p.vehicleId !== null ? p.seat : -1;
    c.weapons = p.weapons;
    c.activeSlot = p.activeSlot;
    c.frags = p.items.frag ?? 0;
    c.ads = p.ads;
    c.adsZoom = w ? w.adsZoom : 1;
    c.scoped = w ? SCOPED.has(w.scope) : false;
    this.input.setContext(c);
  }

  /** Authoritative state arrived: rewind to it and replay the unacknowledged inputs. */
  private reconcile(self: SelfState, snap: Snapshot): void {
    this.selfState = self;
    const ack = self.ack;
    this.observeTickOffset(snap.tick, ack);
    // Acknowledged inputs become the baseline (client-only runtime state + edge buttons).
    while (this.pending.length > 0 && this.pending[0].input.seq <= ack) {
      const e = this.pending.shift()!;
      if (e.input.seq === ack) {
        this.baselineSeq = ack;
        copyPredictRt(this.baselineRt, e.rt);
        this.baselineButtons = e.input.buttons;
        this.baselineSlot = e.input.slot;
      }
      this.spareRt.push(e.rt);
    }

    let p = this.predicted;
    const firstState = p === null;
    const oldX = this.curPos.x, oldY = this.curPos.y, oldZ = this.curPos.z;
    const oldMode = p ? p.mode : null;
    const oldRecoilP = p ? p.recoilPitch : 0, oldRecoilY = p ? p.recoilYaw : 0;
    const oldVeh = this.predVehicle;
    const oldVehX = oldVeh ? oldVeh.pos.x : 0, oldVehY = oldVeh ? oldVeh.pos.y : 0, oldVehZ = oldVeh ? oldVeh.pos.z : 0;
    const oldVehYaw = oldVeh ? oldVeh.yaw : 0;

    if (!p) {
      p = createPredictedPlayer(self, this.roster.get(self.id)?.name ?? '', this.init.team);
      this.predicted = p;
      this.lastActiveSlot = p.activeSlot;
      this.lastStance = p.stance;
    } else {
      applySelfState(p, self);
    }
    if (this.baselineSeq === ack) copyPredictRt(this.rt, this.baselineRt);
    p.lastButtons = this.baselineButtons;

    // Driver-side vehicle prediction starts from the vehicle in the same snapshot. If the vehicle
    // is (unexpectedly) missing from this snapshot, keep the current prediction as it is.
    this.predVehicle = null;
    this.predOthers.length = 0;
    let replayVehicle = false;
    if (p.mode === 'vehicle' && p.seat === 0 && p.vehicleId !== null) {
      const nv = findVehicle(snap.vehicles, p.vehicleId);
      if (!nv && oldVeh && oldVeh.id === p.vehicleId) this.predVehicle = oldVeh;
      if (nv) {
        replayVehicle = true;
        const keep = oldVeh && oldVeh.id === nv.id ? oldVeh : vehicleFromNet(nv);
        applyNetVehicle(keep, nv);
        this.predVehicle = keep;
        this.rebaseOthers(keep);
        if (this.baselineSeq !== ack || oldVeh !== keep) {
          // No predicted history for this vehicle yet: derive the hidden state.
          this.rt.vehThrottle = keep.throttle;
          this.rt.vehYawRate = keep.yawRate;
          this.rt.vehOnGround = keep.onGround;
        }
      }
    }

    // Slot sync: when the server's slot is not the one our acknowledged input asked for (it was
    // changed by something else: drop, death, refused switch) and no newer request is in flight,
    // follow the server instead of fighting it.
    const ackedSlot = this.baselineSeq === ack ? this.baselineSlot : null;
    if (ack >= this.input.slotRequestSeq && self.activeSlot !== this.input.requestedSlot
      && (ackedSlot === null || self.activeSlot !== ackedSlot)) {
      this.input.adoptSlot(self.activeSlot);
    }

    // Replay.
    let prevButtons = this.baselineButtons;
    for (const e of this.pending) {
      e.time = this.inputTime(e.input.seq);
      this.prepareEnv(p, e.time);
      if (!replayVehicle) this.env.vehicle = null;
      predictTick(p, this.rt, e.input, prevButtons, this.env, this.replayEv);
      if (this.env.vehicle) this.stepOtherVehicles(this.env.vehicle);
      prevButtons = e.input.buttons;
      copyPredictRt(e.rt, this.rt);
    }

    // Smooth the correction (or snap when it is large / the movement mode changed).
    const nx = p.pos.x, ny = p.pos.y, nz = p.pos.z;
    const dx = nx - oldX, dy = ny - oldY, dz = nz - oldZ;
    if (firstState || oldMode !== p.mode) {
      this.errOffset.reset();
      this.prevPos.x = nx; this.prevPos.y = ny; this.prevPos.z = nz;
    } else {
      this.prevPos.x += dx; this.prevPos.y += dy; this.prevPos.z += dz;
      this.errOffset.absorb(-dx, -dy, -dz, SNAP_DISTANCE);
    }
    this.curPos.x = nx; this.curPos.y = ny; this.curPos.z = nz;

    if (firstState) {
      this.prevRecoilP = p.recoilPitch;
      this.prevRecoilY = p.recoilYaw;
    } else {
      const drp = p.recoilPitch - oldRecoilP, dry = p.recoilYaw - oldRecoilY;
      this.prevRecoilP += drp;
      this.prevRecoilY += dry;
      this.recoilOffP -= drp;
      this.recoilOffY -= dry;
    }

    const v = this.predVehicle;
    if (v) {
      if (oldVeh === v) {
        const vdx = v.pos.x - oldVehX, vdy = v.pos.y - oldVehY, vdz = v.pos.z - oldVehZ;
        this.prevVehPos.x += vdx; this.prevVehPos.y += vdy; this.prevVehPos.z += vdz;
        this.vehOffset.absorb(-vdx, -vdy, -vdz, SNAP_DISTANCE * 2);
        const dyaw = v.yaw - oldVehYaw;
        this.prevVehYaw += dyaw;
        this.vehYawOff = Math.abs(this.vehYawOff - dyaw) < 0.5 ? this.vehYawOff - dyaw : 0;
      } else {
        this.prevVehPos.x = v.pos.x; this.prevVehPos.y = v.pos.y; this.prevVehPos.z = v.pos.z;
        this.prevVehYaw = v.yaw;
        this.vehOffset.reset();
        this.vehYawOff = 0;
      }
    }
    this.interaction = this.computeInteraction(p);
  }

  /** Local feedback events for a freshly predicted tick (never for replays). */
  private emitTickEvents(p: PlayerState, input: PlayerInput, ev: TickEvents): void {
    const bus = this.events;
    if (ev.switched || p.activeSlot !== this.lastActiveSlot) {
      this.lastActiveSlot = p.activeSlot;
      bus.push({ type: 'localWeaponSwitch', weapon: activeWeapon(p)?.id ?? null });
    }
    if (ev.shot && ev.weapon) {
      this.lastShotAt = this.predTime;
      bus.push({
        type: 'localShot', weapon: ev.weapon, origin: { ...ev.shotOrigin }, dirs: ev.shotDirs.map((d) => ({ ...d })),
        shotIndex: ev.shotIndex, ballistic: ev.ballistic,
      });
    }
    const w = activeWeapon(p);
    if (ev.dryFire && w) bus.push({ type: 'localDryFire', weapon: w.id });
    if (ev.reloadStarted && w) bus.push({ type: 'localReload', weapon: w.id, empty: ev.reloadEmpty });
    if (ev.reloadDone && w) bus.push({ type: 'localReloadDone', weapon: w.id });
    if (ev.move.jumped) bus.push({ type: 'localJump' });
    if (ev.move.landed) bus.push({ type: 'localLand', speed: ev.move.landSpeed });
    if (p.stance !== this.lastStance) {
      this.lastStance = p.stance;
      bus.push({ type: 'localStance', stance: p.stance });
    }
    const adsOn = (input.buttons & BTN.ADS) !== 0 && w !== null && p.life === 'alive';
    if (adsOn !== this.lastAdsOn) {
      this.lastAdsOn = adsOn;
      bus.push({ type: 'localAds', on: adsOn });
    }
    this.footsteps(p);
  }

  /** Stride-driven local footsteps from the predicted movement. */
  private footsteps(p: PlayerState): void {
    const moving = (p.mode === 'ground' && p.onGround) || p.mode === 'swim';
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (!moving || speed < 0.6 || p.life === 'dead') {
      this.stride = 0.6; // the first step after starting comes quickly
      return;
    }
    let stepLen: number, intensity: number;
    if (p.mode === 'swim') { stepLen = 1.7; intensity = 0.5; }
    else if (p.life === 'downed' || p.stance === 'prone') { stepLen = 0.8; intensity = 0.15; }
    else if (p.stance === 'crouch') { stepLen = 1.05; intensity = 0.35; }
    else if (this.rt.sprinting) { stepLen = 2.05; intensity = 1; }
    else if (speed < 3) { stepLen = 1.15; intensity = 0.3; }
    else { stepLen = 1.6; intensity = 0.65; }
    this.stride += speed * TICK_DT;
    if (this.stride >= stepLen) {
      this.stride -= stepLen;
      if (this.stride > stepLen) this.stride = 0;
      this.events.push({ type: 'localFootstep', material: this.surfaceUnder(p), intensity });
    }
  }

  private surfaceUnder(p: PlayerState): SurfaceMaterial {
    if (p.mode === 'swim') return 'water';
    const { x, y, z } = p.pos;
    const terrain = this.world.heightAt(x, z);
    if (y - terrain > 0.2) {
      const boxes = this.world.queryBoxes(x - 0.3, z - 0.3, x + 0.3, z + 0.3, this.boxScratch);
      let best: WorldBox | null = null;
      for (const b of boxes) {
        if (x < b.min.x - 0.3 || x > b.max.x + 0.3 || z < b.min.z - 0.3 || z > b.max.z + 0.3) continue;
        if (Math.abs(b.max.y - y) < 0.2 && (!best || b.max.y > best.max.y)) best = b;
      }
      if (best) return best.material;
    }
    return this.world.surfaceAt(x, z);
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  private computeInteraction(p: PlayerState): Interaction | null {
    const eye = eyePosition(p, p.lean, p.yaw, this.eyeScratch);
    const cy = this.input.yaw + p.recoilYaw, cp = this.input.pitch + p.recoilPitch;
    const ccp = Math.cos(cp);
    this.lookDir.x = -Math.sin(cy) * ccp;
    this.lookDir.y = Math.sin(cp);
    this.lookDir.z = -Math.cos(cy) * ccp;
    let planePos: Vec3 | null = null;
    if (p.mode === 'plane' && this.latest?.plane) {
      planePos = planePositionAt(this.latest.plane, this.latest.time / 1000, this.predTime + TICK_DT, this.planePos);
    }
    this.lootIndex.query(p.pos.x, p.pos.z, 4, this.nearLoot);
    const env = this.interactionEnv;
    env.self = p;
    env.eye = eye;
    env.planePos = planePos;
    return resolveInteraction(env, this.interactionObj);
  }

  // ---------------------------------------------------------------------------
  // Loot
  // ---------------------------------------------------------------------------

  private addLoot(l: LootItem): void {
    const old = this.loot.get(l.id);
    if (old) this.lootIndex.remove(old);
    this.loot.set(l.id, l);
    this.lootIndex.add(l);
  }

  private removeLoot(id: EntityId): void {
    const old = this.loot.get(id);
    if (!old) return;
    this.loot.delete(id);
    this.lootIndex.remove(old);
  }

  // ---------------------------------------------------------------------------
  // Remote entities
  // ---------------------------------------------------------------------------

  private createRemotePlayer(np: NetPlayer): RemotePlayer {
    const r = this.roster.get(np.id);
    const isTeammate = np.team === this.init.team;
    const view = createPlayerView(np.id, r?.name ?? '', np.team, r ? r.isBot : (np.f & PF.BOT) !== 0, false, isTeammate);
    return {
      ring: new SampleRing<NetPlayer>(PLAYER_RING),
      view,
      interp: { pos: view.pos, vel: view.vel, yaw: 0, pitch: 0, extrapolating: false },
      offset: new SmoothOffset(),
      lastNewest: undefined,
      lastNewestTime: 0,
      wasExtrapolating: false,
      lastSeen: 0,
      deadSince: -1,
      rosterBot: r ? r.isBot : false,
    };
  }

  private createRemoteVehicle(nv: NetVehicle): RemoteVehicle {
    const state = vehicleFromNet(nv);
    const view: VehicleView = {
      id: nv.id, type: nv.t, pos: v3(), vel: v3(), yaw: 0, pitch: 0, roll: 0, speed: 0, steer: 0, rpm: 0,
      hp: nv.hp, fuel: nv.fuel, seats: state.seats, destroyed: nv.destroyed, burning: nv.burning, predicted: false,
    };
    return {
      ring: new SampleRing<NetVehicle>(VEHICLE_RING),
      view,
      interp: { pos: v3(), vel: v3(), yaw: 0, pitch: 0, roll: 0, steer: 0, rpm: 0, extrapolating: false },
      offset: new SmoothOffset(),
      lastNewest: undefined,
      lastNewestTime: 0,
      wasExtrapolating: false,
      lastSeen: 0,
      state,
    };
  }

  private updateRemotePlayers(dt: number): void {
    const t = this.renderTime;
    const br = this.brP;
    for (const r of this.remotePlayers.values()) {
      if (this.serverNow - r.lastSeen > STALE_MS && r.lastSeen > 0) {
        this.remotePlayers.delete(r.view.id);
        this.playerViews.delete(r.view.id);
        continue;
      }
      if (!r.ring.bracket(t, br)) continue;
      const v = r.view;
      // interpolatePlayer writes pos/vel straight into the view (shared objects).
      interpolatePlayer(br, r.interp);
      const newest = r.ring.newest();
      if (newest !== r.lastNewest) {
        // Real data replaced an extrapolated guess: the jump is (old guess at this render time) -
        // (new interpolation); absorb it into an offset that decays instead of popping.
        const old = r.lastNewest;
        if (r.wasExtrapolating && old !== undefined) {
          const ex = old.l === 2 ? 0 : Math.min(Math.max(0, t - r.lastNewestTime), MAX_EXTRAPOLATE_MS) / 1000;
          r.offset.absorb(
            old.p[0] + old.v[0] * ex - v.pos.x, old.p[1] + old.v[1] * ex - v.pos.y, old.p[2] + old.v[2] * ex - v.pos.z,
            REMOTE_SMOOTH_MAX,
          );
        }
        r.lastNewest = newest;
        r.lastNewestTime = r.ring.newestTime();
      }
      r.wasExtrapolating = r.interp.extrapolating;
      r.offset.decay(dt, REMOTE_SMOOTH_DECAY);
      v.pos.x += r.offset.x;
      v.pos.y += r.offset.y;
      v.pos.z += r.offset.z;
      v.yaw = r.interp.yaw;
      v.pitch = r.interp.pitch;
      const b = br.b;
      v.stance = STANCE_FROM_CODE[b.s] ?? 'stand';
      v.mode = MODE_LIST[b.m] ?? 'ground';
      v.life = LIFE_LIST[b.l] ?? 'alive';
      v.team = b.team;
      v.isTeammate = b.team === this.init.team;
      v.isBot = r.rosterBot || (b.f & PF.BOT) !== 0;
      v.weapon = b.w;
      v.flags = b.f;
      v.vehicleId = b.veh ?? null;
      v.seat = b.seat ?? -1;
      v.hp = b.hp ?? null;
      v.downedHp = b.dhp ?? null;
      v.gear[0] = b.g[0]; v.gear[1] = b.g[1]; v.gear[2] = b.g[2];
      v.age = Math.max(0, this.serverNow - r.lastSeen);
      if (v.life === 'dead') {
        if (r.deadSince < 0) r.deadSince = t;
        v.deadFor = (t - r.deadSince) / 1000;
      } else {
        r.deadSince = -1;
        v.deadFor = -1;
      }
      r.ring.prune(t - 250);
    }
  }

  private updateVehicles(dt: number): void {
    const t = this.renderTime;
    const br = this.brV;
    const alpha = clamp(this.tickAcc / TICK_DT, 0, 1);
    const pv = this.predVehicle;
    for (const r of this.remoteVehicles.values()) {
      const id = r.view.id;
      if (this.serverNow - r.lastSeen > STALE_MS && r.lastSeen > 0) {
        this.remoteVehicles.delete(id);
        this.vehicleViews.delete(id);
        continue;
      }
      const v = r.view;
      const s = r.state;
      if (pv && pv.id === id) {
        // Predicted (local driver): interpolate between the last two predicted ticks.
        this.vehOffset.decay(dt, ERROR_DECAY);
        this.vehYawOff *= Math.exp(-ERROR_DECAY * dt);
        v.pos.x = lerp(this.prevVehPos.x, pv.pos.x, alpha) + this.vehOffset.x;
        v.pos.y = lerp(this.prevVehPos.y, pv.pos.y, alpha) + this.vehOffset.y;
        v.pos.z = lerp(this.prevVehPos.z, pv.pos.z, alpha) + this.vehOffset.z;
        v.vel.x = pv.vel.x; v.vel.y = pv.vel.y; v.vel.z = pv.vel.z;
        v.yaw = lerpAngle(this.prevVehYaw, pv.yaw, alpha) + this.vehYawOff;
        v.pitch = pv.pitch;
        v.roll = pv.roll;
        v.steer = pv.steer;
        v.rpm = pv.rpm;
        v.speed = pv.speed;
        v.hp = pv.health;
        v.fuel = pv.fuel;
        v.destroyed = pv.destroyed;
        v.predicted = true;
        const latestNet = r.ring.newest();
        v.burning = latestNet ? latestNet.burning : false;
        copySeats(v.seats, pv.seats);
        r.wasExtrapolating = false;
        r.lastNewest = r.ring.newest();
      } else {
        if (!r.ring.bracket(t, br)) continue;
        const it = interpolateVehicle(br, r.interp);
        const newest = r.ring.newest();
        if (newest !== r.lastNewest) {
          const old = r.lastNewest;
          if (r.wasExtrapolating && old !== undefined && !v.predicted) {
            const ex = old.destroyed ? 0 : Math.min(Math.max(0, t - r.lastNewestTime), MAX_EXTRAPOLATE_MS) / 1000;
            r.offset.absorb(
              old.p[0] + old.v[0] * ex - it.pos.x, old.p[1] + old.v[1] * ex - it.pos.y, old.p[2] + old.v[2] * ex - it.pos.z,
              REMOTE_SMOOTH_MAX,
            );
          } else if (v.predicted) {
            // Hand-over from local prediction to interpolation: blend instead of popping back in time.
            r.offset.absorb(v.pos.x - it.pos.x - r.offset.x, v.pos.y - it.pos.y - r.offset.y, v.pos.z - it.pos.z - r.offset.z, 30);
          }
          r.lastNewest = newest;
          r.lastNewestTime = r.ring.newestTime();
        }
        r.wasExtrapolating = it.extrapolating;
        r.offset.decay(dt, v.predicted ? 4 : REMOTE_SMOOTH_DECAY);
        v.pos.x = it.pos.x + r.offset.x;
        v.pos.y = it.pos.y + r.offset.y;
        v.pos.z = it.pos.z + r.offset.z;
        v.vel.x = it.vel.x; v.vel.y = it.vel.y; v.vel.z = it.vel.z;
        v.yaw = it.yaw;
        v.pitch = it.pitch;
        v.roll = it.roll;
        v.steer = it.steer;
        v.rpm = it.rpm;
        v.speed = -Math.sin(it.yaw) * it.vel.x - Math.cos(it.yaw) * it.vel.z;
        const b = br.b;
        v.hp = b.hp;
        v.fuel = b.fuel;
        v.destroyed = b.destroyed;
        v.burning = b.burning;
        v.predicted = false;
        copySeats(v.seats, b.seats);
        r.ring.prune(t - 250);
      }
      // Render pose as VehicleState (for seat placement).
      s.pos.x = v.pos.x; s.pos.y = v.pos.y; s.pos.z = v.pos.z;
      s.yaw = v.yaw; s.pitch = v.pitch; s.roll = v.roll;
      s.vel.x = v.vel.x; s.vel.y = v.vel.y; s.vel.z = v.vel.z;
    }
  }

  private updateProjectiles(): void {
    const t = this.renderTime;
    const br = this.brJ;
    for (const r of this.remoteProjectiles.values()) {
      const id = r.view.id;
      if (t >= r.goneAt || (r.goneAt === Infinity && this.serverNow - r.ring.newestTime() > STALE_MS)) {
        this.remoteProjectiles.delete(id);
        this.projectileViews.delete(id);
        continue;
      }
      if (!r.ring.bracket(t, br)) continue;
      if (t < r.ring.oldestTime()) {
        // Spawned after the render time: not visible yet.
        this.projectileViews.delete(id);
        continue;
      }
      interpolateProjectile(br, r.view.pos, r.view.vel);
      this.projectileViews.set(id, r.view);
      r.ring.prune(t - 250);
    }
  }

  private updateZone(): void {
    const br = this.brS;
    if (!this.snapshots.bracket(this.renderTime, br)) return;
    const a = br.a.zone, b = br.b.zone;
    const z = this.zone;
    const k = br.alpha;
    // Positions blend only within one stage (a new circle must not slide in from the old one).
    const same = a.phase === b.phase && a.stage === b.stage;
    z.phase = b.phase;
    z.stage = b.stage;
    z.cx = same ? lerp(a.cx, b.cx, k) : b.cx;
    z.cz = same ? lerp(a.cz, b.cz, k) : b.cz;
    z.r = same ? lerp(a.r, b.r, k) : b.r;
    z.nx = b.nx;
    z.nz = b.nz;
    z.nr = b.nr;
    z.stageTotal = b.stageTotal;
    z.damagePerSec = b.damagePerSec;
    // Timer counts down smoothly from the newest snapshot using the estimated server clock.
    const latest = this.latest;
    if (latest) {
      const lz = latest.zone;
      z.timer = Math.max(0, lz.timer - Math.max(0, this.serverNow - latest.time) / 1000);
      if (lz.phase !== z.phase || lz.stage !== z.stage) z.timer = lz.timer;
    }
    if (br.extra > 0 && same && b.stage === 'shrinking') {
      // Starved: continue the shrink at its current rate (bounded) so the circle never stalls.
      const ex = Math.min(br.extra, 150) / 1000;
      const rate = b.stageTotal > 0 ? (b.r - b.nr) / Math.max(b.timer, 1e-3) : 0;
      z.r = Math.max(b.nr, b.r - rate * ex);
    }
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  private buildFrame(dt: number): void {
    const f = this.frame;
    const latest = this.latest;
    f.time = this.renderTime;
    f.serverNow = this.serverNow;
    f.dt = dt;
    if (latest) {
      f.phase = latest.phase;
      f.alive = latest.alive;
      f.teamsAlive = latest.teamsAlive;
      f.plane = latest.plane;
    }
    f.ping = this.transport.kind === 'local' ? 0 : Math.round(this.clock.rtt);
    f.results = this.results;

    this.updateRemotePlayers(dt);
    this.updateVehicles(dt);
    this.updateProjectiles();
    this.updateZone();

    // Plane (deterministic from its path; drawn at the predicted time so the local rider matches).
    if (latest?.plane && latest.plane.active) {
      // Drawn on the local prediction timeline so a rider (and the jump) lines up exactly with it.
      const t = this.predicted && this.predTime >= 0
        ? this.predTime + clamp(this.tickAcc / TICK_DT, 0, 1) * TICK_DT
        : (this.serverNow + this.clock.rtt / 2) / 1000;
      planePositionAt(latest.plane, latest.time / 1000, t, this.planePos);
      f.planePos = this.planePos;
    } else {
      f.planePos = null;
    }

    this.updateSelf(dt);
    this.placeRiders();
    this.updateTraining();

    f.interaction = this.interaction;
    const self = f.self;
    if (self) {
      f.viewTargetId = self.life === 'dead' ? self.spectating ?? self.killerId ?? f.localId : f.localId;
    } else {
      f.viewTargetId = f.localId;
    }
    const cam = this.camera;
    const aimYaw = self ? self.aimYaw : this.input.yaw;
    const aimPitch = self ? self.aimPitch : this.input.pitch;
    cam.yaw = aimYaw + this.input.freeYaw;
    cam.pitch = clamp(aimPitch + this.input.freePitch, -1.553, 1.553);
    cam.freeLook = this.input.freeLook;
    cam.mode = this.input.cameraMode;
  }

  private updateSelf(dt: number): void {
    const p = this.predicted;
    const f = this.frame;
    if (!p || this.init.you === null) {
      f.self = null;
      return;
    }
    const sv = this.selfView;
    const alpha = clamp(this.tickAcc / TICK_DT, 0, 1);
    this.errOffset.decay(dt, ERROR_DECAY);
    const kr = Math.exp(-RECOIL_DECAY * dt);
    this.recoilOffP *= kr;
    this.recoilOffY *= kr;

    // Position: plane rider / seated / predicted + smoothed.
    if (p.mode === 'plane' && f.planePos) {
      sv.pos.x = f.planePos.x; sv.pos.y = f.planePos.y; sv.pos.z = f.planePos.z;
    } else if (p.vehicleId !== null && this.vehicleViews.has(p.vehicleId)) {
      const rv = this.remoteVehicles.get(p.vehicleId)!;
      seatWorldPosition(rv.state, Math.max(0, p.seat), sv.pos);
    } else {
      sv.pos.x = lerp(this.prevPos.x, this.curPos.x, alpha) + this.errOffset.x;
      sv.pos.y = lerp(this.prevPos.y, this.curPos.y, alpha) + this.errOffset.y;
      sv.pos.z = lerp(this.prevPos.z, this.curPos.z, alpha) + this.errOffset.z;
    }
    sv.vel.x = p.vel.x; sv.vel.y = p.vel.y; sv.vel.z = p.vel.z;
    sv.onGround = p.onGround;
    sv.stance = p.stance;
    sv.mode = p.mode;
    sv.life = p.life;
    sv.inWater = p.mode === 'swim';
    sv.sprinting = this.rt.sprinting && Math.hypot(p.vel.x, p.vel.z) > 3;
    sv.lean = p.lean;

    // Aim: mouse (per frame) + predicted recoil (tick interpolated) + correction blend.
    sv.baseYaw = this.input.yaw;
    sv.basePitch = this.input.pitch;
    sv.recoilPitch = lerp(this.prevRecoilP, p.recoilPitch, alpha) + this.recoilOffP;
    sv.recoilYaw = lerp(this.prevRecoilY, p.recoilYaw, alpha) + this.recoilOffY;
    sv.aimYaw = sv.baseYaw + sv.recoilYaw;
    sv.aimPitch = clamp(sv.basePitch + sv.recoilPitch, -1.553, 1.553);
    eyePosition(sv, sv.lean, sv.aimYaw, sv.eye);

    sv.health = p.health;
    sv.boost = p.boost;
    sv.downedHp = p.downedHp;
    sv.armor = p.armor;
    sv.weapons = p.weapons;
    sv.activeSlot = p.activeSlot;
    const w = activeWeapon(p);
    sv.weapon = w ? w.id : null;
    sv.ammo = p.ammo;
    sv.items = p.items;
    const self = this.selfState;
    if (self) {
      sv.capacity[0] = self.capacity[0];
      sv.capacity[1] = self.capacity[1];
    }
    sv.fireCooldown = p.fireCooldown;
    const subTick = alpha * TICK_DT;
    sv.reloadProgress = p.reloadTimer > 0 && p.reloadTotal > 0
      ? clamp(1 - (p.reloadTimer - subTick) / p.reloadTotal, 0, 1) : -1;
    const drawTotal = w ? w.drawTime : FISTS_DRAW_TIME;
    sv.drawProgress = p.drawTimer > 0 ? clamp(1 - (p.drawTimer - subTick) / drawTotal, 0, 1) : -1;
    sv.ads = p.ads;
    sv.spread = w ? currentSpread(p, w) : 0;
    sv.sprayCount = p.sprayCount;
    sv.use = p.use;
    sv.useProgress = p.use && p.use.total > 0 ? clamp((p.use.elapsed + subTick) / p.use.total, 0, 1) : -1;
    sv.revive = p.revive;
    sv.reviveProgress = p.revive ? clamp((p.revive.elapsed + subTick) / REVIVE_TIME, 0, 1) : -1;
    sv.revivedBy = p.revivedBy;
    sv.vehicleId = p.vehicleId;
    sv.seat = p.seat;
    sv.parachuteOpen = p.parachuteOpen;
    sv.altitude = p.mode === 'freefall' || p.mode === 'parachute' || p.mode === 'plane'
      ? Math.max(0, sv.pos.y - this.world.groundAt(sv.pos.x, sv.pos.z, sv.pos.y)) : 0;
    sv.jumpY = p.jumpY;
    sv.throwCooldown = p.throwCooldown;
    sv.stats = p.stats;
    sv.placement = p.placement;
    sv.killerId = p.killerId;
    sv.spectating = p.spectating;
    f.self = sv;

    // Self as a PlayerView (third-person body, nameplates, minimap).
    const pv = this.selfPlayerView;
    pv.pos.x = sv.pos.x; pv.pos.y = sv.pos.y; pv.pos.z = sv.pos.z;
    pv.vel.x = sv.vel.x; pv.vel.y = sv.vel.y; pv.vel.z = sv.vel.z;
    pv.yaw = sv.aimYaw;
    pv.pitch = sv.aimPitch;
    pv.stance = sv.stance;
    pv.mode = sv.mode;
    pv.life = sv.life;
    pv.weapon = sv.weapon;
    pv.flags = this.selfFlags(p, w !== null);
    pv.vehicleId = sv.vehicleId;
    pv.seat = sv.seat;
    pv.hp = p.health;
    pv.downedHp = p.downedHp;
    pv.gear[0] = p.armor.helmet; pv.gear[1] = p.armor.vest; pv.gear[2] = p.armor.pack;
    pv.age = this.latest ? Math.max(0, this.serverNow - this.latest.time) : 0;
    pv.deadFor = p.life === 'dead' ? (pv.deadFor < 0 ? 0 : pv.deadFor + dt) : -1;
    this.playerViews.set(pv.id, pv);
  }

  private selfFlags(p: PlayerState, armed: boolean): number {
    let f = 0;
    if (armed && this.predTime - this.lastShotAt < FIRING_FLAG_TIME) f |= PF.FIRING;
    if (p.reloadTimer > 0) f |= PF.RELOADING;
    if (p.ads > 0.5) f |= PF.ADS;
    if (p.use) f |= PF.HEALING;
    if (p.revive) f |= PF.REVIVING;
    if (p.parachuteOpen) f |= PF.CHUTE;
    if (p.lean < 0) f |= PF.LEAN_L;
    if (p.lean > 0) f |= PF.LEAN_R;
    if (this.rt.sprinting) f |= PF.SPRINT;
    if (p.mode === 'swim') f |= PF.SWIM;
    if (p.onGround) f |= PF.ON_GROUND;
    if (p.drawTimer > 0) f |= PF.DRAWING;
    if (this.selfNet && (this.selfNet.f & PF.BEING_REVIVED) !== 0) f |= PF.BEING_REVIVED;
    if (p.revivedBy !== null && p.life === 'downed') f |= PF.BEING_REVIVED;
    return f;
  }

  /** Riders are drawn exactly at their seats of the (interpolated or predicted) vehicle. */
  private placeRiders(): void {
    for (const r of this.remotePlayers.values()) {
      const v = r.view;
      if (v.vehicleId === null || v.mode !== 'vehicle') continue;
      const rv = this.remoteVehicles.get(v.vehicleId);
      if (rv && v.seat >= 0) seatWorldPosition(rv.state, v.seat, v.pos);
    }
  }

  private updateTraining(): void {
    const defs = this.trainingDefs;
    if (defs.length === 0) return;
    const ts = this.renderTime / 1000;
    for (let i = 0; i < defs.length; i++) trainingTargetPosition(defs[i], ts, this.trainingViews[i].pos);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Placeholder self for the reusable interaction env (replaced before every use). */
function createPredictedPlayerStub(): InteractionEnv['self'] {
  return {
    id: -1, team: -1, pos: v3(), stance: 'stand', mode: 'ground', life: 'dead', vehicleId: null, seat: -1,
    parachuteOpen: false, jumpY: 0, items: { bandage: 0, firstaid: 0, medkit: 0, energy: 0, fuel: 0, frag: 0 },
  };
}

function findVehicle(list: NetVehicle[], id: EntityId): NetVehicle | null {
  for (const v of list) if (v.id === id) return v;
  return null;
}

function copySeats(dst: (EntityId | null)[], src: readonly (EntityId | null)[]): void {
  dst.length = src.length;
  for (let i = 0; i < src.length; i++) dst[i] = src[i];
}

function createPlayerView(
  id: EntityId, name: string, team: number, isBot: boolean, isSelf: boolean, isTeammate: boolean,
): PlayerView {
  return {
    id, name, team, isBot, isSelf, isTeammate: isSelf ? false : isTeammate, pos: v3(), vel: v3(), yaw: 0, pitch: 0,
    stance: 'stand', mode: 'ground', life: 'alive', weapon: null, flags: 0, vehicleId: null, seat: -1, hp: null,
    downedHp: null, gear: [0, 0, 0], age: 0, deadFor: -1,
  };
}

function createLocalView(id: EntityId, name: string, team: number): LocalPlayerView {
  return {
    id, name, team, pos: v3(), vel: v3(), onGround: false, stance: 'stand', mode: 'plane', life: 'alive',
    inWater: false, sprinting: false, eye: v3(), baseYaw: 0, basePitch: 0, recoilPitch: 0, recoilYaw: 0,
    aimYaw: 0, aimPitch: 0, lean: 0, health: MAX_HEALTH, boost: 0, downedHp: 0,
    armor: { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 }, weapons: [null, null, null], activeSlot: -1,
    weapon: null, ammo: { ammo_9mm: 0, ammo_556: 0, ammo_762: 0, ammo_12g: 0, ammo_300: 0 },
    items: { bandage: 0, firstaid: 0, medkit: 0, energy: 0, fuel: 0, frag: 0 }, capacity: [0, 0], fireCooldown: 0,
    reloadProgress: -1, drawProgress: -1, ads: 0, spread: 0, sprayCount: 0, use: null, useProgress: -1,
    revive: null, reviveProgress: -1, revivedBy: null, vehicleId: null, seat: -1, parachuteOpen: false,
    altitude: 0, jumpY: 0, throwCooldown: 0,
    stats: { kills: 0, knocks: 0, damage: 0, headshots: 0, revives: 0, longestKill: 0, shotsFired: 0, shotsHit: 0, spawnTime: 0, deathTime: 0 },
    placement: 0, killerId: null, spectating: null,
  };
}
