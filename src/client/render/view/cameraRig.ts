// Camera rig: decides the camera mode from the frame and produces the camera pose.
//
// Modes: on foot TPP (over the right shoulder, collision-aware boom) / FPP at the eye / TPP-ADS
// (switches to the first-person sight view like PUBG) / scope (magnified optic at full ADS, the UI
// draws the overlay); plane chase cam orbiting with the mouse; freefall / parachute third person
// (wider FOV + speed shake in freefall); vehicle chase cam with look-around and auto re-centre
// (driver, non-shooting passengers) or regular TPP/FPP from a shooting seat; spectate (TPP on the
// target's interpolated aim); death orbit around the body before switching to spectate; menu orbit.
//
// The camera always looks along the aim (+ free look) so the crosshair is truthful; cosmetic kick
// and trauma shake from feel are added on top, as are the landing dip, FPP head bob, strafe tilt
// and lean roll. Mode switches blend from the previous pose so nothing snaps.

import { EYE_HEIGHT } from '../../../shared/constants';
import { angleDiff, clamp, damp, dirFromAngles, lerp, lerpAngle, wrapAngle } from '../../../shared/math';
import { raycastWorld } from '../../../shared/physics';
import type { RayHit, Vec3, World } from '../../../shared/types';
import { VEHICLES } from '../../../shared/vehicles';
import type { FrameState, LocalPlayerView, PlayerView } from '../../game/types';
import type { CameraState, CameraViewMode, FeelState } from '../contracts';
import { WEAPONS } from '../../../shared/items';
import { adsZoomMul, sineNoise, smooth01, smoother01, verticalFovFromSetting, zoomFov } from './cameraMath';

/** TPP shoulder boom per stance: back distance, right offset, up offset (m). */
const TPP = {
  stand: { back: 2.6, right: 0.55, up: 0.22 },
  crouch: { back: 2.4, right: 0.55, up: 0.26 },
  prone: { back: 2.15, right: 0.5, up: 0.38 },
} as const;
/** Clearance kept between the camera and geometry (m). */
const CAM_RADIUS = 0.22;
/** Seconds of the slow orbit around the body after death before spectating. */
export const DEATH_ORBIT_SECONDS = 3.5;
/** Mode change blend time (s). */
const BLEND_TIME = 0.42;
const FPP_TOGGLE_TIME = 0.2;
/** Scope overlay appears at this ADS amount. */
const SCOPE_AT = 0.97;
/** TPP crosshair convergence distance limits (m). */
const CONVERGE_MIN = 3;
const CONVERGE_MAX = 150;
/** Collided boom length (m) below which the TPP camera blends into first person. */
const CLOSE_FPP_MIN = 0.4;
const CLOSE_FPP_MAX = 0.75;

type Category = 'foot' | 'vehicle' | 'plane' | 'drop' | 'spectate' | 'death' | 'menu';

export interface RigPose {
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
}

/** Extra outputs for the viewmodel. */
export interface RigInfo {
  /** First-person view of the local player with a weapon possible (fpp, or tpp blended into ADS). */
  firstPerson: boolean;
  /** Look direction (without kick / shake) */
  lookYaw: number;
  lookPitch: number;
  /** Strafe speed (m/s, + right) */
  strafe: number;
  speed: number;
}

export class CameraRig {
  readonly state: CameraState = {
    pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov: 60, mode: 'menu', scope: null, ads: 0, hideLocalBody: false,
  };
  readonly info: RigInfo = { firstPerson: false, lookYaw: 0, lookPitch: 0, strafe: 0, speed: 0 };

  private fovSetting = 85;
  private time = 0;
  // Smoothed eye offset (stance / lean transitions)
  private readonly eyeRel = { x: 0, y: 1.62, z: 0 };
  private eyeInit = false;
  private lastSelfPos = { x: 0, y: 0, z: 0 };
  // TPP / FPP blend (1 = third person)
  private tppBlend = 1;
  private boom = -1;
  // Mode / transition
  private category: Category = 'menu';
  private specTarget: number | null = null;
  private blendT = 1;
  private blendDur = BLEND_TIME;
  private readonly from: RigPose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov: 60 };
  private readonly last: RigPose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov: 60 };
  private readonly pose: RigPose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov: 60 };
  // TPP crosshair convergence distance (m) along the bullet line.
  private convDist = 60;
  // Vehicle chase
  private lastVehYaw = 0;
  private lastVehPitch = 0;
  /** One-frame look override after handing the chase cam direction back to the aim. */
  private lookOverride = false;
  private readonly handoff = { yaw: 0, pitch: 0 };
  private vehYaw = 0;
  private vehOffYaw = 0;
  private vehOffPitch = -0.16;
  private vehIdle = 0;
  private prevLookYaw = 0;
  private prevLookPitch = 0;
  private vehId: number | null = null;
  private readonly vehPivot = { x: 0, y: 0, z: 0 };
  // Spectate smoothing
  private specYaw = 0;
  private specPitch = 0;
  private readonly specPos = { x: 0, y: 0, z: 0 };
  private specInit = false;
  // Death orbit
  private deathT = 0;
  private orbitYaw = 0;
  private wasDead = false;
  // Feel-ish smoothing
  private strafeRoll = 0;
  private leanRoll = 0;
  private sprintFov = 0;
  private dropFov = 0;
  // Scratch
  private readonly hit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, kind: 'terrain', material: 'grass' };
  private readonly rayO: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly rayD: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly desired: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly pivot: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly aimDir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(private readonly world: World) {}

  setFovSetting(deg: number): void {
    this.fovSetting = clamp(deg, 60, 120);
  }

  update(frame: FrameState, feel: FeelState, dt: number): CameraState {
    this.time += dt;
    const st = this.state;
    const self = frame.self;
    const baseV = verticalFovFromSetting(this.fovSetting);
    st.scope = null;
    st.ads = 0;
    st.hideLocalBody = false;
    st.aimHandoff = null;
    this.lookOverride = false;
    this.info.firstPerson = false;
    this.info.strafe = 0;
    this.info.speed = 0;

    // ---------- choose category ----------
    let cat: Category;
    let mode: CameraViewMode;
    const selfView = frame.localId !== null ? frame.players.get(frame.localId) : undefined;
    let specTarget: PlayerView | undefined;
    if (self && self.life === 'dead') {
      if (!this.wasDead) {
        this.wasDead = true;
        this.deathT = 0;
        // Start behind the body (where the camera already was) and slowly circle it.
        this.orbitYaw = wrapAngle(this.last.yaw);
      }
      this.deathT += dt;
      const tgt = frame.viewTargetId !== null && frame.viewTargetId !== frame.localId ? frame.players.get(frame.viewTargetId) : undefined;
      const deadFor = selfView && selfView.deadFor >= 0 ? selfView.deadFor : this.deathT;
      if (tgt && deadFor > DEATH_ORBIT_SECONDS) {
        cat = 'spectate';
        specTarget = tgt;
      } else cat = 'death';
    } else if (self) {
      this.wasDead = false;
      if (self.mode === 'plane') cat = 'plane';
      else if (self.mode === 'freefall' || self.mode === 'parachute') cat = 'drop';
      else if (self.mode === 'vehicle' && self.vehicleId !== null && !this.canShootFromSeat(frame, self)) cat = 'vehicle';
      else cat = 'foot';
    } else {
      const tgt = frame.viewTargetId !== null ? frame.players.get(frame.viewTargetId) : undefined;
      if (tgt) { cat = 'spectate'; specTarget = tgt; } else cat = 'menu';
    }
    const specId = specTarget ? specTarget.id : null;
    if (cat !== this.category || (cat === 'spectate' && specId !== this.specTarget)) {
      if (this.category === 'vehicle' && self && self.life === 'alive') {
        // Leaving the chase cam: hand its direction to the aim (one frame) so the view does not
        // whip back to the aim the player had when getting in.
        this.handoff.yaw = this.lastVehYaw;
        this.handoff.pitch = clamp(this.lastVehPitch, -0.6, 0.6);
        st.aimHandoff = this.handoff;
        this.lookOverride = true;
      }
      this.startBlend(this.category === 'menu' ? 0 : BLEND_TIME);
      if (cat === 'spectate') this.specInit = false;
      if (cat === 'vehicle') this.vehId = null;
      this.boom = -1;
      this.category = cat;
      this.specTarget = specId;
    }

    // ---------- compute the target pose ----------
    const p = this.pose;
    switch (cat) {
      case 'foot': mode = this.footPose(frame, self!, feel, baseV, dt); break;
      case 'vehicle': mode = this.vehiclePose(frame, self!, baseV, dt); break;
      case 'plane': mode = this.planePose(frame, self!, baseV); break;
      case 'drop': mode = this.dropPose(frame, self!, baseV, dt); break;
      case 'spectate': mode = this.spectatePose(frame, specTarget!, baseV, dt); break;
      case 'death': mode = this.deathPose(self!, selfView, baseV, dt); break;
      default: mode = this.menuPose(baseV); break;
    }

    // ---------- blend from the previous mode ----------
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / Math.max(1e-3, this.blendDur));
      const e = smoother01(this.blendT);
      const f = this.from;
      p.pos.x = lerp(f.pos.x, p.pos.x, e);
      p.pos.y = lerp(f.pos.y, p.pos.y, e);
      p.pos.z = lerp(f.pos.z, p.pos.z, e);
      p.yaw = lerpAngle(f.yaw, p.yaw, e);
      p.pitch = lerp(f.pitch, p.pitch, e);
      p.roll = lerp(f.roll, p.roll, e);
      p.fov = lerp(f.fov, p.fov, e);
    }
    copyPose(this.last, p);

    // ---------- feel (shake on everything, kick when it is our gun) ----------
    let yaw = p.yaw + feel.shake.yaw;
    let pitch = p.pitch + feel.shake.pitch;
    let roll = p.roll + feel.shake.roll;
    if (cat === 'foot') {
      yaw += feel.kick.yaw;
      pitch += feel.kick.pitch;
      roll += feel.kick.roll;
    }
    st.pos.x = p.pos.x; st.pos.y = p.pos.y; st.pos.z = p.pos.z;
    st.yaw = wrapAngle(yaw);
    st.pitch = clamp(pitch, -1.565, 1.565);
    st.roll = roll;
    st.fov = clamp(p.fov + (cat === 'foot' || cat === 'vehicle' ? feel.fovPunch : 0), 5, 120);
    st.mode = mode;
    return st;
  }

  // ------------------------------------------------------------------------------------------

  private startBlend(dur: number): void {
    copyPose(this.from, this.last);
    this.blendDur = dur;
    this.blendT = dur > 0 ? 0 : 1;
  }

  private canShootFromSeat(frame: FrameState, self: LocalPlayerView): boolean {
    if (self.vehicleId === null || self.seat <= 0) return false;
    const v = frame.vehicles.get(self.vehicleId);
    if (!v) return false;
    return VEHICLES[v.type].seatCanShoot[self.seat] === true;
  }

  /** Smoothed eye position (stance / lean / seat transitions ease, absolute motion does not). */
  private smoothEye(self: LocalPlayerView, dt: number, out: Vec3): void {
    const rx = self.eye.x - self.pos.x, ry = self.eye.y - self.pos.y, rz = self.eye.z - self.pos.z;
    const jump = Math.hypot(self.pos.x - this.lastSelfPos.x, self.pos.y - this.lastSelfPos.y, self.pos.z - this.lastSelfPos.z);
    this.lastSelfPos.x = self.pos.x; this.lastSelfPos.y = self.pos.y; this.lastSelfPos.z = self.pos.z;
    if (!this.eyeInit || jump > 3 || Math.hypot(rx - this.eyeRel.x, ry - this.eyeRel.y, rz - this.eyeRel.z) > 1.6) {
      this.eyeRel.x = rx; this.eyeRel.y = ry; this.eyeRel.z = rz;
      this.eyeInit = true;
    } else {
      const k = damp(13, dt);
      this.eyeRel.x += (rx - this.eyeRel.x) * k;
      this.eyeRel.y += (ry - this.eyeRel.y) * k;
      this.eyeRel.z += (rz - this.eyeRel.z) * k;
    }
    out.x = self.pos.x + this.eyeRel.x;
    out.y = self.pos.y + this.eyeRel.y;
    out.z = self.pos.z + this.eyeRel.z;
  }

  /**
   * Collision-aware boom from `from` to `to`: sets `out` to the furthest safe point. The boom
   * snaps in instantly (never inside walls) and eases back out.
   */
  private boomTo(from: Vec3, to: Vec3, dt: number, out: Vec3): void {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-4) { out.x = to.x; out.y = to.y; out.z = to.z; return; }
    const ux = dx / L, uy = dy / L, uz = dz / L;
    let allowed = L;
    this.rayD.x = ux; this.rayD.y = uy; this.rayD.z = uz;
    // Centre ray plus two side probes approximate a sphere sweep of radius CAM_RADIUS.
    const sx = -uz, sz = ux;
    const sl = Math.hypot(sx, sz) || 1;
    for (let i = 0; i < 3; i++) {
      const o = i === 0 ? 0 : i === 1 ? CAM_RADIUS * 0.8 : -CAM_RADIUS * 0.8;
      this.rayO.x = from.x + (sx / sl) * o;
      this.rayO.y = from.y + (i === 0 ? 0 : 0.05);
      this.rayO.z = from.z + (sz / sl) * o;
      const h = raycastWorld(this.world, this.rayO, this.rayD, L + CAM_RADIUS, this.hit);
      if (h) allowed = Math.min(allowed, Math.max(0.08, h.dist - CAM_RADIUS));
    }
    if (this.boom < 0 || allowed < this.boom) this.boom = allowed;
    else this.boom += (allowed - this.boom) * damp(4.5, dt);
    const l = Math.min(this.boom, L);
    out.x = from.x + ux * l;
    out.y = from.y + uy * l;
    out.z = from.z + uz * l;
    // Never below the terrain surface.
    const ground = this.world.heightAt(out.x, out.z) + 0.15;
    if (out.y < ground && this.world.inBounds(out.x, out.z)) out.y = ground;
  }

  /** Over-the-shoulder target for a pivot (eye) and look angles. */
  private shoulder(pivot: Vec3, yaw: number, pitch: number, back: number, rightOff: number, up: number, out: Vec3): void {
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    out.x = pivot.x - fx * back + rx * rightOff;
    out.y = pivot.y - fy * back + up;
    out.z = pivot.z - fz * back + rz * rightOff;
  }

  // ------------------------------------------------------------------------------------------
  // Modes
  // ------------------------------------------------------------------------------------------

  private footPose(frame: FrameState, self: LocalPlayerView, feel: FeelState, baseV: number, dt: number): CameraViewMode {
    const p = this.pose;
    const eye = this.pivot;
    this.smoothEye(self, dt, eye);
    eye.y += feel.landDip;
    // The true aim (where bullets go) and the look direction (aim + free look). On the frame the
    // chase cam hands its direction to the aim, both use the handed-off direction.
    const aimYaw = this.lookOverride ? this.handoff.yaw : self.aimYaw;
    const aimPitch = this.lookOverride ? this.handoff.pitch : self.aimPitch;
    const lookYaw = this.lookOverride ? this.handoff.yaw : frame.camera.yaw;
    const lookPitch = this.lookOverride ? this.handoff.pitch : frame.camera.pitch;
    this.info.lookYaw = lookYaw;
    this.info.lookPitch = lookPitch;

    // FPP / TPP toggle blend
    const wantTpp = frame.camera.mode === 'tpp' ? 1 : 0;
    if (this.tppBlend !== wantTpp) {
      const step = dt / FPP_TOGGLE_TIME;
      this.tppBlend = wantTpp > this.tppBlend ? Math.min(1, this.tppBlend + step) : Math.max(0, this.tppBlend - step);
    }
    const def = self.weapon ? WEAPONS[self.weapon] : null;
    const ads = def ? clamp(self.ads, 0, 1) : 0;
    // TPP aiming switches to the first-person sight view.
    const adsCam = smoother01((ads - 0.05) / 0.6);
    const tppBlendW = smoother01(this.tppBlend) * (1 - adsCam);

    // Velocity in the look frame
    const rx = Math.cos(lookYaw), rz = -Math.sin(lookYaw);
    const strafe = self.vel.x * rx + self.vel.z * rz;
    const speed = Math.hypot(self.vel.x, self.vel.z);
    this.info.strafe = strafe;
    this.info.speed = speed;

    let px = eye.x, py = eye.y, pz = eye.z;
    let tppW = tppBlendW;
    if (tppW > 1e-3) {
      const stance = self.life === 'downed' ? 'prone' : self.stance;
      const o = TPP[stance];
      // Pivot for the boom: the head centre (no lateral offset) so the ray starts in free space.
      this.shoulder(eye, lookYaw, lookPitch, o.back, o.right, o.up, this.desired);
      this.boomTo(eye, this.desired, dt, this.desired);
      // Backed against a wall the boom collapses into the head: blend into first person instead
      // (the body hides and the viewmodel shows once past half way).
      const camDist = Math.hypot(this.desired.x - eye.x, this.desired.y - eye.y, this.desired.z - eye.z);
      tppW *= smooth01((camDist - CLOSE_FPP_MIN) / (CLOSE_FPP_MAX - CLOSE_FPP_MIN));
      px = lerp(eye.x, this.desired.x, tppW);
      py = lerp(eye.y, this.desired.y, tppW);
      pz = lerp(eye.z, this.desired.z, tppW);
    } else {
      this.boom = -1;
    }

    // Subtle FPP head bob (feel convention: lateral sin(phase), vertical cos(2 phase)).
    const fppW = 1 - tppW;
    const bobA = feel.bob.amount * fppW * (1 - 0.7 * ads);
    let roll = 0;
    if (bobA > 1e-4) {
      const ph = feel.bob.phase;
      const lat = Math.sin(ph) * 0.012 * bobA;
      px += rx * lat;
      pz += rz * lat;
      py += Math.cos(2 * ph) * -0.016 * bobA;
      roll += Math.sin(ph) * 0.0045 * bobA;
    }
    // Strafe tilt and lean roll (FPP mostly; a hint in TPP).
    const tiltTarget = -clamp(strafe / 6.3, -1, 1) * 0.011 * (1 - 0.6 * ads);
    this.strafeRoll += (tiltTarget - this.strafeRoll) * damp(7, dt);
    const leanTarget = -self.lean * (0.16 * fppW + 0.05 * tppW);
    this.leanRoll += (leanTarget - this.leanRoll) * damp(10, dt);
    roll += this.strafeRoll * (0.4 + 0.6 * fppW) + this.leanRoll;

    // FOV: setting x optic zoom (ADS) + gentle sprint widening.
    const magnified = def !== null && (def.scope === 'x4' || def.scope === 'x8');
    let v = baseV;
    if (def) v = zoomFov(baseV, adsZoomMul(def.adsZoom, ads, magnified));
    const sprintTarget = self.sprinting && self.onGround ? 1 : 0;
    this.sprintFov += (sprintTarget - this.sprintFov) * damp(5, dt);
    v += this.sprintFov * 3 * (1 - ads);

    // TPP crosshair convergence: the shoulder camera is offset from the eye the bullets leave
    // from, so aim it at the point P where the bullet line meets the world (screen centre = hit).
    let yaw = lookYaw, pitch = lookPitch;
    if (tppW > 1e-3) {
      dirFromAngles(aimYaw, aimPitch, this.aimDir);
      const h = raycastWorld(this.world, self.eye, this.aimDir, CONVERGE_MAX, this.hit);
      const target = h ? clamp(h.dist, CONVERGE_MIN, CONVERGE_MAX) : CONVERGE_MAX;
      // Snap closer quickly (walls), ease out slowly (no jitter grazing edges).
      this.convDist += (target - this.convDist) * damp(target < this.convDist ? 16 : 5, dt);
      const tx = self.eye.x + this.aimDir.x * this.convDist;
      const ty = self.eye.y + this.aimDir.y * this.convDist;
      const tz = self.eye.z + this.aimDir.z * this.convDist;
      const convYaw = Math.atan2(-(tx - px), -(tz - pz));
      const convPitch = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz));
      // Keep any free-look offset on top of the converged direction.
      yaw = lookYaw + angleDiff(aimYaw, convYaw) * tppW;
      pitch = lookPitch + (convPitch - aimPitch) * tppW;
    }
    // The viewmodel is posed relative to the actual camera direction.
    this.info.lookYaw = yaw;
    this.info.lookPitch = pitch;

    p.pos.x = px; p.pos.y = py; p.pos.z = pz;
    p.yaw = yaw;
    p.pitch = pitch;
    p.roll = roll;
    p.fov = v;

    const st = this.state;
    st.ads = ads;
    const scoped = magnified && ads >= SCOPE_AT && self.life === 'alive';
    st.scope = scoped ? def!.scope : null;
    const firstPerson = tppW < 0.5;
    st.hideLocalBody = firstPerson;
    this.info.firstPerson = firstPerson && !scoped;
    if (scoped) return 'scope';
    return firstPerson ? 'fpp' : 'tpp';
  }

  private vehiclePose(frame: FrameState, self: LocalPlayerView, baseV: number, dt: number): CameraViewMode {
    const p = this.pose;
    const v = self.vehicleId !== null ? frame.vehicles.get(self.vehicleId) : undefined;
    const lookYaw = frame.camera.yaw, lookPitch = frame.camera.pitch;
    this.info.lookYaw = lookYaw;
    this.info.lookPitch = lookPitch;
    if (!v) {
      // Vehicle not known yet: plain shoulder cam on the seat.
      this.smoothEye(self, dt, this.pivot);
      this.shoulder(this.pivot, lookYaw, lookPitch, 4, 0, 0.6, this.desired);
      this.boomTo(this.pivot, this.desired, dt, p.pos);
      p.yaw = lookYaw; p.pitch = lookPitch; p.roll = 0; p.fov = baseV;
      this.lastVehYaw = lookYaw;
      this.lastVehPitch = lookPitch;
      return 'vehicle';
    }
    // Mouse deltas accumulate a look-around offset relative to the vehicle heading.
    if (this.vehId !== v.id) {
      this.vehId = v.id;
      this.vehYaw = v.yaw;
      this.vehOffYaw = angleDiff(v.yaw, lookYaw);
      this.vehOffPitch = clamp(lookPitch, -0.6, 0.3);
      this.vehIdle = 0;
      this.prevLookYaw = lookYaw;
      this.prevLookPitch = lookPitch;
      this.vehPivot.x = v.pos.x; this.vehPivot.y = v.pos.y; this.vehPivot.z = v.pos.z;
    }
    const dYaw = angleDiff(this.prevLookYaw, lookYaw);
    const dPitch = lookPitch - this.prevLookPitch;
    this.prevLookYaw = lookYaw;
    this.prevLookPitch = lookPitch;
    this.vehOffYaw = wrapAngle(this.vehOffYaw + dYaw);
    this.vehOffPitch = clamp(this.vehOffPitch + dPitch, -0.85, 0.45);
    if (Math.abs(dYaw) + Math.abs(dPitch) > 1e-4) this.vehIdle = 0;
    else this.vehIdle += dt;
    const fpp = frame.camera.mode === 'fpp';
    const moving = Math.abs(v.speed) > 2.5;
    if (this.vehIdle > 1.1 && moving) {
      // Re-centre behind the vehicle (reversing looks forward too, PUBG style).
      const k = damp(1.6, dt);
      this.vehOffYaw -= this.vehOffYaw * k;
      this.vehOffPitch += ((fpp ? -0.05 : -0.16) - this.vehOffPitch) * k;
    }
    this.vehYaw = lerpAngle(this.vehYaw, v.yaw, damp(fpp ? 30 : 7, dt));
    const camYaw = wrapAngle(this.vehYaw + this.vehOffYaw);
    const camPitch = this.vehOffPitch;
    this.lastVehYaw = camYaw;
    this.lastVehPitch = camPitch;
    this.info.lookYaw = camYaw;
    this.info.lookPitch = camPitch;
    const def = VEHICLES[v.type];
    const speed = Math.abs(v.speed);
    if (fpp) {
      this.smoothEye(self, dt, p.pos);
      p.yaw = camYaw; p.pitch = camPitch;
      p.roll = v.roll * 0.35;
      p.fov = baseV + Math.min(6, speed * 0.18);
      this.state.hideLocalBody = true;
      return 'vehicle';
    }
    // Chase pivot above the vehicle (light smoothing removes snapshot jitter).
    const h = def.halfExtents.y * 2 + (v.type === 'bike' ? 0.9 : 0.75);
    const k = damp(25, dt);
    this.vehPivot.x += (v.pos.x - this.vehPivot.x) * k;
    this.vehPivot.y += (v.pos.y + h - this.vehPivot.y) * k;
    this.vehPivot.z += (v.pos.z - this.vehPivot.z) * k;
    if (Math.hypot(v.pos.x - this.vehPivot.x, v.pos.z - this.vehPivot.z) > 8) {
      this.vehPivot.x = v.pos.x; this.vehPivot.y = v.pos.y + h; this.vehPivot.z = v.pos.z;
    }
    const dist = (v.type === 'uaz' ? 7.2 : v.type === 'buggy' ? 6.2 : 4.8) + Math.min(2.5, speed * 0.06);
    this.shoulder(this.vehPivot, camYaw, camPitch, dist, 0, 0.55, this.desired);
    this.boomTo(this.vehPivot, this.desired, dt, p.pos);
    p.yaw = camYaw;
    p.pitch = camPitch;
    p.roll = 0;
    p.fov = baseV + Math.min(9, speed * 0.25);
    return 'vehicle';
  }

  private planePose(frame: FrameState, self: LocalPlayerView, baseV: number): CameraViewMode {
    const p = this.pose;
    const pp = frame.planePos ?? self.pos;
    const yaw = frame.camera.yaw;
    const pitch = clamp(frame.camera.pitch, -1.2, 0.45);
    this.info.lookYaw = yaw;
    this.info.lookPitch = pitch;
    this.pivot.x = pp.x; this.pivot.y = pp.y + 2; this.pivot.z = pp.z;
    this.shoulder(this.pivot, yaw, pitch, 34, 0, 7, p.pos);
    // Keep the plane in frame: look slightly down toward it.
    p.yaw = yaw;
    p.pitch = pitch - 0.1;
    // Gentle sway with the flight.
    p.roll = Math.sin(this.time * 0.6) * 0.01;
    p.fov = baseV + 8;
    this.state.hideLocalBody = true;
    return 'plane';
  }

  private dropPose(frame: FrameState, self: LocalPlayerView, baseV: number, dt: number): CameraViewMode {
    const p = this.pose;
    const free = self.mode === 'freefall';
    const yaw = frame.camera.yaw;
    const pitch = clamp(frame.camera.pitch, -1.3, 0.6);
    this.info.lookYaw = yaw;
    this.info.lookPitch = pitch;
    this.pivot.x = self.pos.x; this.pivot.y = self.pos.y + (free ? 1.0 : 1.3); this.pivot.z = self.pos.z;
    const back = free ? 4.4 : 6.8;
    const up = free ? 0.7 : 2.3;
    this.shoulder(this.pivot, yaw, pitch, back, 0, up, this.desired);
    this.boomTo(this.pivot, this.desired, dt, p.pos);
    const speed = Math.hypot(self.vel.x, self.vel.y, self.vel.z);
    const target = free ? 10 + Math.min(1, speed / 66) * 6 : 4;
    this.dropFov += (target - this.dropFov) * damp(2.5, dt);
    // Speed shake in freefall (wind buffeting).
    const s = free ? Math.min(1, speed / 60) * 0.0045 : 0.0008;
    p.yaw = yaw + sineNoise(this.time * 9, 11) * s;
    p.pitch = pitch + sineNoise(this.time * 10, 17) * s;
    p.roll = sineNoise(this.time * 7, 23) * s * 1.5;
    p.fov = baseV + this.dropFov;
    return free ? 'freefall' : 'parachute';
  }

  private spectatePose(frame: FrameState, t: PlayerView, baseV: number, dt: number): CameraViewMode {
    const p = this.pose;
    if (!this.specInit) {
      this.specInit = true;
      this.specYaw = t.yaw;
      this.specPitch = t.pitch;
      this.specPos.x = t.pos.x; this.specPos.y = t.pos.y; this.specPos.z = t.pos.z;
    }
    const k = damp(14, dt);
    this.specYaw = lerpAngle(this.specYaw, t.yaw, k);
    this.specPitch = lerp(this.specPitch, clamp(t.pitch, -1.2, 1.2), k);
    const kp = damp(20, dt);
    this.specPos.x += (t.pos.x - this.specPos.x) * kp;
    this.specPos.y += (t.pos.y - this.specPos.y) * kp;
    this.specPos.z += (t.pos.z - this.specPos.z) * kp;
    if (Math.hypot(t.pos.x - this.specPos.x, t.pos.y - this.specPos.y, t.pos.z - this.specPos.z) > 6) {
      this.specPos.x = t.pos.x; this.specPos.y = t.pos.y; this.specPos.z = t.pos.z;
    }
    this.info.lookYaw = this.specYaw;
    this.info.lookPitch = this.specPitch;
    let back = 2.6, right = 0.55, up = 0.22, eyeH: number = EYE_HEIGHT.stand;
    let fov = baseV;
    if (t.mode === 'plane') {
      const pp = frame.planePos ?? t.pos;
      this.pivot.x = pp.x; this.pivot.y = pp.y + 2; this.pivot.z = pp.z;
      this.shoulder(this.pivot, this.specYaw, this.specPitch, 34, 0, 7, p.pos);
      p.yaw = this.specYaw; p.pitch = this.specPitch - 0.1; p.roll = 0; p.fov = baseV + 8;
      return 'spectate';
    }
    if (t.mode === 'freefall' || t.mode === 'parachute') {
      back = t.mode === 'freefall' ? 4.4 : 6.8; right = 0; up = t.mode === 'freefall' ? 0.7 : 2.3; eyeH = 1.1;
      fov = baseV + (t.mode === 'freefall' ? 12 : 4);
    } else if (t.mode === 'vehicle') {
      back = 5.5; right = 0; up = 0.8; eyeH = 1.4;
    } else if (t.life === 'downed') {
      eyeH = EYE_HEIGHT.prone; back = 2.2; up = 0.4;
    } else {
      eyeH = EYE_HEIGHT[t.stance];
      const o = TPP[t.stance];
      back = o.back; right = o.right; up = o.up;
    }
    this.pivot.x = this.specPos.x; this.pivot.y = this.specPos.y + eyeH; this.pivot.z = this.specPos.z;
    this.shoulder(this.pivot, this.specYaw, this.specPitch, back, right, up, this.desired);
    this.boomTo(this.pivot, this.desired, dt, p.pos);
    p.yaw = this.specYaw;
    p.pitch = this.specPitch;
    p.roll = 0;
    p.fov = fov;
    return 'spectate';
  }

  private deathPose(self: LocalPlayerView, selfView: PlayerView | undefined, baseV: number, dt: number): CameraViewMode {
    const p = this.pose;
    const body = selfView ? selfView.pos : self.pos;
    this.orbitYaw = wrapAngle(this.orbitYaw + dt * (this.deathT < DEATH_ORBIT_SECONDS ? 0.32 : 0.12));
    const r = Math.min(6.5, 4.2 + this.deathT * 0.35);
    const h = Math.min(3.6, 1.8 + this.deathT * 0.3);
    this.pivot.x = body.x; this.pivot.y = body.y + 0.9; this.pivot.z = body.z;
    this.desired.x = body.x + Math.sin(this.orbitYaw) * r;
    this.desired.y = body.y + h;
    this.desired.z = body.z + Math.cos(this.orbitYaw) * r;
    this.boomTo(this.pivot, this.desired, dt, p.pos);
    // Look at the body.
    const tx = body.x, ty = body.y + 0.4, tz = body.z;
    p.yaw = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
    p.pitch = Math.atan2(ty - p.pos.y, Math.hypot(tx - p.pos.x, tz - p.pos.z));
    p.roll = 0;
    p.fov = baseV;
    this.info.lookYaw = p.yaw;
    this.info.lookPitch = p.pitch;
    return 'death';
  }

  private menuPose(baseV: number): CameraViewMode {
    const p = this.pose;
    const w = this.world;
    const cx = w.training ? w.training.spawn.x : 0;
    const cz = w.training ? w.training.spawn.z : 0;
    const R = w.training ? 60 : w.half * 0.55;
    const a = this.time * 0.035;
    const x = cx + Math.sin(a) * R, z = cz + Math.cos(a) * R;
    const ground = w.inBounds(x, z) ? Math.max(w.heightAt(x, z), w.waterLevel) : w.waterLevel;
    p.pos.x = x;
    p.pos.y = ground + (w.training ? 35 : 140);
    p.pos.z = z;
    const gy = w.inBounds(cx, cz) ? Math.max(w.heightAt(cx, cz), w.waterLevel) : w.waterLevel;
    p.yaw = Math.atan2(-(cx - x), -(cz - z));
    p.pitch = Math.atan2(gy - p.pos.y, R);
    p.roll = 0;
    p.fov = baseV;
    this.info.lookYaw = p.yaw;
    this.info.lookPitch = p.pitch;
    return 'menu';
  }
}

function copyPose(dst: RigPose, src: RigPose): void {
  dst.pos.x = src.pos.x; dst.pos.y = src.pos.y; dst.pos.z = src.pos.z;
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.roll = src.roll; dst.fov = src.fov;
}

