// CONTRACT (owned by the integrator, not by module agents).
// Client-side game state handed to rendering, UI, audio and game-feel every frame, plus the
// settings store and input API shapes. Implemented by src/client/game (ClientGame, settings,
// input) and consumed by src/client/render, src/client/ui, src/client/feel, src/client/app.

import type { MatchInit, RosterEntry } from '../../shared/protocol';
import type {
  ArmorState, AmmoId, ClientAction, ConsumableId, EntityId, GameEvent, ItemId, LifeState, LootItem,
  MatchConfig, MatchPhase, MatchResults, MovementMode, PlaneState, PlayerStats, ReviveState, Stance,
  SurfaceMaterial, TeamId, ThrowableId, UseState, Vec3, VehicleType, WeaponId, WeaponInstance, World,
  ZoneState,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Per-frame views
// ---------------------------------------------------------------------------

export interface PlayerView {
  id: EntityId;
  name: string;
  team: TeamId;
  isBot: boolean;
  isSelf: boolean;
  isTeammate: boolean;
  /** Interpolated (remote) or predicted+smoothed (self) feet position */
  pos: Vec3;
  vel: Vec3;
  /** Effective aim (incl. recoil) */
  yaw: number;
  pitch: number;
  stance: Stance;
  mode: MovementMode;
  life: LifeState;
  weapon: WeaponId | null;
  /** PF flags from protocol.ts */
  flags: number;
  vehicleId: EntityId | null;
  seat: number;
  /** Only known for self and teammates */
  hp: number | null;
  downedHp: number | null;
  /** [helmet, vest, pack] levels */
  gear: [number, number, number];
  /** ms since this player was last present in a snapshot */
  age: number;
  /** Seconds since death (for death animation / fade-out), -1 while not dead */
  deadFor: number;
}

export interface VehicleView {
  id: EntityId;
  type: VehicleType;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Signed forward speed m/s */
  speed: number;
  steer: number;
  rpm: number;
  hp: number;
  fuel: number;
  seats: (EntityId | null)[];
  destroyed: boolean;
  burning: boolean;
  /** True when predicted locally (local player is driving) */
  predicted: boolean;
}

export interface ProjectileView {
  id: EntityId;
  owner: EntityId;
  kind: 'bullet' | 'frag';
  weapon: WeaponId | 'frag';
  pos: Vec3;
  vel: Vec3;
}

export interface LocalPlayerView {
  id: EntityId;
  name: string;
  team: TeamId;
  /** Predicted + error-smoothed feet position */
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  stance: Stance;
  mode: MovementMode;
  life: LifeState;
  inWater: boolean;
  sprinting: boolean;
  /** Eye position (stance, lean, seat aware) */
  eye: Vec3;
  /** Base aim (mouse) */
  baseYaw: number;
  basePitch: number;
  /** Predicted server-authoritative recoil */
  recoilPitch: number;
  recoilYaw: number;
  /** Effective aim = base + recoil (where bullets go) */
  aimYaw: number;
  aimPitch: number;
  lean: -1 | 0 | 1;
  health: number;
  boost: number;
  downedHp: number;
  armor: ArmorState;
  weapons: [WeaponInstance | null, WeaponInstance | null, WeaponInstance | null];
  activeSlot: -1 | 0 | 1 | 2;
  /** Convenience: active weapon id or null */
  weapon: WeaponId | null;
  ammo: Record<AmmoId, number>;
  items: Record<ConsumableId | ThrowableId, number>;
  /** [used, max] */
  capacity: [number, number];
  fireCooldown: number;
  /** 0..1 progress, -1 when not reloading */
  reloadProgress: number;
  /** 0..1 progress, -1 when not drawing */
  drawProgress: number;
  /** ADS blend 0..1 */
  ads: number;
  /** Current spread cone (radians, half angle) for the dynamic crosshair */
  spread: number;
  sprayCount: number;
  use: UseState | null;
  /** 0..1, -1 when not using an item */
  useProgress: number;
  revive: ReviveState | null;
  /** 0..1, -1 when not reviving */
  reviveProgress: number;
  revivedBy: EntityId | null;
  vehicleId: EntityId | null;
  seat: number;
  parachuteOpen: boolean;
  /** Height above ground (freefall/parachute HUD) */
  altitude: number;
  jumpY: number;
  throwCooldown: number;
  stats: PlayerStats;
  placement: number;
  killerId: EntityId | null;
  spectating: EntityId | null;
}

export type InteractionKind = 'jump' | 'chute' | 'pickup' | 'enter' | 'exit' | 'revive' | 'refuel' | 'give';

export interface Interaction {
  kind: InteractionKind;
  targetId?: EntityId;
  item?: ItemId;
  count?: number;
  vehicleType?: VehicleType;
  seat?: number;
  /** Player name (revive target) */
  name?: string;
  /** Requires holding the interact key */
  hold: boolean;
}

export type CameraMode = 'fpp' | 'tpp';

export interface CameraInput {
  /** Look direction (aim, or free-look while holding Alt) */
  yaw: number;
  pitch: number;
  freeLook: boolean;
  mode: CameraMode;
}

export interface TrainingTargetView {
  id: number;
  pos: Vec3;
  kind: 'static' | 'moving' | 'popup';
  range: number;
}

export interface FrameState {
  /** Interpolation (render) time in server ms */
  time: number;
  /** Estimated current server time in ms */
  serverNow: number;
  /** Frame delta seconds */
  dt: number;
  phase: MatchPhase;
  config: MatchConfig;
  world: World;
  roster: ReadonlyMap<EntityId, RosterEntry>;
  localId: EntityId | null;
  localTeam: TeamId;
  /** Player the camera follows: self while alive, spectated player when dead */
  viewTargetId: EntityId | null;
  self: LocalPlayerView | null;
  /** All known players including self (isSelf) */
  players: ReadonlyMap<EntityId, PlayerView>;
  vehicles: ReadonlyMap<EntityId, VehicleView>;
  projectiles: ReadonlyMap<EntityId, ProjectileView>;
  loot: ReadonlyMap<EntityId, LootItem>;
  zone: ZoneState;
  plane: PlaneState | null;
  /** Current plane position (null when no plane) */
  planePos: Vec3 | null;
  alive: number;
  teamsAlive: number;
  /** Round trip ms (0 for local) */
  ping: number;
  interaction: Interaction | null;
  results: MatchResults | null;
  camera: CameraInput;
  trainingTargets: TrainingTargetView[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Locally predicted events (instant feedback before server confirmation). */
export type LocalEvent =
  | { type: 'localShot'; weapon: WeaponId; origin: Vec3; dirs: Vec3[]; shotIndex: number; ballistic: boolean }
  | { type: 'localReload'; weapon: WeaponId; empty: boolean }
  | { type: 'localReloadDone'; weapon: WeaponId }
  | { type: 'localDryFire'; weapon: WeaponId }
  | { type: 'localJump' }
  | { type: 'localLand'; speed: number }
  | { type: 'localFootstep'; material: SurfaceMaterial; intensity: number }
  | { type: 'localStance'; stance: Stance }
  | { type: 'localWeaponSwitch'; weapon: WeaponId | null }
  | { type: 'localAds'; on: boolean }
  | { type: 'localSnapshot' };

export type ClientEvent = GameEvent | LocalEvent;
export type ClientEventType = ClientEvent['type'];
export type ClientEventOf<T extends ClientEventType> = Extract<ClientEvent, { type: T }>;

export interface ClientEventBus {
  on<T extends ClientEventType>(type: T, cb: (ev: ClientEventOf<T>) => void): () => void;
  onAny(cb: (ev: ClientEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export type KeyAction =
  | 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'walk' | 'jump' | 'crouch' | 'prone'
  | 'leanLeft' | 'leanRight' | 'reload' | 'interact' | 'throw' | 'holster'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'swapWeapons'
  | 'inventory' | 'map' | 'cameraToggle' | 'freeLook'
  | 'useBandage' | 'useFirstAid' | 'useMedkit' | 'useEnergy' | 'refuel'
  | 'stats' | 'scoreboard' | 'menu';

export interface Settings {
  playerName: string;
  quality: Quality;
  renderScale: number;
  fov: number;
  mouseSensitivity: number;
  adsSensitivity: number;
  scopeSensitivity: number;
  invertY: boolean;
  masterVolume: number;
  sfxVolume: number;
  uiVolume: number;
  showFps: boolean;
  damageNumbers: boolean;
  toggleCrouch: boolean;
  toggleAds: boolean;
  cameraMode: CameraMode;
  keybinds: Record<KeyAction, string>;
}

export interface SettingsStore {
  get(): Settings;
  set(patch: Partial<Settings>): void;
  setKey(action: KeyAction, code: string): void;
  resetKeybinds(): void;
  subscribe(cb: (s: Settings) => void): () => void;
}

// ---------------------------------------------------------------------------
// Input & ClientGame
// ---------------------------------------------------------------------------

export type InputUiEvent =
  | 'toggleInventory' | 'toggleMap' | 'toggleStats' | 'toggleScoreboard' | 'menu' | 'toggleCamera';

export interface InputApi {
  attach(target: HTMLElement): void;
  detach(): void;
  readonly locked: boolean;
  requestLock(): void;
  exitLock(): void;
  /** When false (menus/inventory/map open) game input is suppressed and keys are released. */
  enabled: boolean;
  on(ev: InputUiEvent, cb: () => void): () => void;
}

export interface ClientGameApi {
  readonly init: MatchInit;
  readonly world: World;
  readonly events: ClientEventBus;
  readonly input: InputApi;
  /** Call every animation frame with the frame delta in seconds. */
  update(dt: number): void;
  getFrame(): FrameState;
  queueAction(a: ClientAction): void;
  /** Perform the current interaction prompt (if any). */
  performInteraction(): void;
  dispose(): void;
}
