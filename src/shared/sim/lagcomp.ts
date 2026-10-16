// Lag compensation: a ring buffer of every player's hitbox pose per tick (HITBOX_HISTORY_MS).
// Poses are interpolated between ticks so a shot can be tested against exactly what the shooter
// saw at their render time (clamped to MAX_REWIND_MS by the caller).

import { HITBOX_HISTORY_MS, TICK_MS } from '../constants';
import { lerpAngle } from '../math';
import type { HitboxPose } from '../physics';
import type { LifeState, MovementMode, PlayerState, Stance, VehicleState } from '../types';

const STANCES: readonly Stance[] = ['stand', 'crouch', 'prone'];
const LIVES: readonly LifeState[] = ['alive', 'downed', 'dead'];
const MODES: readonly MovementMode[] = ['plane', 'freefall', 'parachute', 'ground', 'swim', 'vehicle'];
const STANCE_IDX: Record<Stance, number> = { stand: 0, crouch: 1, prone: 2 };
const LIFE_IDX: Record<LifeState, number> = { alive: 0, downed: 1, dead: 2 };
const MODE_IDX: Record<MovementMode, number> = { plane: 0, freefall: 1, parachute: 2, ground: 3, swim: 4, vehicle: 5 };

/** Floats per sample: x, y, z, yaw, stance, life, mode, lean. */
const STRIDE = 8;
/** Life code used for slots where the player did not exist yet (no hitboxes). */
const ABSENT = 2;

export class HitboxHistory {
  /** Number of samples kept (covers HITBOX_HISTORY_MS plus interpolation slack). */
  readonly size: number;
  private readonly times: Float64Array;
  /** Index of the newest sample, -1 while empty. */
  private headIdx = -1;
  private count = 0;
  private readonly data = new Map<number, Float64Array>();

  constructor() {
    this.size = Math.ceil(HITBOX_HISTORY_MS / TICK_MS) + 2;
    this.times = new Float64Array(this.size);
  }

  /** Register a player (all existing slots are marked absent). */
  addPlayer(id: number): void {
    if (this.data.has(id)) return;
    const arr = new Float64Array(this.size * STRIDE);
    for (let i = 0; i < this.size; i++) arr[i * STRIDE + 5] = ABSENT;
    this.data.set(id, arr);
  }

  /** Record the poses of all players at sim time `time` (seconds). */
  record(time: number, players: readonly PlayerState[]): void {
    this.headIdx = (this.headIdx + 1) % this.size;
    if (this.count < this.size) this.count++;
    this.times[this.headIdx] = time;
    const o = this.headIdx * STRIDE;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      let arr = this.data.get(p.id);
      if (!arr) {
        this.addPlayer(p.id);
        arr = this.data.get(p.id)!;
      }
      arr[o] = p.pos.x;
      arr[o + 1] = p.pos.y;
      arr[o + 2] = p.pos.z;
      arr[o + 3] = p.yaw;
      arr[o + 4] = STANCE_IDX[p.stance];
      arr[o + 5] = LIFE_IDX[p.life];
      arr[o + 6] = MODE_IDX[p.mode];
      arr[o + 7] = p.lean;
    }
  }

  /** Newest recorded time, or -Infinity when empty. */
  latestTime(): number {
    return this.headIdx < 0 ? -Infinity : this.times[this.headIdx];
  }

  /**
   * Pose of a player at `time` (interpolated between the bracketing ticks; clamped to the
   * recorded range). Returns false when the player has no history.
   */
  poseAt(id: number, time: number, out: HitboxPose): boolean {
    const arr = this.data.get(id);
    if (!arr || this.count === 0) return false;
    // Walk back from the newest sample to find the bracket [older, newer].
    let newer = this.headIdx;
    let older = newer;
    let found = false;
    for (let k = 0; k < this.count; k++) {
      const idx = (this.headIdx - k + this.size) % this.size;
      if (this.times[idx] <= time) {
        older = idx;
        found = true;
        break;
      }
      newer = idx;
    }
    if (!found) {
      // Older than everything we have: use the oldest sample.
      older = newer;
    }
    const tA = this.times[older], tB = this.times[newer];
    const f = newer === older || tB <= tA ? 0 : Math.min(1, Math.max(0, (time - tA) / (tB - tA)));
    const a = older * STRIDE, b = newer * STRIDE;
    // A player that did not exist in the older slot snaps to the newer one.
    const useB = f >= 0.5 || arr[a + 5] === ABSENT && arr[b + 5] !== ABSENT;
    const lifeSrc = useB ? b : a;
    if (arr[a + 5] === ABSENT && arr[b + 5] === ABSENT) {
      out.life = 'dead';
      out.pos.x = arr[b]; out.pos.y = arr[b + 1]; out.pos.z = arr[b + 2];
      return true;
    }
    // Interpolate only when both samples are present and the body did not teleport (> 20 m).
    const dx = arr[b] - arr[a], dy = arr[b + 1] - arr[a + 1], dz = arr[b + 2] - arr[a + 2];
    const lerpOk = arr[a + 5] !== ABSENT && dx * dx + dy * dy + dz * dz < 400;
    if (lerpOk) {
      out.pos.x = arr[a] + dx * f;
      out.pos.y = arr[a + 1] + dy * f;
      out.pos.z = arr[a + 2] + dz * f;
      out.yaw = lerpAngle(arr[a + 3], arr[b + 3], f);
    } else {
      const s = useB ? b : a;
      out.pos.x = arr[s]; out.pos.y = arr[s + 1]; out.pos.z = arr[s + 2];
      out.yaw = arr[s + 3];
    }
    out.stance = STANCES[arr[lifeSrc + 4] | 0];
    out.life = LIVES[arr[lifeSrc + 5] | 0];
    out.mode = MODES[arr[lifeSrc + 6] | 0];
    out.lean = arr[lifeSrc + 7];
    return true;
  }
}

/** Fresh scratch pose. */
export function createPose(): HitboxPose {
  return { pos: { x: 0, y: 0, z: 0 }, yaw: 0, stance: 'stand', life: 'alive', mode: 'ground', lean: 0 };
}

/** Floats per vehicle sample: x, y, z, yaw, pitch, roll, present. */
const VSTRIDE = 7;

/**
 * Vehicle hull poses per tick, so shots test hulls where the shooter saw them (same rewind as the
 * player hitboxes). Interpolated between ticks; angles via shortest-arc lerp.
 */
export class VehicleHistory {
  readonly size: number;
  private readonly times: Float64Array;
  private headIdx = -1;
  private count = 0;
  private readonly data = new Map<number, Float64Array>();

  constructor() {
    this.size = Math.ceil(HITBOX_HISTORY_MS / TICK_MS) + 2;
    this.times = new Float64Array(this.size);
  }

  record(time: number, vehicles: readonly VehicleState[]): void {
    this.headIdx = (this.headIdx + 1) % this.size;
    if (this.count < this.size) this.count++;
    this.times[this.headIdx] = time;
    const o = this.headIdx * VSTRIDE;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      let arr = this.data.get(v.id);
      if (!arr) {
        arr = new Float64Array(this.size * VSTRIDE);
        this.data.set(v.id, arr);
      }
      arr[o] = v.pos.x;
      arr[o + 1] = v.pos.y;
      arr[o + 2] = v.pos.z;
      arr[o + 3] = v.yaw;
      arr[o + 4] = v.pitch;
      arr[o + 5] = v.roll;
      arr[o + 6] = 1;
    }
  }

  /**
   * Write the pose of `v` at `time` into `out` (type / id copied from `v`). Falls back to the
   * current pose when there is no history.
   */
  poseAt(v: VehicleState, time: number, out: VehicleState): VehicleState {
    out.id = v.id;
    out.type = v.type;
    const arr = this.data.get(v.id);
    if (!arr || this.count === 0) {
      out.pos.x = v.pos.x; out.pos.y = v.pos.y; out.pos.z = v.pos.z;
      out.yaw = v.yaw; out.pitch = v.pitch; out.roll = v.roll;
      return out;
    }
    let newer = this.headIdx;
    let older = newer;
    let found = false;
    for (let k = 0; k < this.count; k++) {
      const idx = (this.headIdx - k + this.size) % this.size;
      if (this.times[idx] <= time) {
        older = idx;
        found = true;
        break;
      }
      newer = idx;
    }
    if (!found) older = newer;
    const a = older * VSTRIDE, b = newer * VSTRIDE;
    if (arr[a + 6] === 0 || arr[b + 6] === 0) {
      const s = arr[b + 6] !== 0 ? b : a;
      if (arr[s + 6] === 0) {
        out.pos.x = v.pos.x; out.pos.y = v.pos.y; out.pos.z = v.pos.z;
        out.yaw = v.yaw; out.pitch = v.pitch; out.roll = v.roll;
        return out;
      }
      out.pos.x = arr[s]; out.pos.y = arr[s + 1]; out.pos.z = arr[s + 2];
      out.yaw = arr[s + 3]; out.pitch = arr[s + 4]; out.roll = arr[s + 5];
      return out;
    }
    const tA = this.times[older], tB = this.times[newer];
    const f = newer === older || tB <= tA ? 0 : Math.min(1, Math.max(0, (time - tA) / (tB - tA)));
    out.pos.x = arr[a] + (arr[b] - arr[a]) * f;
    out.pos.y = arr[a + 1] + (arr[b + 1] - arr[a + 1]) * f;
    out.pos.z = arr[a + 2] + (arr[b + 2] - arr[a + 2]) * f;
    out.yaw = lerpAngle(arr[a + 3], arr[b + 3], f);
    out.pitch = lerpAngle(arr[a + 4], arr[b + 4], f);
    out.roll = lerpAngle(arr[a + 5], arr[b + 5], f);
    return out;
  }
}

/** Scratch VehicleState used as the rewound "ghost" hull in traces. */
export function createGhostVehicle(): VehicleState {
  return {
    id: -1, type: 'buggy', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0,
    yawRate: 0, speed: 0, steer: 0, throttle: 0, rpm: 0, health: 1, fuel: 0, seats: [], onGround: true,
    destroyed: false, burnTimer: 0, lastDriver: null,
  };
}
