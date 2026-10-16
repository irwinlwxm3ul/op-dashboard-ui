// Lag compensation: a ring buffer of every player's hitbox pose per tick (HITBOX_HISTORY_MS).
// Poses are interpolated between ticks so a shot can be tested against exactly what the shooter
// saw at their render time (clamped to MAX_REWIND_MS by the caller).

import { HITBOX_HISTORY_MS, TICK_MS } from '../constants';
import { lerpAngle } from '../math';
import type { HitboxPose } from '../physics';
import type { LifeState, MovementMode, PlayerState, Stance } from '../types';

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
