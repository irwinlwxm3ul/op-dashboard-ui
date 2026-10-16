// Core shared data model. Plain JSON-serialisable data only (no classes) so it can be
// structured-cloned to a Web Worker and sent over the network.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Vec2 {
  x: number;
  z: number;
}

export type EntityId = number;
export type TeamId = number;

// ============================================================================
// Items
// ============================================================================

export type WeaponId = 'pistol' | 'smg' | 'ar' | 'shotgun' | 'dmr' | 'sniper';
export type AmmoId = 'ammo_9mm' | 'ammo_556' | 'ammo_762' | 'ammo_12g' | 'ammo_300';
export type ConsumableId = 'bandage' | 'firstaid' | 'medkit' | 'energy' | 'fuel';
export type ThrowableId = 'frag';
export type GearId =
  | 'vest1' | 'vest2' | 'vest3'
  | 'helmet1' | 'helmet2' | 'helmet3'
  | 'pack1' | 'pack2' | 'pack3';
export type ItemId = WeaponId | AmmoId | ConsumableId | ThrowableId | GearId;
export type ItemCategory = 'weapon' | 'ammo' | 'consumable' | 'throwable' | 'gear';

export type FireMode = 'auto' | 'semi' | 'bolt' | 'pump';
export type ScopeKind = 'iron' | 'reddot' | 'x4' | 'x8';
export type WeaponSoundKind = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'dmr' | 'sniper';
export type HitPart = 'head' | 'body' | 'limb';

export interface RecoilDef {
  /** Vertical kick per shot (radians) at the start of a spray. */
  vertical: number;
  /** Vertical kick multiplier growth per consecutive shot (pattern climbs then plateaus). */
  verticalGrowth: number;
  /** Max multiplier reached by growth. */
  verticalMaxMul: number;
  /** Horizontal kick magnitude (radians); direction drifts with a seeded walk (learnable). */
  horizontal: number;
  /** Multiplier for the first shot of a spray. */
  firstShotMul: number;
  /** Recoil recovery speed (radians per second) once trigger released. */
  recovery: number;
  adsMul: number;
  crouchMul: number;
  proneMul: number;
}

/** Cosmetic camera/viewmodel kick (client only). */
export interface KickDef {
  camPitch: number;
  camYaw: number;
  camRoll: number;
  vmBack: number;
  vmUp: number;
  vmRot: number;
  shake: number;
}

export interface WeaponDef {
  id: WeaponId;
  category: 'weapon';
  slot: 'primary' | 'pistol';
  ammo: AmmoId;
  magSize: number;
  fireMode: FireMode;
  /** Rounds per minute (for bolt/pump the cycle time is 60/rpm). */
  rpm: number;
  damage: number;
  pellets: number;
  headMul: number;
  limbMul: number;
  /** Damage falloff: full until start (m), linear down to minMul at end (m). */
  falloffStart: number;
  falloffEnd: number;
  falloffMinMul: number;
  /** Hitscan (instant) or ballistic projectile with travel time + drop. */
  hitscan: boolean;
  /** m/s, used by ballistic weapons and for tracer speed of hitscan weapons. */
  muzzleVelocity: number;
  /** Linear drag coefficient (1/s) for ballistic weapons. */
  drag: number;
  gravityScale: number;
  /** Max hitscan range (m). */
  range: number;
  /** Cone half-angles in radians. */
  spreadHip: number;
  spreadAds: number;
  spreadMove: number;
  spreadAir: number;
  /** Shotgun pellet cone (radians, half angle). */
  pelletSpread: number;
  bloomPerShot: number;
  bloomMax: number;
  bloomRecovery: number;
  recoil: RecoilDef;
  kick: KickDef;
  reloadTime: number;
  reloadEmptyTime: number;
  /** Shotgun loads shells one at a time when set. */
  reloadPerShell?: number;
  drawTime: number;
  adsTime: number;
  /** Field of view multiplier when fully ADS (e.g. 0.25 for 4x). */
  adsZoom: number;
  scope: ScopeKind;
  moveSpeedMul: number;
  sound: WeaponSoundKind;
  /** Distance (m) at which the shot is audible / shows on enemy minimap. */
  loudness: number;
  /** Relative weight for loot tables. */
  lootWeight: number;
}

export interface AmmoDef {
  id: AmmoId;
  category: 'ammo';
  stack: number;
  /** Space per round in inventory. */
  weight: number;
}

export interface ConsumableDef {
  id: ConsumableId;
  category: 'consumable';
  useTime: number;
  /** Health restored (absolute amount) — capped at healCap. */
  heal: number;
  healCap: number;
  boost: number;
  /** Can move while using at this speed multiplier. */
  moveMul: number;
  weight: number;
  stack: number;
}

export interface ThrowableDef {
  id: ThrowableId;
  category: 'throwable';
  fuse: number;
  damage: number;
  radius: number;
  throwSpeed: number;
  weight: number;
}

export interface GearDef {
  id: GearId;
  category: 'gear';
  kind: 'vest' | 'helmet' | 'pack';
  level: 1 | 2 | 3;
  /** Damage reduction fraction (vest/helmet). */
  reduction: number;
  durability: number;
  /** Extra inventory capacity (pack) or base capacity contribution (vest). */
  capacity: number;
}

export type ItemDef = WeaponDef | AmmoDef | ConsumableDef | ThrowableDef | GearDef;

// ============================================================================
// World (procedurally generated, identical on client & server for a seed)
// ============================================================================

export type SurfaceMaterial =
  | 'grass' | 'dirt' | 'rock' | 'sand' | 'road' | 'wood' | 'concrete' | 'metal' | 'water' | 'snow';

export type BoxKind =
  | 'wall' | 'floor' | 'roof' | 'stairs' | 'window_frame' | 'door_frame' | 'crate' | 'container'
  | 'fence' | 'barrier' | 'tower' | 'target' | 'rack' | 'ramp' | 'misc';

/** Static axis-aligned collider and render primitive. */
export interface WorldBox {
  id: number;
  min: Vec3;
  max: Vec3;
  kind: BoxKind;
  material: SurfaceMaterial;
  /** Display colour (0xRRGGBB) for procedural rendering. */
  color: number;
  /** Building id this box belongs to, or -1 for free-standing props. */
  building: number;
  /** If false, bullets pass (e.g. glass-less window frame struts are solid; fences may be see-through). */
  blocksBullets: boolean;
}

export type BuildingStyle = 'house' | 'barn' | 'apartment' | 'warehouse' | 'shed' | 'tower' | 'bunker' | 'shop';

export interface BuildingDef {
  id: number;
  style: BuildingStyle;
  /** Footprint (axis-aligned) */
  min: Vec3;
  max: Vec3;
  floors: number;
  /** Indices into World.boxes */
  boxIds: number[];
  /** Roof colour, wall colour for LOD shell */
  wallColor: number;
  roofColor: number;
  town: number;
}

export type TreeKind = 'pine' | 'oak' | 'birch' | 'dead';
export interface TreeDef {
  x: number;
  y: number;
  z: number;
  kind: TreeKind;
  scale: number;
  /** Trunk collision radius */
  r: number;
  /** Total height */
  h: number;
  rot: number;
}

export interface RockDef {
  x: number;
  y: number;
  z: number;
  /** Horizontal collision radius */
  r: number;
  h: number;
  rot: number;
  seed: number;
}

export interface BushDef {
  x: number;
  y: number;
  z: number;
  scale: number;
}

export interface RoadSegment {
  a: Vec2;
  b: Vec2;
  width: number;
}

export interface TownDef {
  id: number;
  /** Proper noun (not translated). */
  name: string;
  x: number;
  z: number;
  r: number;
  /** 0 = small village ... 2 = military / high-tier */
  tier: 0 | 1 | 2;
}

export interface LootSpawn {
  pos: Vec3;
  tier: 0 | 1 | 2;
  indoor: boolean;
}

export type VehicleType = 'buggy' | 'uaz' | 'bike';

export interface VehicleSpawn {
  pos: Vec3;
  yaw: number;
  type: VehicleType;
}

export interface TrainingTarget {
  id: number;
  pos: Vec3;
  /** Distance label in meters from the firing line. */
  range: number;
  kind: 'static' | 'moving' | 'popup';
  /** Moving targets oscillate between a and b. */
  a?: Vec3;
  b?: Vec3;
  speed?: number;
}

export interface TrainingLayout {
  spawn: Vec3;
  spawnYaw: number;
  racks: { pos: Vec3; item: ItemId }[];
  targets: TrainingTarget[];
  /** Firing line used to compute target distances. */
  firingLine: Vec3;
}

export type MapKind = 'island' | 'training';

/** Read-only world data. Implemented by src/shared/world. */
export interface World {
  seed: number;
  kind: MapKind;
  size: number;
  half: number;
  /** Heightmap: res*res floats, row-major (z rows, x columns), covering [-half, half]. */
  res: number;
  cell: number;
  heights: Float32Array;
  /** Per-vertex surface material index into SURFACE_LIST. */
  surface: Uint8Array;
  waterLevel: number;
  boxes: WorldBox[];
  buildings: BuildingDef[];
  trees: TreeDef[];
  rocks: RockDef[];
  bushes: BushDef[];
  roads: RoadSegment[];
  towns: TownDef[];
  lootSpawns: LootSpawn[];
  vehicleSpawns: VehicleSpawn[];
  training: TrainingLayout | null;

  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out?: Vec3): Vec3;
  surfaceAt(x: number, z: number): SurfaceMaterial;
  /** Ground height including box tops under (x,z) at or below y+0.01 (for spawn placement). */
  groundAt(x: number, z: number, fromY?: number): number;
  inBounds(x: number, z: number): boolean;
  queryBoxes(minX: number, minZ: number, maxX: number, maxZ: number, out: WorldBox[]): WorldBox[];
  queryTrees(minX: number, minZ: number, maxX: number, maxZ: number, out: TreeDef[]): TreeDef[];
  queryRocks(minX: number, minZ: number, maxX: number, maxZ: number, out: RockDef[]): RockDef[];
}

export type RayHitKind = 'terrain' | 'box' | 'tree' | 'rock' | 'water' | 'player' | 'vehicle';
export interface RayHit {
  dist: number;
  point: Vec3;
  normal: Vec3;
  kind: RayHitKind;
  material: SurfaceMaterial | 'flesh' | 'armor';
  /** Entity id for player / vehicle hits, box id for boxes. */
  id?: number;
  part?: HitPart;
}

export interface Hitbox {
  /** Capsule from a to b with radius r (a==b is a sphere). */
  a: Vec3;
  b: Vec3;
  r: number;
  part: HitPart;
}

// ============================================================================
// Simulation entities
// ============================================================================

export type Stance = 'stand' | 'crouch' | 'prone';
export type LifeState = 'alive' | 'downed' | 'dead';
export type MovementMode = 'plane' | 'freefall' | 'parachute' | 'ground' | 'swim' | 'vehicle';

export interface WeaponInstance {
  id: WeaponId;
  mag: number;
}

export interface ArmorState {
  vest: 0 | 1 | 2 | 3;
  vestHp: number;
  helmet: 0 | 1 | 2 | 3;
  helmetHp: number;
  pack: 0 | 1 | 2 | 3;
}

export interface UseState {
  item: ConsumableId;
  elapsed: number;
  total: number;
  /** For fuel: vehicle being refuelled */
  target?: EntityId;
}

export interface ReviveState {
  target: EntityId;
  elapsed: number;
}

export interface PlayerStats {
  kills: number;
  knocks: number;
  damage: number;
  headshots: number;
  revives: number;
  longestKill: number;
  shotsFired: number;
  shotsHit: number;
  /** Sim time (s) the player landed / died */
  spawnTime: number;
  deathTime: number;
}

/** Physics body for character movement, shared with client prediction. */
export interface CharacterBody {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  /** Seconds since last grounded (for coyote time). */
  airTime: number;
  /** Remaining jump buffer time. */
  jumpBuffer: number;
  stance: Stance;
  mode: MovementMode;
  /** Max downward speed seen while airborne (for landing / fall damage). */
  fallSpeed: number;
}

/** Full authoritative player state (server / local sim only). */
export interface PlayerState extends CharacterBody {
  id: EntityId;
  name: string;
  team: TeamId;
  isBot: boolean;
  connected: boolean;
  /** Base aim (client-controlled, without recoil). */
  yaw: number;
  pitch: number;
  /** Server-authoritative accumulated recoil. Effective aim = base + recoil. */
  recoilPitch: number;
  recoilYaw: number;
  lean: -1 | 0 | 1;
  life: LifeState;
  health: number;
  boost: number;
  /** Downed bleed-out pool */
  downedHp: number;
  knockCount: number;
  armor: ArmorState;
  /** [primary A, primary B, pistol] */
  weapons: [WeaponInstance | null, WeaponInstance | null, WeaponInstance | null];
  /** -1 = unarmed / fists */
  activeSlot: -1 | 0 | 1 | 2;
  ammo: Record<AmmoId, number>;
  items: Record<ConsumableId | ThrowableId, number>;
  fireCooldown: number;
  reloadTimer: number;
  reloadTotal: number;
  drawTimer: number;
  /** ADS blend 0..1 */
  ads: number;
  /** Consecutive shots in the current spray (drives recoil pattern). */
  sprayCount: number;
  bloom: number;
  /** Total shots fired (deterministic spread seed). */
  shotCounter: number;
  use: UseState | null;
  revive: ReviveState | null;
  revivedBy: EntityId | null;
  vehicleId: EntityId | null;
  seat: number;
  parachuteOpen: boolean;
  /** Height the player left the plane at (for MIN_CHUTE_DROP). */
  jumpY: number;
  lastSeq: number;
  lastButtons: number;
  /** Throwable cooldown */
  throwCooldown: number;
  stats: PlayerStats;
  /** Final placement (1 = winner), 0 while alive */
  placement: number;
  killerId: EntityId | null;
  spectating: EntityId | null;
  /** Damage dealt per attacker for assist / kill credit when bleeding out. */
  lastAttacker: EntityId | null;
  lastAttackerWeapon: WeaponId | 'zone' | 'vehicle' | 'frag' | 'fall' | null;
}

export interface VehicleState {
  id: EntityId;
  type: VehicleType;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Angular velocity around Y (rad/s). */
  yawRate: number;
  /** Signed forward speed (m/s). */
  speed: number;
  steer: number;
  throttle: number;
  rpm: number;
  health: number;
  fuel: number;
  /** Player id per seat, seat 0 is the driver. */
  seats: (EntityId | null)[];
  onGround: boolean;
  destroyed: boolean;
  /** Seconds until explosion once health hits 0 (burning). */
  burnTimer: number;
  lastDriver: EntityId | null;
}

export type LootKind = ItemId;
export interface LootItem {
  id: EntityId;
  item: ItemId;
  count: number;
  pos: Vec3;
  /** For weapon drops: rounds in the magazine. */
  mag?: number;
}

export interface Projectile {
  id: EntityId;
  owner: EntityId;
  kind: 'bullet' | 'frag';
  weapon: WeaponId | 'frag';
  pos: Vec3;
  vel: Vec3;
  /** Sim time when fired (s). */
  born: number;
  /** Lag-compensation offset to apply to hitbox history (s). */
  rewind: number;
  /** Frag fuse remaining. */
  fuse: number;
  /** Traveled distance (for falloff / longest kill). */
  traveled: number;
  origin: Vec3;
  damage: number;
}

export type ZoneStage = 'pre' | 'waiting' | 'shrinking' | 'final';
export interface ZoneState {
  phase: number;
  stage: ZoneStage;
  /** Current (shrinking) circle */
  cx: number;
  cz: number;
  r: number;
  /** Target circle for this phase (white circle) */
  nx: number;
  nz: number;
  nr: number;
  /** Seconds remaining in current stage */
  timer: number;
  /** Total seconds of current stage */
  stageTotal: number;
  damagePerSec: number;
}

export interface PlaneState {
  start: Vec2;
  end: Vec2;
  altitude: number;
  speed: number;
  /** Sim time when plane started */
  startTime: number;
  /** Distance travelled along path */
  traveled: number;
  length: number;
  active: boolean;
}

export type MatchPhase = 'waiting' | 'plane' | 'playing' | 'ended';
export type MatchMode = 'br' | 'training';
export type BotDifficulty = 'easy' | 'normal' | 'hard';
export type TeamSize = 1 | 2 | 4;

export interface MatchConfig {
  mode: MatchMode;
  seed: number;
  maxPlayers: number;
  teamSize: TeamSize;
  botFill: boolean;
  botDifficulty: BotDifficulty;
  /** Multiplier for zone timings (1 = normal; <1 faster) */
  zoneSpeed: number;
  /** Training ground: infinite ammo */
  infiniteAmmo: boolean;
}

export interface PlayerResult {
  id: EntityId;
  name: string;
  team: TeamId;
  isBot: boolean;
  placement: number;
  kills: number;
  knocks: number;
  damage: number;
  headshots: number;
  revives: number;
  longestKill: number;
  survivalTime: number;
  accuracy: number;
}

export interface MatchResults {
  winnerTeam: TeamId | null;
  duration: number;
  players: PlayerResult[];
}

// ============================================================================
// Input (client -> server). The client sends intent only.
// ============================================================================

export const BTN = {
  FIRE: 1 << 0,
  ADS: 1 << 1,
  JUMP: 1 << 2,
  SPRINT: 1 << 3,
  RELOAD: 1 << 4,
  INTERACT: 1 << 5,
  LEAN_L: 1 << 6,
  LEAN_R: 1 << 7,
  WALK: 1 << 8,
  HOLD_BREATH: 1 << 9,
  /** Free look (Alt) — body keeps heading, camera rotates. */
  FREELOOK: 1 << 10,
  /** Vehicle: handbrake (maps from JUMP key client side as well). */
  HANDBRAKE: 1 << 11,
  /** Vehicle boost */
  BOOST: 1 << 12,
  /** Parachute dive (W in freefall) handled by moveZ; this flags "flare". */
  FLARE: 1 << 13,
} as const;

export const STANCE_CODE: Record<Stance, 0 | 1 | 2> = { stand: 0, crouch: 1, prone: 2 };
export const STANCE_FROM_CODE: Stance[] = ['stand', 'crouch', 'prone'];

export type ClientAction =
  | { a: 'pickup'; id: EntityId }
  | { a: 'drop'; item: ItemId; count?: number }
  | { a: 'dropWeapon'; slot: 0 | 1 | 2 }
  | { a: 'use'; item: ConsumableId }
  | { a: 'cancel' }
  | { a: 'throw' }
  | { a: 'enter'; id: EntityId; seat?: number }
  | { a: 'exit' }
  | { a: 'seat'; seat: number }
  | { a: 'revive'; id: EntityId }
  | { a: 'jump' }
  | { a: 'chute' }
  | { a: 'spectate'; id: EntityId }
  | { a: 'respawn' }
  | { a: 'give'; item: ItemId }
  | { a: 'swapWeapons' };

export interface PlayerInput {
  /** Monotonic per-client sequence number; one input == one TICK_DT step. */
  seq: number;
  /** Strafe (right +) and forward (+) axes, each -1..1 (clamped to unit circle by server). */
  mx: number;
  mz: number;
  /** Base aim without recoil. */
  yaw: number;
  pitch: number;
  buttons: number;
  /** Desired stance code 0 stand / 1 crouch / 2 prone. */
  stance: 0 | 1 | 2;
  /** Requested active weapon slot (-1 fists, 0..2) */
  slot: -1 | 0 | 1 | 2;
  /** Server time (ms) of the interpolated world the client was viewing (lag compensation). */
  rt: number;
  actions?: ClientAction[];
}

// ============================================================================
// Game events (server -> client). Codes only; the client translates.
// ============================================================================

export type DamageSource = WeaponId | 'zone' | 'vehicle' | 'frag' | 'fall' | 'explosion' | 'bleed' | 'drown';

export type GameEvent =
  | {
      type: 'shot';
      shooter: EntityId;
      weapon: WeaponId;
      origin: Vec3;
      /** End points of each pellet / tracer (hitscan) */
      ends: Vec3[];
      /** Ballistic projectile ids spawned by this shot */
      projectiles?: EntityId[];
      shotIndex: number;
    }
  | { type: 'impact'; pos: Vec3; normal: Vec3; material: SurfaceMaterial | 'flesh' | 'armor'; weapon?: WeaponId }
  | {
      type: 'hit';
      attacker: EntityId;
      victim: EntityId;
      damage: number;
      part: HitPart;
      armor: boolean;
      /** Victim armor/helmet destroyed by this hit */
      armorBroke: boolean;
      pos: Vec3;
      from: Vec3;
      source: DamageSource;
      /** Victim's resulting state */
      result: 'damage' | 'knock' | 'kill';
      distance: number;
    }
  | { type: 'knock'; attacker: EntityId | null; victim: EntityId; source: DamageSource; headshot: boolean; distance: number }
  | { type: 'kill'; attacker: EntityId | null; victim: EntityId; source: DamageSource; headshot: boolean; distance: number; finished: boolean }
  | { type: 'revived'; reviver: EntityId; target: EntityId }
  | { type: 'teamEliminated'; team: TeamId; placement: number }
  | { type: 'pickup'; player: EntityId; item: ItemId; count: number }
  | { type: 'reload'; player: EntityId; weapon: WeaponId; empty: boolean }
  | { type: 'draw'; player: EntityId; weapon: WeaponId | null }
  | { type: 'dryfire'; player: EntityId }
  | { type: 'useStart'; player: EntityId; item: ConsumableId }
  | { type: 'useDone'; player: EntityId; item: ConsumableId }
  | { type: 'jumpPlane'; player: EntityId }
  | { type: 'chuteOpen'; player: EntityId }
  | { type: 'land'; player: EntityId; speed: number }
  | { type: 'footstep'; player: EntityId; material: SurfaceMaterial }
  | { type: 'jump'; player: EntityId }
  | { type: 'vehicleEnter'; player: EntityId; vehicle: EntityId; seat: number }
  | { type: 'vehicleExit'; player: EntityId; vehicle: EntityId }
  | { type: 'vehicleCrash'; vehicle: EntityId; impact: number; pos: Vec3 }
  | { type: 'vehicleDestroyed'; vehicle: EntityId; pos: Vec3 }
  | { type: 'explosion'; pos: Vec3; radius: number; source: 'frag' | 'vehicle' }
  | { type: 'throw'; player: EntityId; projectile: EntityId }
  | { type: 'zonePhase'; phase: number; stage: ZoneStage; timer: number }
  | { type: 'planeStart' }
  | { type: 'matchStart' }
  | { type: 'matchEnd'; results: MatchResults }
  | { type: 'spawned'; player: EntityId }
  | { type: 'targetHit'; target: number; damage: number; part: HitPart; distance: number };
