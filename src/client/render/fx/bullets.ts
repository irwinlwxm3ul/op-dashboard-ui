// Ballistic bullet visuals (DMR / sniper): glowing streaks for server projectiles and locally
// predicted projectiles for the local player's own shots.
//
// Local shots are simulated on the client with the shared stepBallistic/launchVelocity (same
// curve as the server) from the moment the trigger is pulled, so the arc and drop are visible
// instantly. The server's copy of the local player's bullets is hidden while predictions are
// live: it is rendered ~100 ms in the past (interpolation delay) and would otherwise appear as a
// second streak trailing behind. A predicted streak ends where it meets the world (raycast per
// frame segment) or the capsule of an enemy as interpolated on this client (which is what lag
// compensation tests against on the server), otherwise after the flight time limit.

import { raycastWorld } from '../../../shared/physics';
import { launchVelocity, stepBallistic } from '../../../shared/items';
import type { EntityId, RayHit, Vec3, WeaponDef, World } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import { segmentHitsPlayer } from './muzzle';
import type { TracerSystem } from './tracers';

interface LocalBullet {
  active: boolean;
  def: WeaponDef | null;
  pos: Vec3;
  vel: Vec3;
  prev: Vec3;
  /** Visual offset of the muzzle relative to the true origin; converges over CONVERGE m. */
  off: Vec3;
  travelled: number;
  age: number;
  /** >= 0 once the bullet stopped: seconds of fade left. */
  fading: number;
}

interface RemoteStreak {
  fx: number; fy: number; fz: number;
  seen: number;
}

const MAX_LOCAL = 24;
const MAX_FLIGHT = 3;
const CONVERGE = 40;
const FADE = 0.06;
/** Seconds after the last predicted shot during which server copies of own bullets stay hidden. */
const HIDE_OWN_FOR = 3.5;

const STREAK_COLOR = { r: 3.2, g: 2.3, b: 1.25 };

export class BulletStreaks {
  private readonly local: LocalBullet[] = [];
  private readonly remote = new Map<EntityId, RemoteStreak>();
  private readonly remotePool: RemoteStreak[] = [];
  private readonly hit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, kind: 'terrain', material: 'grass' };
  private readonly rayOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly rayDir: Vec3 = { x: 0, y: 0, z: 0 };
  private sinceLocalShot = Infinity;
  private frameNo = 0;

  constructor(private readonly world: World) {
    for (let i = 0; i < MAX_LOCAL; i++) {
      this.local.push({
        active: false, def: null, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, prev: { x: 0, y: 0, z: 0 },
        off: { x: 0, y: 0, z: 0 }, travelled: 0, age: 0, fading: -1,
      });
    }
  }

  /** Start a predicted local bullet from the true origin (eye) along unit dir. */
  fireLocal(def: WeaponDef, origin: Vec3, dir: Vec3, offX: number, offY: number, offZ: number): void {
    let b = this.local.find((l) => !l.active);
    if (!b) {
      // Reuse the oldest.
      b = this.local[0];
      for (const l of this.local) if (l.age > b.age) b = l;
    }
    b.active = true;
    b.def = def;
    b.pos.x = origin.x; b.pos.y = origin.y; b.pos.z = origin.z;
    b.prev.x = origin.x; b.prev.y = origin.y; b.prev.z = origin.z;
    launchVelocity(def, dir, b.vel);
    b.off.x = offX; b.off.y = offY; b.off.z = offZ;
    b.travelled = 0;
    b.age = 0;
    b.fading = -1;
    this.sinceLocalShot = 0;
  }

  update(frame: FrameState, dt: number, tracers: TracerSystem): void {
    this.frameNo++;
    this.sinceLocalShot += dt;
    this.updateLocal(frame, dt, tracers);
    this.updateRemote(frame, tracers);
  }

  clear(): void {
    for (const b of this.local) b.active = false;
    for (const r of this.remote.values()) this.remotePool.push(r);
    this.remote.clear();
  }

  private updateLocal(frame: FrameState, dt: number, tracers: TracerSystem): void {
    for (const b of this.local) {
      if (!b.active || !b.def) continue;
      b.age += dt;
      if (b.fading >= 0) {
        b.fading -= dt;
        if (b.fading <= 0) { b.active = false; continue; }
        this.drawLocal(b, tracers, b.fading / FADE);
        continue;
      }
      if (b.age > MAX_FLIGHT) { b.active = false; continue; }
      b.prev.x = b.pos.x; b.prev.y = b.pos.y; b.prev.z = b.pos.z;
      stepBallistic(b.pos, b.vel, b.def, dt);
      const sx = b.pos.x - b.prev.x, sy = b.pos.y - b.prev.y, sz = b.pos.z - b.prev.z;
      const segLen = Math.hypot(sx, sy, sz);
      if (segLen > 1e-6) {
        const dx = sx / segLen, dy = sy / segLen, dz = sz / segLen;
        let stop = segLen;
        this.rayOrigin.x = b.prev.x; this.rayOrigin.y = b.prev.y; this.rayOrigin.z = b.prev.z;
        this.rayDir.x = dx; this.rayDir.y = dy; this.rayDir.z = dz;
        const h = raycastWorld(this.world, this.rayOrigin, this.rayDir, segLen, this.hit);
        if (h) stop = Math.min(stop, h.dist);
        // Enemy capsules as seen on this client.
        for (const p of frame.players.values()) {
          if (p.isSelf || p.isTeammate || p.life === 'dead' || p.mode === 'plane') continue;
          const t = segmentHitsPlayer(b.prev.x, b.prev.y, b.prev.z, dx, dy, dz, stop, p.pos, p.stance, p.mode, p.life === 'downed');
          if (t >= 0 && t < stop) stop = t;
        }
        if (stop < segLen) {
          b.pos.x = b.prev.x + dx * stop;
          b.pos.y = b.prev.y + dy * stop;
          b.pos.z = b.prev.z + dz * stop;
          b.travelled += stop;
          b.fading = FADE;
          this.drawLocal(b, tracers, 1);
          continue;
        }
        b.travelled += segLen;
      }
      this.drawLocal(b, tracers, 1);
    }
  }

  private drawLocal(b: LocalBullet, tracers: TracerSystem, alpha: number): void {
    const vx = b.vel.x, vy = b.vel.y, vz = b.vel.z;
    const v = Math.hypot(vx, vy, vz) || 1;
    const len = Math.min(b.travelled, streakLength(v));
    if (len < 0.2) return;
    const tailT = b.travelled - len;
    const kHead = Math.max(0, 1 - b.travelled / CONVERGE);
    const kTail = Math.max(0, 1 - tailT / CONVERGE);
    const hx = b.pos.x + b.off.x * kHead, hy = b.pos.y + b.off.y * kHead, hz = b.pos.z + b.off.z * kHead;
    const tx = b.pos.x - (vx / v) * len + b.off.x * kTail;
    const ty = b.pos.y - (vy / v) * len + b.off.y * kTail;
    const tz = b.pos.z - (vz / v) * len + b.off.z * kTail;
    tracers.push(tx, ty, tz, hx, hy, hz, STREAK_COLOR.r, STREAK_COLOR.g, STREAK_COLOR.b, 0.85 * alpha, 0.03, 1.7);
  }

  private updateRemote(frame: FrameState, tracers: TracerSystem): void {
    const hideOwn = this.sinceLocalShot < HIDE_OWN_FOR;
    for (const pr of frame.projectiles.values()) {
      if (pr.kind !== 'bullet') continue;
      if (hideOwn && pr.owner === frame.localId) continue;
      let st = this.remote.get(pr.id);
      if (!st) {
        st = this.remotePool.pop() ?? { fx: 0, fy: 0, fz: 0, seen: 0 };
        st.fx = pr.pos.x; st.fy = pr.pos.y; st.fz = pr.pos.z;
        this.remote.set(pr.id, st);
      }
      st.seen = this.frameNo;
      const vx = pr.vel.x, vy = pr.vel.y, vz = pr.vel.z;
      const v = Math.hypot(vx, vy, vz);
      if (v < 1) continue;
      const flown = Math.hypot(pr.pos.x - st.fx, pr.pos.y - st.fy, pr.pos.z - st.fz);
      // Tail grows from the first sample so a streak never extends behind where it was first seen
      // (but always show a minimum length so a fresh bullet is visible immediately).
      const len = Math.max(Math.min(4, streakLength(v)), Math.min(flown, streakLength(v)));
      tracers.push(
        pr.pos.x - (vx / v) * len, pr.pos.y - (vy / v) * len, pr.pos.z - (vz / v) * len,
        pr.pos.x, pr.pos.y, pr.pos.z,
        STREAK_COLOR.r, STREAK_COLOR.g, STREAK_COLOR.b, 0.85, 0.03, 1.7,
      );
    }
    if (this.remote.size > 0) this.remote.forEach(this.sweep);
  }

  /** Recycle streak state of projectiles that disappeared this frame (bound once, no garbage). */
  private readonly sweep = (st: RemoteStreak, id: EntityId): void => {
    if (st.seen !== this.frameNo) {
      this.remote.delete(id);
      this.remotePool.push(st);
    }
  };
}

/** Visible streak length for a bullet speed: about one 60 Hz frame of travel, clamped. */
export function streakLength(speed: number): number {
  return Math.min(16, Math.max(3, speed / 55));
}
