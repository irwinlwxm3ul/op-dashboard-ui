// Zone (blue circle) timeline: 'pre' -> 8 x (waiting -> shrinking) -> 'final'. Each next circle lies
// fully inside the previous one with its centre on land (seeded retries).

import { lerp } from '../math';
import type { Rng } from '../rng';
import type { World, ZoneState } from '../types';
import {
  TRAINING_ZONE_RADIUS, ZONE_CENTER_TRIES, ZONE_FIRST_LIMIT, ZONE_PHASES, ZONE_PRE_TIME,
} from './tuning';

/** Zone covering the whole map (before the plane starts). */
export function createZone(world: World): ZoneState {
  const r = world.half * Math.SQRT2 + 10;
  return {
    phase: 0, stage: 'pre', cx: 0, cz: 0, r, nx: 0, nz: 0, nr: r,
    timer: 0, stageTotal: 0, damagePerSec: 0,
  };
}

/** Whether a point is outside the current blue circle. */
export function outsideZone(zone: ZoneState, x: number, z: number): boolean {
  const dx = x - zone.cx, dz = z - zone.cz;
  return dx * dx + dz * dz > zone.r * zone.r;
}

/** Drives one match's ZoneState (owned by GameSim, mutated in place). */
export class ZoneController {
  private readonly zone: ZoneState;
  private readonly world: World;
  private readonly rng: Rng;
  private readonly speed: number;
  /** Blue circle at the start of the current shrink. */
  private fromX = 0;
  private fromZ = 0;
  private fromR = 0;

  constructor(zone: ZoneState, world: World, rng: Rng, speed: number) {
    this.zone = zone;
    this.world = world;
    this.rng = rng;
    this.speed = speed > 0 ? speed : 1;
  }

  /** Training ground: no zone (huge final circle, no damage). */
  disable(): void {
    const z = this.zone;
    z.phase = 0;
    z.stage = 'final';
    z.cx = 0; z.cz = 0; z.r = TRAINING_ZONE_RADIUS;
    z.nx = 0; z.nz = 0; z.nr = TRAINING_ZONE_RADIUS;
    z.timer = 0;
    z.stageTotal = 0;
    z.damagePerSec = 0;
  }

  /** Start the timeline (called when the plane starts). */
  start(): void {
    const z = this.zone;
    z.phase = 0;
    z.stage = 'pre';
    z.stageTotal = ZONE_PRE_TIME * this.speed;
    z.timer = z.stageTotal;
    z.damagePerSec = 0;
  }

  /** Advance by dt. Returns true when the stage changed (the caller emits zonePhase). */
  update(dt: number): boolean {
    const z = this.zone;
    if (z.stage === 'final') return false;
    z.timer = Math.max(0, z.timer - dt);
    if (z.stage === 'shrinking') {
      const f = z.stageTotal > 0 ? 1 - z.timer / z.stageTotal : 1;
      z.cx = lerp(this.fromX, z.nx, f);
      z.cz = lerp(this.fromZ, z.nz, f);
      z.r = lerp(this.fromR, z.nr, f);
    }
    if (z.timer > 0) return false;

    if (z.stage === 'pre') {
      this.beginWaiting(1);
    } else if (z.stage === 'waiting') {
      const def = ZONE_PHASES[z.phase - 1];
      z.stage = 'shrinking';
      z.stageTotal = def.shrink * this.speed;
      z.timer = z.stageTotal;
      z.damagePerSec = def.damage;
      this.fromX = z.cx;
      this.fromZ = z.cz;
      this.fromR = z.r;
    } else {
      // Shrink finished: snap onto the white circle.
      z.cx = z.nx;
      z.cz = z.nz;
      z.r = z.nr;
      if (z.phase >= ZONE_PHASES.length) {
        z.stage = 'final';
        z.timer = 0;
        z.stageTotal = 0;
        z.damagePerSec = ZONE_PHASES[ZONE_PHASES.length - 1].damage;
      } else {
        this.beginWaiting(z.phase + 1);
      }
    }
    return true;
  }

  private beginWaiting(phase: number): void {
    const z = this.zone;
    const def = ZONE_PHASES[phase - 1];
    z.phase = phase;
    z.stage = 'waiting';
    z.stageTotal = def.wait * this.speed;
    z.timer = z.stageTotal;
    z.damagePerSec = def.damage;
    this.pickNextCircle(phase);
  }

  private onLand(x: number, z: number): boolean {
    return this.world.inBounds(x, z) && this.world.heightAt(x, z) > this.world.waterLevel + 0.5;
  }

  /** White circle for `phase` (1-based), fully inside the current blue circle, centre on land. */
  private pickNextCircle(phase: number): void {
    const z = this.zone;
    const nr = ZONE_PHASES[phase - 1].radius;
    const px = z.cx, pz = z.cz;
    // The first circle must stay over the island even though the 'pre' circle covers the sea.
    const limitR = phase === 1 ? Math.min(z.r, this.world.half * ZONE_FIRST_LIMIT) : z.r;
    const maxOff = Math.max(0, limitR - nr);
    let bx = px, bz = pz;
    let found = false;
    for (let i = 0; i < ZONE_CENTER_TRIES; i++) {
      const a = this.rng.next() * Math.PI * 2;
      // Later tries pull towards the previous centre so small land masses are still found.
      const d = Math.sqrt(this.rng.next()) * maxOff * (1 - i / ZONE_CENTER_TRIES);
      const x = px + Math.cos(a) * d, zz = pz + Math.sin(a) * d;
      if (this.onLand(x, zz)) {
        bx = x; bz = zz; found = true;
        break;
      }
    }
    if (!found) {
      // Walk from the previous centre towards the map centre until we hit land (still inside).
      for (let k = 1; k <= 20; k++) {
        const f = 1 - k / 20;
        const x = px * f, zz = pz * f;
        if (Math.hypot(x - px, zz - pz) > maxOff) break;
        if (this.onLand(x, zz)) { bx = x; bz = zz; break; }
      }
    }
    z.nx = bx;
    z.nz = bz;
    z.nr = nr;
  }
}
