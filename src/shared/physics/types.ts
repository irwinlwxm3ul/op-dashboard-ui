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

/**
 * A moving solid the character controller collides with (a vehicle hull): a footprint rectangle
 * rotated about Y, a vertical span from `y0` (ground contact) to the top surface, and a top that
 * can be stood on. Bodies are pushed out of it horizontally only where their vertical span
 * overlaps it, so a body standing on its roof (or on a bridge above it) is left alone.
 * Build one per vehicle with `vehicleObstacle` (src/shared/vehicles).
 */
export interface CharObstacle {
  /** Footprint centre (XZ). */
  x: number;
  z: number;
  /** cos / sin of the footprint yaw (local +X = (c, 0, -s), local +Z = (s, 0, c)). */
  c: number;
  s: number;
  /** Footprint half extents along local X / Z. */
  hx: number;
  hz: number;
  /** Bounding radius of the footprint (broad phase). */
  br: number;
  /** Lowest point of the solid (hull bottom extended down to the ground contact). */
  y0: number;
  /** Highest point of the top surface. */
  y1: number;
  /** Top surface: height above the footprint centre and its slope per metre along world X / Z. */
  top: number;
  gx: number;
  gz: number;
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
