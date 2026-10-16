// Per-bot memory. One object per bot, allocated when the bot is first seen and reused every tick.

import { hash32, Rng } from '../rng';
import type { ClientAction, EntityId, PlayerInput, PlayerState } from '../types';
import { newPathRequest, type PathRequest } from './pathfind';

export type BotGoal =
  | 'plane' | 'drop' | 'downed' | 'combat' | 'cover' | 'heal' | 'revive' | 'zone' | 'vehicle'
  | 'drive' | 'passenger' | 'loot' | 'explore' | 'follow' | 'investigate' | 'idle' | 'descend';

/** Number of enemies a bot can keep track of at once. */
export const MAX_CONTACTS = 8;

/** What the bot knows about one enemy (only what a human could have seen or inferred). */
export interface Contact {
  /** Player id, -1 = free slot. */
  id: EntityId;
  /** Last seen feet position. */
  x: number;
  y: number;
  z: number;
  /** Velocity estimate at the last sighting. */
  vx: number;
  vz: number;
  /** Time the current sighting streak started. */
  firstSeen: number;
  /** Earliest time the bot may shoot at this contact (sighting + reaction time). */
  ready: number;
  /** Last time it was confirmed visible. */
  lastSeen: number;
  /** Last line-of-sight test time. */
  lastCheck: number;
  visible: boolean;
  downed: boolean;
}

export interface BotState {
  id: EntityId;
  rng: Rng;
  seq: number;
  /** Think when (tick + thinkSlot) % THINK_EVERY === 0. */
  thinkSlot: number;
  thoughtOnce: boolean;

  goal: BotGoal;
  goalSince: number;

  // ---- movement ----
  hasDest: boolean;
  destX: number;
  destZ: number;
  /** Destination feet height for upper floors (NaN = ground level). */
  destY: number;
  /** Distance at which the destination counts as reached. */
  arrive: number;
  /** Sprint while travelling. */
  sprint: boolean;
  /** Walk slowly (ADS-ready, quiet). */
  walk: boolean;
  path: PathRequest;
  pathIdx: number;
  /** Destination the current path was planned for. */
  pathGX: number;
  pathGZ: number;
  pathTime: number;
  /** Desired world move direction this tick (unit, or 0). */
  moveX: number;
  moveZ: number;
  moveScale: number;
  // stuck detection
  stuckRefX: number;
  stuckRefZ: number;
  stuckRefTime: number;
  stuckLevel: number;
  sidestepUntil: number;
  sidestepDir: number;
  /** Walking around a vehicle hull (not in the nav grid): which one, orbit sense (+1/-1), until. */
  vehAvoidId: number;
  vehAvoidSide: number;
  vehAvoidUntil: number;
  jumpNow: boolean;
  /** Destination blacklisted after giving up (x, z, until). */
  avoidX: number;
  avoidZ: number;
  avoidUntil: number;
  /** Rotates through roof edges when getting down from a stranded spot fails. */
  descendTry: number;

  // ---- aim ----
  aimYaw: number;
  aimPitch: number;
  errYaw: number;
  errPitch: number;
  wobYaw: number;
  wobPitch: number;
  wobUntil: number;
  /** Previous bearing to the target (tracking-lag estimate). */
  prevBearing: number;
  /** Look target when not fighting. */
  lookYaw: number;
  lookPitch: number;
  /** Look toward an alert bearing until this time (damage / noise). */
  alertYaw: number;
  alertUntil: number;

  // ---- perception / combat ----
  contacts: Contact[];
  targetId: EntityId;
  aimHead: boolean;
  reactAt: number;
  lastContactTime: number;
  lastHealth: number;
  lastDamageTime: number;
  lastHeard: number;
  investigateX: number;
  investigateZ: number;
  investigateTime: number;
  burstLeft: number;
  burstPauseUntil: number;
  lastShotCounter: number;
  lastTapTime: number;
  triggerHeld: boolean;
  strafeDir: number;
  strafeUntil: number;
  crouchUntil: number;
  combatMode: number;
  coverX: number;
  coverZ: number;
  coverValid: boolean;
  coverUntil: number;
  coverDecided: number;
  fragUntil: number;
  fragX: number;
  fragY: number;
  fragZ: number;
  lastSwitch: number;
  reloadPressAt: number;
  /** Slot the bot wants active (-1 = fists). */
  wantSlot: -1 | 0 | 1 | 2;

  // ---- loot / explore ----
  lootId: EntityId;
  lootSince: number;
  lootTries: number;
  lootActionAt: number;
  /** Loot scan cadence and its cached result. */
  lootScanAt: number;
  lootPick: EntityId;
  lootPickScore: number;
  exploreScanAt: number;
  blacklist: Map<EntityId, number>;
  explored: Uint8Array;
  exploreBuilding: number;
  exploreSince: number;

  // ---- support ----
  useActionAt: number;
  reviveId: EntityId;
  reviveActionAt: number;

  // ---- drop ----
  hasLanding: boolean;
  landX: number;
  landZ: number;
  jumpLead: number;
  chuteHeight: number;
  jumpDelayUntil: number;
  planeActionAt: number;

  // ---- vehicles ----
  vehicleId: EntityId;
  /** Vehicle the bot currently sits in (-1 on foot): per-ride state resets when it changes. */
  rideId: EntityId;
  vehicleSince: number;
  vehicleActionAt: number;
  /** Vehicles this bot gave up on (id -> until time). */
  vehicleBlacklist: Map<EntityId, number>;
  driveHeading: number;
  driveStuckSince: number;
  /** Since when the driver has been making steady progress (-1 = not). */
  driveGoodSince: number;
  reverseUntil: number;
  driveStuckCount: number;
  /** Where the last dead end was (m). */
  driveStuckX: number;
  driveStuckZ: number;
  driveWaitUntil: number;
  driveThrottle: number;
  /** Speed the driver aims for (m/s), from the obstacle / turn / terrain probes at think time. */
  driveTargetSpeed: number;
  exitWanted: boolean;

  // ---- zone / idle ----
  zoneKey: number;
  zoneX: number;
  zoneZ: number;
  wanderX: number;
  wanderZ: number;
  wanderUntil: number;

  // ---- output ----
  input: PlayerInput;
  actions: ClientAction[];
}

function createContact(): Contact {
  return { id: -1, x: 0, y: 0, z: 0, vx: 0, vz: 0, firstSeen: 0, ready: 0, lastSeen: -1e9, lastCheck: -1e9, visible: false, downed: false };
}

export function createBotState(p: PlayerState, seed: number, thinkSlot: number, buildings: number): BotState {
  const contacts: Contact[] = [];
  for (let i = 0; i < MAX_CONTACTS; i++) contacts.push(createContact());
  const actions: ClientAction[] = [];
  return {
    id: p.id,
    rng: new Rng(hash32(seed, p.id, 0xb07)),
    seq: p.lastSeq,
    thinkSlot,
    thoughtOnce: false,
    goal: 'idle',
    goalSince: 0,
    hasDest: false,
    destX: 0,
    destZ: 0,
    destY: NaN,
    arrive: 1,
    sprint: false,
    walk: false,
    path: newPathRequest(),
    pathIdx: 0,
    pathGX: 0,
    pathGZ: 0,
    pathTime: -1e9,
    moveX: 0,
    moveZ: 0,
    moveScale: 0,
    stuckRefX: p.pos.x,
    stuckRefZ: p.pos.z,
    stuckRefTime: 0,
    stuckLevel: 0,
    sidestepUntil: 0,
    sidestepDir: 1,
    vehAvoidId: -1,
    vehAvoidSide: 1,
    vehAvoidUntil: -1e9,
    jumpNow: false,
    avoidX: 0,
    avoidZ: 0,
    avoidUntil: -1e9,
    descendTry: 0,
    aimYaw: p.yaw,
    aimPitch: p.pitch,
    errYaw: 0,
    errPitch: 0,
    wobYaw: 0,
    wobPitch: 0,
    wobUntil: 0,
    prevBearing: 0,
    lookYaw: p.yaw,
    lookPitch: 0,
    alertYaw: 0,
    alertUntil: -1e9,
    contacts,
    targetId: -1,
    aimHead: false,
    reactAt: 0,
    lastContactTime: -1e9,
    lastHealth: p.health,
    lastDamageTime: -1e9,
    lastHeard: -1e9,
    investigateX: 0,
    investigateZ: 0,
    investigateTime: -1e9,
    burstLeft: 0,
    burstPauseUntil: 0,
    lastShotCounter: p.shotCounter,
    lastTapTime: -1e9,
    triggerHeld: false,
    strafeDir: 1,
    strafeUntil: 0,
    crouchUntil: 0,
    combatMode: 0,
    coverX: 0,
    coverZ: 0,
    coverValid: false,
    coverUntil: 0,
    coverDecided: -1e9,
    fragUntil: -1e9,
    fragX: 0,
    fragY: 0,
    fragZ: 0,
    lastSwitch: -1e9,
    reloadPressAt: -1e9,
    wantSlot: p.activeSlot,
    lootId: -1,
    lootSince: 0,
    lootTries: 0,
    lootActionAt: -1e9,
    lootScanAt: 0,
    lootPick: -1,
    lootPickScore: 0,
    exploreScanAt: 0,
    blacklist: new Map(),
    explored: new Uint8Array(Math.max(1, buildings)),
    exploreBuilding: -1,
    exploreSince: 0,
    useActionAt: -1e9,
    reviveId: -1,
    reviveActionAt: -1e9,
    hasLanding: false,
    landX: 0,
    landZ: 0,
    jumpLead: 0,
    chuteHeight: 150,
    jumpDelayUntil: -1,
    planeActionAt: -1e9,
    vehicleId: -1,
    rideId: -1,
    vehicleSince: 0,
    vehicleActionAt: -1e9,
    vehicleBlacklist: new Map(),
    driveHeading: 0,
    driveStuckSince: -1,
    driveGoodSince: -1,
    reverseUntil: 0,
    driveStuckCount: 0,
    driveStuckX: 0,
    driveStuckZ: 0,
    driveWaitUntil: 0,
    driveThrottle: 0,
    driveTargetSpeed: 0,
    exitWanted: false,
    zoneKey: -1,
    zoneX: 0,
    zoneZ: 0,
    wanderX: 0,
    wanderZ: 0,
    wanderUntil: -1e9,
    input: { seq: 0, mx: 0, mz: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0, stance: 0, slot: p.activeSlot, rt: 0, actions },
    actions,
  };
}
