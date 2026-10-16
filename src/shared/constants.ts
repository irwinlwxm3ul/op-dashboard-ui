// Global gameplay / engine constants shared by client, server and simulation.
// Units: meters, seconds, radians unless stated otherwise. Y is up.

export const PROTOCOL_VERSION = 1;

// ---- Simulation timing ----
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
export const SNAPSHOT_RATE = 20;
/** Remote entities are rendered this far in the past (ms). */
export const INTERP_DELAY_MS = 100;
/** Max extrapolation when snapshots are late (ms). */
export const MAX_EXTRAPOLATE_MS = 150;
/**
 * Lag compensation: hard cap on the rewind applied to a shot (ms). Each shot's rewind is further
 * bounded per player by its measured RTT + interpolation delay (+ queue wait), so honest players up
 * to ~350 ms RTT are fully compensated while a client can never rewind further than it really lags.
 */
export const MAX_REWIND_MS = 500;
/** Hitbox history length kept on the server (ms). */
export const HITBOX_HISTORY_MS = 1000;
/** Input rate limiting: token bucket refills at TICK_RATE * this per second. */
export const INPUT_RATE_SLACK = 1.25;
export const INPUT_BURST = 8;

// ---- Map ----
export const MAP_SIZE = 1024;
export const HALF_MAP = MAP_SIZE / 2;
/** Heightmap vertices per side (4 m spacing). */
export const TERRAIN_RES = 257;
export const TERRAIN_CELL = MAP_SIZE / (TERRAIN_RES - 1);
export const WATER_LEVEL = 0;
export const TRAINING_MAP_SIZE = 768;

// ---- Physics ----
export const GRAVITY = 9.81;
/** Extra gravity multiplier for characters (snappier jumps). */
export const CHAR_GRAVITY_MUL = 2.0;
export const PLAYER_RADIUS = 0.35;
export const STANCE_HEIGHT = { stand: 1.8, crouch: 1.2, prone: 0.55 } as const;
export const EYE_HEIGHT = { stand: 1.62, crouch: 1.05, prone: 0.4 } as const;
export const STEP_HEIGHT = 0.45;
export const MAX_SLOPE_DEG = 50;
export const MOVE_SPEED = {
  walk: 4.7,
  sprint: 6.3,
  crouch: 2.7,
  prone: 1.2,
  swim: 2.4,
  slowWalk: 1.9,
  downedCrawl: 0.9,
} as const;
export const GROUND_ACCEL = 55;
export const GROUND_FRICTION = 10;
export const AIR_ACCEL = 8;
export const JUMP_VELOCITY = 5.6;
export const COYOTE_TIME = 0.1;
export const JUMP_BUFFER_TIME = 0.1;
/** Fall speed above which landing hurts (m/s) and damage per m/s beyond it. */
export const FALL_DAMAGE_SPEED = 13;
export const FALL_DAMAGE_PER_MS = 9;

// ---- Drop ----
export const PLANE_ALTITUDE = 320;
export const PLANE_SPEED = 70;
export const FREEFALL_SPEED = 52;
export const FREEFALL_DIVE_SPEED = 66;
export const FREEFALL_HORIZONTAL = 28;
export const PARACHUTE_DESCENT = 6;
export const PARACHUTE_HORIZONTAL = 11;
/** Parachute auto-opens at this height above ground (m). */
export const AUTO_CHUTE_HEIGHT = 120;
/** Can't open chute until this many meters below the plane. */
export const MIN_CHUTE_DROP = 15;

// ---- Health / combat ----
export const MAX_HEALTH = 100;
export const MAX_BOOST = 100;
export const HEAL_CAP_PARTIAL = 75;
export const DOWNED_HEALTH = 100;
/** Downed health lost per second (increases with each knock in the same life). */
export const DOWNED_BLEED_PER_SEC = 4;
export const REVIVE_TIME = 6;
export const INTERACT_RANGE = 3;
export const REVIVE_RANGE = 2.2;
export const VEHICLE_ENTER_RANGE = 4;
export const SPEED_OF_SOUND = 343;
export const SUPPRESSION_RADIUS = 3;

// ---- Visibility / LOD ----
export const PLAYER_RENDER_DISTANCE = 1000;
export const LOD_NEAR = 50;
export const LOD_MID = 250;
export const LOD_HYSTERESIS = 6;
export const ENEMY_NAMEPLATE_RANGE = 200;
/** Server interest management: distances (m) and snapshot divisors. */
export const RELEVANCE_BANDS = [
  { maxDist: 150, every: 1 },
  { maxDist: 500, every: 2 },
  { maxDist: Infinity, every: 5 },
] as const;

// ---- Limits ----
export const MAX_PLAYERS = 64;
export const MIN_PLAYERS = 2;
export const MAX_VEHICLES = 24;
export const MAX_PROJECTILES = 200;
export const MAX_NAME_LEN = 16;
export const MAX_LOBBY_NAME_LEN = 24;
export const MAX_CHAT_LEN = 140;
export const MAX_MESSAGE_BYTES = 16 * 1024;

export const DEFAULT_SERVER_PORT = 8787;
