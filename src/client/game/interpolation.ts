// Snapshot interpolation primitives: a time-ordered sample ring per entity and bracket lookup at
// the render time, plus entity specific blending of the quantised network formats. Pure (no DOM).

import { MAX_EXTRAPOLATE_MS } from '../../shared/constants';
import { lerp, lerpAngle } from '../../shared/math';
import type { NetPlayer, NetProjectile, NetVehicle } from '../../shared/protocol';
import type { Vec3 } from '../../shared/types';

export interface Bracket<T> {
  a: T;
  b: T;
  ta: number;
  tb: number;
  /** Blend factor from a to b (0..1). */
  alpha: number;
  /** Milliseconds past the newest sample (> 0 while extrapolating, capped by the caller). */
  extra: number;
}

/** Fixed capacity ring of samples ordered by time (oldest first). */
export class SampleRing<T> {
  private readonly times: Float64Array;
  private readonly items: (T | undefined)[];
  private start = 0;
  private n = 0;

  constructor(readonly capacity: number) {
    this.times = new Float64Array(capacity);
    this.items = new Array<T | undefined>(capacity);
  }

  get count(): number {
    return this.n;
  }

  /** Append a sample. Out-of-order samples are ignored; a sample at the newest time replaces it. */
  push(t: number, item: T): boolean {
    if (this.n > 0) {
      const newest = this.timeAt(this.n - 1);
      if (t < newest) return false;
      if (t === newest) {
        this.items[(this.start + this.n - 1) % this.capacity] = item;
        return true;
      }
    }
    if (this.n === this.capacity) {
      this.items[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.n--;
    }
    const i = (this.start + this.n) % this.capacity;
    this.times[i] = t;
    this.items[i] = item;
    this.n++;
    return true;
  }

  /** i = 0 is the oldest sample. */
  at(i: number): T {
    return this.items[(this.start + i) % this.capacity] as T;
  }

  timeAt(i: number): number {
    return this.times[(this.start + i) % this.capacity];
  }

  newest(): T | undefined {
    return this.n > 0 ? this.at(this.n - 1) : undefined;
  }

  newestTime(): number {
    return this.n > 0 ? this.timeAt(this.n - 1) : -Infinity;
  }

  oldestTime(): number {
    return this.n > 0 ? this.timeAt(0) : Infinity;
  }

  /** Drop samples older than `t`, keeping the last sample at or before `t` (needed to interpolate at t). */
  prune(t: number): void {
    while (this.n > 2 && this.timeAt(1) <= t) {
      this.items[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.n--;
    }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.items[i] = undefined;
    this.start = 0;
    this.n = 0;
  }

  /**
   * Locate the samples around time t. Before the oldest sample the oldest is held; after the
   * newest one, `extra` reports how far past it t is (the caller extrapolates). Returns false
   * when empty.
   */
  bracket(t: number, out: Bracket<T>): boolean {
    const n = this.n;
    if (n === 0) return false;
    const last = n - 1;
    const tLast = this.timeAt(last);
    if (t >= tLast) {
      const s = this.at(last);
      out.a = s;
      out.b = s;
      out.ta = tLast;
      out.tb = tLast;
      out.alpha = 1;
      out.extra = t - tLast;
      return true;
    }
    if (t <= this.timeAt(0)) {
      const s = this.at(0);
      out.a = s;
      out.b = s;
      out.ta = out.tb = this.timeAt(0);
      out.alpha = 0;
      out.extra = 0;
      return true;
    }
    // Render time is almost always within the last few samples: scan backward.
    let i = last - 1;
    while (i > 0 && this.timeAt(i) > t) i--;
    const ta = this.timeAt(i), tb = this.timeAt(i + 1);
    out.a = this.at(i);
    out.b = this.at(i + 1);
    out.ta = ta;
    out.tb = tb;
    out.alpha = tb > ta ? (t - ta) / (tb - ta) : 1;
    out.extra = 0;
    return true;
  }
}

export function makeBracket<T>(): Bracket<T> {
  return { a: undefined as unknown as T, b: undefined as unknown as T, ta: 0, tb: 0, alpha: 0, extra: 0 };
}

/** Max plausible entity speed (m/s, plane) used to detect teleports between samples. */
const TELEPORT_SPEED = 90;
const TELEPORT_MIN_DIST = 20;

/**
 * True when two position samples are too far apart to be continuous motion (respawn, seat warp,
 * relevance gap): interpolating would draw a streak, so the caller should snap instead.
 */
export function isTeleport(a: readonly number[], b: readonly number[], dtMs: number): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const limit = TELEPORT_MIN_DIST + TELEPORT_SPEED * Math.max(0, dtMs) / 1000;
  return dx * dx + dy * dy + dz * dz > limit * limit;
}

/** Interpolated continuous state of a remote player (discrete fields come from `b`). */
export interface PlayerInterp {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  /** True when the position is extrapolated past the newest sample. */
  extrapolating: boolean;
}

/**
 * Blend two NetPlayer samples: position/velocity lerp, angles lerpAngle; when past the newest
 * sample, extrapolate along its velocity for at most MAX_EXTRAPOLATE_MS.
 */
export function interpolatePlayer(br: Bracket<NetPlayer>, out: PlayerInterp): PlayerInterp {
  const a = br.a, b = br.b;
  if (br.extra > 0 || a === b) {
    const ex = Math.min(br.extra, MAX_EXTRAPOLATE_MS) / 1000;
    // Dead / plane riders do not move on their own.
    const moving = b.l !== 2;
    out.pos.x = b.p[0] + (moving ? b.v[0] * ex : 0);
    out.pos.y = b.p[1] + (moving ? b.v[1] * ex : 0);
    out.pos.z = b.p[2] + (moving ? b.v[2] * ex : 0);
    out.vel.x = b.v[0];
    out.vel.y = b.v[1];
    out.vel.z = b.v[2];
    out.yaw = b.y;
    out.pitch = b.pt;
    out.extrapolating = br.extra > 0;
    return out;
  }
  let t = br.alpha;
  if (isTeleport(a.p, b.p, br.tb - br.ta)) t = 1;
  out.pos.x = lerp(a.p[0], b.p[0], t);
  out.pos.y = lerp(a.p[1], b.p[1], t);
  out.pos.z = lerp(a.p[2], b.p[2], t);
  out.vel.x = lerp(a.v[0], b.v[0], t);
  out.vel.y = lerp(a.v[1], b.v[1], t);
  out.vel.z = lerp(a.v[2], b.v[2], t);
  out.yaw = lerpAngle(a.y, b.y, t);
  out.pitch = lerp(a.pt, b.pt, t);
  out.extrapolating = false;
  return out;
}

export interface VehicleInterp {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  steer: number;
  rpm: number;
  extrapolating: boolean;
}

export function interpolateVehicle(br: Bracket<NetVehicle>, out: VehicleInterp): VehicleInterp {
  const a = br.a, b = br.b;
  if (br.extra > 0 || a === b) {
    const ex = b.destroyed ? 0 : Math.min(br.extra, MAX_EXTRAPOLATE_MS) / 1000;
    out.pos.x = b.p[0] + b.v[0] * ex;
    out.pos.y = b.p[1] + b.v[1] * ex;
    out.pos.z = b.p[2] + b.v[2] * ex;
    out.vel.x = b.v[0];
    out.vel.y = b.v[1];
    out.vel.z = b.v[2];
    out.yaw = b.r[0];
    out.pitch = b.r[1];
    out.roll = b.r[2];
    out.steer = b.steer;
    out.rpm = b.rpm;
    out.extrapolating = br.extra > 0;
    return out;
  }
  let t = br.alpha;
  if (isTeleport(a.p, b.p, br.tb - br.ta)) t = 1;
  out.pos.x = lerp(a.p[0], b.p[0], t);
  out.pos.y = lerp(a.p[1], b.p[1], t);
  out.pos.z = lerp(a.p[2], b.p[2], t);
  out.vel.x = lerp(a.v[0], b.v[0], t);
  out.vel.y = lerp(a.v[1], b.v[1], t);
  out.vel.z = lerp(a.v[2], b.v[2], t);
  out.yaw = lerpAngle(a.r[0], b.r[0], t);
  out.pitch = lerpAngle(a.r[1], b.r[1], t);
  out.roll = lerpAngle(a.r[2], b.r[2], t);
  out.steer = lerp(a.steer, b.steer, t);
  out.rpm = lerp(a.rpm, b.rpm, t);
  out.extrapolating = false;
  return out;
}

/** Projectiles fly ballistic paths: lerp between samples, extrapolate linearly past the newest. */
export function interpolateProjectile(br: Bracket<NetProjectile>, pos: Vec3, vel: Vec3): void {
  const a = br.a, b = br.b;
  if (br.extra > 0 || a === b) {
    const ex = Math.min(br.extra, MAX_EXTRAPOLATE_MS) / 1000;
    pos.x = b.p[0] + b.v[0] * ex;
    pos.y = b.p[1] + b.v[1] * ex;
    pos.z = b.p[2] + b.v[2] * ex;
    vel.x = b.v[0];
    vel.y = b.v[1];
    vel.z = b.v[2];
    return;
  }
  const t = br.alpha;
  pos.x = lerp(a.p[0], b.p[0], t);
  pos.y = lerp(a.p[1], b.p[1], t);
  pos.z = lerp(a.p[2], b.p[2], t);
  vel.x = lerp(a.v[0], b.v[0], t);
  vel.y = lerp(a.v[1], b.v[1], t);
  vel.z = lerp(a.v[2], b.v[2], t);
}

/**
 * Visual correction offset for an entity whose extrapolated position was superseded by real data:
 * the jump is absorbed into an offset that decays over ~100 ms instead of popping.
 */
export class SmoothOffset {
  x = 0;
  y = 0;
  z = 0;

  /** Absorb a discontinuity (previous rendered - new raw). Ignored (snap) when larger than `maxDist`. */
  absorb(dx: number, dy: number, dz: number, maxDist: number): void {
    const nx = this.x + dx, ny = this.y + dy, nz = this.z + dz;
    if (nx * nx + ny * ny + nz * nz > maxDist * maxDist) {
      this.x = this.y = this.z = 0;
      return;
    }
    this.x = nx;
    this.y = ny;
    this.z = nz;
  }

  decay(dt: number, rate: number): void {
    const k = Math.exp(-rate * dt);
    this.x *= k;
    this.y *= k;
    this.z *= k;
    if (this.x * this.x + this.y * this.y + this.z * this.z < 1e-8) this.x = this.y = this.z = 0;
  }

  get length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  reset(): void {
    this.x = this.y = this.z = 0;
  }
}
