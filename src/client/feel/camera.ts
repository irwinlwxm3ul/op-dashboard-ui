// Camera / viewmodel feel: trauma shake, cosmetic recoil kick springs, FOV punch, viewmodel kick,
// landing dip, stride-synced head bob and the low-health intensity. Produces FeelState values that
// the view rig (src/client/render/view) adds on top of the true aim, so the crosshair stays honest.
//
// Head bob phase convention: the phase advances by PI per footstep (stride), so a full 2*PI cycle is
// a left + right step. Footfalls happen at phase = k * PI; local footstep events nudge the phase
// back onto that grid so the bob stays in sync with the footstep sounds.

import { MOVE_SPEED } from '../../shared/constants';
import { clamp, damp, smoothstep, TAU } from '../../shared/math';
import type { Stance, WeaponDef } from '../../shared/types';
import type { LocalPlayerView } from '../game/types';
import type { FeelState } from '../render/contracts';
import {
  addTrauma, decayTrauma, kickSpring, limitSpring, shakeNoise, spring, stepSpring, type Spring,
} from './math';

/** Trauma lost per second (linear). */
const TRAUMA_DECAY = 1.4;
/** Shake amplitude at trauma 1 (radians). Shake = trauma^2 * noise * max. */
const SHAKE_MAX_PITCH = 0.045;
const SHAKE_MAX_YAW = 0.04;
const SHAKE_MAX_ROLL = 0.06;
/** Noise lattice frequency (Hz) — fast enough to read as a jolt, slow enough not to buzz. */
const SHAKE_FREQ = 15;

// Spring stiffness (rad/s). Critically damped; an impulse peaks after 1/omega s and settles in ~5/omega.
const W_KICK_PITCH = 16;
const W_KICK_YAW = 18;
const W_KICK_ROLL = 14;
const W_FOV = 11;
const W_VM_BACK = 24;
const W_VM_UP = 17;
const W_VM_ROT = 15;
const W_VM_SIDE = 19;
const W_DIP = 9;

/** Hard limits so sustained automatic fire stays bounded. */
const KICK_LIMIT_PITCH = 0.12;
const KICK_LIMIT_YAW = 0.05;
const KICK_LIMIT_ROLL = 0.06;
const VM_LIMIT_BACK = 0.16;
const VM_LIMIT_UP = 0.07;
const VM_LIMIT_ROT = 0.3;
const VM_LIMIT_SIDE = 0.04;

/** Health below which the low-health effects start. */
export const LOW_HEALTH_THRESHOLD = 35;

/** Shot shake: trauma added per shot = kick.shake * this, capped so sprays never feel like explosions. */
const SHOT_TRAUMA_MUL = 1.5;
const SHOT_TRAUMA_CAP = 0.5;

export class CameraFeel {
  /** Current trauma 0..1 */
  trauma = 0;
  private time = 0;
  private readonly seed = (Math.random() * 0x7fffffff) | 0;

  private readonly kickPitch: Spring = spring();
  private readonly kickYaw: Spring = spring();
  private readonly kickRoll: Spring = spring();
  private readonly fov: Spring = spring();
  private readonly vmBack: Spring = spring();
  private readonly vmUp: Spring = spring();
  private readonly vmRot: Spring = spring();
  private readonly vmSide: Spring = spring();
  private readonly dip: Spring = spring();

  private bobPhase = 0;
  private bobAmount = 0;
  /** Remaining phase correction toward the footstep grid (applied smoothly). */
  private phaseFix = 0;
  private low = 0;

  /** Adds camera trauma (0..1), never pushing it above `cap` through this call. */
  addTrauma(amount: number, cap = 1): void {
    this.trauma = addTrauma(this.trauma, amount, cap);
  }

  /** Cosmetic recoil for a locally predicted shot. */
  shot(w: WeaponDef, ads: number, stance: Stance): void {
    const k = w.kick;
    const stanceMul = stance === 'prone' ? 0.65 : stance === 'crouch' ? 0.85 : 1;
    // Zoomed optics magnify angular motion on screen: tone the camera kick down while scoped.
    const zoomDamp = 1 - 0.45 * ads * (1 - w.adsZoom);
    const camMul = stanceMul * zoomDamp;
    const sign = Math.random() < 0.5 ? -1 : 1;
    const jitter = 0.75 + Math.random() * 0.5;

    kickSpring(this.kickPitch, k.camPitch * camMul * (0.92 + Math.random() * 0.16), W_KICK_PITCH, 0.35);
    kickSpring(this.kickYaw, k.camYaw * sign * jitter * camMul, W_KICK_YAW, 0.35);
    kickSpring(this.kickRoll, k.camRoll * sign * camMul, W_KICK_ROLL, 0.25);
    limitSpring(this.kickPitch, KICK_LIMIT_PITCH);
    limitSpring(this.kickYaw, KICK_LIMIT_YAW);
    limitSpring(this.kickRoll, KICK_LIMIT_ROLL);

    // FOV punch only on big guns (shotgun, DMR, sniper), scaled by the current zoom so a scope
    // gets a proportional (not ballooning) punch.
    const punch = Math.max(0, k.camPitch - 0.015) * 60;
    if (punch > 0) {
      const zoom = 1 + (w.adsZoom - 1) * ads;
      kickSpring(this.fov, punch * zoom, W_FOV, 0.5);
      limitSpring(this.fov, 4);
    }

    // Viewmodel: strong push back, less climb / twist while aiming down sights so the sight stays usable.
    const adsUp = 1 - 0.6 * ads;
    const adsRot = 1 - 0.5 * ads;
    kickSpring(this.vmBack, k.vmBack * stanceMul, W_VM_BACK, 0.5);
    kickSpring(this.vmUp, k.vmUp * adsUp * stanceMul, W_VM_UP, 0.3);
    kickSpring(this.vmRot, k.vmRot * adsRot * stanceMul, W_VM_ROT, 0.3);
    kickSpring(this.vmSide, k.vmBack * 0.25 * sign * jitter * stanceMul, W_VM_SIDE, 0.3);
    limitSpring(this.vmBack, VM_LIMIT_BACK);
    limitSpring(this.vmUp, VM_LIMIT_UP);
    limitSpring(this.vmRot, VM_LIMIT_ROT);
    limitSpring(this.vmSide, VM_LIMIT_SIDE);

    this.addTrauma(k.shake * SHOT_TRAUMA_MUL * zoomDamp, SHOT_TRAUMA_CAP);
  }

  /** Landing: dip proportional to the vertical speed, a slight nod and trauma for hard landings. */
  land(speed: number): void {
    const depth = clamp(speed * 0.011, 0.02, 0.2);
    kickSpring(this.dip, -depth, W_DIP, 0.15);
    kickSpring(this.kickPitch, -depth * 0.12, W_KICK_PITCH, 0.2);
    limitSpring(this.kickPitch, KICK_LIMIT_PITCH);
    const hard = smoothstep(7, 18, speed);
    if (hard > 0) this.addTrauma(hard * 0.55, 0.7);
  }

  /** Small upward camera jolt (parachute canopy opening). */
  jolt(amount: number): void {
    kickSpring(this.dip, amount, W_DIP, 0.2);
  }

  /** Local footstep: pull the bob phase onto the footfall grid (k * PI). */
  footstep(): void {
    if (this.bobAmount < 0.08) return;
    const target = Math.round(this.bobPhase / Math.PI) * Math.PI;
    this.phaseFix = target - this.bobPhase;
  }

  update(self: LocalPlayerView | null, dt: number, out: FeelState): void {
    this.time += dt;

    // ---- Trauma shake ----
    this.trauma = decayTrauma(this.trauma, TRAUMA_DECAY, dt);
    const t2 = this.trauma * this.trauma;
    if (t2 > 0) {
      const nt = this.time * SHAKE_FREQ;
      out.shake.pitch = t2 * SHAKE_MAX_PITCH * shakeNoise(this.seed, nt);
      out.shake.yaw = t2 * SHAKE_MAX_YAW * shakeNoise(this.seed + 101, nt);
      out.shake.roll = t2 * SHAKE_MAX_ROLL * shakeNoise(this.seed + 202, nt);
    } else {
      out.shake.pitch = 0;
      out.shake.yaw = 0;
      out.shake.roll = 0;
    }

    // ---- Springs ----
    stepSpring(this.kickPitch, W_KICK_PITCH, dt);
    stepSpring(this.kickYaw, W_KICK_YAW, dt);
    stepSpring(this.kickRoll, W_KICK_ROLL, dt);
    stepSpring(this.fov, W_FOV, dt);
    stepSpring(this.vmBack, W_VM_BACK, dt);
    stepSpring(this.vmUp, W_VM_UP, dt);
    stepSpring(this.vmRot, W_VM_ROT, dt);
    stepSpring(this.vmSide, W_VM_SIDE, dt);
    stepSpring(this.dip, W_DIP, dt);
    out.kick.pitch = this.kickPitch.x;
    out.kick.yaw = this.kickYaw.x;
    out.kick.roll = this.kickRoll.x;
    out.fovPunch = this.fov.x;
    out.vm.back = this.vmBack.x;
    out.vm.up = this.vmUp.x;
    out.vm.rot = this.vmRot.x;
    out.vm.side = this.vmSide.x;
    out.landDip = this.dip.x;

    // ---- Head bob ----
    let target = 0;
    if (self && self.life === 'alive' && self.vehicleId === null) {
      const speed = Math.hypot(self.vel.x, self.vel.z);
      if (self.mode === 'ground' && self.onGround && self.stance !== 'prone' && speed > 0.25) {
        const stride = self.sprinting ? 2.4 : self.stance === 'crouch' ? 1.45 : speed < 2.6 ? 1.5 : 1.9;
        this.bobPhase += ((speed * dt) / stride) * Math.PI;
        target = Math.min(1, speed / MOVE_SPEED.sprint) * (self.stance === 'crouch' ? 0.75 : 1);
      } else if (self.mode === 'swim' && speed > 0.25) {
        this.bobPhase += ((speed * dt) / 2.6) * Math.PI;
        target = 0.35 * Math.min(1, speed / MOVE_SPEED.swim);
      }
    }
    if (this.phaseFix !== 0) {
      const step = this.phaseFix * damp(14, dt);
      this.bobPhase += step;
      this.phaseFix -= step;
      if (Math.abs(this.phaseFix) < 1e-4) this.phaseFix = 0;
    }
    if (this.bobPhase >= TAU) this.bobPhase -= TAU;
    else if (this.bobPhase < 0) this.bobPhase += TAU;
    // Fade in quickly when starting to move, out a little slower when stopping (no snapping).
    this.bobAmount += (target - this.bobAmount) * damp(target > this.bobAmount ? 8 : 6, dt);
    if (target === 0 && this.bobAmount < 1e-3) this.bobAmount = 0;
    out.bob.phase = this.bobPhase;
    out.bob.amount = this.bobAmount;

    // ---- Low health ----
    let lowTarget = 0;
    if (self) {
      if (self.life === 'downed') lowTarget = 1;
      else if (self.life === 'alive' && self.health < LOW_HEALTH_THRESHOLD) {
        lowTarget = Math.sqrt((LOW_HEALTH_THRESHOLD - Math.max(0, self.health)) / LOW_HEALTH_THRESHOLD);
      }
    }
    this.low += (lowTarget - this.low) * damp(lowTarget > this.low ? 5 : 2.5, dt);
    if (lowTarget === 0 && this.low < 1e-3) this.low = 0;
    out.lowHealth = this.low;
  }
}

/** A zeroed FeelState. */
export function createFeelState(): FeelState {
  return {
    shake: { pitch: 0, yaw: 0, roll: 0 },
    kick: { pitch: 0, yaw: 0, roll: 0 },
    fovPunch: 0,
    vm: { back: 0, up: 0, rot: 0, side: 0 },
    landDip: 0,
    bob: { phase: 0, amount: 0 },
    lowHealth: 0,
  };
}
