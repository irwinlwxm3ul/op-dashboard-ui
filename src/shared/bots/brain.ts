// Goal selection (hierarchical state machine with utility scoring) and the non-combat on-foot
// behaviours: loot, explore buildings, rotate with the zone (optionally by vehicle), heal and
// boost, revive teammates, follow a human squad leader, investigate noises and wander.

import { REVIVE_RANGE } from '../constants';
import { WEAPONS, canUseConsumable, isWeaponId } from '../items';
import { angleDiff } from '../math';
import type { ConsumableId, PlayerState } from '../types';
import { BTN } from '../types';
import { WEAPON_RANGE, slotRounds } from './aim';
import { activeWeapon, combatAct, combatThink, manageWeapon, steerAim, wantReload } from './combat';
import { freeCapacity, lootUtility, wellEquipped, worstPrimarySlot } from './loot';
import { INTERIOR_NONE, INTERIOR_OK, INTERIOR_PENDING, buildingInterior } from './mapinfo';
import {
  aboveGround, checkStuck, clearDest, facingMove, followPath, isAvoided, moveYaw, setDest, setDirectDest,
} from './movement';
import type { FloorLoc } from './floors';
import { PATH_QUEUED, PATH_RUNNING } from './pathfind';
import { findContact, perceive, selectTarget } from './perception';
import type { BotGoal, BotState } from './state';
import type { BotSystem } from './system';
import { VEHICLE_BLACKLIST_TIME, VEHICLE_TRIP, approachVehicle, findVehicle } from './vehicle';
import { insideNext, outsideCurrent, updateZoneTarget, zoneActive, zoneUrgency } from './zone';
import { hyp } from './util';

const LOOT_RADIUS = 30;
/** Unarmed bots look further for a gun. */
const LOOT_RADIUS_UNARMED = 55;
const EXPLORE_RADIUS = 220;
const REVIVE_SEARCH = 120;
/** Revive action distance (3D, inside the sim's REVIVE_RANGE + slack) and where the bot stops. */
const REVIVE_START_DIST = REVIVE_RANGE - 0.1;
const REVIVE_STOP_DIST = 1.3;
/** Items more than this above the terrain lie on an upper floor. */
const UPPER_FLOOR = 2.4;
/** A bot this far above the nav floor under it is on a roof / upper floor. */
const ELEVATED = 2.2;
/** Loot within this height of the feet can be picked up from where the bot stands. */
const PICKUP_DY = 2.4;
const floorLoc: FloorLoc = { building: -1, level: -1, cell: -1 };
/** Goal stickiness (score bonus for the current goal). */
const HYSTERESIS = 8;

// Think-time scratch results (behaviour code is not re-entrant).
let curGoal: BotGoal = 'idle';
let bestGoal: BotGoal = 'idle';
let bestScore = 0;
let lootPick = -1;
let lootPickScore = 0;
let revivePick: PlayerState | null = null;
let followPick: PlayerState | null = null;
let followHuman = false;

export interface ActOut {
  mx: number;
  mz: number;
  buttons: number;
  stance: 0 | 1 | 2;
}

// ---------------------------------------------------------------------------
// Think
// ---------------------------------------------------------------------------

/** On-foot think (alive, ground or swimming). */
export function brainThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now, sk = sys.skill;
  perceive(sys, b, p);
  selectTarget(sys, b, p);
  if (checkStuck(sys, b, p)) onGaveUp(sys, b);
  if (zoneActive(sys)) updateZoneTarget(sys, b, p);

  const target = findContact(b, b.targetId);
  const visible = !!target && target.visible;
  const sinceContact = t - b.lastContactTime;
  const quiet = sinceContact > 3 && t - b.lastDamageTime > 3;

  // ---- Scores ----
  curGoal = b.goal;
  bestGoal = 'idle';
  bestScore = 5 + (b.goal === 'idle' ? HYSTERESIS : 0);

  // Stranded on a roof / ledge without stairs (chute drift): get down first. Positions with a
  // stairwell are handled by the normal goals (their routes go through the stairs).
  if (isStranded(sys, p)) offer('descend', 97);

  // Combat.
  if (target) {
    const d = hyp(target.x - p.pos.x, target.z - p.pos.z);
    const w = activeWeapon(p);
    const armed = hasAnyRounds(p);
    if (visible) {
      if (!armed) {
        // Unarmed: only back off from close threats; otherwise grabbing a gun matters more.
        offer('combat', d < 15 ? 62 : 28);
      } else {
        const far = w ? d > WEAPON_RANGE[w.id].max * 1.3 : true;
        offer('combat', far && t - b.lastDamageTime > 3 ? 44 : 100);
      }
    } else if (armed) {
      // Stay engaged right after losing sight (pre-aim / peek), then decide by aggression.
      const lost = t - target.lastSeen;
      if (lost < 2.5) offer('combat', 80);
      else if (lost < 8) offer('combat', 48 + sk.aggression * 15);
    }
  }

  // Revive a downed teammate.
  revivePick = findDownedTeammate(sys, p);
  if (revivePick) {
    // A downed human squad leader comes first; otherwise wait until the fight has paused.
    const human = !revivePick.isBot;
    offer('revive', p.revive ? 95 : sinceContact > 2.5 ? (human ? 92 : 88) : visible ? 0 : human ? 75 : 60);
  }

  // Heal / boost.
  const heal = chooseHeal(sys, p);
  if (p.use) {
    offer('heal', visible && target && hyp(target.x - p.pos.x, target.z - p.pos.z) < 40 ? 0 : 99);
  } else if (heal) {
    if (p.health < 60) offer('heal', quiet ? 70 + (60 - p.health) / 2 : !visible && sinceContact > 1.5 && p.health < 35 ? 72 : 0);
    // Smart bots top up before the next fight.
    else if (sk.healSmart >= 0.5 && sinceContact > 6 && t - b.lastDamageTime > 6) offer('heal', 30);
  }
  if (!p.use && quiet && sk.healSmart >= 0.5 && (p.items.energy || 0) > 0 && p.boost < 45 && canUseConsumable(p, 'energy')) {
    offer('heal', 26);
  }

  // Zone.
  let zoneScore = 0;
  if (zoneActive(sys)) {
    if (outsideCurrent(sys, p.pos.x, p.pos.z)) zoneScore = 96;
    else {
      const u = zoneUrgency(sys, p, false);
      if (u > 0) zoneScore = Math.min(92, 24 + 60 * u);
    }
    offer('zone', zoneScore);
  }

  // Follow a human squad leader (or loosely the bot squad leader).
  let followScore = 0;
  followPick = sys.humanLeader(p);
  followHuman = followPick !== null;
  if (!followPick) followPick = botSquadLeader(sys, p);
  if (followPick && followPick.life === 'alive') {
    const d = hyp(followPick.pos.x - p.pos.x, followPick.pos.z - p.pos.z);
    followScore = followHuman ? (d > 30 ? 66 : d > 16 ? 28 : 0) : d > 70 ? 36 : 0;
    offer('follow', followScore);
  }

  // Loot / explore.
  // Loot scan at ~3 Hz (every think while actively looting).
  if (b.goal === 'loot' || t >= b.lootScanAt) {
    b.lootScanAt = t + 0.33;
    lootPick = -1;
    lootPickScore = 0;
    scanLoot(sys, b, p);
    b.lootPick = lootPick;
    b.lootPickScore = lootPickScore;
  } else {
    lootPick = b.lootPick >= 0 && sys.sim.loot.has(b.lootPick) ? b.lootPick : -1;
    lootPickScore = lootPick >= 0 ? b.lootPickScore : 0;
  }
  if (lootPick >= 0) {
    // Without a usable gun, getting one beats almost everything except a closing zone.
    const pick = sys.sim.loot.get(lootPick);
    const gunHunt = pick !== undefined && isWeaponId(pick.item) && !hasAnyRounds(p);
    offer('loot', (gunHunt ? 42 : 28) + 55 * lootPickScore);
  }
  if (!wellEquipped(p) && pickExplore(sys, b, p)) offer('explore', 20 + (p.weapons[0] || p.weapons[1] ? 0 : 14));

  // Investigate noises / damage.
  if (!visible && t - b.investigateTime < 8 && hasAnyRounds(p)) offer('investigate', 30 + sk.aggression * 18);

  // Keep walking to a chosen vehicle while the reason for it (rotation / following) holds.
  if (b.goal === 'vehicle' && b.vehicleId >= 0) offer('vehicle', Math.max(zoneScore, followScore, 40) + 1);

  const goal = bestGoal;
  setGoal(sys, b, goal);

  // ---- Goal think ----
  switch (b.goal) {
    case 'combat':
      combatThink(sys, b, p);
      break;
    case 'revive':
      reviveThink(sys, b, p);
      break;
    case 'heal':
      healThink(sys, b, p, heal);
      break;
    case 'zone':
      zoneThink(sys, b, p);
      break;
    case 'vehicle':
      if (!approachVehicle(sys, b, p)) setGoal(sys, b, 'idle');
      break;
    case 'follow':
      followThink(sys, b, p);
      break;
    case 'loot':
      lootThink(sys, b, p);
      break;
    case 'explore':
      exploreThink(sys, b, p);
      break;
    case 'investigate':
      setDest(sys, b, p, b.investigateX, b.investigateZ, 4, false);
      b.walk = true;
      break;
    case 'descend':
      descendThink(sys, b, p);
      break;
    default:
      idleThink(sys, b, p);
  }

  if (b.goal !== 'combat') manageWeapon(sys, b, p, false, 0);
  // Occasionally glance around when standing still.
  if (b.moveScale < 0.1 && b.rng.chance(0.15)) b.lookYaw = b.aimYaw + (b.rng.next() - 0.5) * 2.4;
}

/** Offer a goal with a utility score (the current goal gets a stickiness bonus). */
function offer(g: BotGoal, s: number): void {
  if (s <= 0) return;
  if (g === curGoal) s += HYSTERESIS;
  if (s > bestScore) {
    bestScore = s;
    bestGoal = g;
  }
}

function setGoal(sys: BotSystem, b: BotState, g: BotGoal): void {
  if (g === b.goal) return;
  b.goal = g;
  b.goalSince = sys.now;
  b.walk = false;
  b.coverValid = false;
  if (g !== 'vehicle') b.vehicleId = -1;
  clearDest(sys, b);
}

/**
 * Standing well above the ground-level nav floor (roof, upper floor, container top) somewhere the
 * stairs navigation does not cover.
 */
function isStranded(sys: BotSystem, p: PlayerState): boolean {
  if (p.mode !== 'ground' || p.pos.y - sys.grid.baseOr(p.pos.x, p.pos.z) <= ELEVATED) return false;
  if (sys.floors.onStairs(p.pos.x, p.pos.y, p.pos.z)) return false;
  const nav = sys.floors.locate(p.pos.x, p.pos.y, p.pos.z, floorLoc, false);
  if (nav === undefined) return false; // building nav pending this tick: decide on a later think
  return !nav || !nav.reachable(floorLoc);
}

/** Upper-floor position reachable from the ground through stairs (budgeted nav construction). */
function floorReachable(sys: BotSystem, x: number, y: number, z: number): boolean {
  const nav = sys.floors.locate(x, y, z, floorLoc, false);
  return !!nav && nav.reachable(floorLoc);
}

/** Destination height for an item: its own when upstairs, ground level otherwise. */
function lootY(sys: BotSystem, x: number, y: number, z: number): number {
  return aboveGround(sys, x, y, z) ? y : NaN;
}

/** The current route has been walked to its end (or there is none). */
function pathEnded(b: BotState): boolean {
  return b.path.status !== PATH_QUEUED && b.path.status !== PATH_RUNNING && b.pathIdx >= b.path.count - 1;
}

/** Walk off the roof over the nearest footprint edge (the drop is survivable from one storey). */
function descendThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const w = sys.world;
  let ex = p.pos.x + Math.cos(p.id) * 4, ez = p.pos.z + Math.sin(p.id) * 4;
  let best = Infinity;
  for (let i = 0; i < w.buildings.length; i++) {
    const bd = w.buildings[i];
    if (p.pos.x < bd.min.x - 0.5 || p.pos.x > bd.max.x + 0.5 || p.pos.z < bd.min.z - 0.5 || p.pos.z > bd.max.z + 0.5) continue;
    const dW = p.pos.x - bd.min.x, dE = bd.max.x - p.pos.x, dN = p.pos.z - bd.min.z, dS = bd.max.z - p.pos.z;
    const m = Math.min(dW, dE, dN, dS);
    if (m >= best) continue;
    best = m;
    if (m === dW) { ex = bd.min.x - 2.5; ez = p.pos.z; }
    else if (m === dE) { ex = bd.max.x + 2.5; ez = p.pos.z; }
    else if (m === dN) { ex = p.pos.x; ez = bd.min.z - 2.5; }
    else { ex = p.pos.x; ez = bd.max.z + 2.5; }
  }
  if (!b.hasDest || hyp(b.destX - ex, b.destZ - ez) > 1) setDirectDest(sys, b, ex, ez, 0.8);
}

function hasAnyRounds(p: PlayerState): boolean {
  return slotRounds(p, 0) > 0 || slotRounds(p, 1) > 0 || slotRounds(p, 2) > 0;
}

/** The destination was abandoned after getting stuck: blacklist what we were going for. */
function onGaveUp(sys: BotSystem, b: BotState): void {
  const t = sys.now;
  if (b.goal === 'loot' && b.lootId >= 0) {
    b.blacklist.set(b.lootId, t + 60);
    b.lootId = -1;
  } else if (b.goal === 'explore' && b.exploreBuilding >= 0) {
    b.explored[b.exploreBuilding] = 1;
    b.exploreBuilding = -1;
  } else if (b.goal === 'vehicle') {
    if (b.vehicleId >= 0) b.vehicleBlacklist.set(b.vehicleId, t + VEHICLE_BLACKLIST_TIME);
    b.vehicleId = -1;
  } else if (b.goal === 'idle') {
    b.wanderUntil = t;
  }
}

// ---------------------------------------------------------------------------
// Goal helpers
// ---------------------------------------------------------------------------

function findDownedTeammate(sys: BotSystem, p: PlayerState): PlayerState | null {
  let best: PlayerState | null = null, bestS = Infinity;
  const mates = sys.teamMembers(p.team);
  for (let i = 0; i < mates.length; i++) {
    const q = mates[i];
    if (q.id === p.id || q.life !== 'downed') continue;
    if (q.revivedBy !== null && q.revivedBy !== p.id) continue;
    // Teammates up on floors / roofs without stairs cannot be reached.
    if (Math.abs(q.pos.y - p.pos.y) > 2.2 && q.pos.y - sys.world.heightAt(q.pos.x, q.pos.z) > UPPER_FLOOR &&
        !floorReachable(sys, q.pos.x, q.pos.y, q.pos.z)) continue;
    const d = hyp(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
    if (d > REVIVE_SEARCH) continue;
    const s = d - (q.isBot ? 0 : 40);
    if (s < bestS) {
      bestS = s;
      best = q;
    }
  }
  return best;
}

function botSquadLeader(sys: BotSystem, p: PlayerState): PlayerState | null {
  const id = sys.teamBotLeader.get(p.team);
  if (id === undefined || id === p.id) return null;
  const q = sys.sim.players.get(id);
  return q && q.life === 'alive' ? q : null;
}

/** Best heal item for the situation, or null. */
function chooseHeal(sys: BotSystem, p: PlayerState): ConsumableId | null {
  const smart = sys.skill.healSmart;
  const bandage = p.items.bandage || 0, firstaid = p.items.firstaid || 0, medkit = p.items.medkit || 0;
  let item: ConsumableId | null = null;
  if (p.health < 75) {
    if (smart >= 0.5) {
      if (p.health < 40 && medkit > 0) item = 'medkit';
      else if (p.health < 65 && firstaid > 0) item = 'firstaid';
      else if (bandage > 0) item = 'bandage';
      else if (firstaid > 0) item = 'firstaid';
      else if (medkit > 0) item = 'medkit';
    } else {
      item = bandage > 0 ? 'bandage' : firstaid > 0 ? 'firstaid' : medkit > 0 ? 'medkit' : null;
    }
  } else if (p.health < 85 && medkit > 0 && smart >= 0.9) {
    item = 'medkit';
  }
  return item && canUseConsumable(p, item) ? item : null;
}

function scanLoot(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  const unarmed = !hasAnyRounds(p);
  const items = sys.sim.lootNear(p.pos.x, p.pos.z, unarmed ? LOOT_RADIUS_UNARMED : LOOT_RADIUS, sys.lootBuf);
  const free = freeCapacity(p);
  const world = sys.world;
  const stranded = isStranded(sys, p);
  if (b.blacklist.size > 48) {
    for (const [id, until] of b.blacklist) if (until <= t) b.blacklist.delete(id);
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const until = b.blacklist.get(it.id);
    if (until !== undefined && until > t) continue;
    const u = lootUtility(p, it, free);
    if (u < 0.05) continue;
    const d = hyp(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
    let s = u / (1 + d / 14);
    if (it.id === b.lootId) s *= 1.25;
    if (s <= lootPickScore) continue;
    // Other floors: reachable through stairs (budgeted building-nav construction), and a bot
    // stranded up high only takes what is on its own level.
    const dy = it.pos.y - p.pos.y;
    if (Math.abs(dy) > 1.6) {
      if (stranded) continue;
      if (it.pos.y - world.heightAt(it.pos.x, it.pos.z) > UPPER_FLOOR && !floorReachable(sys, it.pos.x, it.pos.y, it.pos.z)) continue;
      // Stairs detour.
      s = u / (1 + (d + Math.abs(dy) * 2.5) / 14);
      if (it.id === b.lootId) s *= 1.25;
      if (s <= lootPickScore) continue;
    }
    if (isAvoided(sys, b, it.pos.x, it.pos.z)) continue;
    lootPick = it.id;
    lootPickScore = s;
  }
}

function lootThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  if (lootPick >= 0 && lootPick !== b.lootId) {
    b.lootId = lootPick;
    b.lootSince = t;
    b.lootTries = 0;
  }
  const it = b.lootId >= 0 ? sys.sim.loot.get(b.lootId) : undefined;
  if (!it) {
    b.lootId = -1;
    clearDest(sys, b);
    return;
  }
  if (t - b.lootSince > 30) {
    b.blacklist.set(it.id, t + 60);
    b.lootId = -1;
    clearDest(sys, b);
    return;
  }
  const d = hyp(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
  const dy = it.pos.y - p.pos.y;
  if (d < 1.9 && Math.abs(dy) >= PICKUP_DY && pathEnded(b)) {
    // Above / below us on another level and the route ends here: not reachable.
    b.blacklist.set(it.id, t + 60);
    b.lootId = -1;
    clearDest(sys, b);
    return;
  }
  if (d < 1.9 && Math.abs(dy) < PICKUP_DY) {
    // Replacing a primary: switch to the weapon we are willing to drop first.
    if (isWeaponId(it.item) && WEAPONS[it.item].slot === 'primary') {
      const worst = worstPrimarySlot(p);
      if (worst >= 0 && p.activeSlot !== worst) {
        b.wantSlot = worst;
        b.lastSwitch = t;
        return;
      }
    }
    if (t - b.lootActionAt > 0.5) {
      b.actions.push({ a: 'pickup', id: it.id });
      b.lootActionAt = t;
      if (++b.lootTries > 4) {
        b.blacklist.set(it.id, t + 60);
        b.lootId = -1;
      }
    }
    setDest(sys, b, p, it.pos.x, it.pos.z, 1.0, false, lootY(sys, it.pos.x, it.pos.y, it.pos.z));
  } else {
    setDest(sys, b, p, it.pos.x, it.pos.z, 1.0, d > 8, lootY(sys, it.pos.x, it.pos.y, it.pos.z));
  }
}

function pickExplore(sys: BotSystem, b: BotState, p: PlayerState): boolean {
  if (b.exploreBuilding >= 0 && !b.explored[b.exploreBuilding]) return true;
  b.exploreBuilding = -1;
  // Searching every building is cheap but not free: at most every 1.5 s.
  if (sys.now < b.exploreScanAt) return false;
  b.exploreScanAt = sys.now + 1.5;
  const info = sys.info, w = sys.world;
  let best = -1, bestD = EXPLORE_RADIUS;
  for (let i = 0; i < w.buildings.length; i++) {
    if (b.explored[i]) continue;
    const cx = info.bCenter[i * 2], cz = info.bCenter[i * 2 + 1];
    const d = hyp(cx - p.pos.x, cz - p.pos.z);
    if (d >= bestD) continue;
    if (!insideNext(sys, cx, cz) || isAvoided(sys, b, cx, cz)) continue;
    best = i;
    bestD = d;
  }
  if (best < 0) return false;
  const r = buildingInterior(w, info, sys.grid, best, sys.xz);
  if (r === INTERIOR_PENDING) return false;
  if (r === INTERIOR_NONE) {
    b.explored[best] = 1;
    return false;
  }
  b.exploreBuilding = best;
  b.exploreSince = sys.now;
  return true;
}

function exploreThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const bi = b.exploreBuilding;
  if (bi < 0 || buildingInterior(sys.world, sys.info, sys.grid, bi, sys.xz) !== INTERIOR_OK) {
    clearDest(sys, b);
    return;
  }
  const d = hyp(sys.xz.x - p.pos.x, sys.xz.z - p.pos.z);
  if (d < 2.5 || sys.now - b.exploreSince > 35) {
    b.explored[bi] = 1;
    b.exploreBuilding = -1;
    clearDest(sys, b);
    return;
  }
  setDest(sys, b, p, sys.xz.x, sys.xz.z, 1.8, d > 6);
}

function zoneThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  const d = hyp(b.zoneX - p.pos.x, b.zoneZ - p.pos.z);
  if (d > VEHICLE_TRIP && t - b.vehicleActionAt > 3) {
    const v = findVehicle(sys, b, p, 80, true);
    if (v) {
      setGoal(sys, b, 'vehicle');
      b.vehicleId = v.id;
      b.vehicleSince = t;
      approachVehicle(sys, b, p);
      return;
    }
  } else if (d > 120) {
    // A squadmate's car nearby with a free seat.
    const v = findVehicle(sys, b, p, 45, false);
    if (v && v.seats[0] !== null) {
      setGoal(sys, b, 'vehicle');
      b.vehicleId = v.id;
      b.vehicleSince = t;
      approachVehicle(sys, b, p);
      return;
    }
  }
  setDest(sys, b, p, b.zoneX, b.zoneZ, 6, true);
}

function healThink(sys: BotSystem, b: BotState, p: PlayerState, heal: ConsumableId | null): void {
  const t = sys.now;
  clearDest(sys, b);
  if (p.use) return;
  let item = heal;
  if (!item && (p.items.energy || 0) > 0 && canUseConsumable(p, 'energy')) item = 'energy';
  if (item && t - b.useActionAt > 1.2) {
    b.actions.push({ a: 'use', item });
    b.useActionAt = t;
  }
}

function reviveThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const q = revivePick;
  if (!q) return;
  b.reviveId = q.id;
  if (p.revive) {
    // Reviving: stand still (INTERACT is held in brainAct) until it completes.
    clearDest(sys, b);
    return;
  }
  // Same 3D distance as the sim's check; the action is sent anywhere inside the range and the bot
  // keeps closing in until the revive has started.
  if (dist3(p, q) <= REVIVE_START_DIST && sys.now - b.reviveActionAt > 0.4) {
    b.actions.push({ a: 'revive', id: q.id });
    b.reviveActionAt = sys.now;
  }
  setDest(sys, b, p, q.pos.x, q.pos.z, REVIVE_STOP_DIST, true, lootY(sys, q.pos.x, q.pos.y, q.pos.z));
}

function dist3(a: PlayerState, b: PlayerState): number {
  const dx = a.pos.x - b.pos.x, dy = a.pos.y - b.pos.y, dz = a.pos.z - b.pos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function followThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const q = followPick;
  if (!q) return;
  const t = sys.now;
  if (followHuman && q.mode === 'vehicle' && q.vehicleId !== null) {
    const v = sys.sim.vehicles.get(q.vehicleId);
    if (v && hyp(v.pos.x - p.pos.x, v.pos.z - p.pos.z) < 45) {
      setGoal(sys, b, 'vehicle');
      b.vehicleId = v.id;
      b.vehicleSince = t;
      approachVehicle(sys, b, p);
      return;
    }
  }
  const a = (p.id % 7) * 0.9;
  const r = followHuman ? 7 : 12;
  // Indoors upstairs: come close (same floor); outdoors keep a loose formation.
  if (aboveGround(sys, q.pos.x, q.pos.y, q.pos.z)) setDest(sys, b, p, q.pos.x, q.pos.z, 3, true, q.pos.y);
  else setDest(sys, b, p, q.pos.x + Math.cos(a) * r, q.pos.z + Math.sin(a) * r, 4, true);
}

function idleThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  const reached = hyp(b.wanderX - p.pos.x, b.wanderZ - p.pos.z) < 5;
  if (t >= b.wanderUntil || reached) {
    const w = sys.world, info = sys.info, rng = b.rng;
    let found = false;
    for (let k = 0; k < 8 && !found; k++) {
      let x: number, z: number;
      if (w.buildings.length > 0 && rng.chance(0.7)) {
        const bi = rng.int(0, w.buildings.length - 1);
        x = info.bCenter[bi * 2] + (rng.next() - 0.5) * 20;
        z = info.bCenter[bi * 2 + 1] + (rng.next() - 0.5) * 20;
      } else if (zoneActive(sys)) {
        const zn = sys.sim.zone;
        const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * zn.nr * 0.6;
        x = zn.nx + Math.cos(a) * r;
        z = zn.nz + Math.sin(a) * r;
      } else {
        x = p.pos.x + (rng.next() - 0.5) * 160;
        z = p.pos.z + (rng.next() - 0.5) * 160;
      }
      if (hyp(x - p.pos.x, z - p.pos.z) > 250 || !insideNext(sys, x, z) || !w.inBounds(x, z)) continue;
      if (w.heightAt(x, z) < w.waterLevel + 0.5) continue;
      // Snap to a free cell when the area is already mapped (the planner snaps otherwise).
      if (sys.grid.nearestFree(x, z, 6, sys.xz, false)) {
        x = sys.xz.x;
        z = sys.xz.z;
      }
      b.wanderX = x;
      b.wanderZ = z;
      found = true;
    }
    if (!found) {
      b.wanderX = p.pos.x;
      b.wanderZ = p.pos.z;
    }
    b.wanderUntil = t + 20 + rng.next() * 15;
  }
  setDest(sys, b, p, b.wanderX, b.wanderZ, 4, false);
}

// ---------------------------------------------------------------------------
// Per-tick act (on foot)
// ---------------------------------------------------------------------------

export function brainAct(sys: BotSystem, b: BotState, p: PlayerState, out: ActOut): void {
  const t = sys.now;
  let buttons = 0;
  let stance: 0 | 1 | 2 = 0;
  followPath(sys, b, p);
  const goal = b.goal;
  if (goal === 'revive') {
    const q = sys.sim.players.get(b.reviveId);
    if (q && q.life === 'downed' && (p.revive || dist3(p, q) <= REVIVE_START_DIST)) {
      // In range: stand still holding INTERACT (the revive starts with the action sent on think,
      // and the sim cancels it if the reviver moves or lets go).
      b.moveScale = 0;
      buttons |= BTN.INTERACT;
      steerAim(sys, b, Math.atan2(-(q.pos.x - p.pos.x), -(q.pos.z - p.pos.z)), -0.4, 0.6);
    } else {
      lookAround(sys, b, p);
    }
  } else if (goal === 'combat') {
    buttons |= combatAct(sys, b, p);
    if (t < b.crouchUntil && b.moveScale < 0.5) stance = 1;
  } else {
    if (goal === 'heal') {
      b.moveScale = 0;
      stance = 1;
    }
    lookAround(sys, b, p);
  }
  if (b.sprint && !b.walk && b.moveScale > 0.9 && goal !== 'combat' && goal !== 'heal' && facingMove(b) && !p.use) {
    buttons |= BTN.SPRINT;
  }
  if (b.walk && b.moveScale > 0) buttons |= BTN.WALK;
  if (b.jumpNow) {
    buttons |= BTN.JUMP;
    b.jumpNow = false;
  }
  // Reload: forced when empty, topped up when quiet.
  if (!(buttons & BTN.FIRE) && wantReload(sys, b, p, t - b.lastContactTime > 2.5 && goal !== 'combat')) {
    buttons |= BTN.RELOAD;
    b.reloadPressAt = t;
  }
  out.buttons = buttons;
  out.stance = stance;
}

/** Non-combat view: alerts, then the movement direction, else idle glances. */
function lookAround(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  let yaw: number;
  let pitch = -0.05;
  if (t < b.alertUntil) {
    yaw = b.alertYaw;
    pitch = 0;
  } else if (b.moveScale > 0.1) {
    yaw = moveYaw(b);
  } else {
    const c = findContact(b, b.targetId);
    yaw = c && t - c.lastSeen < 10 ? Math.atan2(-(c.x - p.pos.x), -(c.z - p.pos.z)) : b.lookYaw;
  }
  // Turn a bit more lazily than in combat.
  steerAim(sys, b, yaw, pitch, Math.abs(angleDiff(b.aimYaw, yaw)) > 1.5 ? 0.8 : 0.55);
}

// ---------------------------------------------------------------------------
// Downed
// ---------------------------------------------------------------------------

/** Downed: crawl toward the nearest standing teammate, else away from the last threat. */
export function downedThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  perceive(sys, b, p);
  selectTarget(sys, b, p);
  setGoal(sys, b, 'downed');
  let best: PlayerState | null = null, bestD = 60;
  const mates = sys.teamMembers(p.team);
  for (let i = 0; i < mates.length; i++) {
    const q = mates[i];
    if (q.id === p.id || q.life !== 'alive') continue;
    const d = hyp(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  if (best) {
    setDest(sys, b, p, best.pos.x, best.pos.z, 1.2, false, best.pos.y);
    return;
  }
  const c = findContact(b, b.targetId);
  if (c) {
    let ax = p.pos.x - c.x, az = p.pos.z - c.z;
    const l = hyp(ax, az) || 1;
    ax /= l;
    az /= l;
    const fx = p.pos.x + ax * 8, fz = p.pos.z + az * 8;
    if (sys.grid.nearestFree(fx, fz, 3, sys.xz, false)) setDest(sys, b, p, sys.xz.x, sys.xz.z, 1, false);
    else setDest(sys, b, p, fx, fz, 1, false);
  } else {
    clearDest(sys, b);
  }
}

export function downedAct(sys: BotSystem, b: BotState, p: PlayerState, out: ActOut): void {
  followPath(sys, b, p);
  lookAround(sys, b, p);
  out.buttons = 0;
  out.stance = 0;
}
