// Contract between the simulation (GameSim) and its consumers that must not depend on its
// internals: the bot AI and the MatchRunner. GameSim implements SimView.

import type {
  EntityId, GameEvent, LootItem, MatchConfig, MatchPhase, PlaneState, PlayerInput, PlayerState,
  Projectile, Vec3, VehicleState, World, ZoneState,
} from '../types';

/** A sound / disturbance bots can react to. Kept for ~3 s. */
export interface NoiseEvent {
  pos: Vec3;
  time: number;
  source: EntityId;
  kind: 'shot' | 'footstep' | 'vehicle' | 'explosion' | 'impact';
  /** Audible radius in meters */
  radius: number;
}

/** Event emitted by the simulation with its audience. */
export interface SimEvent {
  ev: GameEvent;
  /** Private recipients (player ids). Undefined = everyone (subject to range). */
  to?: EntityId[];
  /** Position for range culling; with `range` events are only delivered to viewers within range. */
  pos?: Vec3;
  range?: number;
}

export interface SimView {
  readonly config: MatchConfig;
  readonly world: World;
  /** Simulation time in seconds */
  readonly time: number;
  readonly tick: number;
  readonly phase: MatchPhase;
  readonly players: ReadonlyMap<EntityId, PlayerState>;
  readonly vehicles: ReadonlyMap<EntityId, VehicleState>;
  readonly loot: ReadonlyMap<EntityId, LootItem>;
  readonly projectiles: ReadonlyMap<EntityId, Projectile>;
  readonly zone: ZoneState;
  readonly plane: PlaneState | null;
  /** Recent noises (shots, explosions, vehicles, footsteps) within the last ~3 s. */
  readonly noises: readonly NoiseEvent[];

  /** Queue one input for a player; same path for bots and humans. */
  queueInput(id: EntityId, input: PlayerInput): void;
  /** Spatial queries (XZ radius). Results are appended to out (cleared first). */
  lootNear(x: number, z: number, radius: number, out: LootItem[]): LootItem[];
  playersNear(x: number, z: number, radius: number, out: PlayerState[]): PlayerState[];
  vehiclesNear(x: number, z: number, radius: number, out: VehicleState[]): VehicleState[];
  /** Eye position of a player (respects stance, lean, vehicle seat). */
  eyePos(id: EntityId, out?: Vec3): Vec3;
  /** Whether two players are teammates. */
  sameTeam(a: EntityId, b: EntityId): boolean;
}

/** Bot AI plugs into the runner: called once per tick before GameSim.step(). */
export interface BotDriver {
  update(dt: number): void;
  /** Called when a player is converted to/from bot control or removed. */
  onPlayerRemoved?(id: EntityId): void;
}
