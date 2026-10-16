// Wire protocol between client and server (and between the browser main thread and the
// local single-player worker, which speaks exactly the same protocol).
//
// Rule: the server never sends display text. Errors and notifications are codes that the
// client translates via i18n.

import type {
  ArmorState, AmmoId, BotDifficulty, ClientAction, ConsumableId, EntityId, GameEvent, ItemId,
  LootItem, MatchConfig, MatchPhase, MatchResults, PlaneState, PlayerInput, PlayerStats, ReviveState,
  TeamId, TeamSize, ThrowableId, UseState, VehicleType, WeaponId, WeaponInstance, ZoneState,
} from './types';
import type { SnapDelta } from './netcodec';

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

export interface LobbySettings {
  name: string;
  maxPlayers: number;
  teamSize: TeamSize;
  botFill: boolean;
  botDifficulty: BotDifficulty;
  /** Zone speed multiplier (1 normal, 0.5 = twice as fast) */
  zoneSpeed: number;
}

export interface LobbyMember {
  clientId: string;
  name: string;
  /** Team slot chosen in the lobby (0-based team index) */
  team: TeamId;
  ready: boolean;
  isHost: boolean;
  ping: number;
}

export type LobbyStatus = 'waiting' | 'starting' | 'in_game';

export interface LobbySummary {
  id: string;
  name: string;
  host: string;
  players: number;
  maxPlayers: number;
  teamSize: TeamSize;
  status: LobbyStatus;
}

export interface LobbyState {
  id: string;
  hostId: string;
  settings: LobbySettings;
  members: LobbyMember[];
  status: LobbyStatus;
  /** Seconds until auto-start countdown ends, or -1 */
  countdown: number;
  /** Number of team slots available (= ceil(maxPlayers / teamSize)) */
  teamCount: number;
}

export type LobbyErrorCode =
  | 'lobby.notFound'
  | 'lobby.full'
  | 'lobby.inGame'
  | 'lobby.notHost'
  | 'lobby.teamFull'
  | 'lobby.notReady'
  | 'lobby.badSettings'
  | 'lobby.nameInvalid'
  /** Server-wide or per-address limit reached (lobbies, matches, connections). */
  | 'lobby.serverLimit'
  | 'net.rateLimited'
  | 'net.badMessage'
  | 'net.versionMismatch'
  | 'net.kicked';

// ---------------------------------------------------------------------------
// Match snapshot formats (compact, quantised)
// ---------------------------------------------------------------------------

/** Flags in NetPlayer.f */
export const PF = {
  FIRING: 1 << 0,
  RELOADING: 1 << 1,
  ADS: 1 << 2,
  HEALING: 1 << 3,
  REVIVING: 1 << 4,
  CHUTE: 1 << 5,
  LEAN_L: 1 << 6,
  LEAN_R: 1 << 7,
  SPRINT: 1 << 8,
  SWIM: 1 << 9,
  ON_GROUND: 1 << 10,
  BEING_REVIVED: 1 << 11,
  DRAWING: 1 << 12,
  BOT: 1 << 13,
} as const;

/** Movement mode codes */
export const MODE_CODES = ['plane', 'freefall', 'parachute', 'ground', 'swim', 'vehicle'] as const;
/** Life codes */
export const LIFE_CODES = ['alive', 'downed', 'dead'] as const;

export interface NetPlayer {
  id: EntityId;
  /** Position [x,y,z] rounded to cm */
  p: [number, number, number];
  /** Velocity [x,y,z] rounded to cm/s */
  v: [number, number, number];
  /** Effective aim yaw / pitch (incl. recoil), radians rounded to 1e-3 */
  y: number;
  pt: number;
  /** Stance code 0/1/2 */
  s: 0 | 1 | 2;
  /** Mode code index into MODE_CODES */
  m: number;
  /** Life code index into LIFE_CODES */
  l: number;
  team: TeamId;
  /** Active weapon id or null (fists) */
  w: WeaponId | null;
  /** PF flags */
  f: number;
  /** Vehicle id & seat when in a vehicle */
  veh?: EntityId;
  seat?: number;
  /** Health 0..100 — only included for teammates (and self) */
  hp?: number;
  /** Downed bleed pool — only teammates */
  dhp?: number;
  /** Visible gear (helmet/vest/pack levels) for silhouettes: [helmet, vest, pack] */
  g: [number, number, number];
}

export interface NetVehicle {
  id: EntityId;
  t: VehicleType;
  p: [number, number, number];
  v: [number, number, number];
  /** yaw, pitch, roll */
  r: [number, number, number];
  steer: number;
  rpm: number;
  hp: number;
  fuel: number;
  seats: (EntityId | null)[];
  destroyed: boolean;
  burning: boolean;
}

export interface NetProjectile {
  id: EntityId;
  o: EntityId;
  k: 'bullet' | 'frag';
  w: WeaponId | 'frag';
  p: [number, number, number];
  v: [number, number, number];
}

/** Full private state of the receiving player (for HUD + prediction/reconciliation). */
export interface SelfState {
  id: EntityId;
  /** Last processed input seq (ack) */
  ack: number;
  pos: [number, number, number];
  vel: [number, number, number];
  onGround: boolean;
  airTime: number;
  jumpBuffer: number;
  fallSpeed: number;
  stance: 0 | 1 | 2;
  mode: number;
  life: number;
  health: number;
  boost: number;
  downedHp: number;
  armor: ArmorState;
  weapons: [WeaponInstance | null, WeaponInstance | null, WeaponInstance | null];
  activeSlot: -1 | 0 | 1 | 2;
  ammo: Record<AmmoId, number>;
  items: Record<ConsumableId | ThrowableId, number>;
  /** Used / max inventory capacity */
  capacity: [number, number];
  fireCooldown: number;
  reloadTimer: number;
  reloadTotal: number;
  drawTimer: number;
  ads: number;
  sprayCount: number;
  bloom: number;
  shotCounter: number;
  recoilPitch: number;
  recoilYaw: number;
  use: UseState | null;
  revive: ReviveState | null;
  revivedBy: EntityId | null;
  vehicleId: EntityId | null;
  seat: number;
  parachuteOpen: boolean;
  jumpY: number;
  throwCooldown: number;
  stats: PlayerStats;
  placement: number;
  spectating: EntityId | null;
  killerId: EntityId | null;
}

export interface Snapshot {
  tick: number;
  /** Server match time in ms */
  time: number;
  phase: MatchPhase;
  /** Alive players / alive teams */
  alive: number;
  teamsAlive: number;
  zone: ZoneState;
  plane: PlaneState | null;
  players: NetPlayer[];
  vehicles: NetVehicle[];
  projectiles: NetProjectile[];
  self: SelfState | null;
  /** Ids of players removed from relevance since last snapshot (left the match) */
  gone?: EntityId[];
  /** Events since the previous snapshot sent to this client, in order. */
  events: GameEvent[];
  /** Loot delta since previous snapshot */
  lootAdd?: LootItem[];
  lootRemove?: EntityId[];
}

export interface RosterEntry {
  id: EntityId;
  name: string;
  team: TeamId;
  isBot: boolean;
}

export interface MatchInit {
  config: MatchConfig;
  /** Player id controlled by this client (null = pure spectator) */
  you: EntityId | null;
  team: TeamId;
  roster: RosterEntry[];
  /** All loot on the map at join time */
  loot: LootItem[];
  /** Server time (ms) at the moment this message was produced */
  time: number;
  tickRate: number;
  snapshotRate: number;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** codec 'delta1': the server sends snapshots as `snapd` deltas (see netcodec.ts). */
  | { t: 'hello'; name: string; version: number; codec?: 'delta1' }
  | { t: 'listLobbies' }
  | { t: 'createLobby'; settings: LobbySettings }
  | { t: 'joinLobby'; id: string }
  | { t: 'leaveLobby' }
  | { t: 'lobbySettings'; settings: LobbySettings }
  | { t: 'setTeam'; team: TeamId }
  | { t: 'ready'; ready: boolean }
  | { t: 'startMatch' }
  | { t: 'chat'; text: string }
  | { t: 'input'; inputs: PlayerInput[] }
  | { t: 'ping'; c: number }
  /** Leave the running match and go back to the lobby room (after death / end). */
  | { t: 'leaveMatch' }
  /** The client finished building the match scene (releases the parked plane). */
  | { t: 'loaded' }
  /** Local worker only: start an offline match with these settings. */
  | { t: 'startLocal'; config: MatchConfig; name: string };

export type ServerMessage =
  | { t: 'welcome'; clientId: string; version: number }
  | { t: 'lobbyList'; lobbies: LobbySummary[] }
  | { t: 'lobbyState'; lobby: LobbyState }
  | { t: 'lobbyLeft' }
  | { t: 'error'; code: LobbyErrorCode }
  | { t: 'chat'; from: string; text: string }
  | { t: 'matchInit'; init: MatchInit }
  | { t: 'snap'; s: Snapshot }
  /** Delta-encoded snapshot (only to clients that announced codec 'delta1'). */
  | { t: 'snapd'; d: SnapDelta }
  | { t: 'pong'; c: number; s: number }
  | { t: 'matchOver'; results: MatchResults }
  /** Server returned this client to the lobby room after the match. */
  | { t: 'backToLobby' };

export type { ClientAction, PlayerInput, ItemId };

export const DEFAULT_LOBBY_SETTINGS: LobbySettings = {
  name: '',
  maxPlayers: 16,
  teamSize: 1,
  botFill: true,
  botDifficulty: 'normal',
  zoneSpeed: 1,
};
