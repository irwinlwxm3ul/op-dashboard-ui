// FX renderer: turns game events and per-frame state into tracers, bullet streaks, muzzle
// flashes, impacts, blood, explosions, frags, casings, dust and splashes.
//
// Events from the bus are queued (no work in the callbacks) and processed in update(), which the
// app calls after the view rig positioned the camera, so the local player's tracers can start at
// the first-person muzzle of this very frame (see muzzle.ts `localMuzzle`). Every system is
// pooled; per-frame work allocates nothing.

import * as THREE from 'three';
import { raycastWorld } from '../../../shared/physics';
import { WEAPONS, isWeaponId } from '../../../shared/items';
import type { EntityId, MovementMode, RayHit, Vec3, World } from '../../../shared/types';
import type { CameraState, FxRenderer, RenderCore } from '../contracts';
import type { ClientEvent, ClientEventBus, ClientEventOf, FrameState, Quality } from '../../game/types';
import { BulletStreaks } from './bullets';
import { CasingPool, type CasingKind } from './casings';
import { DecalSystem } from './decals';
import { EffectRecipes, type ImpactMaterial } from './effects';
import { FragRenderer } from './frags';
import { FlashLights } from './lights';
import { approxMuzzle, localMuzzle } from './muzzle';
import { ParticleSystem } from './particles';
import { releaseAtlases, retainAtlases } from './textures';
import { TracerSystem, type TracerStyle } from './tracers';

/** Effects beyond this distance are skipped (tracers and explosions excepted). */
const CULL_DIST = 400;
/** Decals only near the camera. */
const DECAL_DIST = 140;
/** Third-person casings only near the camera. */
const CASING_DIST = 22;

interface QualityPreset {
  alphaCap: number;
  addCap: number;
  decals: number;
  mul: number;
  lights: number;
  muzzleLights: boolean;
  casings: boolean;
  trails: boolean;
}

const PRESETS: Record<Quality, QualityPreset> = {
  low: { alphaCap: 900, addCap: 600, decals: 60, mul: 0.45, lights: 0, muzzleLights: false, casings: false, trails: false },
  medium: { alphaCap: 1800, addCap: 1200, decals: 120, mul: 0.75, lights: 1, muzzleLights: false, casings: true, trails: true },
  high: { alphaCap: 3200, addCap: 2000, decals: 200, mul: 1, lights: 3, muzzleLights: true, casings: true, trails: true },
  ultra: { alphaCap: 4500, addCap: 2800, decals: 220, mul: 1.25, lights: 4, muzzleLights: true, casings: true, trails: true },
};

const TRACER_REMOTE: TracerStyle = { r: 3.0, g: 2.1, b: 1.0, alpha: 0.9, width: 0.028, minPx: 1.6, length: 9 };
const TRACER_LOCAL: TracerStyle = { r: 2.6, g: 1.9, b: 0.95, alpha: 0.55, width: 0.018, minPx: 1.2, length: 7 };
const TRACER_PELLET: TracerStyle = { r: 2.4, g: 1.7, b: 0.85, alpha: 0.5, width: 0.014, minPx: 1.0, length: 4 };

const CASING_OF: Record<string, CasingKind> = {
  pistol: 'pistol', smg: 'pistol', ar: 'rifle', dmr: 'rifle', shotgun: 'shotgun', sniper: 'sniper',
};

/** Damage sources that should not spawn blood at the hit position. */
const NO_BLOOD = new Set(['zone', 'bleed', 'drown', 'fall']);

interface PlayerTrack {
  mode: MovementMode;
  seen: number;
}

interface RecentFx {
  x: number; y: number; z: number;
  t: number;
}

export class FxRendererImpl implements FxRenderer {
  private readonly group = new THREE.Group();
  private readonly alpha: ParticleSystem;
  private readonly add: ParticleSystem;
  private readonly decals: DecalSystem;
  private readonly tracers: TracerSystem;
  private readonly lights: FlashLights;
  private readonly casings: CasingPool;
  private readonly frags: FragRenderer;
  private readonly effects: EffectRecipes;
  private readonly bullets: BulletStreaks;
  private readonly unsubs: (() => void)[] = [];
  private readonly queue: ClientEvent[] = [];
  private quality: Quality;
  private preset: QualityPreset;
  private time = 0;
  private frameNo = 0;
  private readonly tracks = new Map<EntityId, PlayerTrack>();
  private readonly trackPool: PlayerTrack[] = [];
  /** Recent blood / explosion positions for de-duplicating overlapping events. */
  private readonly recentBlood: RecentFx[] = [];
  private bloodIdx = 0;
  private readonly recentBlasts: RecentFx[] = [];
  private blastIdx = 0;
  // Scratch
  private readonly hit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, kind: 'terrain', material: 'grass' };
  private readonly muzzle: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly bufSize = new THREE.Vector2();
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private disposed = false;

  constructor(private readonly core: RenderCore, private readonly world: World, events: ClientEventBus) {
    retainAtlases();
    this.quality = core.quality;
    this.preset = PRESETS[this.quality];
    this.group.name = 'fx';
    this.alpha = new ParticleSystem(PRESETS.ultra.alphaCap, false, 2);
    this.add = new ParticleSystem(PRESETS.ultra.addCap, true, 3);
    this.decals = new DecalSystem(PRESETS.ultra.decals);
    this.tracers = new TracerSystem();
    this.lights = new FlashLights(this.preset.lights);
    this.casings = new CasingPool(world, 64);
    this.frags = new FragRenderer();
    this.effects = new EffectRecipes(world, this.alpha, this.add, this.decals, this.lights);
    this.bullets = new BulletStreaks(world);
    this.group.add(
      this.decals.mesh, this.alpha.mesh, this.add.mesh, this.tracers.mesh, this.effects.rings.group,
      this.lights.group, this.casings.mesh, this.frags.mesh,
    );
    core.scene.add(this.group);
    this.applyQuality();
    for (let i = 0; i < 16; i++) this.recentBlood.push({ x: 0, y: -1e9, z: 0, t: -1e9 });
    for (let i = 0; i < 8; i++) this.recentBlasts.push({ x: 0, y: -1e9, z: 0, t: -1e9 });

    const enqueue = (ev: ClientEvent) => { this.queue.push(ev); };
    for (const type of ['shot', 'localShot', 'impact', 'hit', 'explosion', 'vehicleDestroyed', 'land', 'localLand', 'chuteOpen'] as const) {
      this.unsubs.push(events.on(type, enqueue));
    }
  }

  update(frame: FrameState, cam: CameraState, dt: number): void {
    if (this.disposed) return;
    this.frameNo++;
    this.time += dt;
    this.camX = cam.pos.x; this.camY = cam.pos.y; this.camZ = cam.pos.z;
    if (this.core.quality !== this.quality) {
      this.quality = this.core.quality;
      this.preset = PRESETS[this.quality];
      this.applyQuality();
    }

    // Moving tracers advance before new ones are fired this frame so a new tracer starts at the muzzle.
    this.core.renderer.getDrawingBufferSize(this.bufSize);
    const pixelAngle = (2 * Math.tan((this.core.camera.fov * Math.PI) / 360)) / Math.max(1, this.bufSize.y);
    this.tracers.begin(dt, pixelAngle);

    for (let i = 0; i < this.queue.length; i++) this.handle(this.queue[i], frame);
    this.queue.length = 0;

    this.trackWaterEntries(frame);
    this.bullets.update(frame, dt, this.tracers);
    this.tracers.end();

    this.alpha.update(dt);
    this.add.update(dt);
    this.decals.update(dt);
    this.lights.update(dt);
    this.casings.update(dt);
    this.effects.update(dt);
    this.frags.update(frame.projectiles, dt, this.effects, this.preset.trails);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.queue.length = 0;
    this.core.scene.remove(this.group);
    this.alpha.dispose();
    this.add.dispose();
    this.decals.dispose();
    this.tracers.dispose();
    this.lights.dispose();
    this.casings.dispose();
    this.frags.dispose();
    this.effects.dispose();
    this.bullets.clear();
    releaseAtlases();
  }

  // -----------------------------------------------------------------------------------------------

  private applyQuality(): void {
    const p = this.preset;
    this.alpha.setCap(p.alphaCap);
    this.add.setCap(p.addCap);
    this.decals.setRing(p.decals);
    this.effects.quality = p.mul;
    this.effects.muzzleLights = p.muzzleLights && this.lights.size > 0;
  }

  private distTo(p: Vec3): number {
    return Math.hypot(p.x - this.camX, p.y - this.camY, p.z - this.camZ);
  }

  /** Particle count multiplier by distance (1 near, 0.35 far). */
  private lod(d: number): number {
    return d < 40 ? 1 : d < 150 ? 0.75 : d < 260 ? 0.5 : 0.35;
  }

  private handle(ev: ClientEvent, frame: FrameState): void {
    switch (ev.type) {
      case 'shot': this.onShot(ev, frame); break;
      case 'localShot': this.onLocalShot(ev, frame); break;
      case 'impact': this.onImpact(ev); break;
      case 'hit': this.onHit(ev); break;
      case 'explosion': this.onExplosion(ev.pos, ev.radius, ev.source === 'vehicle'); break;
      case 'vehicleDestroyed': this.onExplosion(ev.pos, 6, true); break;
      case 'land': {
        if (ev.player === frame.localId) break; // local landing comes from localLand (predicted)
        const p = frame.players.get(ev.player);
        if (!p) break;
        const d = this.distTo(p.pos);
        if (d < 150) this.effects.landingDust(p.pos.x, p.pos.y, p.pos.z, ev.speed, this.lod(d));
        break;
      }
      case 'localLand': {
        const s = frame.self;
        if (s && s.mode !== 'swim' && !s.inWater) this.effects.landingDust(s.pos.x, s.pos.y, s.pos.z, ev.speed, 1);
        break;
      }
      case 'chuteOpen': {
        const p = frame.players.get(ev.player);
        if (!p) break;
        const d = this.distTo(p.pos);
        if (d < CULL_DIST) this.effects.chutePuff(p.pos.x, p.pos.y + 4.6, p.pos.z, this.lod(d));
        break;
      }
      default:
        break;
    }
  }

  private onShot(ev: ClientEventOf<'shot'>, frame: FrameState): void {
    // The local shooter's shots were already drawn from the predicted localShot.
    if (ev.shooter === frame.localId) return;
    const def = WEAPONS[ev.weapon];
    if (!def) return;
    const shooter = frame.players.get(ev.shooter);
    const m = this.muzzle;
    if (shooter && shooter.life !== 'dead') {
      approxMuzzle(shooter.pos, shooter.yaw, shooter.pitch, shooter.stance, shooter.mode, shooter.flags, ev.weapon, m);
      // Interpolated pose and the authoritative origin can disagree; trust the origin if far off.
      if (Math.hypot(m.x - ev.origin.x, m.y - ev.origin.y, m.z - ev.origin.z) > 3) {
        m.x = ev.origin.x; m.y = ev.origin.y; m.z = ev.origin.z;
      }
    } else {
      m.x = ev.origin.x; m.y = ev.origin.y; m.z = ev.origin.z;
    }
    const d = this.distTo(m);
    const yaw = shooter ? shooter.yaw : 0;
    const pitch = shooter ? shooter.pitch : 0;
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    if (d < CULL_DIST) {
      this.effects.muzzleFlash(m.x, m.y, m.z, fx, fy, fz, ev.weapon, this.lod(d), this.effects.muzzleLights && d < 70);
      if (this.preset.casings && d < CASING_DIST && shooter) this.ejectThirdPerson(ev.weapon, m, yaw, pitch, shooter.vel);
    }
    // Hitscan tracers to every end point (ballistic shots are drawn from projectiles).
    if (def.hitscan && !(ev.projectiles && ev.projectiles.length > 0)) {
      const style = ev.weapon === 'shotgun' ? TRACER_PELLET : TRACER_REMOTE;
      for (const e of ev.ends) {
        const dx = e.x - m.x, dy = e.y - m.y, dz = e.z - m.z;
        const l = Math.hypot(dx, dy, dz);
        if (l < 1) continue;
        this.tracers.fire(m.x, m.y, m.z, dx / l, dy / l, dz / l, def.muzzleVelocity, l, style, 0, 0, 0, 1, 0.4);
      }
    }
  }

  private onLocalShot(ev: ClientEventOf<'localShot'>, frame: FrameState): void {
    const def = WEAPONS[ev.weapon];
    const self = frame.self;
    if (!def || !self) return;
    const m = this.muzzle;
    const vmValid = localMuzzle.viewmodelVisible && performance.now() - localMuzzle.stamp < 250;
    if (vmValid) {
      m.x = localMuzzle.pos.x; m.y = localMuzzle.pos.y; m.z = localMuzzle.pos.z;
    } else {
      // Third person: the local body is visible, draw its flash and casing here.
      const sv = frame.localId !== null ? frame.players.get(frame.localId) : undefined;
      approxMuzzle(self.pos, self.aimYaw, self.aimPitch, self.stance, self.mode, sv ? sv.flags : 0, ev.weapon, m);
      const cp = Math.cos(self.aimPitch);
      this.effects.muzzleFlash(m.x, m.y, m.z, -Math.sin(self.aimYaw) * cp, Math.sin(self.aimPitch), -Math.cos(self.aimYaw) * cp, ev.weapon, 1, false);
      if (this.preset.casings) this.ejectThirdPerson(ev.weapon, m, self.aimYaw, self.aimPitch, self.vel);
    }
    if (this.effects.muzzleLights) this.lights.flash(m.x, m.y, m.z, 0xffb45e, def.pellets > 1 || !def.hitscan ? 40 : 24, 10, 0.06);

    const ox = m.x - ev.origin.x, oy = m.y - ev.origin.y, oz = m.z - ev.origin.z;
    for (const dir of ev.dirs) {
      if (ev.ballistic || !def.hitscan) {
        this.bullets.fireLocal(def, ev.origin, dir, ox, oy, oz);
        continue;
      }
      const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
      this.dir.x = dir.x / l; this.dir.y = dir.y / l; this.dir.z = dir.z / l;
      const h = raycastWorld(this.world, ev.origin, this.dir, def.range, this.hit);
      const dist = h ? h.dist : def.range;
      const style = def.pellets > 1 ? TRACER_PELLET : TRACER_LOCAL;
      // Start a little ahead of the muzzle so the streak never covers the sights.
      this.tracers.fire(ev.origin.x, ev.origin.y, ev.origin.z, this.dir.x, this.dir.y, this.dir.z,
        def.muzzleVelocity, dist, style, ox, oy, oz, Math.min(30, dist * 0.6), 1.2);
    }
  }

  private ejectThirdPerson(weapon: string, m: Vec3, yaw: number, pitch: number, vel: Vec3): void {
    const kind = CASING_OF[weapon] ?? 'rifle';
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp, fz = -Math.cos(yaw) * cp;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const back = weapon === 'pistol' ? 0.15 : 0.45;
    const delay = weapon === 'sniper' ? 0.45 : weapon === 'shotgun' ? 0.3 : 0;
    const side = 1.4 + Math.random() * 0.8;
    this.casings.eject(
      kind,
      m.x - fx * back + rx * 0.04, m.y + 0.03, m.z - fz * back + rz * 0.04,
      vel.x + rx * side - fx * 0.3, vel.y + 1.2 + Math.random() * 0.6, vel.z + rz * side - fz * 0.3,
      delay,
    );
  }

  private onImpact(ev: ClientEventOf<'impact'>): void {
    const d = this.distTo(ev.pos);
    if (d > CULL_DIST) return;
    const mat = ev.material as ImpactMaterial;
    if (mat === 'flesh' || mat === 'armor') {
      if (this.recentlyNear(this.recentBlood, ev.pos, 0.6, 0.2)) return;
      this.remember(this.recentBlood, ev.pos, true);
    }
    const n = ev.normal;
    this.effects.impact(ev.pos.x, ev.pos.y, ev.pos.z, n.x, n.y, n.z, mat, ev.weapon, this.lod(d), d < DECAL_DIST);
  }

  private onHit(ev: ClientEventOf<'hit'>): void {
    if (NO_BLOOD.has(ev.source)) return;
    const d = this.distTo(ev.pos);
    if (d > CULL_DIST) return;
    if (this.recentlyNear(this.recentBlood, ev.pos, 0.6, 0.2)) return;
    this.remember(this.recentBlood, ev.pos, true);
    // Direction the bullet travelled (attacker -> victim).
    let dx = ev.pos.x - ev.from.x, dy = ev.pos.y - ev.from.y, dz = ev.pos.z - ev.from.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    if (ev.armor) {
      this.effects.armorSpark(ev.pos.x, ev.pos.y, ev.pos.z, -dx, -dy, -dz, this.lod(d));
    } else {
      const k = isWeaponId(ev.source) ? (ev.source === 'sniper' ? 1.6 : ev.source === 'shotgun' ? 0.7 : 1) : 1.2;
      this.effects.blood(ev.pos.x, ev.pos.y, ev.pos.z, dx, dy, dz, k, this.lod(d));
    }
  }

  private onExplosion(pos: Vec3, radius: number, vehicle: boolean): void {
    if (this.recentlyNear(this.recentBlasts, pos, 3, 0.4)) return;
    this.remember(this.recentBlasts, pos, false);
    const d = this.distTo(pos);
    this.effects.explosion(pos.x, pos.y, pos.z, radius, vehicle, this.lod(d));
  }

  private recentlyNear(list: RecentFx[], p: Vec3, r: number, window: number): boolean {
    for (const e of list) {
      if (this.time - e.t > window) continue;
      const dx = e.x - p.x, dy = e.y - p.y, dz = e.z - p.z;
      if (dx * dx + dy * dy + dz * dz < r * r) return true;
    }
    return false;
  }

  private remember(list: RecentFx[], p: Vec3, blood: boolean): void {
    const i = blood ? (this.bloodIdx = (this.bloodIdx + 1) % list.length) : (this.blastIdx = (this.blastIdx + 1) % list.length);
    const e = list[i];
    e.x = p.x; e.y = p.y; e.z = p.z; e.t = this.time;
  }

  /** Splash when a player transitions into swimming (dropping or wading into deep water). */
  private trackWaterEntries(frame: FrameState): void {
    const wl = this.world.waterLevel;
    for (const p of frame.players.values()) {
      let tr = this.tracks.get(p.id);
      if (!tr) {
        tr = this.trackPool.pop() ?? { mode: p.mode, seen: 0 };
        tr.mode = p.mode;
        this.tracks.set(p.id, tr);
      }
      tr.seen = this.frameNo;
      if (p.mode === 'swim' && tr.mode !== 'swim' && p.life !== 'dead') {
        const d = this.distTo(p.pos);
        if (d < CULL_DIST) {
          const fall = Math.abs(p.vel.y);
          const strength = tr.mode === 'freefall' || tr.mode === 'parachute' ? Math.min(3, 0.8 + fall / 5) : Math.min(2, 0.6 + fall / 6);
          this.effects.waterSplash(p.pos.x, wl, p.pos.z, strength, this.lod(d));
        }
      }
      tr.mode = p.mode;
    }
    if (this.tracks.size > frame.players.size) this.tracks.forEach(this.sweepTracks);
  }

  private readonly sweepTracks = (tr: PlayerTrack, id: EntityId): void => {
    if (tr.seen !== this.frameNo) {
      this.tracks.delete(id);
      this.trackPool.push(tr);
    }
  };
}

export function createFx(core: RenderCore, world: World, events: ClientEventBus): FxRenderer {
  return new FxRendererImpl(core, world, events);
}
