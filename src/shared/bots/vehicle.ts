// Vehicles: pick a vehicle for long rotations (or a squadmate's free seat), walk to it and enter,
// drive toward the rotation target with throttle/steer and grid feelers around obstacles,
// recover from getting stuck by reversing, and exit when close, stuck, out of fuel or burning.

import { hyp } from './util';
import { VEHICLE_ENTER_RANGE } from '../constants';
import { angleDiff, clamp } from '../math';
import type { PlayerState, VehicleState } from '../types';
import { BTN } from '../types';
import { VEHICLES } from '../vehicles';
import { steerAim } from './combat';
import { setDest } from './movement';
import { NF_BLOCKED, NF_NEAR, NF_ON_BOX, NF_UNKNOWN } from './nav';
import type { BotState } from './state';
import type { BotSystem } from './system';
import { insideNext, outsideCurrent, updateZoneTarget, zoneActive } from './zone';
import { findContact } from './perception';
import { slotRounds } from './aim';

/** Rotations longer than this prefer a vehicle (m). */
export const VEHICLE_TRIP = 250;
/** Seconds a vehicle the bot gave up on is ignored. */
export const VEHICLE_BLACKLIST_TIME = 90;
const ARRIVE_DIST = 35;
/** Enemies closer than this make a slow driver get out and fight. */
const THREAT_EXIT_DIST = 45;
const HEADINGS: readonly number[] = [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.35, -1.35];

export function freeSeat(v: VehicleState, driver: boolean): number {
  if (driver) return v.seats[0] === null ? 0 : -1;
  for (let i = 1; i < v.seats.length; i++) if (v.seats[i] === null) return i;
  return -1;
}

function usable(sys: BotSystem, v: VehicleState): boolean {
  const def = VEHICLES[v.type];
  if (v.destroyed || v.health < def.health * 0.25) return false;
  return sys.world.heightAt(v.pos.x, v.pos.z) > sys.world.waterLevel - 0.6;
}

/** Find a vehicle to take within `radius`: a free driver seat, or a seat next to a teammate driver. */
export function findVehicle(sys: BotSystem, b: BotState, p: PlayerState, radius: number, needDriverSeat: boolean): VehicleState | null {
  const near = sys.sim.vehiclesNear(p.pos.x, p.pos.z, radius, sys.vehicleBuf);
  let best: VehicleState | null = null, bestS = Infinity;
  for (let i = 0; i < near.length; i++) {
    const v = near[i];
    const until = b.vehicleBlacklist.get(v.id);
    if ((until !== undefined && until > sys.now) || !usable(sys, v)) continue;
    const def = VEHICLES[v.type];
    const d = hyp(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
    const driver = v.seats[0];
    let s = Infinity;
    if (driver === null) {
      if (needDriverSeat && v.fuel > def.fuelMax * 0.06) s = d;
    } else if (sys.sim.sameTeam(b.id, driver) && freeSeat(v, false) >= 0) {
      s = d - 15;
    }
    if (s < bestS) {
      bestS = s;
      best = v;
    }
  }
  return best;
}

/** Walk to the chosen vehicle and enter it. Returns false when the plan is abandoned. */
export function approachVehicle(sys: BotSystem, b: BotState, p: PlayerState): boolean {
  const t = sys.now;
  const v = sys.sim.vehicles.get(b.vehicleId);
  if (!v || !usable(sys, v) || t - b.vehicleSince > 25) {
    b.vehicleBlacklist.set(b.vehicleId, t + VEHICLE_BLACKLIST_TIME);
    b.vehicleId = -1;
    return false;
  }
  const driver = v.seats[0];
  let seat: number;
  if (driver === null) seat = 0;
  else if (sys.sim.sameTeam(b.id, driver)) seat = freeSeat(v, false);
  else seat = -1;
  if (seat < 0) {
    b.vehicleBlacklist.set(v.id, t + VEHICLE_BLACKLIST_TIME);
    b.vehicleId = -1;
    return false;
  }
  const d = hyp(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
  if (d < VEHICLE_ENTER_RANGE - 0.9) {
    if (t - b.vehicleActionAt > 0.6) {
      b.actions.push({ a: 'enter', id: v.id, seat });
      b.vehicleActionAt = t;
    }
    b.moveScale = 0;
  } else {
    setDest(sys, b, p, v.pos.x, v.pos.z, VEHICLE_ENTER_RANGE - 1.2, true);
  }
  return true;
}

function rayClear(sys: BotSystem, x: number, z: number, h: number, L: number, mask: number): boolean {
  const fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
  const g = sys.grid;
  // Dense samples (1 m) so thin barriers and fences cannot slip between them; NEAR catches
  // tree trunks thinner than a cell. Vehicles also stay out of buildings (box floors).
  for (let s = 2; s <= L; s += 1) {
    for (let lat = -1; lat <= 1; lat++) {
      const f = g.flagsAt(x + fx * s + rx * lat * 1.1, z + fz * s + rz * lat * 1.1, false);
      if (f !== NF_UNKNOWN && f & mask) return false;
    }
  }
  return true;
}

/** Driver / passenger logic. Writes axes into out; returns buttons. */
export function vehicleTick(sys: BotSystem, b: BotState, p: PlayerState, think: boolean, out: { mx: number; mz: number }): number {
  const sim = sys.sim;
  const t = sys.now;
  out.mx = 0;
  out.mz = 0;
  const v = p.vehicleId !== null ? sim.vehicles.get(p.vehicleId) : undefined;
  if (!v) return 0;
  if (b.vehicleId !== v.id) {
    // Just got in.
    b.vehicleId = v.id;
    b.vehicleSince = t;
    b.exitWanted = false;
    b.driveStuckCount = 0;
    b.driveStuckSince = -1;
    b.reverseUntil = 0;
    b.driveWaitUntil = p.seat === 0 && teammatesWalkingNear(sys, p, 35) ? t + 4 : t;
  }
  const def = VEHICLES[v.type];
  const speed = v.speed;
  let buttons = 0;

  if (p.seat !== 0) {
    // Passenger: get out when there is no driver (or the vehicle is wrecked) and it is slow.
    if (think && (v.seats[0] === null || v.destroyed) && Math.abs(speed) < 7 && t - b.vehicleActionAt > 0.6) {
      b.actions.push({ a: 'exit' });
      b.vehicleActionAt = t;
    }
    return 0;
  }

  // ---- Driver ----
  let tx: number, tz: number;
  const leader = sys.humanLeader(p);
  if (leader) {
    tx = leader.pos.x;
    tz = leader.pos.z;
  } else {
    updateZoneTarget(sys, b, p);
    tx = zoneActive(sys) ? b.zoneX : b.destX;
    tz = zoneActive(sys) ? b.zoneZ : b.destZ;
  }
  const dist = hyp(tx - v.pos.x, tz - v.pos.z);
  if (think) {
    const arrivedNow = dist < ARRIVE_DIST || (!leader && zoneActive(sys) && insideNext(sys, v.pos.x, v.pos.z, 20) && dist < 120);
    // Bail out to fight only when an enemy is close, the bot can shoot back and it is not
    // racing the zone.
    const c = findContact(b, b.targetId);
    const threatClose = !!c && c.visible && Math.abs(speed) < 8 && hyp(c.x - v.pos.x, c.z - v.pos.z) < THREAT_EXIT_DIST &&
      hasRounds(p) && !outsideCurrent(sys, v.pos.x, v.pos.z);
    if (arrivedNow || v.destroyed || v.health < def.health * 0.2 || v.fuel <= 0.05 || b.driveStuckCount >= 3 || threatClose) {
      b.exitWanted = true;
    }
    if (b.exitWanted && Math.abs(speed) < 3 && t - b.vehicleActionAt > 0.6) {
      b.actions.push({ a: 'exit' });
      b.vehicleActionAt = t;
      if (b.driveStuckCount >= 3 || v.fuel <= 0.05) b.vehicleBlacklist.set(v.id, t + VEHICLE_BLACKLIST_TIME);
    }
    // Heading with feelers: strict first, then without the obstacle margin, then short range.
    const desired = Math.atan2(-(tx - v.pos.x), -(tz - v.pos.z));
    const L = clamp(Math.abs(speed) * 1.4, 8, 30);
    let chosen = NaN;
    for (let pass = 0; pass < 3 && Number.isNaN(chosen); pass++) {
      const mask = pass === 0 ? NF_BLOCKED | NF_ON_BOX | NF_NEAR : NF_BLOCKED | NF_ON_BOX;
      const len = pass === 2 ? 5 : L;
      for (let k = 0; k < HEADINGS.length; k++) {
        const h = desired + HEADINGS[k];
        if (rayClear(sys, v.pos.x, v.pos.z, h, len, mask)) {
          chosen = h;
          break;
        }
      }
    }
    b.driveHeading = Number.isNaN(chosen) ? desired : chosen;
    if (Number.isNaN(chosen) && t >= b.reverseUntil) {
      b.reverseUntil = t + 1.2;
      b.driveStuckCount++;
    }
    // Stuck: throttling without moving.
    if (b.driveThrottle > 0.4 && Math.abs(speed) < 1.5 && t >= b.reverseUntil) {
      if (b.driveStuckSince < 0) b.driveStuckSince = t;
      else if (t - b.driveStuckSince > 1.5) {
        b.reverseUntil = t + 1.3;
        b.driveStuckCount++;
        b.driveStuckSince = -1;
      }
    } else {
      b.driveStuckSince = -1;
    }
  }
  steerAim(sys, b, v.yaw, -0.05, 0.6);
  const yawErr = angleDiff(v.yaw, b.driveHeading);
  let throttle: number, steer: number;
  if (b.exitWanted) {
    throttle = Math.abs(speed) > 1 ? -Math.sign(speed) : 0;
    steer = 0;
    if (Math.abs(speed) < 8) buttons |= BTN.HANDBRAKE;
  } else if (t < b.driveWaitUntil && teammatesWalkingNear(sys, p, 35)) {
    throttle = 0;
    steer = 0;
  } else if (t < b.reverseUntil) {
    throttle = -0.9;
    steer = clamp(yawErr * 2, -1, 1); // reversing swings the nose the other way
  } else {
    steer = clamp(-yawErr * 2.2, -1, 1);
    const ae = Math.abs(yawErr);
    throttle = ae > 1.3 ? 0.3 : 1 - (0.45 * ae) / 1.3;
    if (Math.abs(speed) > 18 && ae > 0.5) throttle = 0.15;
    // Bots drive at a sane cruising speed (crashes hurt, bikes especially).
    const cruise = Math.min(def.maxSpeed * 0.7, def.isBike ? 18 : 22);
    if (speed > cruise) throttle = Math.min(throttle, speed > cruise + 3 ? -0.3 : 0);
    if (dist < 80) throttle *= Math.max(0.35, dist / 80);
  }
  b.driveThrottle = throttle;
  out.mx = steer;
  out.mz = throttle;
  return buttons;
}

function hasRounds(p: PlayerState): boolean {
  return slotRounds(p, 0) > 0 || slotRounds(p, 1) > 0 || slotRounds(p, 2) > 0;
}

function teammatesWalkingNear(sys: BotSystem, p: PlayerState, r: number): boolean {
  const near = sys.sim.playersNear(p.pos.x, p.pos.z, r, sys.playerBuf2);
  for (let i = 0; i < near.length; i++) {
    const q = near[i];
    if (q.id !== p.id && q.life === 'alive' && q.mode !== 'vehicle' && q.isBot && sys.sim.sameTeam(p.id, q.id)) return true;
  }
  return false;
}
