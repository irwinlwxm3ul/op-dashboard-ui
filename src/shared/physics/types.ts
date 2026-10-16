// Public data types of the physics module (see ARCHITECTURE.md "src/shared/physics").

import type { LifeState, MovementMode, Stance, Vec3 } from '../types';

/** Per-tick movement intent, built by the sim (server) and by client prediction from PlayerInput. */
export interface MoveIntent {
  /** Strafe right (+) / forward (+) axes, already clamped to the unit circle. */
  mx: number;
  mz: number;
  /** Body heading used as the movement basis. */
  yaw: number;
  sprint: boolean;
  walk: boolean;
  /** Edge-triggered jump press (buffered internally via body.jumpBuffer). */
  jumpPressed: boolean;
  wantStance: Stance;
  /** Weapon / ADS / healing / boost multipliers combined. */
  speedMul: number;
  /** Downed: crawl only (forces prone, no jump, MOVE_SPEED.downedCrawl). */
  downed: boolean;
  /** Freefall / parachute forward lean -1..1 (from mz). 0 falls back to mz. */
  dive: number;
}

/** Discrete things that happened during one movement step. */
export interface MoveEvents {
  jumped: boolean;
  landed: boolean;
  /** Vertical speed at landing (m/s, positive). 0 for landings in deep water. */
  landSpeed: number;
  /** Wanted stance not possible (no headroom). */
  stanceBlocked: boolean;
  enteredWater: boolean;
}

/** Everything needed to place a player's hitboxes (also stored in the lag-compensation history). */
export interface HitboxPose {
  pos: Vec3;
  yaw: number;
  stance: Stance;
  life: LifeState;
  mode: MovementMode;
  lean: number;
}

/** Fresh zeroed events object (allocate once and pass as `out` to avoid per-tick garbage). */
export function createMoveEvents(): MoveEvents {
  return { jumped: false, landed: false, landSpeed: 0, stanceBlocked: false, enteredWater: false };
}

/** Neutral intent (no input, standing). */
export function createMoveIntent(yaw = 0): MoveIntent {
  return {
    mx: 0, mz: 0, yaw, sprint: false, walk: false, jumpPressed: false,
    wantStance: 'stand', speedMul: 1, downed: false, dive: 0,
  };
}

export function resetMoveEvents(e: MoveEvents): MoveEvents {
  e.jumped = false;
  e.landed = false;
  e.landSpeed = 0;
  e.stanceBlocked = false;
  e.enteredWater = false;
  return e;
}
