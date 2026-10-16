// Zone awareness: where to rotate to and how urgent it is.

import type { PlayerState } from '../types';
import type { BotState } from './state';
import type { BotSystem } from './system';

/** Assumed travel speeds (m/s) for rotation timing. */
const FOOT_SPEED = 5.6;
const VEHICLE_SPEED = 14;

/** Margin kept inside the next circle. */
export function zoneMargin(nr: number): number {
  return Math.min(nr * 0.35, 30);
}

/** True when the zone is active (not the pre-game stage / training). */
export function zoneActive(sys: BotSystem): boolean {
  const z = sys.sim.zone;
  return z.stage !== 'pre' && z.r < sys.world.size * 2;
}

/** Recompute the bot's rotation target when a new circle is announced. */
export function updateZoneTarget(sys: BotSystem, b: BotState, p: PlayerState): void {
  const z = sys.sim.zone;
  const key = z.phase * 8 + (z.stage === 'final' ? 7 : 0);
  if (key === b.zoneKey) return;
  b.zoneKey = key;
  const nr = z.nr;
  const safe = Math.max(0, nr - zoneMargin(nr));
  // Somewhere on the bot's side of the circle, randomised so bots do not converge on one spot.
  let ax = p.pos.x - z.nx, az = p.pos.z - z.nz;
  const l = Math.hypot(ax, az);
  let ang = l > 1 ? Math.atan2(az, ax) : b.rng.next() * Math.PI * 2;
  ang += b.rng.gauss() * 0.6;
  const rad = safe * (0.2 + 0.55 * b.rng.next());
  ax = Math.cos(ang);
  az = Math.sin(ang);
  let x = z.nx + ax * rad, zz = z.nz + az * rad;
  if (!sys.grid.nearestFree(x, zz, 10, sys.xz)) {
    // In water or blocked: fall back toward the centre.
    x = z.nx;
    zz = z.nz;
    if (sys.grid.nearestFree(x, zz, 20, sys.xz)) {
      x = sys.xz.x;
      zz = sys.xz.z;
    }
  } else {
    x = sys.xz.x;
    zz = sys.xz.z;
  }
  b.zoneX = x;
  b.zoneZ = zz;
}

/** Is (x, z) inside the next circle with margin? */
export function insideNext(sys: BotSystem, x: number, z: number, extraMargin = 0): boolean {
  const zn = sys.sim.zone;
  if (!zoneActive(sys)) return true;
  const safe = Math.max(0, zn.nr - zoneMargin(zn.nr) - extraMargin);
  return Math.hypot(x - zn.nx, z - zn.nz) <= Math.max(safe, 3);
}

/** Taking zone damage now (or about to)? */
export function outsideCurrent(sys: BotSystem, x: number, z: number): boolean {
  const zn = sys.sim.zone;
  if (!zoneActive(sys)) return false;
  return Math.hypot(x - zn.cx, z - zn.cz) > zn.r - 3;
}

/**
 * Rotation urgency: estimated travel time to the safe area divided by the time available
 * (0 = already safe, >= 1 = leave now).
 */
export function zoneUrgency(sys: BotSystem, p: PlayerState, inVehicle: boolean): number {
  if (!zoneActive(sys)) return 0;
  const z = sys.sim.zone;
  const safe = Math.max(0, z.nr - zoneMargin(z.nr));
  const dNext = Math.hypot(p.pos.x - z.nx, p.pos.z - z.nz);
  const outside = dNext - safe;
  if (outside <= 0) return 0;
  const travel = outside / (inVehicle ? VEHICLE_SPEED : FOOT_SPEED);
  let avail: number;
  if (z.stage === 'waiting') {
    avail = z.timer + z.timer * 0.6;
  } else if (z.stage === 'shrinking') {
    const dCur = Math.hypot(p.pos.x - z.cx, p.pos.z - z.cz);
    const closing = z.r - z.nr;
    avail = closing > 1 ? z.timer * Math.max(0, (z.r - dCur) / closing) : z.timer;
  } else {
    avail = 0;
  }
  const u = travel / Math.max(1, avail);
  return outsideCurrent(sys, p.pos.x, p.pos.z) ? Math.max(u, 2) : u;
}
