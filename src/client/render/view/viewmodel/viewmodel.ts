// First-person viewmodel: procedural arms + guns in their own scene, rendered after the world.
//
// Rendering approach (robust against whatever the render core does with its scene): the
// viewmodel lives in a separate THREE.Scene with its own narrow-FOV camera at the origin (camera
// space). We chain `core.scene.onAfterRender`, which three.js calls at the very end of
// `renderer.render(core.scene, core.camera)` — after the world, transparent objects and any
// multisample resolve — and there, with autoClear disabled, clear only the depth buffer and render
// the viewmodel scene into the same target. The gun therefore never clips into walls, uses its own
// FOV, inherits tone mapping / colour space / post-processing of the main pass, and costs only
// its own draw calls. The hook renders at most once per frame and only for the main camera (so
// reflection or shadow passes that reuse the scene never pick it up).
//
// Animation layers (all procedural, camera space): hip <-> ADS blend aligning the sight with the
// screen centre, sprint pose, draw / holster, idle breathing, mouse inertia lag (springs), stride
// bob from feel, strafe tilt, jump / land spring, recoil from feel.vm, dry-fire click, reloads
// (magazine out/in, charging handle / slide / bolt on empty, shell-by-shell for the shotgun),
// sniper bolt and shotgun pump cycles after each shot, pistol slide blowback + lock on empty,
// muzzle flash + light, shell ejection, healing item animations, grenade throw, fists unarmed.

import * as THREE from 'three';
import { WEAPONS } from '../../../../shared/items';
import { angleDiff, clamp, damp, lerp } from '../../../../shared/math';
import type { ConsumableId, Vec3, WeaponId, World } from '../../../../shared/types';
import type { ClientEventBus, LocalPlayerView } from '../../../game/types';
import type { FeelState, RenderCore } from '../../contracts';
import { ENV } from '../../core';
import { CasingPool } from '../../fx/casings';
import { localMuzzle } from '../../fx/muzzle';
import { releaseAtlases, retainAtlases } from '../../fx/textures';
import {
  easeInOutSine, easeOutBack, easeOutCubic, pulse, ramp, sineNoise, smooth01, springStep, window4, type Spring1,
} from '../cameraMath';
import { Arm, type HandStyle } from './arms';
import { BOLT_KNOB, buildGun, type GunModel } from './guns';
import { HeldItems } from './heldItems';
import { MuzzleFlash } from './muzzleFlash';
import { releaseMaterials, retainMaterials, type MatKey } from './parts';

/** Viewmodel vertical FOV at hip / fully aimed (deg). */
const VM_FOV_HIP = 60;
const VM_FOV_ADS = 55;
const HOLSTER_TIME = 0.14;
const SLIDE_TIME = 0.07;
const DRY_TIME = 0.18;
const THROW_TIME = 0.62;
const PUMP_DELAY = 0.1;
const PUMP_TIME = 0.42;
const BOLT_DELAY = 0.22;
const SHELL_ENTER = 0.22;
const SHELL_EXIT = 0.22;
const SHELL_PUMP = 0.36;

/** Per-frame inputs from the rig. */
export interface VmInput {
  self: LocalPlayerView;
  /** Viewmodel should be drawn this frame (camera is first person, not scoped, alive...). */
  visible: boolean;
  /** Camera look direction (without cosmetic kick / shake) and the true aim. */
  camYaw: number;
  camPitch: number;
  aimYaw: number;
  aimPitch: number;
  /** Strafe speed (m/s, + right) for the tilt. */
  strafe: number;
  /** Horizontal speed (m/s). */
  speed: number;
  feel: FeelState;
  /** 0 outdoors .. 1 fully indoors (dims the sun light). */
  indoor: number;
  /** Main camera (already posed this frame) for screen-matched world positions. */
  mainCamera: THREE.PerspectiveCamera;
  sunDir: THREE.Vector3;
}

interface ReloadState {
  active: boolean;
  weapon: WeaponId | null;
  empty: boolean;
  t: number;
  total: number;
  /** Normalised progress for magazine reloads. */
  u: number;
  seenProgress: boolean;
  done: boolean;
  /** Shell-by-shell: phase bookkeeping. */
  perShell: number;
  exitT: number;
  lastCycle: number;
}

function activeWeapon(self: LocalPlayerView): { mag: number } | null {
  const slot = self.activeSlot;
  return slot === 0 || slot === 1 || slot === 2 ? self.weapons[slot] : null;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(VM_FOV_HIP, 16 / 9, 0.01, 20);
  private readonly core: RenderCore;
  private readonly mats: Record<MatKey, THREE.Material>;
  private readonly pivot = new THREE.Group();
  private readonly holder = new THREE.Group();
  private readonly guns = new Map<WeaponId, GunModel>();
  private gun: GunModel | null = null;
  private readonly rightArm: Arm;
  private readonly leftArm: Arm;
  private readonly items: HeldItems;
  private readonly flash: MuzzleFlash;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly casings: CasingPool;
  private readonly unsubs: (() => void)[] = [];
  private prevAfterRender: THREE.Object3D['onAfterRender'];
  private renderPending = false;
  private disposed = false;

  // --- animation state ---
  private time = 0;
  private visible = false;
  private shown: WeaponId | null = null;
  private switching = false;
  private holsterT = 0;
  private raise = 1;
  private lowerUse = 0;
  private sprint = 0;
  private itemRise = 0;
  private itemId: ConsumableId | null = null;
  private reviveW = 0;
  private slideT = 0;
  private slideLocked = false;
  private boltActive = false;
  private boltT = 0;
  private pumpActive = false;
  private pumpT = 0;
  private boltEjected = false;
  private pumpEjected = false;
  private dryT = 0;
  private throwT = -1;
  private readonly lagYaw: Spring1 = { x: 0, v: 0 };
  private readonly lagPitch: Spring1 = { x: 0, v: 0 };
  private readonly vSpring: Spring1 = { x: 0, v: 0 };
  private readonly jolt: Spring1 = { x: 0, v: 0 };
  private prevCamYaw = 0;
  private prevCamPitch = 0;
  private hasPrev = false;
  private strafeTilt = 0;
  private readonly reload: ReloadState = {
    active: false, weapon: null, empty: false, t: 0, total: 1, u: 0, seenProgress: false, done: false,
    perShell: 0, exitT: -1, lastCycle: -1,
  };
  private reloadW = 0;
  private shellStage: 'none' | 'enter' | 'loop' | 'pump' | 'exit' = 'none';
  private shellInHand = false;
  private lastMag = -1;

  // --- scratch ---
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly e2 = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly leftT = new THREE.Vector3();
  private readonly leftR = new THREE.Euler();
  private readonly rightT = new THREE.Vector3();
  private readonly m4 = new THREE.Matrix4();
  private readonly worldTmp = new THREE.Vector3();
  private readonly velTmp = new THREE.Vector3();

  constructor(core: RenderCore, world: World, events: ClientEventBus) {
    this.core = core;
    retainAtlases();
    this.mats = retainMaterials();
    this.scene.name = 'viewmodel';
    this.scene.matrixWorldAutoUpdate = true;
    this.pivot.name = 'vm-pivot';
    this.holder.name = 'vm-holder';
    this.pivot.add(this.holder);
    this.scene.add(this.pivot);

    // Same light rig as the world (render core ENV) so the gun matches its surroundings.
    this.hemi = new THREE.HemisphereLight(ENV.hemiSky, ENV.hemiGround, ENV.hemiIntensity);
    this.sun = new THREE.DirectionalLight(ENV.sunColor, ENV.sunIntensity);
    this.scene.add(this.hemi, this.sun);

    this.rightArm = new Arm(this.pivot, this.mats, false, new THREE.Vector3(0.24, -0.34, 0.16), new THREE.Vector3(0.75, -1, 0.15));
    this.leftArm = new Arm(this.pivot, this.mats, true, new THREE.Vector3(-0.26, -0.36, 0.02), new THREE.Vector3(-0.75, -1, 0.15));
    this.items = new HeldItems(this.mats);
    this.pivot.add(this.items.group);
    this.flash = new MuzzleFlash();
    this.pivot.add(this.flash.light);

    this.casings = new CasingPool(world, 40);
    core.scene.add(this.casings.mesh);

    // Render hook (see header comment).
    this.prevAfterRender = core.scene.onAfterRender;
    const self = this;
    core.scene.onAfterRender = function (renderer, scene, camera, geometry, material, group) {
      self.prevAfterRender.call(core.scene, renderer, scene, camera, geometry, material, group);
      if (camera !== core.camera || !self.renderPending || self.disposed) return;
      self.renderPending = false;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(self.scene, self.camera);
      renderer.autoClear = autoClear;
    };

    this.unsubs.push(
      events.on('localShot', (ev) => this.onShot(ev.weapon)),
      events.on('localReload', (ev) => this.onReload(ev.weapon, ev.empty)),
      events.on('localReloadDone', () => { this.reload.done = true; }),
      events.on('localDryFire', () => { this.dryT = DRY_TIME; }),
      events.on('localJump', () => { this.vSpring.v -= 0.32; }),
      events.on('localLand', (ev) => { this.vSpring.v -= clamp(ev.speed * 0.055, 0.12, 0.9); }),
      events.on('throw', (ev) => { if (this.selfId !== null && ev.player === this.selfId) this.throwT = 0; }),
    );
  }

  private selfId: number | null = null;
  /** Casing ejections requested by events, spawned after posing. */
  private pendingEjects = 0;

  /** Main per-frame update. Returns true when the viewmodel will be drawn. */
  update(inp: VmInput, dt: number): boolean {
    if (this.disposed) return false;
    const self = inp.self;
    this.selfId = self.id;
    this.time += dt;
    this.visible = inp.visible;

    this.updateWeaponSwitch(self, dt);
    this.updateTimers(self, dt);
    this.updateReload(self, dt);
    this.updateLook(inp, dt);

    const gun = this.gun;
    const ads = gun ? clamp(self.ads, 0, 1) : 0;
    const adsE = smooth01(ads);

    // Viewmodel camera
    const fov = lerp(VM_FOV_HIP, VM_FOV_ADS, adsE);
    const aspect = inp.mainCamera.aspect;
    if (Math.abs(this.camera.fov - fov) > 1e-3 || Math.abs(this.camera.aspect - aspect) > 1e-4) {
      this.camera.fov = fov;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    this.updateLights(inp, dt);

    this.pose(inp, adsE);
    this.poseParts(self);
    this.poseHands(inp, adsE);
    this.flash.update(dt);
    this.casings.update(dt);

    this.scene.updateMatrixWorld();
    this.publishMuzzle(inp);
    // Casings queued by events this frame spawn from the freshly posed gun.
    while (this.pendingEjects > 0) {
      this.pendingEjects--;
      this.ejectCasing();
    }
    this.renderPending = this.visible;
    return this.visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.core.scene.onAfterRender = this.prevAfterRender;
    this.core.scene.remove(this.casings.mesh);
    this.casings.dispose();
    for (const g of this.guns.values()) {
      g.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          if (o === g.reticle) (m.material as THREE.Material).dispose();
        }
      });
    }
    this.guns.clear();
    this.rightArm.dispose();
    this.leftArm.dispose();
    this.items.dispose();
    this.flash.dispose();
    this.hemi.dispose();
    this.sun.dispose();
    releaseMaterials();
    releaseAtlases();
    localMuzzle.viewmodelVisible = false;
  }

  // ------------------------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------------------------

  private onShot(weapon: WeaponId): void {
    if (weapon !== this.shown || !this.gun) return;
    const gun = this.gun;
    if (this.visible) this.flash.fire(gun.flashScale);
    const def = WEAPONS[weapon];
    if (def.fireMode === 'bolt') {
      this.boltActive = true;
      this.boltT = -BOLT_DELAY;
      this.boltEjected = false;
    } else if (def.fireMode === 'pump') {
      this.pumpActive = true;
      this.pumpT = -PUMP_DELAY;
      this.pumpEjected = false;
    } else {
      if (gun.slide) this.slideT = SLIDE_TIME;
      if (this.visible) this.pendingEjects++;
    }
    // A shot interrupts any reload animation (the sim cancels shell-by-shell reloads on fire).
    if (this.reload.active && this.reload.perShell > 0) this.reload.done = true;
  }

  private onReload(weapon: WeaponId, empty: boolean): void {
    const def = WEAPONS[weapon];
    const r = this.reload;
    r.active = true;
    r.weapon = weapon;
    r.empty = empty;
    r.t = 0;
    r.total = empty ? def.reloadEmptyTime : def.reloadTime;
    r.u = 0;
    r.seenProgress = false;
    r.done = false;
    r.perShell = def.reloadPerShell ?? 0;
    r.exitT = -1;
    r.lastCycle = -1;
    this.shellStage = r.perShell > 0 ? 'enter' : 'none';
    // A bolt cycle in progress is folded into the reload.
    this.boltActive = false;
  }

  // ------------------------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------------------------

  private getGun(id: WeaponId): GunModel {
    let g = this.guns.get(id);
    if (!g) {
      g = buildGun(id, this.mats);
      g.root.visible = false;
      this.holder.add(g.root);
      this.guns.set(id, g);
    }
    return g;
  }

  private setShown(id: WeaponId | null): void {
    if (this.gun) this.gun.root.visible = false;
    this.shown = id;
    this.gun = id ? this.getGun(id) : null;
    if (this.gun) {
      this.gun.root.visible = true;
      this.gun.root.add(this.flash.group);
      this.flash.group.position.copy(this.gun.muzzle);
    } else {
      this.flash.group.removeFromParent();
    }
    // Reset per-gun mechanical state.
    this.slideT = 0;
    this.boltActive = false;
    this.pumpActive = false;
    this.slideLocked = false;
    this.lastMag = -1;
  }

  private updateWeaponSwitch(self: LocalPlayerView, dt: number): void {
    const want = self.weapon;
    if (want !== this.shown) {
      if (!this.visible || this.raise < 0.05) {
        // Nothing on screen to lower: swap immediately.
        this.setShown(want);
        this.switching = false;
        this.raise = 0;
      } else if (!this.switching) {
        this.switching = true;
        this.holsterT = 0;
      }
    }
    if (this.switching) {
      this.holsterT += dt / HOLSTER_TIME;
      if (this.holsterT >= 1) {
        this.switching = false;
        this.setShown(want);
        this.raise = 0;
      }
    } else if (this.raise < 1) {
      const drawTime = this.shown ? WEAPONS[this.shown].drawTime : 0.3;
      this.raise = Math.min(1, this.raise + dt / Math.max(0.1, drawTime));
      if (self.drawProgress >= 0) this.raise = Math.max(this.raise, Math.min(1, self.drawProgress));
    }
    // Reload belongs to the gun it started on.
    if (this.reload.active && this.reload.weapon !== this.shown) this.endReload();
  }

  private updateTimers(self: LocalPlayerView, dt: number): void {
    const gun = this.gun;
    if (this.slideT > 0) this.slideT = Math.max(0, this.slideT - dt);
    if (this.dryT > 0) this.dryT = Math.max(0, this.dryT - dt);
    if (this.throwT >= 0) {
      this.throwT += dt;
      if (this.throwT >= THROW_TIME) this.throwT = -1;
    }
    // Pistol slide locks back on the last round and releases on reload.
    if (gun && gun.slide && self.activeSlot >= 0) {
      const inst = activeWeapon(self);
      const mag = inst ? inst.mag : 0;
      if (this.lastMag > 0 && mag === 0 && this.slideT > 0) this.slideLocked = true;
      if (mag > 0 && !this.reload.active) this.slideLocked = false;
      this.lastMag = mag;
    }
    // Bolt (sniper) cycle: starts after a short delay so the recoil settles first.
    if (this.boltActive) {
      this.boltT += dt;
      const dur = this.boltDuration();
      if (!this.boltEjected && this.boltT / dur >= 0.45) {
        this.boltEjected = true;
        if (this.visible) this.pendingEjects++;
      }
      if (this.boltT >= dur) this.boltActive = false;
    }
    // Shotgun pump cycle
    if (this.pumpActive) {
      this.pumpT += dt;
      if (!this.pumpEjected && this.pumpT / PUMP_TIME >= 0.42) {
        this.pumpEjected = true;
        if (this.visible) this.pendingEjects++;
      }
      if (this.pumpT >= PUMP_TIME) this.pumpActive = false;
    }
    // Healing / reviving / throwing lower the gun.
    const using = self.use !== null;
    if (using) this.itemId = self.use!.item;
    const reviving = self.revive !== null;
    const throwing = this.throwT >= 0;
    this.itemRise += ((using ? 1 : 0) - this.itemRise) * damp(using ? 7 : 9, dt);
    this.reviveW += ((reviving ? 1 : 0) - this.reviveW) * damp(7, dt);
    const lowerTarget = using || reviving || throwing ? 1 : 0;
    this.lowerUse += (lowerTarget - this.lowerUse) * damp(lowerTarget > this.lowerUse ? 10 : 6, dt);
    // Sprint pose
    const sprinting = self.sprinting && self.onGround && self.ads < 0.3 && !this.reload.active;
    this.sprint += ((sprinting ? 1 : 0) - this.sprint) * damp(9, dt);
  }

  private boltDuration(): number {
    const def = WEAPONS.sniper;
    return Math.max(0.6, Math.min(1.0, (60 / def.rpm) * 0.65));
  }

  private updateReload(self: LocalPlayerView, dt: number): void {
    const r = this.reload;
    if (!r.active) {
      this.reloadW += (0 - this.reloadW) * damp(12, dt);
      return;
    }
    r.t += dt;
    this.reloadW += (1 - this.reloadW) * damp(14, dt);
    const prog = self.reloadProgress;
    if (prog >= 0) r.seenProgress = true;
    if (r.perShell > 0) {
      this.updateShellReload(self, dt);
      return;
    }
    if (prog >= 0) r.u = Math.max(r.u, prog);
    else if (!r.seenProgress) r.u = Math.min(0.99, r.t / Math.max(0.2, r.total));
    // Finished (or cancelled) on the authoritative side.
    if ((r.seenProgress && prog < 0) || r.done) {
      if (r.u > 0.6 || r.done) {
        // Play the tail out quickly.
        r.u = Math.min(1, r.u + dt / Math.max(0.25, r.total * 0.25));
        if (r.u >= 1) this.endReload();
      } else {
        this.endReload();
      }
    }
    if (r.t > r.total + 1.5) this.endReload();
  }

  private updateShellReload(self: LocalPlayerView, dt: number): void {
    const r = this.reload;
    const def = WEAPONS.shotgun;
    const inst = activeWeapon(self);
    const full = inst ? inst.mag >= def.magSize : false;
    const finished = r.done || full || (r.seenProgress && self.reloadProgress < 0);
    switch (this.shellStage) {
      case 'enter':
        if (r.t >= SHELL_ENTER) { this.shellStage = 'loop'; r.lastCycle = -1; }
        break;
      case 'loop': {
        const c = ((r.t - SHELL_ENTER) / r.perShell) % 1;
        // Leave the loop at a cycle boundary (or right away if the hand is empty).
        if (finished && (c < 0.3 || c > 0.88 || r.done)) {
          this.shellStage = r.empty ? 'pump' : 'exit';
          r.exitT = 0;
        }
        const cyc = Math.floor((r.t - SHELL_ENTER) / r.perShell);
        if (cyc !== r.lastCycle) r.lastCycle = cyc;
        if (c >= 0.86 && c - dt / r.perShell < 0.86) this.jolt.v += 0.12;
        break;
      }
      case 'pump':
        r.exitT += dt;
        if (r.exitT >= SHELL_PUMP) { this.shellStage = 'exit'; r.exitT = 0; }
        break;
      case 'exit':
        r.exitT += dt;
        if (r.exitT >= SHELL_EXIT) this.endReload();
        break;
      default:
        break;
    }
  }

  private endReload(): void {
    const r = this.reload;
    r.active = false;
    r.done = false;
    this.shellStage = 'none';
    this.shellInHand = false;
  }

  private updateLook(inp: VmInput, dt: number): void {
    if (!this.hasPrev || dt <= 0) {
      this.prevCamYaw = inp.camYaw;
      this.prevCamPitch = inp.camPitch;
      this.hasPrev = true;
      return;
    }
    const dYaw = angleDiff(this.prevCamYaw, inp.camYaw);
    const dPitch = inp.camPitch - this.prevCamPitch;
    this.prevCamYaw = inp.camYaw;
    this.prevCamPitch = inp.camPitch;
    // Big jumps (respawn, mode switches) are not mouse motion.
    const yawVel = Math.abs(dYaw) > 0.6 ? 0 : dYaw / dt;
    const pitchVel = Math.abs(dPitch) > 0.6 ? 0 : dPitch / dt;
    springStep(this.lagYaw, clamp(-yawVel * 0.016, -0.09, 0.09), 5.5, dt);
    springStep(this.lagPitch, clamp(-pitchVel * 0.014, -0.07, 0.07), 5.5, dt);
    springStep(this.vSpring, 0, 4.2, dt);
    springStep(this.jolt, 0, 7, dt);
    const strafeTarget = clamp(inp.strafe / 6.3, -1, 1);
    this.strafeTilt += (strafeTarget - this.strafeTilt) * damp(6, dt);
  }

  private updateLights(inp: VmInput, dt: number): void {
    // Sun and sky directions in camera space so the gun is lit like the world.
    this.q.copy(inp.mainCamera.quaternion).invert();
    this.v.copy(inp.sunDir).applyQuaternion(this.q).normalize();
    this.sun.position.copy(this.v).multiplyScalar(5);
    this.hemi.position.set(0, 1, 0).applyQuaternion(this.q);
    const indoor = clamp(inp.indoor, 0, 1);
    const target = ENV.sunIntensity * (1 - 0.8 * indoor);
    this.sun.intensity += (target - this.sun.intensity) * damp(4, dt);
    this.hemi.intensity = ENV.hemiIntensity * (1 - 0.4 * indoor);
    // Share the world's environment map (if any) for consistent reflections.
    const env = this.core.scene.environment;
    if (this.scene.environment !== env) this.scene.environment = env;
  }

  // ------------------------------------------------------------------------------------------
  // Posing
  // ------------------------------------------------------------------------------------------

  private pose(inp: VmInput, adsE: number): void {
    const gun = this.gun;
    const feel = inp.feel;
    const t = this.time;
    // Free look: the gun keeps pointing along the aim while the camera looks around.
    const offYaw = angleDiff(inp.camYaw, inp.aimYaw);
    const offPitch = inp.aimPitch - inp.camPitch;
    this.pivot.rotation.set(offPitch, offYaw, 0, 'YXZ');
    if (Math.abs(offYaw) > 1.1 || Math.abs(offPitch) > 1.0) this.visible = false;

    let px: number, py: number, pz: number, rx: number, ry: number, rz: number;
    if (gun) {
      const ax = 0, ay = -gun.sightY, az = -gun.eyeRelief - gun.sightZ;
      px = lerp(gun.hip.x, ax, adsE);
      py = lerp(gun.hip.y, ay, adsE);
      pz = lerp(gun.hip.z, az, adsE);
      rx = gun.hipRot.x * (1 - adsE);
      ry = gun.hipRot.y * (1 - adsE);
      rz = gun.hipRot.z * (1 - adsE);
      // Slight dip along the ADS path so it reads as bringing the gun up to the eye.
      py -= Math.sin(Math.PI * adsE) * 0.012;
    } else {
      px = 0; py = -0.14; pz = -0.33; rx = 0; ry = 0; rz = 0;
    }

    // Sprint pose: rifle across the chest, pistol pointed down.
    const sp = this.sprint * (1 - adsE);
    if (sp > 0.001) {
      if (!gun || gun.id === 'pistol') {
        px += sp * 0.01; py += sp * -0.02; pz += sp * 0.03; rx += sp * -0.55; ry += sp * 0.12;
      } else {
        px += sp * -0.03; py += sp * -0.02; pz += sp * 0.04; rx += sp * -0.22; ry += sp * 0.55; rz += sp * 0.38;
      }
    }

    // Lowered: weapon switch, healing, reviving, throwing.
    const switchLow = this.switching ? easeInOutSine(this.holsterT) : 1 - clamp(easeOutBack(this.raise, 1.2), 0, 1.08);
    const low = Math.max(switchLow, this.lowerUse);
    if (low > 0.001) {
      px += low * 0.03; py += low * -0.3; pz += low * 0.1; rx += low * -0.9; ry += low * 0.25; rz += low * 0.45;
    }

    // Reload tilt
    const tilt = this.reloadTilt() * this.reloadW;
    if (tilt > 0.001) {
      const k = 1 - adsE * 0.5;
      // Roll the gun top-right and swing the muzzle right so its left side and magwell face the
      // camera, lifted toward the centre where the hands work.
      px += tilt * -0.045 * k; py += tilt * 0.06 * k; pz += tilt * 0.01;
      rx += tilt * 0.12; ry += tilt * -0.3; rz += tilt * -0.6;
    }
    // Bolt cycle: tilt toward the bolt, shotgun pump: small rock.
    if (this.boltActive && this.boltT >= 0 && gun) {
      const b = this.boltT / this.boltDuration();
      const w = window4(b, 0, 0.15, 0.8, 1);
      rz += w * -0.12 * (1 - adsE * 0.7);
      rx += w * 0.05;
      px += w * -0.01;
    }
    if (this.pumpActive && this.pumpT >= 0) {
      const p = pulse(this.pumpT / PUMP_TIME, 0, 1);
      rx += p * 0.05; pz += p * 0.01;
    }

    // Idle breathing (much smaller when aiming)
    const idleK = (1 - adsE * 0.85) * (1 - sp * 0.7);
    px += sineNoise(t * 0.55, 1) * 0.0022 * idleK;
    py += (sineNoise(t * 0.5, 2) * 0.0018 + Math.sin(t * 1.65) * 0.0012) * idleK;
    rx += sineNoise(t * 0.45, 3) * 0.004 * idleK;
    ry += sineNoise(t * 0.4, 4) * 0.005 * idleK;

    // Stride bob from feel: phase advances PI per footstep, footfalls at k*PI. Lateral sway
    // follows sin(phase) (one cycle per left+right step), vertical follows cos(2*phase) and
    // dips on each footfall.
    const A = feel.bob.amount * (1 - adsE * 0.82) * (1 + sp * 0.9);
    if (A > 1e-4) {
      const ph = feel.bob.phase;
      px += Math.sin(ph) * 0.011 * A;
      py += Math.cos(2 * ph) * -0.007 * A;
      rz += Math.sin(ph) * 0.022 * A;
      ry += Math.sin(ph) * 0.01 * A;
    }

    // Mouse inertia lag
    const lagK = 1 - adsE * 0.7;
    ry += this.lagYaw.x * lagK;
    rx += this.lagPitch.x * lagK;
    px += this.lagYaw.x * -0.06 * lagK;
    py += this.lagPitch.x * 0.05 * lagK;

    // Strafe tilt
    rz += this.strafeTilt * -0.035 * (1 - adsE * 0.7);

    // Jump / land / reload jolts
    py += this.vSpring.x * 0.12 + this.jolt.x * 0.05;
    rx += this.vSpring.x * -0.15;

    // Recoil kick (feel) and dry fire
    pz += feel.vm.back;
    py += feel.vm.up * (1 - adsE * 0.4);
    px += feel.vm.side;
    rx += feel.vm.rot;
    if (this.dryT > 0) {
      const d = pulse(1 - this.dryT / DRY_TIME, 0, 1);
      rx += d * -0.022;
      pz += d * 0.005;
    }

    this.holder.position.set(px, py, pz);
    this.holder.rotation.set(rx, ry, rz, 'YXZ');
    this.holder.updateMatrix();
    if (gun) gun.root.visible = true;
    // Hide when lowered completely out of view and nothing else is shown.
    if (low > 0.97 && this.itemRise < 0.02 && this.throwT < 0 && this.reviveW < 0.02) this.visible = false;
  }

  private reloadTilt(): number {
    const r = this.reload;
    if (!r.active && this.reloadW < 0.01) return 0;
    if (r.perShell > 0) {
      switch (this.shellStage) {
        case 'enter': return smooth01(r.t / SHELL_ENTER);
        case 'loop': return 1;
        case 'pump': return 1 - smooth01(r.exitT / SHELL_PUMP) * 0.6;
        case 'exit': return 0.4 * (1 - smooth01(r.exitT / SHELL_EXIT));
        default: return 0;
      }
    }
    return r.empty ? window4(r.u, 0, 0.1, 0.9, 1) : window4(r.u, 0, 0.12, 0.8, 0.98);
  }

  /** Magazine offset along its drop direction (m) and visibility for the current reload. */
  private magState(u: number): { off: number; visible: boolean } {
    const s = this.magScratch;
    if (u < 0.16) { s.off = 0; s.visible = true; }
    else if (u < 0.3) { s.off = 0.08 * smooth01((u - 0.16) / 0.14); s.visible = true; }
    else if (u < 0.4) { const k = (u - 0.3) / 0.1; s.off = 0.08 + 0.3 * k * k; s.visible = u < 0.37; }
    else if (u < 0.48) { s.off = 0.3; s.visible = false; }
    else if (u < 0.62) { s.off = 0.3 - 0.285 * easeOutCubic((u - 0.48) / 0.14); s.visible = true; }
    else if (u < 0.66) { s.off = 0.015 * (1 - (u - 0.62) / 0.04); s.visible = true; }
    else { s.off = 0; s.visible = true; }
    return s;
  }
  private readonly magScratch = { off: 0, visible: true };

  private poseParts(self: LocalPlayerView): void {
    const gun = this.gun;
    if (!gun) return;
    const r = this.reload;
    const reloading = r.active && r.perShell === 0;
    const u = reloading ? r.u : 0;
    // Magazine
    if (gun.mag) {
      const ms = this.magState(reloading ? u : 0);
      gun.mag.position.copy(gun.magDrop).multiplyScalar(ms.off);
      gun.mag.visible = ms.visible;
    }
    // Insert jolt (edge-detected on progress)
    if (reloading) {
      if (this.prevU < 0.66 && u >= 0.66) this.jolt.v += 0.14;
      this.prevU = u;
    } else {
      this.prevU = 0;
    }
    // Pistol slide
    if (gun.slide) {
      let back = 0;
      if (this.slideT > 0) {
        const k = 1 - this.slideT / SLIDE_TIME;
        back = k < 0.3 ? k / 0.3 : 1 - (k - 0.3) / 0.7;
      }
      if (this.slideLocked) back = 1;
      if (reloading && r.empty) {
        // Locked back until the slide release at 0.74, then snaps forward.
        back = u < 0.74 ? 1 : Math.max(0, 1 - (u - 0.74) / 0.03);
        if (u >= 0.77) this.slideLocked = false;
      }
      gun.slide.position.z = back * 0.034;
    }
    // Charging handle (AR / SMG / DMR) on empty reloads
    if (gun.charge) {
      let back = 0;
      if (reloading && r.empty) back = u < 0.76 ? 0 : u < 0.82 ? smooth01((u - 0.76) / 0.06) : Math.max(0, 1 - (u - 0.82) / 0.025);
      gun.charge.position.z = back * 0.065;
    }
    // Shotgun pump: after each shot and when racking after an empty reload
    if (gun.pump) {
      let back = 0;
      if (this.pumpActive && this.pumpT >= 0) back = window4(this.pumpT / PUMP_TIME, 0, 0.4, 0.48, 0.92);
      if (r.active && this.shellStage === 'pump') back = window4(r.exitT / SHELL_PUMP, 0, 0.42, 0.5, 0.95);
      gun.pump.position.z = back * 0.075;
    }
    // Sniper bolt: after each shot, and at the end of an empty reload
    if (gun.bolt) {
      let b = -1;
      if (this.boltActive && this.boltT >= 0) b = this.boltT / this.boltDuration();
      else if (reloading && r.empty && u >= 0.72) b = Math.min(1, (u - 0.72) / 0.24);
      let lift = 0, back = 0;
      if (b >= 0) {
        lift = window4(b, 0, 0.18, 0.75, 0.92);
        back = window4(b, 0.2, 0.42, 0.5, 0.72);
      }
      gun.bolt.rotation.z = lift * 1.15;
      gun.bolt.position.z = 0.06 + back * 0.085;
    }
    // Red dot reticle only when looking roughly through the sight.
    if (gun.reticle) gun.reticle.visible = self.ads > 0.25;
  }
  private prevU = 0;

  /** Gun-local point -> pivot space (through the holder pose). */
  private toPivot(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).applyMatrix4(this.holder.matrix);
  }

  private poseHands(inp: VmInput, adsE: number): void {
    const gun = this.gun;
    const showHands = this.visible;
    this.rightArm.visible = showHands;
    this.leftArm.visible = showHands;
    this.items.group.visible = showHands;
    if (!showHands) {
      this.items.show(null);
      return;
    }
    const holderQ = this.holder.quaternion;
    const r = this.reload;

    // ----- right hand -----
    let rightStyle: HandStyle = 'grip';
    if (gun) {
      this.rightT.set(0, 0, 0);
      this.e2.copy(gun.gripRot);
      // Bolt cycle: hand goes to the knob.
      let bw = 0;
      let b = -1;
      if (this.boltActive && this.boltT >= 0 && gun.bolt) b = this.boltT / this.boltDuration();
      else if (r.active && r.empty && gun.bolt && r.u >= 0.7) b = Math.min(1, (r.u - 0.72) / 0.24);
      if (b >= 0 && gun.bolt) {
        bw = window4(b, -0.02, 0.12, 0.85, 1);
        gun.bolt.updateMatrix();
        this.v.copy(BOLT_KNOB).applyMatrix4(gun.bolt.matrix);
        this.rightT.lerp(this.v.add(this.v2.set(0.012, -0.01, 0.02)), bw);
      }
      this.toPivot(this.rightT, this.v2);
      this.rightArm.hand.position.copy(this.v2);
      this.q2.setFromEuler(this.e2.set(this.e2.x - bw * 0.6, this.e2.y, this.e2.z + bw * 0.5));
      this.rightArm.hand.quaternion.copy(holderQ).multiply(this.q2);
    } else {
      this.v.set(0.14, -0.02, 0);
      this.toPivot(this.v, this.v2);
      this.rightArm.hand.position.copy(this.v2);
      this.q2.setFromEuler(this.e2.set(0.35, 0.12, 0.3));
      this.rightArm.hand.quaternion.copy(holderQ).multiply(this.q2);
      rightStyle = 'fist';
    }

    // ----- left hand -----
    let leftStyle: HandStyle = gun ? gun.supportStyle : 'fist';
    if (gun) {
      this.leftT.copy(gun.support);
      this.leftR.copy(gun.supportRot);
      if (gun.pump) this.leftT.z += gun.pump.position.z;
      if (r.active) {
        if (r.perShell > 0) this.shellLeftHand(gun);
        else this.magLeftHand(gun);
      }
      this.toPivot(this.leftT, this.v2);
      this.leftArm.hand.position.copy(this.v2);
      this.q2.setFromEuler(this.leftR);
      this.leftArm.hand.quaternion.copy(holderQ).multiply(this.q2);
    } else {
      this.v.set(-0.13, -0.03, -0.04);
      this.toPivot(this.v, this.v2);
      this.leftArm.hand.position.copy(this.v2);
      this.q2.setFromEuler(this.e2.set(0.35, -0.12, -0.3));
      this.leftArm.hand.quaternion.copy(holderQ).multiply(this.q2);
    }

    // ----- held items, throws, revive (override hands) -----
    this.poseItems(inp);
    if (this.styleR) rightStyle = this.styleR;
    if (this.styleL) leftStyle = this.styleL;

    this.rightArm.setStyle(rightStyle);
    this.leftArm.setStyle(leftStyle);
    this.rightArm.solve();
    this.leftArm.solve();
    void adsE;
  }

  /** Smoothly interpolate the reload hand target between two gun-local points. */
  private mixTarget(ax: number, ay: number, az: number, bx: number, by: number, bz: number, f: number): void {
    const e = smooth01(f);
    this.tgt.set(ax + (bx - ax) * e, ay + (by - ay) * e, az + (bz - az) * e);
  }
  private readonly tgt = new THREE.Vector3();

  /** Left hand path during a magazine reload (writes leftT / leftR in gun-local space). */
  private magLeftHand(gun: GunModel): void {
    const r = this.reload;
    const u = r.u;
    const S = this.leftT; // currently the support anchor
    const T = this.tgt;
    // Magazine bottom (follows the current mag offset), a point down out of view, charging handle.
    const ms = this.magState(u);
    const mbx = gun.magBottom.x + gun.magDrop.x * ms.off - 0.012;
    const mby = gun.magBottom.y + gun.magDrop.y * ms.off - 0.02;
    const mbz = gun.magBottom.z + gun.magDrop.z * ms.off + 0.01;
    const dx = gun.magBottom.x - 0.08, dy = gun.magBottom.y - 0.3, dz = gun.magBottom.z + 0.08;
    const cx = gun.chargeAnchor.x, cy = gun.chargeAnchor.y, cz = gun.chargeAnchor.z + (gun.charge ? gun.charge.position.z : 0);
    let k = 1;
    if (u < 0.1) this.mixTarget(S.x, S.y, S.z, mbx, mby, mbz, u / 0.1);
    else if (u < 0.3) T.set(mbx, mby, mbz);
    else if (u < 0.42) this.mixTarget(mbx, mby, mbz, dx, dy, dz, (u - 0.3) / 0.12);
    else if (u < 0.5) T.set(dx, dy, dz);
    else if (u < 0.66) this.mixTarget(dx, dy, dz, mbx, mby, mbz, (u - 0.5) / 0.1);
    else if (!r.empty || !gun.charge) {
      if (u < 0.8) this.mixTarget(mbx, mby, mbz, S.x, S.y, S.z, (u - 0.66) / 0.14);
      else k = 0;
    } else if (u < 0.74) this.mixTarget(mbx, mby, mbz, cx, cy, cz, (u - 0.66) / 0.08);
    else if (u < 0.86) T.set(cx, cy, cz);
    else if (u < 0.96) this.mixTarget(cx, cy, cz, S.x, S.y, S.z, (u - 0.86) / 0.1);
    else k = 0;
    k *= this.reloadW;
    if (k > 0) S.lerp(T, k);
    // Hand turns palm-in while handling the magazine.
    const handling = k * window4(u, 0.04, 0.12, 0.7, 0.8);
    this.leftR.set(this.leftR.x - handling * 0.4, this.leftR.y + handling * 0.5, this.leftR.z - handling * 0.9);
  }

  /** Left hand path during a shell-by-shell reload (writes leftT / leftR, toggles the shell). */
  private shellLeftHand(gun: GunModel): void {
    const r = this.reload;
    const S = this.leftT;
    const px = gun.port.x - 0.01, py = gun.port.y - 0.035, pz = gun.port.z + 0.02;
    const pouchX = 0.02, pouchY = -0.3, pouchZ = 0.1;
    let k = 1;
    this.shellInHand = false;
    switch (this.shellStage) {
      case 'enter':
        this.mixTarget(S.x, S.y, S.z, px, py - 0.02, pz + 0.04, r.t / SHELL_ENTER);
        break;
      case 'loop': {
        const c = ((r.t - SHELL_ENTER) / r.perShell) % 1;
        if (c < 0.35) this.mixTarget(px, py - 0.02, pz + 0.04, pouchX, pouchY, pouchZ, c / 0.35);
        else if (c < 0.7) {
          this.mixTarget(pouchX, pouchY, pouchZ, px, py - 0.04, pz + 0.05, (c - 0.35) / 0.35);
          this.shellInHand = c > 0.42;
        } else if (c < 0.88) {
          this.mixTarget(px, py - 0.04, pz + 0.05, px, py, pz, (c - 0.7) / 0.18);
          this.shellInHand = c < 0.85;
        } else this.mixTarget(px, py, pz, px, py - 0.02, pz + 0.04, (c - 0.88) / 0.12);
        break;
      }
      case 'pump':
        this.mixTarget(px, py - 0.02, pz + 0.04, S.x, S.y, S.z, r.exitT / 0.12);
        break;
      default:
        k = 0;
        break;
    }
    k *= this.reloadW;
    if (k > 0) S.lerp(this.tgt, k);
    this.leftR.set(this.leftR.x - k * 0.5, this.leftR.y, this.leftR.z + k * 0.6);
  }

  /**
   * Healing items, grenade throws, revive gesture and the shotgun shell. Poses hands directly in
   * pivot space when something overrides them and records the hand shapes to use.
   */
  private poseItems(inp: VmInput): void {
    const self = inp.self;
    this.styleR = null;
    this.styleL = null;
    const R = this.rightArm.hand, L = this.leftArm.hand;
    // Shotgun shell in the left hand during shell reloads.
    if (this.shellInHand) {
      const obj = this.items.show('shell');
      if (obj) {
        L.updateMatrix();
        obj.position.set(0.0, -0.01, -0.03).applyMatrix4(L.matrix);
        obj.quaternion.copy(L.quaternion);
      }
      this.styleL = 'grip';
      return;
    }
    // Grenade throw: raise, wind back, throw forward (released at ~68 %), follow through.
    if (this.throwT >= 0) {
      const t = this.throwT / THROW_TIME;
      const obj = this.items.show(t < 0.68 ? 'frag' : null);
      let x: number, y: number, z: number;
      if (t < 0.25) { const k = easeOutCubic(t / 0.25); x = 0.14; y = lerp(-0.4, -0.1, k); z = lerp(-0.2, -0.26, k); }
      else if (t < 0.55) { const k = easeInOutSine((t - 0.25) / 0.3); x = lerp(0.14, 0.18, k); y = lerp(-0.1, -0.02, k); z = lerp(-0.26, -0.1, k); }
      else if (t < 0.72) { const k = smooth01((t - 0.55) / 0.17); x = lerp(0.18, 0.04, k); y = lerp(-0.02, -0.07, k); z = lerp(-0.1, -0.55, k); }
      else { const k = smooth01((t - 0.72) / 0.28); x = lerp(0.04, 0.12, k); y = lerp(-0.07, -0.45, k); z = lerp(-0.55, -0.4, k); }
      R.position.set(x, y, z);
      R.rotation.set(0.3 - t * 0.6, 0.2, -0.2);
      if (obj) {
        obj.position.set(x, y - 0.005, z - 0.01);
        obj.rotation.set(0.2, t * 2, 0.4);
      }
      // Left arm reaches forward for balance.
      const lw = window4(t, 0.1, 0.3, 0.6, 0.85);
      L.position.set(lerp(-0.2, -0.12, lw), lerp(-0.45, -0.12, lw), lerp(-0.3, -0.5, lw));
      L.rotation.set(0, -0.3, -0.6);
      this.styleR = 'grip';
      this.styleL = 'palm';
      return;
    }
    // Healing items
    if (this.itemRise > 0.02 && this.itemId) {
      const id = this.itemId;
      const obj = this.items.show(id);
      const rise = (1 - easeOutCubic(this.itemRise)) * -0.32;
      const prog = self.useProgress >= 0 ? self.useProgress : 1;
      const t = this.time;
      if (!obj) return;
      switch (id) {
        case 'bandage': {
          obj.position.set(-0.02, -0.1 + rise, -0.3);
          obj.rotation.set(0.2, 0.3, 0);
          // Left hand holds the roll, the right hand winds the strip around (circling).
          L.position.set(-0.065, -0.105 + rise, -0.29);
          L.rotation.set(0, 0.3, 1.25);
          const w = t * 6.5;
          R.position.set(0.04 + Math.cos(w) * 0.022, -0.095 + rise + Math.sin(w) * 0.02, -0.28 + Math.sin(w) * 0.012);
          R.rotation.set(0.2, 0, -1.2 + Math.sin(w) * 0.2);
          this.styleR = 'grip';
          this.styleL = 'grip';
          return;
        }
        case 'firstaid':
        case 'medkit': {
          // Held in both palms, tipped toward the body while it is applied.
          const big = id === 'medkit';
          const apply = window4(prog, 0.25, 0.4, 0.8, 0.95);
          const y = (big ? -0.115 : -0.1) + rise + apply * -0.025;
          const z = (big ? -0.36 : -0.32) + apply * 0.06;
          obj.position.set(0, y, z);
          obj.rotation.set(-0.4 - apply * 0.3, Math.sin(t * 1.3) * 0.04, Math.sin(t * 2.1) * 0.03);
          const half = (big ? 0.08 : 0.055);
          R.position.set(half, y - (big ? 0.06 : 0.045), z + 0.02);
          R.rotation.set(-0.4, 0, 0.35);
          L.position.set(-half, y - (big ? 0.06 : 0.045), z + 0.02);
          L.rotation.set(-0.4, 0, -0.35);
          this.styleR = 'palm';
          this.styleL = 'palm';
          return;
        }
        case 'energy': {
          // Raise the can toward the mouth (bottom of the view) and tip it.
          const drink = window4(prog, 0.45, 0.6, 0.88, 0.98);
          obj.position.set(lerp(0.075, 0.035, drink), lerp(-0.1, -0.085, drink) + rise, lerp(-0.32, -0.26, drink));
          obj.rotation.set(drink * 0.95, 0, lerp(-0.1, 0.05, drink));
          R.position.copy(obj.position);
          R.position.y -= 0.005;
          R.rotation.set(drink * 0.95, 0, lerp(-0.1, 0.05, drink));
          this.leftArm.visible = false;
          this.styleR = 'grip';
          return;
        }
        case 'fuel': {
          // Jerry can held by its handle, tipped forward to pour.
          const pour = window4(prog, 0.15, 0.3, 0.85, 0.97);
          obj.scale.setScalar(0.85);
          obj.position.set(0.03, -0.17 + rise - pour * 0.03, -0.5);
          obj.rotation.set(-pour * 0.7, 0.15, Math.sin(t * 1.6) * 0.03);
          obj.updateMatrix();
          R.position.set(-0.005, 0.072, 0).applyMatrix4(obj.matrix);
          R.rotation.set(-pour * 0.7, 0.15, Math.PI / 2);
          L.position.set(-0.07, -0.2, 0.02).applyMatrix4(obj.matrix);
          L.rotation.set(-pour * 0.7, 0, -0.4);
          this.styleR = 'grip';
          this.styleL = 'palm';
          return;
        }
      }
    }
    this.items.show(null);
    // Reviving: both palms press down in front (gun lowered).
    if (this.reviveW > 0.02) {
      const press = Math.max(0, Math.sin(this.time * 9)) * 0.03;
      const y = lerp(-0.45, -0.22, this.reviveW) - press;
      R.position.set(0.05, y, -0.36);
      R.rotation.set(Math.PI - 0.4, 0, 0.2);
      L.position.set(-0.05, y - 0.01, -0.38);
      L.rotation.set(Math.PI - 0.4, 0, -0.2);
      this.styleR = 'palm';
      this.styleL = 'palm';
    }
  }
  /** Hand shapes requested by poseItems this frame (null = keep the weapon's). */
  private styleR: HandStyle | null = null;
  private styleL: HandStyle | null = null;

  // ------------------------------------------------------------------------------------------
  // World mapping (muzzle for FX tracers, casings)
  // ------------------------------------------------------------------------------------------

  /** Viewmodel-camera-space point -> world point that appears at the same place on screen. */
  private vmToWorld(p: THREE.Vector3, main: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    const k = Math.tan((main.fov * Math.PI) / 360) / Math.tan((this.camera.fov * Math.PI) / 360);
    out.set(p.x * k, p.y * k, p.z);
    return out.applyMatrix4(main.matrixWorld);
  }

  private publishMuzzle(inp: VmInput): void {
    const gun = this.gun;
    localMuzzle.viewmodelVisible = this.visible && gun !== null;
    if (!gun || !this.visible) return;
    this.v.copy(gun.muzzle).applyMatrix4(gun.root.matrixWorld);
    this.vmToWorld(this.v, inp.mainCamera, this.worldTmp);
    const out: Vec3 = localMuzzle.pos;
    out.x = this.worldTmp.x; out.y = this.worldTmp.y; out.z = this.worldTmp.z;
    localMuzzle.stamp = performance.now();
    // Keep the flash light at the muzzle (pivot space).
    this.m4.copy(this.pivot.matrixWorld).invert();
    this.flash.light.position.copy(this.v).applyMatrix4(this.m4);
  }

  private ejectCasing(): void {
    const gun = this.gun;
    if (!gun || !this.visible) return;
    const main = this.core.camera;
    this.v.copy(gun.eject).applyMatrix4(gun.root.matrixWorld);
    this.vmToWorld(this.v, main, this.worldTmp);
    // Out to the right, up and slightly back (camera space) + the player's own velocity.
    const side = gun.id === 'shotgun' || gun.id === 'sniper' ? 1.4 : 1.9;
    this.velTmp.set(side + Math.random() * 0.7, 1.3 + Math.random() * 0.6, 0.35 + Math.random() * 0.4).applyQuaternion(main.quaternion);
    this.casings.eject(gun.casing, this.worldTmp.x, this.worldTmp.y, this.worldTmp.z,
      this.velTmp.x + this.playerVel.x, this.velTmp.y + this.playerVel.y, this.velTmp.z + this.playerVel.z);
  }

  /** Player velocity (for casing inheritance), updated by the rig each frame. */
  readonly playerVel = new THREE.Vector3();
}
