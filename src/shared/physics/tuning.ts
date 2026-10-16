// Physics tuning values that are local to the physics module (the shared gameplay constants live in
// src/shared/constants.ts). Exported so the client (camera, prediction smoothing) and the sim can
// stay consistent with what the controller actually does.

import { CHAR_GRAVITY_MUL, GRAVITY, MAX_SLOPE_DEG, PLAYER_RADIUS, STEP_HEIGHT } from '../constants';

// ---- Integration ----
/** Maximum distance (m) the body may travel in one sub-step. Smaller than PLAYER_RADIUS so a
 *  circle can never tunnel through a wall of any thickness. */
export const SUBSTEP_MAX_MOVE = 0.25;
/** Hard cap on sub-steps per call (66 m/s dive at 30 Hz needs 9). */
export const MAX_SUBSTEPS = 32;

// ---- Character ----
/** Effective character gravity (m/s^2). */
export const CHAR_GRAVITY = GRAVITY * CHAR_GRAVITY_MUL;
/** Ground contact is kept (snapped) when the support drops by at most this much in a sub-step:
 *  walking down stairs and slopes never turns into tiny falls. */
export const STEP_DOWN = STEP_HEIGHT + 0.05;
/** While airborne, ledges up to this far above the feet are climbed onto ("ledge assist"). */
export const AIR_STEP = 0.2;
/** Support footprint as a fraction of the collision radius: you can lean over an edge a bit
 *  before falling off, and step-up kicks in once the foot is properly over the step. */
export const SUPPORT_RADIUS_FRAC = 0.8;
/** Below this speed ground friction removes a constant amount (Quake style) so the body comes to
 *  a crisp stop instead of creeping. */
export const STOP_SPEED = 1.5;
/** cos(MAX_SLOPE_DEG): terrain with normal.y below this is too steep to stand on. */
export const COS_MAX_SLOPE = Math.cos((MAX_SLOPE_DEG * Math.PI) / 180);
/** Crouch walking (walk key held) speed relative to normal crouch speed. */
export const CROUCH_WALK_MUL = 0.6;
/** Upper bound for intent.speedMul (defensive; the sim combines weapon/ADS/boost multipliers). */
export const MAX_SPEED_MUL = 2;

// ---- Water ----
/** Enter swim mode when the water above the terrain is deeper than this (m). */
export const SWIM_ENTER_DEPTH = 1.3;
/** Leave swim mode when the water gets shallower than this (m). */
export const SWIM_EXIT_DEPTH = 1.1;
/** While swimming the feet are held this far below the surface (head stays above water). */
export const SWIM_FEET_DEPTH = 1.25;
/** Falling bodies only switch to swimming once their feet are this far under the surface. */
export const SWIM_SUBMERGE_DEPTH = 1.0;
export const SWIM_ACCEL = 14;
export const SWIM_FRICTION = 4;
/** Exponential rate (1/s) with which a swimmer floats to the swim height. */
export const SWIM_FLOAT_RATE = 5;

// ---- Eye / lean ----
export const SEATED_EYE_HEIGHT = 1.1;
/** Prone eye sits slightly ahead of the body centre (at the face), still inside the collision
 *  radius so the camera can never poke through a wall. */
export const PRONE_EYE_FORWARD = 0.3;
export const LEAN_OFFSET = 0.35;
export const LEAN_DROP = 0.05;

// ---- Drop (freefall / parachute) ----
/** Max downward acceleration while speeding up in freefall (m/s^2). */
export const FREEFALL_GRAVITY = GRAVITY * 3;
/** Exponential rates (1/s) for easing toward the target velocities. */
export const FREEFALL_VERTICAL_RATE = 1.5;
export const FREEFALL_HORIZONTAL_RATE = 0.9;
export const FREEFALL_BRAKE_RATE = 1.6;
/** Flare (back input) slows the freefall descent by this fraction at full input. */
export const FREEFALL_FLARE_SLOW = 0.12;
/** Strafe input authority relative to the max horizontal speed. */
export const FREEFALL_STRAFE = 0.6;
export const PARACHUTE_DIVE_DESCENT = 9;
export const PARACHUTE_FLARE_DESCENT = 4.5;
/** Constant forward drift with no input, as a fraction of PARACHUTE_HORIZONTAL. */
export const PARACHUTE_DRIFT = 0.45;
/** Forward speed with full back input, as a fraction of PARACHUTE_HORIZONTAL. */
export const PARACHUTE_BRAKE_FWD = 0.1;
export const PARACHUTE_STRAFE = 0.7;
export const PARACHUTE_VERTICAL_RATE = 2.0;
export const PARACHUTE_HORIZONTAL_RATE = 1.4;

// ---- World colliders ----
/** Tree trunk collision height as a fraction of the total tree height. */
export const TREE_TRUNK_FRAC = 0.6;

/** Contact skin used when testing whether a circle merely touches a collider. */
export const CONTACT_SKIN = 0.01;

/** Radius of the support footprint. */
export const SUPPORT_RADIUS = PLAYER_RADIUS * SUPPORT_RADIUS_FRAC;
