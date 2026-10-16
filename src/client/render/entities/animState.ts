// Logical animation state of a player: a renderer-agnostic description ("walk at 1.4 Hz with the
// rifle, reloading") derived from the PlayerView. The procedural soldier does not need it (it blends
// poses directly), but clip-based character backends (skinned glTF characters with an
// AnimationMixer) pick their clips from it, and can sync locomotion clips to the gait cadence via
// `cycleHz` (one clip loop = one gait cycle = two footfalls, matching footstep sounds).

import { PF } from '../../../shared/protocol';
import type { PlayerView } from '../../game/types';
import { strideLength } from './pose';
import { WEAPON_HOLD } from './weaponModels';

export type LogicalAnimState =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'jump'
  | 'crouchIdle' | 'crouchWalk'
  | 'prone' | 'crawl'
  | 'downed' | 'downedCrawl'
  | 'swimIdle' | 'swim'
  | 'freefall' | 'dive' | 'parachute'
  | 'drive' | 'ride' | 'sit'
  | 'revive' | 'heal'
  | 'death';

/** Upper-body layer on top of the base state. */
export type LogicalAnimOverlay = 'none' | 'aim' | 'shoot' | 'reload';

export type WeaponClass = 'none' | 'pistol' | 'long';

export interface LogicalAnim {
  state: LogicalAnimState;
  overlay: LogicalAnimOverlay;
  weaponClass: WeaponClass;
  /** Gait cycles per second for locomotion states (0 when not moving). */
  cycleHz: number;
  /** Horizontal speed (m/s). */
  speed: number;
  /** Seconds since death (death state), else 0. */
  deadFor: number;
}

export function createLogicalAnim(): LogicalAnim {
  return { state: 'idle', overlay: 'none', weaponClass: 'none', cycleHz: 0, speed: 0, deadFor: 0 };
}

const MOVING = 0.3;

/** Resolve the logical state of `v` (horizontal speed `speed`) into `out`. Allocation free. */
export function resolveLogicalAnim(v: PlayerView, speed: number, out: LogicalAnim): LogicalAnim {
  const f = v.flags;
  const sprinting = (f & PF.SPRINT) !== 0;
  out.speed = speed;
  out.cycleHz = 0;
  out.deadFor = 0;
  out.weaponClass = v.weapon === null ? 'none' : WEAPON_HOLD[v.weapon].pistol ? 'pistol' : 'long';
  out.overlay = 'none';
  if (v.weapon !== null && v.life === 'alive') {
    if ((f & PF.RELOADING) !== 0) out.overlay = 'reload';
    else if ((f & PF.FIRING) !== 0) out.overlay = 'shoot';
    else if ((f & PF.ADS) !== 0) out.overlay = 'aim';
  }
  if (v.life === 'dead') {
    out.state = 'death';
    out.deadFor = Math.max(0, v.deadFor);
    return out;
  }
  if (v.life === 'downed') {
    out.state = speed > MOVING ? 'downedCrawl' : 'downed';
    if (speed > MOVING) out.cycleHz = speed / strideLength('downed', speed, false);
    return out;
  }
  switch (v.mode) {
    case 'vehicle':
      out.state = v.seat === 0 ? 'drive' : out.weaponClass === 'none' ? 'sit' : 'ride';
      return out;
    case 'freefall':
      out.state = -v.vel.y > 58 ? 'dive' : 'freefall';
      return out;
    case 'parachute':
      out.state = 'parachute';
      return out;
    case 'swim':
      out.state = speed > MOVING ? 'swim' : 'swimIdle';
      if (speed > MOVING) out.cycleHz = speed / strideLength('swim', speed, false);
      return out;
    default:
      break;
  }
  if ((f & PF.REVIVING) !== 0) {
    out.state = 'revive';
    return out;
  }
  if ((f & PF.HEALING) !== 0 && speed <= MOVING) {
    out.state = 'heal';
    return out;
  }
  if ((f & PF.ON_GROUND) === 0 && Math.abs(v.vel.y) > 1.2 && v.stance !== 'prone') {
    out.state = 'jump';
    return out;
  }
  if (v.stance === 'prone') {
    out.state = speed > 0.2 ? 'crawl' : 'prone';
    if (speed > 0.2) out.cycleHz = speed / strideLength('prone', speed, false);
    return out;
  }
  if (v.stance === 'crouch') {
    out.state = speed > MOVING ? 'crouchWalk' : 'crouchIdle';
    if (speed > MOVING) out.cycleHz = speed / strideLength('crouch', speed, false);
    return out;
  }
  if (speed <= MOVING) {
    out.state = 'idle';
    return out;
  }
  out.cycleHz = speed / strideLength('stand', speed, sprinting);
  out.state = sprinting ? 'sprint' : speed > 3.2 ? 'run' : 'walk';
  return out;
}
