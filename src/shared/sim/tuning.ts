// Simulation-local tuning values (the shared gameplay constants live in src/shared/constants.ts).
// Exported so tests, bots and the client can stay consistent with what the server does.

import type { ZoneStage } from '../types';

// ---- Zone ----------------------------------------------------------------------------------

export interface ZonePhaseDef {
  /** Seconds the white (next) circle is shown before the blue zone starts to move. */
  wait: number;
  /** Seconds the blue zone takes to shrink onto the white circle. */
  shrink: number;
  /** Radius (m) of the white circle of this phase. */
  radius: number;
  /** Damage per second outside the blue zone during this phase (ignores armor). */
  damage: number;
}

/** The 8 zone phases. Timings are multiplied by MatchConfig.zoneSpeed. */
export const ZONE_PHASES: readonly ZonePhaseDef[] = [
  { wait: 100, shrink: 90, radius: 320, damage: 0.4 },
  { wait: 80, shrink: 60, radius: 200, damage: 0.6 },
  { wait: 70, shrink: 50, radius: 120, damage: 1.0 },
  { wait: 60, shrink: 40, radius: 70, damage: 2.0 },
  { wait: 50, shrink: 35, radius: 40, damage: 3.5 },
  { wait: 40, shrink: 30, radius: 20, damage: 5 },
  { wait: 30, shrink: 25, radius: 8, damage: 8 },
  { wait: 20, shrink: 20, radius: 0, damage: 12 },
];

/** Seconds (x zoneSpeed) of the 'pre' stage between plane start and the first white circle. */
export const ZONE_PRE_TIME = 30;
/** The first white circle is kept inside this fraction of the map half-size (stays on the island). */
export const ZONE_FIRST_LIMIT = 0.92;
/** Attempts to find a circle centre on land before falling back to the previous centre. */
export const ZONE_CENTER_TRIES = 48;
/** Radius used by the training ground "zone" (effectively disabled). */
export const TRAINING_ZONE_RADIUS = 100000;

export const ZONE_STAGES: readonly ZoneStage[] = ['pre', 'waiting', 'shrinking', 'final'];

// ---- Plane -----------------------------------------------------------------------------------

/** The flight line passes within this distance (m) of the island centre. */
export const PLANE_CENTER_SPREAD = 200;
/** Path start / end lie this far beyond the map edges (m). */
export const PLANE_EDGE_MARGIN = 60;
/** Players still aboard are ejected when the plane has covered this fraction of its path. */
export const PLANE_AUTO_EJECT = 0.9;
/** Jumpers appear this far behind the plane (m) plus a small per-player spread. */
export const PLANE_JUMP_BACK = 6;
export const PLANE_JUMP_SPREAD = 3;
/** Fraction of the plane's speed carried by a jumper. */
export const PLANE_JUMP_CARRY = 0.25;

// ---- Weapons / handling ------------------------------------------------------------------------

/** Movement speed multiplier at full ADS. */
export const ADS_MOVE_MUL = 0.65;
/** Spray index resets once the trigger has been released for this many fire intervals. */
export const SPRAY_RESET_INTERVALS = 1.5;
/** Hard cap on accumulated server recoil (radians). */
export const MAX_RECOIL_PITCH = 0.6;
export const MAX_RECOIL_YAW = 0.35;
/** Pitch clamp for effective aim (radians, 89 deg). */
export const PITCH_LIMIT = (89 * Math.PI) / 180;
/** Draw time when switching to fists (s). */
export const FISTS_DRAW_TIME = 0.15;
/** PF.FIRING is set for this long after a shot (s). */
export const FIRING_FLAG_TIME = 0.2;
/** Minimum horizontal input that counts as "moving" for revive / sprint checks. */
export const MOVE_DEADZONE = 0.1;
/** Physics sprints only when forward input exceeds this (mirrors the character controller). */
export const SPRINT_MIN_FORWARD = 0.3;

// ---- Hit detection -----------------------------------------------------------------------------

/** Broadphase: only players whose centre is this close to a ray are tested against hitboxes. */
export const RAY_BROADPHASE = 3;
/** Vehicles take this fraction of weapon damage. */
export const VEHICLE_BULLET_MUL = 0.5;
/** Ballistic projectile sub-step (s). */
export const PROJECTILE_SUBSTEP = 1 / 120;
/** Projectiles are removed after this many seconds. */
export const PROJECTILE_LIFETIME = 3;
/** Training dummy part classification: top fraction of a target box counts as head. */
export const TARGET_HEAD_FRAC = 0.22;

// ---- Throwables --------------------------------------------------------------------------------

export const THROW_COOLDOWN = 1.0;
/** Upward bias added to the throw pitch (radians). */
export const THROW_UP_BIAS = 0.17;
/** Fraction of the thrower's velocity inherited by the grenade. */
export const THROW_INHERIT = 0.5;
export const FRAG_GRAVITY = 9.81;
export const FRAG_RESTITUTION = 0.32;
export const FRAG_FRICTION = 0.7;
export const FRAG_REST_SPEED = 0.6;
/** Explosion damage multiplier applied to vehicles. */
export const FRAG_VEHICLE_MUL = 2.5;

// ---- Downed / revive / healing -----------------------------------------------------------------

/** Health after a successful revive. */
export const REVIVE_HEALTH = 10;
/** Extra range slack while a revive is in progress (m). */
export const REVIVE_KEEP_SLACK = 0.6;
/** Pickup range tolerance on top of INTERACT_RANGE (latency slack). */
export const INTERACT_SLACK = 0.3;
/** Fuel can adds this fraction of the tank. */
export const REFUEL_FRACTION = 0.5;

// ---- Vehicles ----------------------------------------------------------------------------------

/** Bailing out faster than this (m/s) hurts: (speed - BAIL_SPEED) * BAIL_DAMAGE_PER_MS. */
export const BAIL_SPEED = 8;
export const BAIL_DAMAGE_PER_MS = 3;
/** Vehicles must be faster than this (m/s) to run players over. */
export const RUNOVER_SPEED = 4;
/** Run-over damage per m/s above RUNOVER_SPEED. */
export const RUNOVER_DAMAGE_PER_MS = 6.5;
/** A player cannot be run over twice within this time (s). */
export const RUNOVER_COOLDOWN = 0.6;
/** Crashes softer than this (m/s) are ignored for damage/events. */
export const CRASH_MIN_IMPACT = 3;
/** Seconds a wreck burns before exploding. */
export const VEHICLE_BURN_TIME = 5;
export const VEHICLE_EXPLOSION_RADIUS = 6;
export const VEHICLE_EXPLOSION_DAMAGE = 150;
/** Training ground: destroyed vehicles respawn after this many seconds. */
export const VEHICLE_RESPAWN_TIME = 10;
/** Seeded initial fuel fraction range. */
export const VEHICLE_FUEL_MIN = 0.3;
export const VEHICLE_FUEL_MAX = 0.9;
/** Parked vehicles go to sleep (skip physics) after this many still ticks. */
export const VEHICLE_SLEEP_TICKS = 20;
export const VEHICLE_SLEEP_SPEED = 0.05;

// ---- Noise (bot hearing) ----------------------------------------------------------------------

export const NOISE_LIFETIME = 3;
export const NOISE_VEHICLE_INTERVAL = 0.5;
export const NOISE_VEHICLE_RADIUS = 150;
export const NOISE_FOOTSTEP_INTERVAL = 0.35;
export const NOISE_FOOTSTEP_RADIUS = 30;
export const NOISE_EXPLOSION_RADIUS = 500;
export const NOISE_IMPACT_RADIUS = 20;

// ---- Event audiences (ranges in m) -------------------------------------------------------------

export const EVENT_RANGE = {
  shot: 1100,
  impact: 300,
  near: 150,
  movement: 250,
  vehicle: 500,
  explosion: 1200,
} as const;

// ---- Loot --------------------------------------------------------------------------------------

/** Fraction of world loot spawns that receive items. */
export const LOOT_FILL = 0.75;
export const LOOT_CELL = 16;
/** Spill ring radius around a dead body (m). */
export const SPILL_RADIUS = 0.75;

// ---- Training ----------------------------------------------------------------------------------

export const TRAINING_RESPAWN_DELAY = 3;
/** Minimum seconds between two `give` actions. */
export const GIVE_COOLDOWN = 0.2;
export const GIVE_AMMO = 60;
export const GIVE_COUNTS: Record<string, number> = {
  bandage: 5, firstaid: 3, medkit: 1, energy: 3, fuel: 1, frag: 3,
};
/** Spacing between training spawn points (m). */
export const TRAINING_SPAWN_SPACING = 2.5;

// ---- Match flow --------------------------------------------------------------------------------

/** Dead players are listed in snapshots for this long (s) before being reported as gone. */
export const DEAD_VISIBLE_TIME = 5;
/** Players that exchanged damage with a client stay full-rate for this long (s). */
export const COMBAT_RELEVANCE_TIME = 2;
/** Projectiles further than this from the viewpoint are not sent (m). */
export const PROJECTILE_RELEVANCE = 800;
/** Max catch-up ticks per MatchRunner.update before the backlog is dropped. */
export const MAX_CATCHUP_TICKS = 5;
