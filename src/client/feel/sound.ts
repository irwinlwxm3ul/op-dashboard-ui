// Sound routing: turns client/game events and per-frame state into calls on the `audio` engine.
// Everything audible in a match goes through here (gunshots, near misses, impacts, explosions,
// footsteps, reload phases, vehicle engines, wind, zone hum). The engine itself handles spatial
// panning, distance delay and muffling; this module decides *what* plays *when*, rate-limits
// bursts and keeps per-entity loop handles (engines) in sync with the world.

import { FREEFALL_DIVE_SPEED, MOVE_SPEED, SUPPRESSION_RADIUS } from '../../shared/constants';
import { distSq } from '../../shared/math';
import { PF } from '../../shared/protocol';
import { WEAPONS } from '../../shared/items';
import type {
  EntityId, MovementMode, SurfaceMaterial, Vec3, WeaponId, WeaponSoundKind, World, WorldBox,
} from '../../shared/types';
import { audio } from '../audio';
import type { FrameState, PlayerView, VehicleView } from '../game/types';
import type { CameraState } from '../render/contracts';
import { closestOnSegment } from './math';

type ReloadPhase = Parameters<typeof audio.reload>[1];
type EngineHandle = ReturnType<typeof audio.engine>;

/** Remote footsteps are only simulated within this distance of the listener (m). */
const FOOTSTEP_RANGE = 40;
/** Vehicle engine loops exist only within this distance of the listener (m). */
const ENGINE_RANGE = 250;
/** Impacts farther than this are not worth a voice (m). */
const IMPACT_RANGE = 220;
/** Impact token bucket: sustained rate (per second) and burst size. */
const IMPACT_RATE = 28;
const IMPACT_BURST = 8;
/** Two explosion events closer than this in space (m) and time (s) are the same blast. */
const EXPLOSION_DEDUP_DIST = 4;
const EXPLOSION_DEDUP_TIME = 0.3;
/** A near-miss only counts when the shooter is at least this far away (otherwise you hear the shot itself). */
const NEAR_MISS_MIN_ORIGIN = SUPPRESSION_RADIUS * 2;
/** Max remote footsteps triggered per frame (squads moving together). */
const MAX_STEPS_PER_FRAME = 6;

interface ScheduledSound {
  at: number;
  kind: WeaponSoundKind;
  phase: ReloadPhase;
  /** 'reload' entries are cancelled by firing / switching; 'cycle' (bolt / pump after a shot) only by switching. */
  group: 'reload' | 'cycle';
  local: boolean;
}

interface StepTrack {
  acc: number;
  seen: number;
}

interface EngineTrack {
  handle: EngineHandle;
  lastSpeed: number;
  accel: number;
  seen: number;
}

interface ProjectileTrack {
  x: number;
  y: number;
  z: number;
  cracked: boolean;
  seen: number;
}

interface RecentImpact {
  x: number;
  y: number;
  z: number;
  t: number;
  material: string;
}

/** Called for every near miss (bullet passing close to the listener's head). */
export type NearMissHandler = (pos: Vec3) => void;

export class SoundRouter {
  private now = 0;
  private frameNo = 0;

  /** Listener (camera) position for spatial culling. */
  private readonly listener: Vec3 = { x: 0, y: 0, z: 0 };
  /** The local player's head (near-miss tests); falls back to the listener. */
  private readonly head: Vec3 = { x: 0, y: 0, z: 0 };
  private hasListener = false;

  private readonly pending: ScheduledSound[] = [];
  private readonly spare: ScheduledSound[] = [];
  private localReloadStarted = -1;

  private readonly steps = new Map<EntityId, StepTrack>();
  private readonly engines = new Map<EntityId, EngineTrack>();
  private readonly projectiles = new Map<EntityId, ProjectileTrack>();
  private readonly spareProjectiles: ProjectileTrack[] = [];

  private impactTokens = IMPACT_BURST;
  private readonly recentImpacts: RecentImpact[] = [];
  private recentImpactIdx = 0;
  private readonly recentExplosions: { x: number; y: number; z: number; t: number }[] = [];

  private wind = 0;
  private zoneOutside = false;
  private zoneIntensity = 0;

  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratch2: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly boxScratch: WorldBox[] = [];

  constructor(private readonly onNearMiss: NearMissHandler) {
    for (let i = 0; i < 8; i++) this.recentImpacts.push({ x: 0, y: 0, z: 0, t: -1, material: '' });
    for (let i = 0; i < 4; i++) this.recentExplosions.push({ x: 0, y: 0, z: 0, t: -1 });
  }

  // ---------------------------------------------------------------------------
  // Weapons
  // ---------------------------------------------------------------------------

  /** Locally predicted shot: instant, un-delayed gunshot plus the bolt / pump cycle afterwards. */
  localShot(weapon: WeaponId, origin: Vec3): void {
    const def = WEAPONS[weapon];
    audio.gunshot(def.sound, origin, true);
    // Firing interrupts a (shell-by-shell) reload.
    this.cancel(true, 'reload');
    this.scheduleCycle(weapon, true);
  }

  /**
   * Server-confirmed shot by someone else. `asLocal` renders it like a local shot (the player we
   * are spectating). Returns nothing; near misses are reported through `onNearMiss`.
   */
  remoteShot(weapon: WeaponId, origin: Vec3, ends: readonly Vec3[], asLocal: boolean): void {
    const def = WEAPONS[weapon];
    audio.gunshot(def.sound, origin, asLocal);
    if (asLocal) this.scheduleCycle(weapon, false);
    if (!this.hasListener || ends.length === 0) return;
    const r2 = SUPPRESSION_RADIUS * SUPPRESSION_RADIUS;
    if (distSq(origin, this.head) < NEAR_MISS_MIN_ORIGIN * NEAR_MISS_MIN_ORIGIN) return;
    // One crack per shot event (shotgun pellets share it), at the closest pass.
    let best = r2;
    let found = false;
    for (let i = 0; i < ends.length; i++) {
      const t = closestOnSegment(origin, ends[i], this.head, this.scratch);
      if (t <= 0) continue;
      const d2 = distSq(this.scratch, this.head);
      if (d2 < best) {
        best = d2;
        found = true;
        this.scratch2.x = this.scratch.x;
        this.scratch2.y = this.scratch.y;
        this.scratch2.z = this.scratch.z;
      }
    }
    if (found) this.nearMiss(this.scratch2);
  }

  /**
   * Reload phase sounds over the reload duration: mag out at 20 %, mag in at 70 %, bolt at the end
   * for empty reloads. Shell-by-shell weapons follow the predicted timeline (client-net / sim): an
   * empty tube first spends the extra empty time racking the action, then one shell per
   * `reloadPerShell` until full or out of reserve. `mag` is the magazine count when the reload
   * started, `reserve` the rounds available (Infinity when unknown or infinite).
   */
  reload(weapon: WeaponId, empty: boolean, mag: number, reserve: number, local: boolean): void {
    const def = WEAPONS[weapon];
    this.cancel(local, 'reload');
    if (local) this.localReloadStarted = this.now;
    const kind = def.sound;
    if (def.reloadPerShell !== undefined && def.reloadPerShell > 0) {
      const missing = def.magSize - Math.max(0, Math.min(def.magSize, empty ? 0 : mag));
      const shells = Math.max(1, Math.min(missing, reserve));
      const rack = empty ? Math.max(0, def.reloadEmptyTime - def.reloadTime) : 0;
      if (empty) this.schedule(rack * 0.45, kind, 'bolt', 'reload', local);
      for (let i = 0; i < shells; i++) this.schedule(rack + (i + 0.7) * def.reloadPerShell, kind, 'shell', 'reload', local);
      return;
    }
    const total = empty ? def.reloadEmptyTime : def.reloadTime;
    this.schedule(total * 0.2, kind, 'out', 'reload', local);
    this.schedule(total * 0.7, kind, 'in', 'reload', local);
    if (empty) this.schedule(total * 0.88, kind, 'bolt', 'reload', local);
  }

  /** Cancels pending weapon-handling sounds (reload phases and/or bolt cycles) of one owner. */
  cancel(local: boolean, group: 'reload' | 'cycle' | 'all'): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i];
      if (s.local !== local || (group !== 'all' && s.group !== group)) continue;
      this.pending[i] = this.pending[this.pending.length - 1];
      this.pending.pop();
      this.spare.push(s);
    }
    if (local && group !== 'cycle') this.localReloadStarted = -1;
  }

  private scheduleCycle(weapon: WeaponId, local: boolean): void {
    const def = WEAPONS[weapon];
    if (def.fireMode !== 'bolt' && def.fireMode !== 'pump') return;
    const cycle = 60 / def.rpm;
    const at = Math.min(0.6, Math.max(0.22, cycle * 0.33));
    this.schedule(at, def.sound, 'bolt', 'cycle', local);
  }

  private schedule(delay: number, kind: WeaponSoundKind, phase: ReloadPhase, group: 'reload' | 'cycle', local: boolean): void {
    const s = this.spare.pop() ?? { at: 0, kind, phase, group, local };
    s.at = this.now + delay;
    s.kind = kind;
    s.phase = phase;
    s.group = group;
    s.local = local;
    this.pending.push(s);
  }

  // ---------------------------------------------------------------------------
  // World sounds
  // ---------------------------------------------------------------------------

  /** Bullet impact, rate limited (shotgun bursts / sprays) and de-duplicated. */
  impact(material: string, pos: Vec3): void {
    if (this.hasListener && distSq(pos, this.listener) > IMPACT_RANGE * IMPACT_RANGE) return;
    if (this.impactTokens < 1) return;
    for (let i = 0; i < this.recentImpacts.length; i++) {
      const r = this.recentImpacts[i];
      if (r.t >= 0 && this.now - r.t < 0.05 && r.material === material && distSq(r, pos) < 0.36) return;
    }
    this.impactTokens -= 1;
    const slot = this.recentImpacts[this.recentImpactIdx];
    this.recentImpactIdx = (this.recentImpactIdx + 1) % this.recentImpacts.length;
    slot.x = pos.x;
    slot.y = pos.y;
    slot.z = pos.z;
    slot.t = this.now;
    slot.material = material;
    audio.impact(material, pos);
  }

  /**
   * Explosion sound. Returns false when this blast was already played (vehicle explosions can
   * arrive both as `explosion` and `vehicleDestroyed`).
   */
  explosion(pos: Vec3): boolean {
    let oldest = this.recentExplosions[0];
    const d2max = EXPLOSION_DEDUP_DIST * EXPLOSION_DEDUP_DIST;
    for (let i = 0; i < this.recentExplosions.length; i++) {
      const r = this.recentExplosions[i];
      if (r.t >= 0 && this.now - r.t < EXPLOSION_DEDUP_TIME && distSq(r, pos) < d2max) return false;
      if (r.t < oldest.t) oldest = r;
    }
    oldest.x = pos.x;
    oldest.y = pos.y;
    oldest.z = pos.z;
    oldest.t = this.now;
    audio.explosion(pos);
    return true;
  }

  /** Distance from the local head (or listener) to a point; Infinity without a listener. */
  distanceToHead(p: Vec3): number {
    if (!this.hasListener) return Infinity;
    return Math.sqrt(distSq(p, this.head));
  }

  private nearMiss(p: Vec3): void {
    audio.bulletCrack(p);
    this.onNearMiss(p);
  }

  // ---------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------

  /**
   * Start of a frame (before events are routed): advances the clock and updates the listener so
   * event handlers cull / measure against the current camera.
   */
  begin(frame: FrameState, cam: CameraState | null, dt: number): void {
    this.now += dt;
    this.frameNo++;
    const self = frame.self;

    // ---- Listener ----
    if (cam) {
      audio.setListener(cam.pos, cam.yaw, cam.pitch);
      copyInto(this.listener, cam.pos);
      this.hasListener = true;
    } else if (self) {
      audio.setListener(self.eye, self.aimYaw, self.aimPitch);
      copyInto(this.listener, self.eye);
      this.hasListener = true;
    }
    if (self && self.life !== 'dead') copyInto(this.head, self.eye);
    else copyInto(this.head, this.listener);

    this.impactTokens = Math.min(IMPACT_BURST, this.impactTokens + IMPACT_RATE * dt);
  }

  /** End of a frame (after events): scheduled sounds, footsteps, engines, loops, engine update. */
  end(frame: FrameState, dt: number): void {
    const self = frame.self;

    // ---- Scheduled weapon-handling sounds ----
    // A local reload that the prediction aborted (sprint, slot switch, ...) drops its later phases.
    if (this.localReloadStarted >= 0 && self && self.reloadProgress < 0 && this.now - this.localReloadStarted > 0.2) {
      this.dropFutureLocalReload();
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i];
      if (s.at > this.now) continue;
      audio.reload(s.kind, s.phase);
      this.pending[i] = this.pending[this.pending.length - 1];
      this.pending.pop();
      this.spare.push(s);
    }

    if (this.hasListener) {
      this.updateFootsteps(frame, dt);
      this.updateEngines(frame, dt);
      this.updateProjectiles(frame);
    }
    this.updateWind(frame);
    this.updateZone(frame);
    audio.update(dt);
  }

  private dropFutureLocalReload(): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i];
      if (!s.local || s.group !== 'reload' || s.at <= this.now + 0.12) continue;
      this.pending[i] = this.pending[this.pending.length - 1];
      this.pending.pop();
      this.spare.push(s);
    }
    this.localReloadStarted = -1;
  }

  /** Remote footsteps derived from interpolated movement (stride accumulator per player). */
  private updateFootsteps(frame: FrameState, dt: number): void {
    const range2 = FOOTSTEP_RANGE * FOOTSTEP_RANGE;
    let budget = MAX_STEPS_PER_FRAME;
    for (const p of frame.players.values()) {
      if (p.isSelf || p.life === 'dead' || p.vehicleId !== null) continue;
      const swim = p.mode === 'swim';
      if (!swim && (p.mode !== 'ground' || (p.flags & PF.ON_GROUND) === 0)) continue;
      if (distSq(p.pos, this.listener) > range2) continue;
      let track = this.steps.get(p.id);
      if (!track) {
        track = { acc: 0, seen: 0 };
        this.steps.set(p.id, track);
      }
      track.seen = this.frameNo;
      const speed = Math.hypot(p.vel.x, p.vel.z);
      const gait = footGait(p, speed, swim);
      if (speed < 0.5) {
        // Primed so the first step lands soon after the player starts moving.
        track.acc = gait.stride * 0.6;
        continue;
      }
      track.acc += speed * dt;
      if (track.acc < gait.stride) continue;
      track.acc -= gait.stride;
      if (track.acc > gait.stride) track.acc = 0;
      if (budget-- <= 0) continue;
      const material = swim ? 'water' : surfaceUnder(frame.world, p.pos, this.boxScratch);
      audio.footstep(material, p.pos, false, gait.intensity);
    }
    // Forget players that left range / the match (sweep a few times per second is plenty).
    if ((this.frameNo & 31) === 0) {
      for (const [id, t] of this.steps) if (this.frameNo - t.seen > 32) this.steps.delete(id);
    }
  }

  /** One engine loop per running vehicle near the listener. */
  private updateEngines(frame: FrameState, dt: number): void {
    const range2 = ENGINE_RANGE * ENGINE_RANGE;
    const localVehicle = frame.self?.vehicleId ?? null;
    for (const v of frame.vehicles.values()) {
      if (!vehicleRunning(v) || distSq(v.pos, this.listener) > range2) continue;
      let track = this.engines.get(v.id);
      if (!track) {
        track = { handle: audio.engine(v.id), lastSpeed: Math.abs(v.speed), accel: 0, seen: 0 };
        this.engines.set(v.id, track);
      }
      track.seen = this.frameNo;
      const speed = Math.abs(v.speed);
      if (dt > 0) {
        const a = (speed - track.lastSpeed) / dt;
        track.accel += (a - track.accel) * Math.min(1, dt * 6);
      }
      track.lastSpeed = speed;
      // No throttle input reaches the client for other drivers: estimate it from speed and acceleration.
      const throttle = Math.min(1, (Math.min(1, speed / 22) * 0.55) + Math.max(0, Math.min(1, track.accel / 5)) * 0.45);
      track.handle.update(v.pos, v.rpm, throttle, v.id === localVehicle);
    }
    for (const [id, t] of this.engines) {
      if (t.seen === this.frameNo) continue;
      t.handle.stop();
      this.engines.delete(id);
    }
  }

  /** Near misses of ballistic projectiles (DMR / sniper rounds have no hitscan end points). */
  private updateProjectiles(frame: FrameState): void {
    const localId = frame.localId;
    const r2 = SUPPRESSION_RADIUS * SUPPRESSION_RADIUS;
    for (const p of frame.projectiles.values()) {
      if (p.kind !== 'bullet' || p.owner === localId) continue;
      let track = this.projectiles.get(p.id);
      if (!track) {
        track = this.spareProjectiles.pop() ?? { x: 0, y: 0, z: 0, cracked: false, seen: 0 };
        track.x = p.pos.x;
        track.y = p.pos.y;
        track.z = p.pos.z;
        track.cracked = false;
        track.seen = this.frameNo;
        this.projectiles.set(p.id, track);
        continue;
      }
      track.seen = this.frameNo;
      if (!track.cracked) {
        const t = closestOnSegment(track, p.pos, this.head, this.scratch);
        if (t > 0 && distSq(this.scratch, this.head) < r2 && distSq(track, this.head) > r2) {
          track.cracked = true;
          this.nearMiss(this.scratch);
        }
      }
      track.x = p.pos.x;
      track.y = p.pos.y;
      track.z = p.pos.z;
    }
    for (const [id, t] of this.projectiles) {
      if (t.seen === this.frameNo) continue;
      this.projectiles.delete(id);
      this.spareProjectiles.push(t);
    }
  }

  /** Freefall / parachute wind (and a little at speed in vehicles / aboard the plane). */
  private updateWind(frame: FrameState): void {
    const subject = viewSubject(frame);
    let w = 0;
    if (subject) {
      const speed = Math.hypot(subject.vel.x, subject.vel.y, subject.vel.z);
      if (subject.mode === 'freefall') w = 0.55 + 0.45 * clamp01((speed - 30) / (FREEFALL_DIVE_SPEED - 30));
      else if (subject.mode === 'parachute') w = 0.2 + 0.2 * clamp01(speed / 15);
      else if (subject.mode === 'plane') w = 0.12;
      else if (subject.mode === 'vehicle') w = 0.35 * clamp01((speed - 10) / 30);
    }
    if (Math.abs(w - this.wind) > 0.01 || (w === 0 && this.wind !== 0)) {
      this.wind = w;
      audio.setWind(w);
    }
  }

  /** Electric hum when outside (or right at the edge of) the safe zone. */
  private updateZone(frame: FrameState): void {
    let outside = false;
    let intensity = 0;
    const subject = viewSubject(frame);
    const z = frame.zone;
    if (
      subject && frame.phase === 'playing' && frame.config.mode !== 'training' &&
      z.stage !== 'pre' && subject.mode !== 'plane' && subject.mode !== 'freefall' && subject.mode !== 'parachute'
    ) {
      const d = Math.hypot(subject.pos.x - z.cx, subject.pos.z - z.cz) - z.r;
      if (d > 0) {
        outside = true;
        intensity = clamp01(0.55 + d / 60);
      } else {
        intensity = 0.5 * clamp01(1 + d / 40);
      }
    }
    if (outside !== this.zoneOutside || Math.abs(intensity - this.zoneIntensity) > 0.01) {
      this.zoneOutside = outside;
      this.zoneIntensity = intensity;
      audio.setZoneProximity(outside, intensity);
    }
  }

  dispose(): void {
    for (const t of this.engines.values()) t.handle.stop();
    this.engines.clear();
    this.steps.clear();
    this.projectiles.clear();
    this.pending.length = 0;
    audio.setWind(0);
    audio.setZoneProximity(false, 0);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function copyInto(o: Vec3, a: Vec3): void {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
}

interface Gait {
  stride: number;
  intensity: number;
}
// Same cadence and loudness as the local player's predicted footsteps (src/client/game), so every
// character sounds alike.
const GAIT_SWIM: Gait = { stride: 1.7, intensity: 0.5 };
const GAIT_CRAWL: Gait = { stride: 0.8, intensity: 0.15 };
const GAIT_CROUCH: Gait = { stride: 1.05, intensity: 0.35 };
const GAIT_SPRINT: Gait = { stride: 2.05, intensity: 1 };
const GAIT_SLOW: Gait = { stride: 1.15, intensity: 0.3 };
const GAIT_WALK: Gait = { stride: 1.6, intensity: 0.65 };
/** Below this horizontal speed (m/s) a walking player counts as slow-walking. */
const SLOW_WALK_SPEED = 3;

function footGait(p: PlayerView, speed: number, swim: boolean): Gait {
  if (swim) return GAIT_SWIM;
  if (p.life === 'downed' || p.stance === 'prone') return GAIT_CRAWL;
  if (p.stance === 'crouch') return GAIT_CROUCH;
  if ((p.flags & PF.SPRINT) !== 0 || speed > MOVE_SPEED.walk + 0.6) return GAIT_SPRINT;
  if (speed < SLOW_WALK_SPEED) return GAIT_SLOW;
  return GAIT_WALK;
}

/**
 * Surface under a standing position: the top of a building floor / prop box when standing on one,
 * shallow water near the waterline, otherwise the terrain surface.
 */
export function surfaceUnder(world: World, pos: Vec3, scratch: WorldBox[]): SurfaceMaterial {
  const ground = world.heightAt(pos.x, pos.z);
  if (pos.y > ground + 0.25) {
    scratch.length = 0;
    world.queryBoxes(pos.x - 0.05, pos.z - 0.05, pos.x + 0.05, pos.z + 0.05, scratch);
    let best: WorldBox | null = null;
    for (let i = 0; i < scratch.length; i++) {
      const b = scratch[i];
      if (pos.x < b.min.x || pos.x > b.max.x || pos.z < b.min.z || pos.z > b.max.z) continue;
      const top = b.max.y;
      if (top > pos.y + 0.3 || top < pos.y - 0.6) continue;
      if (!best || top > best.max.y) best = b;
    }
    scratch.length = 0;
    if (best) return best.material;
  }
  if (pos.y < world.waterLevel + 0.15) return 'water';
  return world.surfaceAt(pos.x, pos.z);
}

function vehicleRunning(v: VehicleView): boolean {
  if (v.destroyed || v.fuel <= 0) return false;
  for (let i = 0; i < v.seats.length; i++) if (v.seats[i] !== null) return true;
  // Unoccupied but still rolling (driver just bailed out): engine keeps idling down.
  return Math.abs(v.speed) > 1;
}

interface Subject {
  pos: Vec3;
  vel: Vec3;
  mode: MovementMode;
}

/** The player whose senses we render: self while alive, the spectated player otherwise. */
function viewSubject(frame: FrameState): Subject | null {
  const self = frame.self;
  if (self && self.life !== 'dead') return self;
  if (frame.viewTargetId !== null) {
    const p = frame.players.get(frame.viewTargetId);
    if (p && p.life !== 'dead') return p;
  }
  return null;
}
