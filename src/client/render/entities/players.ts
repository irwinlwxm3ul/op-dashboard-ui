// Player rendering orchestration: per-player animation state, LOD selection with hysteresis and
// dithered crossfades, near pool assignment (closest players win when the pool is full), vehicle
// seating, death fade/sink, parachute canopies and the anchors nameplates use.

import * as THREE from 'three';
import { MAX_PLAYERS } from '../../../shared/constants';
import { wrapAngle } from '../../../shared/math';
import { seatWorldPosition } from '../../../shared/vehicles';
import type { EntityId, Vec3, VehicleState, WeaponId } from '../../../shared/types';
import type { FrameState, PlayerView, VehicleView } from '../../game/types';
import type { CameraState } from '../contracts';
import {
  type AnimInput, AnimState, DEATH_FADE_START, DEATH_FADE_TIME, type SeatInfo, animate, deathSink, deathVisibility,
} from './animator';
import { type LogicalAnim, createLogicalAnim, resolveLogicalAnim } from './animState';
import type { BodyFrame, MidBodyRenderer, NearBody, NearBodyProvider } from './bodies';
import { FarCrowd, MidCrowd, NearPool, type SoldierLook } from './crowd';
import {
  LOD_HIDDEN_IDX, type LodFade, type LodLevel, type LodThresholds, createLodFade, effectiveLodDistance, fadeCode,
  minScreenScale, selectLod, stepLodFade,
} from './lod';
import { teamColor, clothTintHex, skinToneHex } from './palette';
import { Parachutes } from './parachutes';
import { createPose, smooth } from './pose';
import { B, type RigInput, createBoneMatrices, evaluateRig, headPosition } from './rig';
import { SLUNG_DEPTH } from './soldierModel';

/** Seconds a LOD crossfade takes. */
const LOD_FADE_TIME = 0.35;
/** Players not refreshed by a snapshot for this long (ms) are considered gone. */
const STALE_MS = 4000;
/** Reference vertical FOV (deg) for zoom-aware LOD distances. */
const REF_FOV = 65;
/** Minimum on-screen height (device px) of far silhouettes. */
const MIN_FAR_PX = 2.5;

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _one = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _seat: Vec3 = { x: 0, y: 0, z: 0 };
const _animIn: AnimInput = { view: null, seat: null, aimYawRel: 0, localVx: 0, localVz: 0, time: 0, dt: 0 };
const _rigIn: RigInput = { pose: createPose(), aimPitch: 0, aimYaw: 0, weapon: null, slungDepth: 0 };
/** Scratch per-player frame handed to the body backends (created on first use, then reused). */
let _bodyScratch: BodyFrame | null = null;
function bodyFrame(v: PlayerView): BodyFrame {
  if (!_bodyScratch) {
    _bodyScratch = {
      root: new THREE.Matrix4(), rig: [], look: {
        accent: new THREE.Color(), cloth: new THREE.Color(), skin: new THREE.Color(), gear: [0, 0, 0], weapon: null,
      },
      showWeapon: false, fade: 0, shadows: false, view: v, logical: createLogicalAnim(),
      aimPitch: 0, aimYawRel: 0, dt: 0, time: 0,
    };
  }
  return _bodyScratch;
}

/** Scratch VehicleState used to evaluate seat positions from an interpolated VehicleView. */
const _veh: VehicleState = {
  id: 0, type: 'buggy', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, yawRate: 0,
  speed: 0, steer: 0, throttle: 0, rpm: 0, health: 1, fuel: 1, seats: [], onGround: true, destroyed: false,
  burnTimer: 0, lastDriver: null,
};

export class PlayerEntry {
  id: EntityId = -1;
  view: PlayerView | null = null;
  readonly anim = new AnimState();
  fade: LodFade = createLodFade(LOD_HIDDEN_IDX);
  near: NearBody | null = null;
  /** Provider that owns `near` (bodies are returned to the provider they came from). */
  nearOwner: NearBodyProvider | null = null;
  readonly logical: LogicalAnim = createLogicalAnim();
  readonly look: SoldierLook & { gear: [number, number, number] } = {
    accent: new THREE.Color(), cloth: new THREE.Color(), skin: new THREE.Color(), gear: [0, 0, 0], weapon: null,
  };
  private lookTeam = Number.NaN;
  private lookLocalTeam = Number.NaN;
  readonly rootPos = new THREE.Vector3();
  readonly rootQuat = new THREE.Quaternion();
  readonly root = new THREE.Matrix4();
  readonly bones = createBoneMatrices();
  /** World position above the head (nameplates) and chest (aim / line of sight tests). */
  readonly anchor = new THREE.Vector3();
  readonly chest = new THREE.Vector3();
  /** True when anchor/chest are valid this frame (player rendered or tracked). */
  tracked = false;
  dist = 0;
  seen = 0;
  yaw = 0;
  deathYaw: number | null = null;
  chuteFor = -1;
  wasChute = false;
  farLie = 0;
  farCrouch = 0;
  rigValid = false;
  readonly seat: SeatInfo = { type: 'buggy', seat: 0, steer: 0 };

  reset(id: EntityId): void {
    this.id = id;
    this.view = null;
    this.anim.reset(id);
    this.fade = createLodFade(LOD_HIDDEN_IDX);
    this.near = null;
    this.lookTeam = Number.NaN;
    this.lookLocalTeam = Number.NaN;
    this.tracked = false;
    this.deathYaw = null;
    this.chuteFor = -1;
    this.wasChute = false;
    this.farLie = 0;
    this.farCrouch = 0;
    this.rigValid = false;
    this.look.cloth.setHex(clothTintHex(id));
    this.look.skin.setHex(skinToneHex(id));
  }

  updateLook(v: PlayerView, localTeam: number): void {
    if (v.team !== this.lookTeam || localTeam !== this.lookLocalTeam) {
      teamColor(v.team, localTeam, this.look.accent);
      this.lookTeam = v.team;
      this.lookLocalTeam = localTeam;
    }
    const g = this.look.gear;
    g[0] = Math.max(0, Math.min(3, v.gear[0] | 0));
    g[1] = Math.max(0, Math.min(3, v.gear[1] | 0));
    g[2] = Math.max(0, Math.min(3, v.gear[2] | 0));
    this.look.weapon = v.weapon;
  }
}

export interface PlayersUpdateContext {
  camPos: THREE.Vector3;
  cam: CameraState;
  lod: LodThresholds;
  /** Drawing-buffer focal length in px: (height / 2) / tan(vfov / 2). */
  focalPx: number;
  shadows: boolean;
  time: number;
}

export class PlayersRenderer {
  readonly entries = new Map<EntityId, PlayerEntry>();
  private readonly pool: PlayerEntry[] = [];
  /** Procedural backends (always available: the fallback for asset-based bodies). */
  private readonly procNear: NearPool;
  private readonly procMid: MidCrowd;
  private nearPool: NearBodyProvider;
  private mid: MidBodyRenderer;
  private nearCapacity: number;
  private readonly far: FarCrowd;
  readonly chutes: Parachutes;
  private frameNo = 0;
  private readonly stale: EntityId[] = [];
  private readonly nearHolders: PlayerEntry[] = [];
  private frame: FrameState | null = null;
  private ctx: PlayersUpdateContext | null = null;
  private dt = 0;

  constructor(parent: THREE.Object3D, nearCapacity: number) {
    this.nearCapacity = nearCapacity;
    this.procNear = new NearPool(parent, nearCapacity);
    this.procMid = new MidCrowd(parent, MAX_PLAYERS);
    this.nearPool = this.procNear;
    this.mid = this.procMid;
    this.far = new FarCrowd(parent, MAX_PLAYERS + 16);
    this.chutes = new Parachutes(parent);
  }

  setNearCapacity(n: number): void {
    this.nearCapacity = n;
    this.nearPool.setCapacity(n);
    if (this.nearPool !== this.procNear) this.procNear.setCapacity(n);
  }

  /**
   * Swap the near / mid body backends (e.g. skinned glTF characters once their assets loaded).
   * Passing null restores the procedural soldier. Bodies currently assigned are returned to their
   * provider; players pick up a body from the new provider on the next frame. The caller owns
   * non-procedural backends and disposes them after swapping them out.
   */
  setBodyBackends(near: NearBodyProvider | null, mid: MidBodyRenderer | null): void {
    const nextNear = near ?? this.procNear;
    const nextMid = mid ?? this.procMid;
    if (nextNear !== this.nearPool) {
      this.entries.forEach(this.releaseNearOf);
      this.nearPool = nextNear;
      this.nearPool.setCapacity(this.nearCapacity);
    }
    if (nextMid !== this.mid) {
      this.mid.clear();
      this.mid = nextMid;
    }
  }

  /** Name of the active near / mid backends (diagnostics). */
  get backendNames(): { near: string; mid: string } {
    return { near: this.nearPool.name, mid: this.mid.name };
  }

  private readonly releaseNearOf = (e: PlayerEntry): void => {
    this.releaseNear(e);
  };

  private releaseNear(e: PlayerEntry): void {
    if (e.near && e.nearOwner) e.nearOwner.release(e.near);
    e.near = null;
    e.nearOwner = null;
  }

  /** Bullet hit on a player: flinch + remembered fall direction. */
  onHit(victim: EntityId, from: Vec3, pos: Vec3, damage: number): void {
    const e = this.entries.get(victim);
    if (!e) return;
    const dx = pos.x - from.x, dz = pos.z - from.z;
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
    // Model frame: x = right(yaw) = (c, 0, -s); z = backward = (s, 0, c).
    const bx = dx * c - dz * s;
    const bz = dx * s + dz * c;
    e.anim.hit(bx, bz, damage / 35);
  }

  /** A player fired (recoil kick on the third-person weapon). */
  onShot(shooter: EntityId, weapon: WeaponId): void {
    const e = this.entries.get(shooter);
    if (!e) return;
    e.anim.kick(weapon === 'pistol' ? 0.6 : weapon === 'shotgun' || weapon === 'sniper' ? 1.4 : weapon === 'dmr' ? 1.1 : 0.8);
  }

  update(frame: FrameState, ctx: PlayersUpdateContext, dt: number): void {
    this.frameNo++;
    this.frame = frame;
    this.ctx = ctx;
    this.dt = dt;
    this.mid.begin();
    this.far.begin();
    this.chutes.begin();
    frame.players.forEach(this.visit);
    // Drop players that left the frame.
    this.stale.length = 0;
    this.entries.forEach(this.collectStale);
    for (const id of this.stale) {
      const e = this.entries.get(id);
      if (!e) continue;
      this.releaseNear(e);
      this.entries.delete(id);
      this.pool.push(e);
    }
    this.chutes.updateCollapsing(dt);
    this.mid.end();
    this.far.end();
    this.chutes.end();
    this.frame = null;
    this.ctx = null;
  }

  private readonly collectStale = (e: PlayerEntry): void => {
    if (e.seen !== this.frameNo) this.stale.push(e.id);
  };

  private entry(id: EntityId): PlayerEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = this.pool.pop() ?? new PlayerEntry();
      e.reset(id);
      this.entries.set(id, e);
    }
    return e;
  }

  /** Acquire a near soldier for `e`, stealing from a farther holder when the pool is full. */
  private acquireNear(e: PlayerEntry): NearBody | null {
    let s = this.nearPool.acquire(e.id);
    if (s) return s;
    let victim: PlayerEntry | null = null;
    this.nearHolders.length = 0;
    this.entries.forEach(this.collectNearHolder);
    for (const h of this.nearHolders) {
      if (h === e || h.view?.isSelf) continue;
      if (h.dist > e.dist + 2 && (!victim || h.dist > victim.dist)) victim = h;
    }
    if (!victim || !victim.near) return null;
    this.releaseNear(victim);
    // The victim drops to mid immediately.
    victim.fade.cur = 1;
    if (victim.fade.prev === 0) victim.fade.prev = 1;
    victim.fade.t = 1;
    s = this.nearPool.acquire(e.id);
    return s;
  }

  private readonly collectNearHolder = (h: PlayerEntry): void => {
    if (h.near) this.nearHolders.push(h);
  };

  private readonly visit = (v: PlayerView): void => {
    const frame = this.frame!, ctx = this.ctx!, dt = this.dt;
    const e = this.entry(v.id);
    e.seen = this.frameNo;
    e.view = v;
    e.updateLook(v, frame.localTeam);

    // --- Root transform --------------------------------------------------------------------------
    let seat: SeatInfo | null = null;
    let aimYawRel = 0;
    let veh: VehicleView | undefined;
    if (v.mode === 'vehicle' && v.vehicleId !== null && (veh = frame.vehicles.get(v.vehicleId)) !== undefined) {
      _veh.type = veh.type;
      _veh.pos.x = veh.pos.x; _veh.pos.y = veh.pos.y; _veh.pos.z = veh.pos.z;
      _veh.yaw = veh.yaw; _veh.pitch = veh.pitch; _veh.roll = veh.roll;
      seatWorldPosition(_veh, v.seat, _seat);
      e.rootPos.set(_seat.x, _seat.y, _seat.z);
      _e.set(veh.pitch, veh.yaw, veh.roll, 'YXZ');
      e.rootQuat.setFromEuler(_e);
      e.yaw = veh.yaw;
      aimYawRel = wrapAngle(v.yaw - veh.yaw);
      seat = e.seat;
      seat.type = veh.type;
      seat.seat = v.seat;
      seat.steer = veh.steer;
    } else {
      let yaw = v.yaw;
      if (v.life === 'dead') {
        if (e.deathYaw === null) e.deathYaw = v.yaw;
        yaw = e.deathYaw;
      } else {
        e.deathYaw = null;
      }
      e.yaw = yaw;
      e.rootPos.set(v.pos.x, v.pos.y, v.pos.z);
      e.rootQuat.setFromAxisAngle(_v.set(0, 1, 0), yaw);
    }
    const deadFor = v.life === 'dead' ? Math.max(0, v.deadFor) : -1;
    if (deadFor > 0) e.rootPos.y -= deathSink(deadFor);
    e.root.compose(e.rootPos, e.rootQuat, _one);

    // --- Visibility / LOD ------------------------------------------------------------------------
    const gone = v.mode === 'plane' || v.age > STALE_MS || (deadFor >= 0 && deadFor > DEATH_FADE_START + DEATH_FADE_TIME);
    const bodyHidden = gone || (v.isSelf && ctx.cam.hideLocalBody);
    e.dist = e.rootPos.distanceTo(ctx.camPos);
    if (gone) {
      // Leaving the world (boarding the plane, stale, fully faded corpse): hide at once.
      if (e.fade.cur !== LOD_HIDDEN_IDX || e.fade.t < 1) e.fade = createLodFade(LOD_HIDDEN_IDX);
    } else if (v.isSelf) {
      if (e.fade.cur !== 0) e.fade = createLodFade(0);
    } else {
      const eff = effectiveLodDistance(e.dist, ctx.cam.fov, REF_FOV);
      let target: LodLevel = selectLod(e.fade.cur, eff, ctx.lod);
      // Never fade in beyond the render distance (true distance, not zoom adjusted).
      if (e.dist > ctx.lod.far + ctx.lod.hysteresis) target = LOD_HIDDEN_IDX;
      stepLodFade(e.fade, target, dt, LOD_FADE_TIME);
    }
    e.tracked = !gone;

    // Near soldier assignment.
    const wantsNear = !bodyHidden && (e.fade.cur === 0 || (e.fade.prev === 0 && e.fade.t < 1));
    if (wantsNear && !e.near) {
      e.near = this.acquireNear(e);
      e.nearOwner = e.near ? this.nearPool : null;
      if (!e.near) {
        // Pool exhausted: stay on the mid LOD.
        if (e.fade.cur === 0) e.fade.cur = 1;
        if (e.fade.prev === 0) e.fade.prev = 1;
      }
    } else if (!wantsNear && e.near) {
      this.releaseNear(e);
    }

    const vis = deadFor >= 0 ? deathVisibility(deadFor) : 1;
    const codeNear = bodyHidden ? 0 : fadeCode(e.fade, 0, vis);
    const codeMid = bodyHidden ? 0 : fadeCode(e.fade, 1, vis);
    const codeFar = bodyHidden ? 0 : fadeCode(e.fade, 2, vis);

    // --- Animation -------------------------------------------------------------------------------
    const needRig = codeNear !== 0 || codeMid !== 0 || (!gone && e.dist < 120);
    if (needRig) {
      const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
      const riding = seat !== null;
      _animIn.view = v;
      _animIn.seat = seat;
      _animIn.aimYawRel = aimYawRel;
      _animIn.localVx = riding ? 0 : v.vel.x * c - v.vel.z * s;
      _animIn.localVz = riding ? 0 : v.vel.x * s + v.vel.z * c;
      _animIn.time = ctx.time;
      _animIn.dt = dt;
      animate(e.anim, _animIn);
      _rigIn.pose = e.anim.pose;
      _rigIn.aimPitch = v.pitch;
      _rigIn.aimYaw = aimYawRel;
      _rigIn.weapon = v.weapon;
      _rigIn.slungDepth = SLUNG_DEPTH[e.look.gear[2]];
      evaluateRig(_rigIn, e.bones);
      e.rigValid = true;
      headPosition(e.bones, _v).applyMatrix4(e.root);
      e.anchor.copy(_v);
      e.anchor.y += 0.42;
      _v.set(0, 0.12, 0).applyMatrix4(e.bones[B.CHEST]).applyMatrix4(e.root);
      e.chest.copy(_v);
    } else {
      e.rigValid = false;
      const lying = v.life !== 'alive' || v.stance === 'prone' || v.mode === 'swim' || v.mode === 'freefall';
      const h = lying ? 0.45 : v.mode === 'vehicle' ? 1.3 : v.stance === 'crouch' ? 1.15 : 1.75;
      e.anchor.set(e.rootPos.x, e.rootPos.y + h + 0.4, e.rootPos.z);
      e.chest.set(e.rootPos.x, e.rootPos.y + h * 0.7, e.rootPos.z);
    }

    // --- Draw --------------------------------------------------------------------------------------
    const _body = bodyFrame(v);
    if ((codeNear !== 0 || codeMid !== 0) && e.rigValid) {
      resolveLogicalAnim(v, e.anim.speed, e.logical);
      _body.root = e.root;
      _body.rig = e.bones;
      _body.look = e.look;
      _body.showWeapon = v.weapon !== null && v.life !== 'dead';
      _body.shadows = ctx.shadows;
      _body.view = v;
      _body.logical = e.logical;
      _body.aimPitch = v.pitch;
      _body.aimYawRel = aimYawRel;
      _body.dt = dt;
      _body.time = ctx.time;
    }
    if (e.near) {
      if (codeNear !== 0 && e.rigValid) {
        _body.fade = codeNear;
        e.near.apply(_body);
      } else {
        e.near.hide();
      }
    }
    if (codeMid !== 0 && e.rigValid) {
      _body.fade = codeMid;
      this.mid.add(_body);
    }
    if (codeFar !== 0) this.drawFar(e, v, codeFar, ctx, dt);
    else this.trackFarShape(e, v, dt);

    // --- Parachute --------------------------------------------------------------------------------
    const chute = v.mode === 'parachute' && v.life !== 'dead' && !gone;
    if (chute) {
      e.chuteFor = e.wasChute ? e.chuteFor + dt : 0;
      const bank = -0.3 * e.anim.steer;
      if (e.dist < ctx.lod.far) this.chutes.addOpen(e.root, e.chuteFor, bank, e.look.accent, 1);
    } else if (e.wasChute && !gone && e.dist < 400) {
      this.chutes.drop(e.root, -0.3 * e.anim.steer, e.look.accent, v.pos.y);
    }
    e.wasChute = chute;
  };

  /** Smooth the far-silhouette stance shaping even while the far LOD is not drawn. */
  private trackFarShape(e: PlayerEntry, v: PlayerView, dt: number): void {
    const lie = v.life !== 'alive' || v.stance === 'prone' || v.mode === 'swim' || v.mode === 'freefall' ? 1 : 0;
    const crouch = v.mode === 'vehicle' ? 1 : v.stance === 'crouch' && lie === 0 ? 1 : 0;
    const k = 1 - Math.exp(-6 * dt);
    e.farLie += (lie - e.farLie) * k;
    e.farCrouch += (crouch - e.farCrouch) * k;
  }

  private drawFar(e: PlayerEntry, v: PlayerView, code: number, ctx: PlayersUpdateContext, dt: number): void {
    this.trackFarShape(e, v, dt);
    const lie = smooth(e.farLie);
    // Lie down around the hips: T(0, 0.2) * Rx(-90deg) * T(0, -0.95), blended by `lie`.
    _m.makeTranslation(0, 0.2 * lie, 0);
    _m2.makeRotationX(-Math.PI / 2 * lie);
    _m.multiply(_m2);
    _m2.makeTranslation(0, -0.95 * lie, 0);
    _m.multiply(_m2);
    const k = minScreenScale(1.8, e.dist, ctx.focalPx, MIN_FAR_PX);
    _m2.makeScale(k, k * (1 - 0.3 * e.farCrouch), k);
    _m.multiply(_m2);
    _m.premultiply(e.root);
    this.far.add(_m, e.look.accent, code);
  }

  dispose(): void {
    this.entries.forEach(this.releaseNearOf);
    this.procNear.dispose();
    this.procMid.dispose();
    this.far.dispose();
    this.chutes.dispose();
    this.entries.clear();
  }
}
