// Discrete player actions (validated server side; invalid ones are ignored silently).

import { INTERACT_RANGE, MIN_CHUTE_DROP, REVIVE_RANGE } from '../constants';
import {
  CONSUMABLES, WEAPONS, applyConsumable, canUseConsumable, isGearId, isWeaponId, pickupItem, removeItem,
} from '../items';
import { lineOfSight } from '../physics';
import { hashFloat } from '../rng';
import { VEHICLES } from '../vehicles';
import type { ClientAction, ConsumableId, EntityId, ItemId, PlayerState, Vec3, VehicleState } from '../types';
import { bodyCenter, canSpectate, cancelRevive } from './combat';
import type { GameSim } from './GameSim';
import { planeDirection, planePosition } from './plane';
import type { PlayerRt } from './players';
import { spawnFrag } from './projectiles';
import { giveItem, respawnPlayer } from './training';
import {
  EVENT_RANGE, INTERACT_SLACK, PLANE_JUMP_BACK, PLANE_JUMP_CARRY, PLANE_JUMP_SPREAD, THROW_COOLDOWN,
} from './tuning';
import { enterVehicle, exitVehicle, nearVehicle, switchSeat } from './vehiclesSim';
import { cancelReload, cancelUse, weaponModeOk } from './weapons';

const c: Vec3 = { x: 0, y: 0, z: 0 };
const eye: Vec3 = { x: 0, y: 0, z: 0 };
const tgt: Vec3 = { x: 0, y: 0, z: 0 };
const dropPos: Vec3 = { x: 0, y: 0, z: 0 };

/** Dispatch one action of a living (alive or downed) player. */
export function handleAction(sim: GameSim, rt: PlayerRt, a: ClientAction): void {
  const p = rt.p;
  switch (a.a) {
    case 'pickup': actPickup(sim, p, a.id); break;
    case 'drop': actDrop(sim, p, a.item, a.count); break;
    case 'dropWeapon': actDropWeapon(sim, p, a.slot); break;
    case 'use': actUse(sim, p, a.item); break;
    case 'cancel':
      cancelUse(p);
      cancelRevive(sim, p);
      cancelReload(p);
      break;
    case 'throw': actThrow(sim, p); break;
    case 'enter': enterVehicle(sim, rt, a.id, a.seat); break;
    case 'exit': exitVehicle(sim, rt); break;
    case 'seat': switchSeat(sim, rt, a.seat); break;
    case 'revive': actRevive(sim, p, a.id); break;
    case 'jump': actJump(sim, p); break;
    case 'chute':
      if (p.mode === 'freefall' && p.life === 'alive' && p.jumpY - p.pos.y >= MIN_CHUTE_DROP) openChute(sim, p);
      break;
    case 'respawn':
      if (sim.config.mode === 'training') respawnPlayer(sim, rt);
      break;
    case 'give':
      giveItem(sim, rt, a.item);
      break;
    case 'swapWeapons': actSwap(sim, p); break;
    case 'spectate':
    default:
      break;
  }
}

/** Actions available to dead players: spectate switching, training respawn. */
export function handleDeadAction(sim: GameSim, rt: PlayerRt, a: ClientAction): void {
  const p = rt.p;
  if (a.a === 'spectate') {
    if (canSpectate(sim, p, a.id)) p.spectating = a.id;
  } else if (a.a === 'respawn' && sim.config.mode === 'training') {
    respawnPlayer(sim, rt);
  }
}

/** Ground point in front of the player for dropped items (never inside a wall). */
function dropPoint(sim: GameSim, p: PlayerState, out: Vec3): Vec3 {
  bodyCenter(p, c);
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  out.x = p.pos.x + fx * 0.6;
  out.z = p.pos.z + fz * 0.6;
  out.y = c.y;
  if (!lineOfSight(sim.world, c, out)) {
    out.x = p.pos.x;
    out.z = p.pos.z;
  }
  out.y = p.pos.y;
  return out;
}

function actPickup(sim: GameSim, p: PlayerState, id: EntityId): void {
  if (p.life !== 'alive' || p.mode !== 'ground') return;
  const it = sim.loot.get(id);
  if (!it) return;
  bodyCenter(p, c);
  const dC = Math.hypot(c.x - it.pos.x, c.y - it.pos.y, c.z - it.pos.z);
  const dF = Math.hypot(p.pos.x - it.pos.x, p.pos.y - it.pos.y, p.pos.z - it.pos.z);
  if (Math.min(dC, dF) > INTERACT_RANGE + INTERACT_SLACK) return;
  sim.eyePos(p.id, eye);
  tgt.x = it.pos.x; tgt.y = it.pos.y + 0.15; tgt.z = it.pos.z;
  if (!lineOfSight(sim.world, eye, tgt) && !lineOfSight(sim.world, c, tgt)) return;
  const res = pickupItem(p, it.item, it.count, it.mag);
  if (res.taken <= 0) return;
  sim.removeLoot(id);
  // Whatever did not fit stays on the ground (as a new stack id so client deltas stay simple).
  if (res.taken < it.count) sim.placeLootAt(it.item, it.count - res.taken, it.pos, it.mag);
  if (res.dropped.length > 0) {
    dropPoint(sim, p, dropPos);
    for (const d of res.dropped) sim.placeLoot(d.item, d.count, dropPos, p.pos.y, d.mag);
  }
  sim.emit({ type: 'pickup', player: p.id, item: it.item, count: res.taken }, [p.id]);
}

function actDropWeapon(sim: GameSim, p: PlayerState, slot: 0 | 1 | 2): void {
  if (p.life !== 'alive' || (p.mode !== 'ground' && p.mode !== 'swim')) return;
  const inst = p.weapons[slot];
  if (!inst) return;
  p.weapons[slot] = null;
  if (p.activeSlot === slot) {
    p.activeSlot = -1;
    cancelReload(p);
    p.ads = 0;
    p.drawTimer = 0;
    p.sprayCount = 0;
  }
  sim.placeLoot(inst.id, 1, dropPoint(sim, p, dropPos), p.pos.y, inst.mag);
}

function actDrop(sim: GameSim, p: PlayerState, item: ItemId, count?: number): void {
  if (p.life !== 'alive' || (p.mode !== 'ground' && p.mode !== 'swim')) return;
  if (isWeaponId(item)) {
    let slot = -1;
    if (p.activeSlot !== -1 && p.weapons[p.activeSlot]?.id === item) slot = p.activeSlot;
    else slot = p.weapons.findIndex((w) => w !== null && w.id === item);
    if (slot >= 0) actDropWeapon(sim, p, slot as 0 | 1 | 2);
    return;
  }
  let mag: number | undefined;
  let n: number;
  if (isGearId(item)) {
    if (item.startsWith('vest')) mag = Math.ceil(p.armor.vestHp);
    else if (item.startsWith('helmet')) mag = Math.ceil(p.armor.helmetHp);
    n = 1;
  } else {
    const have = item.startsWith('ammo_') ? p.ammo[item as keyof PlayerState['ammo']] || 0
      : p.items[item as keyof PlayerState['items']] || 0;
    n = count !== undefined ? Math.min(count, have) : have;
  }
  const removed = removeItem(p, item, n);
  if (removed <= 0) return;
  if (p.use && (p.items[p.use.item] || 0) <= 0) cancelUse(p);
  sim.placeLoot(item, removed, dropPoint(sim, p, dropPos), p.pos.y, mag);
}

/** Nearest non-destroyed vehicle the player can refuel (own vehicle first). */
function refuelTarget(sim: GameSim, p: PlayerState): VehicleState | null {
  const notFull = (v: VehicleState) => !v.destroyed && v.health > 0 && v.fuel < VEHICLES[v.type].fuelMax - 0.01;
  if (p.vehicleId !== null) {
    const v = sim.vehicles.get(p.vehicleId);
    return v && notFull(v) ? v : null;
  }
  let best: VehicleState | null = null;
  let bestD = Infinity;
  for (const v of sim.vehicleList) {
    if (!notFull(v) || !nearVehicle(p, v)) continue;
    const d = (v.pos.x - p.pos.x) ** 2 + (v.pos.z - p.pos.z) ** 2;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

function actUse(sim: GameSim, p: PlayerState, item: ConsumableId): void {
  if (p.life !== 'alive' || (p.mode !== 'ground' && p.mode !== 'vehicle')) return;
  if (p.use && p.use.item === item) return;
  if (!canUseConsumable(p, item)) return;
  let target: EntityId | undefined;
  if (item === 'fuel') {
    const v = refuelTarget(sim, p);
    if (!v) return;
    target = v.id;
  }
  cancelReload(p);
  cancelRevive(sim, p);
  p.ads = 0;
  const d = CONSUMABLES[item];
  p.use = target !== undefined
    ? { item, elapsed: 0, total: d.useTime, target }
    : { item, elapsed: 0, total: d.useTime };
  sim.emit({ type: 'useStart', player: p.id, item }, undefined, p.pos, EVENT_RANGE.near);
}

/** Completion of a consumable use: apply heal / boost, or refuel (+50% tank). */
export function completeUse(sim: GameSim, p: PlayerState): void {
  const u = p.use;
  if (!u) return;
  p.use = null;
  if ((p.items[u.item] || 0) <= 0) return;
  if (u.item === 'fuel') {
    const v = u.target !== undefined ? sim.vehicles.get(u.target) : undefined;
    if (!v || v.destroyed || (p.vehicleId !== v.id && !nearVehicle(p, v))) return;
    const max = VEHICLES[v.type].fuelMax;
    v.fuel = Math.min(max, v.fuel + max * 0.5);
  } else {
    applyConsumable(p, u.item);
  }
  removeItem(p, u.item, 1);
  sim.emit({ type: 'useDone', player: p.id, item: u.item }, [p.id]);
}

function actThrow(sim: GameSim, p: PlayerState): void {
  if (!weaponModeOk(sim, p) || (p.items.frag || 0) <= 0 || p.throwCooldown > 0 || p.use) return;
  const id = spawnFrag(sim, p);
  if (id < 0) return;
  p.items.frag -= 1;
  p.throwCooldown = THROW_COOLDOWN;
  cancelReload(p);
  sim.emit({ type: 'throw', player: p.id, projectile: id }, undefined, p.pos, EVENT_RANGE.movement);
}

const losA: Vec3 = { x: 0, y: 0, z: 0 };
const losB: Vec3 = { x: 0, y: 0, z: 0 };

/** Reviver and downed teammate can see each other (no reviving through walls / floors). */
export function reviveLineOfSight(sim: GameSim, p: PlayerState, t: PlayerState): boolean {
  bodyCenter(t, losB);
  losB.y += 0.1;
  bodyCenter(p, losA);
  if (lineOfSight(sim.world, losA, losB)) return true;
  sim.eyePos(p.id, losA);
  return lineOfSight(sim.world, losA, losB);
}

function actRevive(sim: GameSim, p: PlayerState, id: EntityId): void {
  if (p.life !== 'alive' || p.mode !== 'ground' || p.revive) return;
  const t = sim.players.get(id);
  if (!t || t === p || t.team !== p.team || t.life !== 'downed') return;
  if (t.revivedBy !== null && t.revivedBy !== p.id) return;
  const d = Math.hypot(t.pos.x - p.pos.x, t.pos.y - p.pos.y, t.pos.z - p.pos.z);
  if (d > REVIVE_RANGE + INTERACT_SLACK) return;
  if (!reviveLineOfSight(sim, p, t)) return;
  cancelUse(p);
  cancelReload(p);
  p.ads = 0;
  p.revive = { target: id, elapsed: 0 };
  t.revivedBy = p.id;
}

function actSwap(sim: GameSim, p: PlayerState): void {
  if (p.life !== 'alive' || (p.mode !== 'ground' && p.mode !== 'vehicle')) return;
  const a = p.weapons[0], b = p.weapons[1];
  if (!a && !b) return;
  p.weapons[0] = b;
  p.weapons[1] = a;
  if (p.activeSlot === 0 || p.activeSlot === 1) {
    const now = p.weapons[p.activeSlot];
    cancelReload(p);
    p.ads = 0;
    p.sprayCount = 0;
    p.drawTimer = now ? WEAPONS[now.id].drawTime : 0;
    sim.emit({ type: 'draw', player: p.id, weapon: now ? now.id : null }, undefined, p.pos, EVENT_RANGE.near);
  }
}

const planePos: Vec3 = { x: 0, y: 0, z: 0 };
const planeDir = { x: 0, z: 0 };

function actJump(sim: GameSim, p: PlayerState): void {
  if (p.mode !== 'plane' || p.life !== 'alive' || !sim.plane || sim.isPlaneHeld) return;
  planePosition(sim.plane, planePos);
  if (!sim.world.inBounds(planePos.x, planePos.z)) return;
  jumpFromPlane(sim, p);
}

/** Leave the plane: freefall slightly behind it with a little of its speed. */
export function jumpFromPlane(sim: GameSim, p: PlayerState): void {
  const plane = sim.plane;
  if (!plane) return;
  planePosition(plane, planePos);
  planeDirection(plane, planeDir);
  // Deterministic per-player spread so jumpers do not overlap.
  const back = PLANE_JUMP_BACK + hashFloat(sim.config.seed, p.id, 1) * PLANE_JUMP_SPREAD;
  const side = (hashFloat(sim.config.seed, p.id, 2) - 0.5) * 2 * PLANE_JUMP_SPREAD;
  p.pos.x = planePos.x - planeDir.x * back - planeDir.z * side;
  p.pos.z = planePos.z - planeDir.z * back + planeDir.x * side;
  p.pos.y = planePos.y - 2;
  const lim = sim.world.half - 1;
  p.pos.x = Math.max(-lim, Math.min(lim, p.pos.x));
  p.pos.z = Math.max(-lim, Math.min(lim, p.pos.z));
  p.vel.x = planeDir.x * plane.speed * PLANE_JUMP_CARRY;
  p.vel.y = 0;
  p.vel.z = planeDir.z * plane.speed * PLANE_JUMP_CARRY;
  p.mode = 'freefall';
  p.onGround = false;
  p.airTime = 0;
  p.fallSpeed = 0;
  p.jumpBuffer = 0;
  p.parachuteOpen = false;
  p.stance = 'stand';
  p.jumpY = p.pos.y;
  sim.emit({ type: 'jumpPlane', player: p.id }, undefined, p.pos, EVENT_RANGE.movement);
}

export function openChute(sim: GameSim, p: PlayerState): void {
  if (p.parachuteOpen) return;
  p.parachuteOpen = true;
  p.mode = 'parachute';
  sim.emit({ type: 'chuteOpen', player: p.id }, undefined, p.pos, EVENT_RANGE.movement);
}
