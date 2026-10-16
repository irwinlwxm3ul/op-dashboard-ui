// Vehicle integration: spawning, enter / exit / seat switching, driving, crashes, run-overs,
// burning + explosion, sleeping parked vehicles, and (training) respawning wrecks.

import { MAX_VEHICLES, PLAYER_RADIUS, VEHICLE_ENTER_RANGE } from '../constants';
import { lineOfSight } from '../physics';
import type { Rng } from '../rng';
import {
  VEHICLES, crashDamage, createVehicle, exitPosition, seatWorldPosition, stepVehicle, vehicleHitsPoint,
} from '../vehicles';
import type { VehicleStepEvents } from '../vehicles';
import type { EntityId, PlayerState, VehicleSpawn, VehicleState } from '../types';
import { bodyCenter, cancelRevive, damageInfo, damagePlayer } from './combat';
import { explode } from './projectiles';
import type { GameSim } from './GameSim';
import type { PlayerRt } from './players';
import {
  BAIL_DAMAGE_PER_MS, BAIL_SPEED, CRASH_MIN_IMPACT, EVENT_RANGE, NOISE_VEHICLE_INTERVAL,
  NOISE_VEHICLE_RADIUS, RUNOVER_COOLDOWN, RUNOVER_DAMAGE_PER_MS, RUNOVER_SPEED, VEHICLE_BURN_TIME,
  VEHICLE_EXPLOSION_DAMAGE, VEHICLE_EXPLOSION_RADIUS, VEHICLE_FUEL_MAX, VEHICLE_FUEL_MIN,
  VEHICLE_RESPAWN_TIME, VEHICLE_SLEEP_SPEED, VEHICLE_SLEEP_TICKS,
} from './tuning';

/** Server-side bookkeeping per vehicle. */
export interface VehicleRt {
  v: VehicleState;
  spawn: VehicleSpawn;
  fuelFraction: number;
  still: number;
  asleep: boolean;
  noiseTimer: number;
  lastAttacker: EntityId | null;
  destroyedAt: number;
  ev: VehicleStepEvents;
  others: VehicleState[];
}

export function spawnVehicles(sim: GameSim, rng: Rng): void {
  const spawns = sim.world.vehicleSpawns;
  const n = Math.min(spawns.length, MAX_VEHICLES);
  for (let i = 0; i < n; i++) {
    const s = spawns[i];
    const fuel = rng.range(VEHICLE_FUEL_MIN, VEHICLE_FUEL_MAX);
    const v = createVehicle(sim.allocId(), s, fuel);
    const vrt: VehicleRt = {
      v, spawn: s, fuelFraction: fuel, still: 0, asleep: false, noiseTimer: 0, lastAttacker: null,
      destroyedAt: 0, ev: { crash: 0, crashPos: null, inWater: false }, others: [],
    };
    sim.vehicles.set(v.id, v);
    sim.vehicleList.push(v);
    sim.vrtById.set(v.id, vrt);
    sim.vrtList.push(vrt);
  }
}

function wake(sim: GameSim, v: VehicleState): void {
  const vrt = sim.vrtById.get(v.id);
  if (vrt) { vrt.asleep = false; vrt.still = 0; }
}

const center = { x: 0, y: 0, z: 0 };

/** Whether `p` is close enough to interact with `v` (enter / refuel). */
export function nearVehicle(p: PlayerState, v: VehicleState): boolean {
  bodyCenter(p, center);
  const dx = center.x - v.pos.x, dy = center.y - v.pos.y, dz = center.z - v.pos.z;
  if (dx * dx + dy * dy + dz * dz <= (VEHICLE_ENTER_RANGE + 0.5) ** 2) return true;
  return vehicleHitsPoint(v, center, 1.5);
}

const losEye = { x: 0, y: 0, z: 0 };
const losSeat = { x: 0, y: 0, z: 0 };

/**
 * No entering through walls: the player's eye or body centre must see the vehicle centre or the
 * chosen seat (vehicles themselves never block world line-of-sight tests).
 */
export function vehicleLineOfSight(sim: GameSim, p: PlayerState, v: VehicleState, seat: number): boolean {
  seatWorldPosition(v, seat, losSeat);
  losSeat.y += 0.7;
  bodyCenter(p, center);
  if (lineOfSight(sim.world, center, v.pos) || lineOfSight(sim.world, center, losSeat)) return true;
  sim.eyePos(p.id, losEye);
  return lineOfSight(sim.world, losEye, v.pos) || lineOfSight(sim.world, losEye, losSeat);
}

export function vehicleFull(v: VehicleState): boolean {
  for (let i = 0; i < v.seats.length; i++) if (v.seats[i] === null) return false;
  return true;
}

/** Action `enter`: nearest free seat (driver preferred) or the requested one. */
export function enterVehicle(sim: GameSim, rt: PlayerRt, id: EntityId, seat?: number): void {
  const p = rt.p;
  if (p.life !== 'alive' || (p.mode !== 'ground' && p.mode !== 'swim') || p.vehicleId !== null) return;
  const v = sim.vehicles.get(id);
  if (!v || v.destroyed || v.health <= 0) return;
  if (!nearVehicle(p, v)) return;
  let s = -1;
  if (seat !== undefined && seat >= 0 && seat < v.seats.length && v.seats[seat] === null) s = seat;
  if (s < 0 && seat === undefined) {
    for (let i = 0; i < v.seats.length; i++) if (v.seats[i] === null) { s = i; break; }
  }
  if (s < 0) return;
  if (!vehicleLineOfSight(sim, p, v, s)) return;
  v.seats[s] = p.id;
  p.vehicleId = v.id;
  p.seat = s;
  p.mode = 'vehicle';
  p.stance = 'stand';
  p.lean = 0;
  p.onGround = true;
  p.airTime = 0;
  p.fallSpeed = 0;
  p.jumpBuffer = 0;
  p.ads = 0;
  p.reloadTimer = 0;
  p.reloadTotal = 0;
  p.use = null;
  cancelRevive(sim, p);
  if (s === 0) v.lastDriver = p.id;
  seatWorldPosition(v, s, p.pos);
  p.vel.x = v.vel.x; p.vel.y = v.vel.y; p.vel.z = v.vel.z;
  wake(sim, v);
  sim.emit({ type: 'vehicleEnter', player: p.id, vehicle: v.id, seat: s }, undefined, v.pos, EVENT_RANGE.vehicle);
}

/** Action `seat`: move to a free seat of the current vehicle. */
export function switchSeat(sim: GameSim, rt: PlayerRt, seat: number): void {
  const p = rt.p;
  if (p.vehicleId === null || p.life === 'dead') return;
  const v = sim.vehicles.get(p.vehicleId);
  if (!v || seat < 0 || seat >= v.seats.length || v.seats[seat] !== null) return;
  if (p.life === 'downed') return;
  v.seats[p.seat] = null;
  v.seats[seat] = p.id;
  p.seat = seat;
  p.ads = 0;
  p.reloadTimer = 0;
  p.reloadTotal = 0;
  if (seat === 0) v.lastDriver = p.id;
  seatWorldPosition(v, seat, p.pos);
  wake(sim, v);
}

const bailInfo = damageInfo(null, 'fall');

/**
 * Remove a player from their vehicle and place them at the exit position. `bail` applies the
 * bail-out damage when the vehicle is moving fast.
 */
export function ejectFromVehicle(sim: GameSim, p: PlayerState, bail: boolean): void {
  const v = p.vehicleId !== null ? sim.vehicles.get(p.vehicleId) : undefined;
  let speed = 0;
  if (v) {
    if (p.seat >= 0 && v.seats[p.seat] === p.id) v.seats[p.seat] = null;
    const ex = exitPosition(v, p.seat, sim.world);
    p.pos.x = ex.x; p.pos.y = ex.y; p.pos.z = ex.z;
    speed = Math.hypot(v.vel.x, v.vel.y, v.vel.z);
    wake(sim, v);
    sim.emit({ type: 'vehicleExit', player: p.id, vehicle: v.id }, undefined, v.pos, EVENT_RANGE.vehicle);
  }
  p.vehicleId = null;
  p.seat = -1;
  p.mode = 'ground';
  p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
  p.onGround = false;
  p.airTime = 0;
  p.fallSpeed = 0;
  p.stance = p.life === 'downed' ? 'prone' : 'stand';
  if (bail && speed > BAIL_SPEED && p.life !== 'dead') {
    bailInfo.attacker = null;
    bailInfo.from = v ? v.pos : null;
    damagePlayer(sim, p, (speed - BAIL_SPEED) * BAIL_DAMAGE_PER_MS, bailInfo);
  }
}

/** Action `exit`. */
export function exitVehicle(sim: GameSim, rt: PlayerRt): void {
  if (rt.p.mode !== 'vehicle' || rt.p.life === 'dead') return;
  ejectFromVehicle(sim, rt.p, true);
}

/** Bullet / explosion / crash damage to a vehicle. Health 0 starts the burn timer. */
export function damageVehicle(sim: GameSim, v: VehicleState, amount: number, attacker: PlayerState | null): void {
  if (v.destroyed || v.health <= 0 || !(amount > 0) || sim.phase === 'ended') return;
  const vrt = sim.vrtById.get(v.id);
  if (attacker && vrt) vrt.lastAttacker = attacker.id;
  v.health -= amount;
  if (v.health <= 0) {
    v.health = 0;
    v.burnTimer = VEHICLE_BURN_TIME;
  }
  wake(sim, v);
}

const crashInfo = damageInfo(null, 'vehicle');

function handleCrash(sim: GameSim, vrt: VehicleRt, impact: number): void {
  const v = vrt.v;
  const cd = crashDamage(impact, v.type);
  if (cd.vehicle <= 0 && cd.occupants <= 0) return;
  if (cd.vehicle > 0) damageVehicle(sim, v, cd.vehicle, null);
  const pos = vrt.ev.crashPos ?? v.pos;
  if (cd.occupants > 0) {
    for (let s = 0; s < v.seats.length; s++) {
      const id = v.seats[s];
      if (id === null) continue;
      const occ = sim.players.get(id);
      if (!occ) continue;
      crashInfo.attacker = null;
      crashInfo.from = pos; // the occupant's damage feedback points at the impact
      damagePlayer(sim, occ, cd.occupants, crashInfo);
    }
  }
  sim.emit({
    type: 'vehicleCrash', vehicle: v.id, impact: Math.round(impact * 10) / 10,
    pos: { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: Math.round(pos.z * 100) / 100 },
  }, undefined, pos, EVENT_RANGE.vehicle);
}

const explInfo = damageInfo(null, 'explosion');
const occupantsScratch: PlayerState[] = [];

function explodeVehicle(sim: GameSim, vrt: VehicleRt): void {
  const v = vrt.v;
  v.destroyed = true;
  v.health = 0;
  v.burnTimer = 0;
  vrt.destroyedAt = sim.time;
  const attacker = vrt.lastAttacker !== null ? sim.players.get(vrt.lastAttacker) ?? null : null;
  sim.emit({
    type: 'vehicleDestroyed', vehicle: v.id,
    pos: { x: Math.round(v.pos.x * 100) / 100, y: Math.round(v.pos.y * 100) / 100, z: Math.round(v.pos.z * 100) / 100 },
  }, undefined, v.pos, EVENT_RANGE.vehicle);
  // Occupants take the full blast (no line-of-sight test) and are thrown out.
  occupantsScratch.length = 0;
  for (let s = 0; s < v.seats.length; s++) {
    const id = v.seats[s];
    if (id === null) continue;
    const occ = sim.players.get(id);
    if (!occ) { v.seats[s] = null; continue; }
    ejectFromVehicle(sim, occ, false);
    occupantsScratch.push(occ);
  }
  for (const occ of occupantsScratch) {
    explInfo.attacker = attacker;
    explInfo.pos = occ.pos;
    explInfo.from = v.pos;
    explInfo.emitHit = attacker !== null;
    explInfo.distance = attacker ? Math.hypot(attacker.pos.x - occ.pos.x, attacker.pos.z - occ.pos.z) : 0;
    damagePlayer(sim, occ, VEHICLE_EXPLOSION_DAMAGE, explInfo);
  }
  explode(sim, v.pos, VEHICLE_EXPLOSION_RADIUS, VEHICLE_EXPLOSION_DAMAGE, attacker, 'explosion', 'vehicle', occupantsScratch, v);
  occupantsScratch.length = 0;
}

function respawnVehicle(sim: GameSim, vrt: VehicleRt): void {
  const fresh = createVehicle(vrt.v.id, vrt.spawn, vrt.fuelFraction);
  Object.assign(vrt.v, fresh);
  vrt.lastAttacker = null;
  vrt.asleep = false;
  vrt.still = 0;
}

const nearPlayers: PlayerState[] = [];
const runInfo = damageInfo(null, 'vehicle');
const pc = { x: 0, y: 0, z: 0 };

function runOver(sim: GameSim, v: VehicleState, speed: number): void {
  const he = VEHICLES[v.type].halfExtents;
  const reach = Math.hypot(he.x, he.z) + 1;
  sim.playersNear(v.pos.x, v.pos.z, reach, nearPlayers);
  let driver: PlayerState | null = null;
  const did = v.seats[0] ?? v.lastDriver;
  if (did !== null) driver = sim.players.get(did) ?? null;
  for (let i = 0; i < nearPlayers.length; i++) {
    const p = nearPlayers[i];
    if (p.life === 'dead' || p.vehicleId !== null || (p.mode !== 'ground' && p.mode !== 'swim')) continue;
    const prt = sim.rtById.get(p.id);
    if (!prt || prt.runOverCooldown > 0) continue;
    bodyCenter(p, pc);
    if (!vehicleHitsPoint(v, pc, PLAYER_RADIUS)) continue;
    prt.runOverCooldown = RUNOVER_COOLDOWN;
    // Knock the player aside (away from the vehicle centre, along its motion).
    let nx = p.pos.x - v.pos.x, nz = p.pos.z - v.pos.z;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    p.vel.x = v.vel.x * 0.6 + nx * 4;
    p.vel.z = v.vel.z * 0.6 + nz * 4;
    p.vel.y = 3.5;
    p.onGround = false;
    runInfo.attacker = driver;
    runInfo.pos = pc;
    runInfo.from = v.pos;
    runInfo.distance = 0;
    runInfo.emitHit = driver !== null;
    damagePlayer(sim, p, (speed - RUNOVER_SPEED) * RUNOVER_DAMAGE_PER_MS, runInfo);
  }
}

/** Advance every vehicle one tick (driver controls come from the players' inputs). */
export function stepVehicles(sim: GameSim, dt: number): void {
  const list = sim.vrtList;
  for (let i = 0; i < list.length; i++) {
    const vrt = list[i];
    const v = vrt.v;
    if (v.destroyed) {
      if (sim.config.mode === 'training' && sim.time - vrt.destroyedAt >= VEHICLE_RESPAWN_TIME) respawnVehicle(sim, vrt);
    } else if (v.health <= 0 && sim.phase !== 'ended') {
      v.burnTimer -= dt;
      if (v.burnTimer <= 0) explodeVehicle(sim, vrt);
    }
    let ctl = null;
    const driverId = v.seats[0];
    if (driverId !== null && !v.destroyed) {
      const drt = sim.rtById.get(driverId);
      if (drt && drt.hasControls && drt.p.life === 'alive') ctl = drt.controls;
    }
    const vsq = v.vel.x * v.vel.x + v.vel.y * v.vel.y + v.vel.z * v.vel.z;
    if (ctl === null && vrt.asleep) {
      if (vsq <= VEHICLE_SLEEP_SPEED * VEHICLE_SLEEP_SPEED) continue;
      vrt.asleep = false;
      vrt.still = 0;
    }
    // Nearby vehicles for vehicle-vs-vehicle collisions.
    const others = vrt.others;
    others.length = 0;
    const vl = sim.vehicleList;
    for (let k = 0; k < vl.length; k++) {
      const o = vl[k];
      if (o === v) continue;
      const dx = o.pos.x - v.pos.x, dz = o.pos.z - v.pos.z;
      if (dx * dx + dz * dz < 18 * 18) others.push(o);
    }
    stepVehicle(v, ctl, dt, sim.world, others, vrt.ev);
    if (ctl && driverId !== null) v.lastDriver = driverId;
    if (vrt.ev.crash > CRASH_MIN_IMPACT) handleCrash(sim, vrt, vrt.ev.crash);
    const hit = vrt.ev.hitVehicle;
    if (hit !== undefined && hit >= 0 && (vrt.ev.hitVehicleImpact ?? 0) > CRASH_MIN_IMPACT) {
      const ort = sim.vrtById.get(hit);
      if (ort) {
        ort.ev.crashPos = vrt.ev.crashPos;
        handleCrash(sim, ort, vrt.ev.hitVehicleImpact!);
        wake(sim, ort.v);
      }
    }
    const hs = Math.hypot(v.vel.x, v.vel.z);
    if (hs > RUNOVER_SPEED && !v.destroyed) runOver(sim, v, hs);
    // Engine noise for bots.
    if (ctl || hs > 1) {
      vrt.noiseTimer -= dt;
      if (vrt.noiseTimer <= 0) {
        vrt.noiseTimer = NOISE_VEHICLE_INTERVAL;
        sim.addNoise(v.pos, driverId ?? -1, 'vehicle', NOISE_VEHICLE_RADIUS);
      }
    }
    // Sleep bookkeeping.
    if (ctl === null && v.onGround && vsq < VEHICLE_SLEEP_SPEED * VEHICLE_SLEEP_SPEED) {
      if (++vrt.still >= VEHICLE_SLEEP_TICKS) vrt.asleep = true;
    } else {
      vrt.still = 0;
      vrt.asleep = false;
    }
  }
}

/** Occupants ride at their seat positions (after the vehicles moved). */
export function syncOccupants(sim: GameSim): void {
  const vl = sim.vehicleList;
  for (let i = 0; i < vl.length; i++) {
    const v = vl[i];
    for (let s = 0; s < v.seats.length; s++) {
      const id = v.seats[s];
      if (id === null) continue;
      const p = sim.players.get(id);
      if (!p || p.vehicleId !== v.id) { v.seats[s] = null; continue; }
      seatWorldPosition(v, s, p.pos);
      p.vel.x = v.vel.x; p.vel.y = v.vel.y; p.vel.z = v.vel.z;
      p.onGround = true;
    }
  }
}

/** Whether the occupant of `seat` may use weapons. */
export function seatCanShoot(v: VehicleState, seat: number): boolean {
  const def = VEHICLES[v.type];
  return seat >= 0 && seat < def.seatCanShoot.length && def.seatCanShoot[seat];
}
