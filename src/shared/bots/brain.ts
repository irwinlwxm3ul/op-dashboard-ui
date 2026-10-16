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
import { buildingInterior } from './mapinfo';
import {
  checkStuck, clearDest, facingMove, followPath, isAvoided, moveYaw, setDest,
} from './movement';
import { findContact, perceive, selectTarget } from './perception';
import type { BotGoal, BotState } from './state';
import type { BotSystem } from './system';
import { VEHICLE_TRIP, approachVehicle, findVehicle } from './vehicle';
import { insideNext, outsideCurrent, updateZoneTarget, zoneActive, zoneUrgency } from './zone';

const LOOT_RADIUS = 30;
const EXPLORE_RADIUS = 220;
const REVIVE_SEARCH = 120;
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

  // Combat.
  if (target) {
    const d = Math.hypot(target.x - p.pos.x, target.z - p.pos.z);
    const w = activeWeapon(p);
    const armed = hasAnyRounds(p);
    if (visible) {
      const far = w ? d > WEAPON_RANGE[w.id].max * 1.3 : true;
      offer('combat', !armed ? 58 : far && t - b.lastDamageTime > 3 ? 44 : 100);
    } else if (t - target.lastSeen < 8 && armed) {
      offer('combat', 48 + sk.aggression * 15);
    }
  }

  // Revive a downed teammate.
  revivePick = findDownedTeammate(sys, b, p);
  if (revivePick) offer('revive', sinceContact > 2.5 ? 88 : visible ? 0 : 46);

  // Heal / boost.
  const heal = chooseHeal(sys, p);
  if (p.use) {
    offer('heal', visible && target && Math.hypot(target.x - p.pos.x, target.z - p.pos.z) < 40 ? 0 : 99);
  } else if (heal) {
    if (p.health < 60) offer('heal', quiet ? 70 + (60 - p.health) / 2 : !visible && sinceContact > 1.5 && p.health < 35 ? 72 : 0);
    else if (sinceContact > 6 && t - b.lastDamageTime > 6) offer('heal', 30);
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
  if (followPick) {
    const d = Math.hypot(followPick.pos.x - p.pos.x, followPick.pos.z - p.pos.z);
    followScore = followHuman ? (d > 30 ? 66 : d > 16 ? 28 : 0) : d > 70 ? 36 : 0;
    offer('follow', followScore);
  }

  // Loot / explore.
  lootPick = -1;
  lootPickScore = 0;
  scanLoot(sys, b, p);
  if (lootPick >= 0) offer('loot', 25 + 50 * lootPickScore);
  if (!wellEquipped(p) && pickExplore(sys, b, p)) offer('explore', 20 + (p.weapons[0] || p.weapons[1] ? 0 : 14));

  // Investigate noises / damage.
  if (!visible && t - b.investigateTime < 8) offer('investigate', 30 + sk.aggression * 18);

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
    b.vehicleBlacklist = b.vehicleId;
    b.vehicleId = -1;
  } else if (b.goal === 'idle') {
    b.wanderUntil = t;
  }
}

// ---------------------------------------------------------------------------
// Goal helpers
// ---------------------------------------------------------------------------

function findDownedTeammate(sys: BotSystem, b: BotState, p: PlayerState): PlayerState | null {
  let best: PlayerState | null = null, bestS = Infinity;
  const mates = sys.teamMembers(p.team);
  for (let i = 0; i < mates.length; i++) {
    const q = mates[i];
    if (q.id === p.id || q.life !== 'downed') continue;
    if (q.revivedBy !== null && q.revivedBy !== p.id) continue;
    const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
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
export function chooseHeal(sys: BotSystem, p: PlayerState): ConsumableId | null {
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
  const items = sys.sim.lootNear(p.pos.x, p.pos.z, LOOT_RADIUS, sys.lootBuf);
  const free = freeCapacity(p);
  const grid = sys.grid;
  if (b.blacklist.size > 48) {
    for (const [id, until] of b.blacklist) if (until <= t) b.blacklist.delete(id);
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const until = b.blacklist.get(it.id);
    if (until !== undefined && until > t) continue;
    const u = lootUtility(p, it, free);
    if (u < 0.05) continue;
    const d = Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
    let s = u / (1 + d / 14);
    if (it.id === b.lootId) s *= 1.25;
    if (s <= lootPickScore) continue;
    // Upper floors are skipped unless the bot is already up there (ground-floor navigation).
    if (Math.abs(it.pos.y - p.pos.y) > 1.3 && it.pos.y - grid.base(grid.cell(it.pos.x), grid.cell(it.pos.z)) > 1.3) continue;
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
  const d = Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
  if (d < 1.9 && Math.abs(it.pos.y - p.pos.y) < 2) {
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
    setDest(sys, b, p, it.pos.x, it.pos.z, 1.0, false);
  } else {
    setDest(sys, b, p, it.pos.x, it.pos.z, 1.0, d > 8);
  }
}

function pickExplore(sys: BotSystem, b: BotState, p: PlayerState): boolean {
  if (b.exploreBuilding >= 0 && !b.explored[b.exploreBuilding]) return true;
  b.exploreBuilding = -1;
  const info = sys.info, w = sys.world;
  let best = -1, bestD = EXPLORE_RADIUS;
  for (let i = 0; i < w.buildings.length; i++) {
    if (b.explored[i]) continue;
    const cx = info.bCenter[i * 2], cz = info.bCenter[i * 2 + 1];
    const d = Math.hypot(cx - p.pos.x, cz - p.pos.z);
    if (d >= bestD) continue;
    if (!insideNext(sys, cx, cz) || isAvoided(sys, b, cx, cz)) continue;
    best = i;
    bestD = d;
  }
  if (best < 0) return false;
  if (!buildingInterior(w, info, sys.grid, best, sys.xz)) {
    b.explored[best] = 1;
    return false;
  }
  b.exploreBuilding = best;
  b.exploreSince = sys.now;
  return true;
}

function exploreThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const bi = b.exploreBuilding;
  if (bi < 0 || !buildingInterior(sys.world, sys.info, sys.grid, bi, sys.xz)) {
    clearDest(sys, b);
    return;
  }
  const d = Math.hypot(sys.xz.x - p.pos.x, sys.xz.z - p.pos.z);
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
  const d = Math.hypot(b.zoneX - p.pos.x, b.zoneZ - p.pos.z);
  if (d > VEHICLE_TRIP && t - b.vehicleActionAt > 3) {
    const v = findVehicle(sys, b, p, 80, true);
    if (v) {
      b.vehicleId = v.id;
      b.vehicleSince = t;
      setGoal(sys, b, 'vehicle');
      b.vehicleId = v.id;
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
  const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
  if (d <= REVIVE_RANGE - 0.5) {
    clearDest(sys, b);
    if (!p.revive && sys.now - b.reviveActionAt > 0.8) {
      b.actions.push({ a: 'revive', id: q.id });
      b.reviveActionAt = sys.now;
    }
  } else {
    setDest(sys, b, p, q.pos.x, q.pos.z, REVIVE_RANGE - 0.8, true);
  }
}

function followThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const q = followPick;
  if (!q) return;
  const t = sys.now;
  if (followHuman && q.mode === 'vehicle' && q.vehicleId !== null) {
    const v = sys.sim.vehicles.get(q.vehicleId);
    if (v && Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z) < 45) {
      setGoal(sys, b, 'vehicle');
      b.vehicleId = v.id;
      b.vehicleSince = t;
      approachVehicle(sys, b, p);
      return;
    }
  }
  const a = (p.id % 7) * 0.9;
  const r = followHuman ? 7 : 12;
  setDest(sys, b, p, q.pos.x + Math.cos(a) * r, q.pos.z + Math.sin(a) * r, 4, true);
}

function idleThink(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  const reached = Math.hypot(b.wanderX - p.pos.x, b.wanderZ - p.pos.z) < 5;
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
      if (Math.hypot(x - p.pos.x, z - p.pos.z) > 250 || !insideNext(sys, x, z) || !w.inBounds(x, z)) continue;
      if (!sys.grid.nearestFree(x, z, 6, sys.xz)) continue;
      b.wanderX = sys.xz.x;
      b.wanderZ = sys.xz.z;
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
    if (q && q.life === 'downed') {
      const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
      if (d <= REVIVE_RANGE - 0.2) {
        b.moveScale = 0;
        buttons |= BTN.INTERACT;
        steerAim(sys, b, Math.atan2(-(q.pos.x - p.pos.x), -(q.pos.z - p.pos.z)), -0.4, 0.6);
      } else {
        lookAround(sys, b, p);
      }
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
    const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  if (best) {
    setDest(sys, b, p, best.pos.x, best.pos.z, 1.2, false);
    return;
  }
  const c = findContact(b, b.targetId);
  if (c) {
    let ax = p.pos.x - c.x, az = p.pos.z - c.z;
    const l = Math.hypot(ax, az) || 1;
    ax /= l;
    az /= l;
    if (sys.grid.nearestFree(p.pos.x + ax * 8, p.pos.z + az * 8, 3, sys.xz)) setDest(sys, b, p, sys.xz.x, sys.xz.z, 1, false);
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
