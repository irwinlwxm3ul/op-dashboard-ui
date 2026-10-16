// Character controller for modes 'ground' and 'swim'.
//
// The body is a vertical cylinder (radius PLAYER_RADIUS, height by stance) whose `pos` is the
// centre of the feet. One call advances one tick and is fully deterministic: the client runs it
// for prediction and the server for authority, so it only reads the world and mutates the body
// and the events object.
//
// Per tick: stance -> jump -> horizontal velocity (accel / friction / air control) -> sub-stepped
// integration (<= SUBSTEP_MAX_MOVE per sub-step) with collision against boxes, trunks and rocks,
// step-up / step-down, ceilings, slopes and water.

import {
  AIR_ACCEL, COYOTE_TIME, GROUND_ACCEL, GROUND_FRICTION, JUMP_BUFFER_TIME, JUMP_VELOCITY, MOVE_SPEED,
  PLAYER_RADIUS, STANCE_HEIGHT, STEP_HEIGHT,
} from '../constants';
import type { CharacterBody, Stance, Vec3, World } from '../types';
import {
  SUPPORT_TERRAIN, canStandGathered, ceilingAbove, clampToBounds, gatherNear, resolveCircle, resolved,
  spanBlocked, support, supportHeight, supportWalkable,
} from './colliders';
import { stepDrop } from './drop';
import type { MoveEvents, MoveIntent } from './types';
import { createMoveEvents, resetMoveEvents } from './types';
import {
  AIR_STEP, CHAR_GRAVITY, CONTACT_SKIN, CROUCH_WALK_MUL, MAX_SPEED_MUL, MAX_SUBSTEPS, SLIDE_FRICTION,
  STEP_DOWN, STOP_SPEED, SUBSTEP_MAX_MOVE, SUPPORT_RADIUS, SWIM_ACCEL, SWIM_EXIT_DEPTH, SWIM_FEET_DEPTH,
  SWIM_FLOAT_RATE, SWIM_FRICTION, MAX_STEP_DT,
} from './tuning';
import { enterSwim, groundBelow, shouldSwim, waterDepthBelow } from './water';

const R = PLAYER_RADIUS;
/** Tolerance for "the support is higher than the feet". */
const RISE_EPS = 1e-4;
/** Small allowance for coyote / buffer timers so float accumulation never drops a tick. */
const TIMER_EPS = 1e-6;

const nScratch: Vec3 = { x: 0, y: 1, z: 0 };

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

/** Sanitised intent values for this step (module scratch). */
const inp = { mx: 0, mz: 0, speedMul: 1 };

function readInput(intent: MoveIntent): void {
  let mx = fin(intent.mx), mz = fin(intent.mz);
  const l2 = mx * mx + mz * mz;
  if (l2 > 1) {
    const il = 1 / Math.sqrt(l2);
    mx *= il;
    mz *= il;
  }
  inp.mx = mx;
  inp.mz = mz;
  const sm = fin(intent.speedMul, 1);
  inp.speedMul = sm < 0 ? 0 : sm > MAX_SPEED_MUL ? MAX_SPEED_MUL : sm;
}

function isStance(s: unknown): s is Stance {
  return s === 'stand' || s === 'crouch' || s === 'prone';
}

/** Target ground speed (m/s) for the current stance and input. */
function groundSpeed(body: CharacterBody, intent: MoveIntent): number {
  let s: number;
  if (intent.downed) s = MOVE_SPEED.downedCrawl;
  else if (body.stance === 'prone') s = MOVE_SPEED.prone;
  else if (body.stance === 'crouch') s = intent.walk ? MOVE_SPEED.crouch * CROUCH_WALK_MUL : MOVE_SPEED.crouch;
  else if (intent.walk) s = MOVE_SPEED.slowWalk;
  else if (intent.sprint && inp.mz > 0.3) s = MOVE_SPEED.sprint;
  else s = MOVE_SPEED.walk;
  return s * inp.speedMul;
}

/** Move the horizontal velocity toward (tx, tz) by at most maxDelta. */
function accelerateXZ(vel: Vec3, tx: number, tz: number, maxDelta: number): void {
  const ex = tx - vel.x, ez = tz - vel.z;
  const e = Math.sqrt(ex * ex + ez * ez);
  if (e <= maxDelta || e < 1e-9) {
    vel.x = tx;
    vel.z = tz;
  } else {
    const k = maxDelta / e;
    vel.x += ex * k;
    vel.z += ez * k;
  }
}

/** Quake-style ground friction: proportional, with a minimum "control" speed for crisp stops. */
function applyFriction(vel: Vec3, friction: number, dt: number): void {
  const sp = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  if (sp < 1e-4) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = sp < STOP_SPEED ? STOP_SPEED : sp;
  let ns = sp - control * friction * dt;
  if (ns < 0) ns = 0;
  const k = ns / sp;
  vel.x *= k;
  vel.z *= k;
}

// ---------------------------------------------------------------------------
// Stance
// ---------------------------------------------------------------------------

function updateStance(body: CharacterBody, intent: MoveIntent, out: MoveEvents): void {
  let want: Stance = intent.downed ? 'prone' : isStance(intent.wantStance) ? intent.wantStance : body.stance;
  // Cannot go prone in mid-air; keep the current stance until landing.
  if (!body.onGround && want === 'prone' && body.stance !== 'prone' && !intent.downed) want = body.stance;
  if (want === body.stance) return;
  if (STANCE_HEIGHT[want] <= STANCE_HEIGHT[body.stance]) {
    body.stance = want;
    return;
  }
  const p = body.pos;
  if (canStandGathered(p.x, p.y, p.z, want)) {
    body.stance = want;
    return;
  }
  out.stanceBlocked = true;
  // Prone -> stand under a low ceiling: get as high as possible.
  if (want === 'stand' && body.stance === 'prone' && canStandGathered(p.x, p.y, p.z, 'crouch')) {
    body.stance = 'crouch';
  }
}

// ---------------------------------------------------------------------------
// Jump
// ---------------------------------------------------------------------------

function canJump(body: CharacterBody, intent: MoveIntent): boolean {
  if (intent.downed || body.stance === 'prone' || body.mode !== 'ground') return false;
  return body.onGround || (body.airTime <= COYOTE_TIME + TIMER_EPS && body.vel.y <= 0);
}

function doJump(body: CharacterBody, out: MoveEvents): void {
  const p = body.pos;
  // Jumping out of a crouch stands up when there is room.
  if (body.stance === 'crouch' && canStandGathered(p.x, p.y, p.z, 'stand')) body.stance = 'stand';
  body.vel.y = JUMP_VELOCITY;
  body.onGround = false;
  // Consume the coyote window so a second press mid-air cannot jump again.
  if (body.airTime < COYOTE_TIME + TIMER_EPS) body.airTime = COYOTE_TIME + TIMER_EPS;
  body.jumpBuffer = 0;
  body.fallSpeed = 0;
  out.jumped = true;
}

// ---------------------------------------------------------------------------
// Ground mode sub-step
// ---------------------------------------------------------------------------

/** Remove the uphill component of a horizontal displacement / velocity on steep terrain. */
let steepNX = 0, steepNZ = 0;
function steepDownhill(world: World, x: number, z: number): boolean {
  world.normalAt(x, z, nScratch);
  const hl = Math.sqrt(nScratch.x * nScratch.x + nScratch.z * nScratch.z);
  if (hl < 1e-6) return false;
  steepNX = nScratch.x / hl;
  steepNZ = nScratch.z / hl;
  return true;
}

/**
 * Advance a ground-mode body by h seconds. Returns false when the body switched to swim mode
 * (the remainder of the tick is then skipped).
 */
function groundSubstep(
  body: CharacterBody, intent: MoveIntent, h: number, world: World, out: MoveEvents,
): boolean {
  const pos = body.pos, vel = body.vel;
  const height = STANCE_HEIGHT[body.stance];
  const x0 = pos.x, y0 = pos.y, z0 = pos.z;

  if (body.onGround) {
    vel.y = 0;
    // ---- walking ----
    let nx = x0 + vel.x * h, nz = z0 + vel.z * h;
    resolveCircle(nx, nz, R, y0 + STEP_HEIGHT, y0 + height, vel);
    nx = resolved.x;
    nz = resolved.z;
    let sup = supportHeight(world, nx, nz, y0 + STEP_HEIGHT, SUPPORT_RADIUS);
    let walkable = supportWalkable(world, nx, nz);

    if (sup > y0 + RISE_EPS && support.kind === SUPPORT_TERRAIN && !walkable) {
      // Walking into a slope that is too steep: slide along its contour instead of climbing.
      if (steepDownhill(world, nx, nz)) {
        let ddx = nx - x0, ddz = nz - z0;
        const dn = ddx * steepNX + ddz * steepNZ;
        if (dn < 0) { ddx -= dn * steepNX; ddz -= dn * steepNZ; }
        const vn = vel.x * steepNX + vel.z * steepNZ;
        if (vn < 0) { vel.x -= vn * steepNX; vel.z -= vn * steepNZ; }
        resolveCircle(x0 + ddx, z0 + ddz, R, y0 + STEP_HEIGHT, y0 + height, vel);
        nx = resolved.x;
        nz = resolved.z;
        sup = supportHeight(world, nx, nz, y0 + STEP_HEIGHT, SUPPORT_RADIUS);
        walkable = supportWalkable(world, nx, nz);
      }
      if (sup > y0 + RISE_EPS && support.kind === SUPPORT_TERRAIN && !walkable) {
        // Still climbing (e.g. a crevice): stay put.
        nx = x0;
        nz = z0;
        sup = supportHeight(world, nx, nz, y0 + STEP_HEIGHT, SUPPORT_RADIUS);
        walkable = supportWalkable(world, nx, nz);
      }
    }

    if (sup > y0 + RISE_EPS && spanBlocked(nx, nz, R - 2 * CONTACT_SKIN, y0 + height, sup + height)) {
      // Stepping up would push the head into something: treat steps as walls this sub-step.
      resolveCircle(x0 + vel.x * h, z0 + vel.z * h, R, y0 + CONTACT_SKIN, y0 + height, vel);
      nx = resolved.x;
      nz = resolved.z;
      sup = supportHeight(world, nx, nz, y0 + CONTACT_SKIN, SUPPORT_RADIUS);
      walkable = supportWalkable(world, nx, nz);
      if (sup > y0 + RISE_EPS) {
        // Terrain rising under a ceiling: no room to move there.
        nx = x0;
        nz = z0;
        sup = supportHeight(world, nx, nz, y0 + CONTACT_SKIN, SUPPORT_RADIUS);
        walkable = supportWalkable(world, nx, nz);
      }
    }

    pos.x = nx;
    pos.z = nz;
    if (sup >= y0 - STEP_DOWN && (walkable || support.kind !== SUPPORT_TERRAIN)) {
      // Step up / follow the ground down (stairs, slopes) without leaving it.
      pos.y = sup;
      return true;
    }
    // Walked off a ledge or onto a slope too steep to stand on: start falling / sliding.
    body.onGround = false;
    if (sup > y0) pos.y = sup;
    return true;
  }

  // ---- airborne (jumping, falling, sliding on steep terrain) ----
  const vy0 = vel.y;
  let ny = y0 + vy0 * h - 0.5 * CHAR_GRAVITY * h * h;
  vel.y = vy0 - CHAR_GRAVITY * h;

  resolveCircle(x0 + vel.x * h, z0 + vel.z * h, R, y0 + AIR_STEP, y0 + height, vel);
  const nx = resolved.x, nz = resolved.z;

  if (ny > y0) {
    // Ceilings stop upward motion.
    const c = ceilingAbove(nx, nz, R - CONTACT_SKIN, y0 + height - CONTACT_SKIN);
    if (ny + height > c) {
      ny = Math.max(y0, c - height);
      if (vel.y > 0) vel.y = 0;
    }
  }

  const sup = supportHeight(world, nx, nz, (ny > y0 ? ny : y0) + AIR_STEP, SUPPORT_RADIUS);
  pos.x = nx;
  pos.z = nz;

  if (ny <= sup) {
    if (support.kind === SUPPORT_TERRAIN && !supportWalkable(world, nx, nz)) {
      // Steep terrain: slide down it. Lose the velocity into the surface and apply slide friction.
      pos.y = sup;
      world.normalAt(nx, nz, nScratch);
      const vn = vel.x * nScratch.x + vel.y * nScratch.y + vel.z * nScratch.z;
      if (vn < 0) {
        vel.x -= vn * nScratch.x;
        vel.y -= vn * nScratch.y;
        vel.z -= vn * nScratch.z;
      }
      const k = Math.max(0, 1 - SLIDE_FRICTION * h);
      vel.x *= k;
      vel.y *= k;
      vel.z *= k;
      if (-vel.y > body.fallSpeed) body.fallSpeed = -vel.y;
      return true;
    }
    pos.y = sup;
    if (vel.y > 0) {
      // Rising past a low ledge (ledge assist): pop onto it and keep going up.
      return true;
    }
    // Landed.
    const landSpeed = -vel.y;
    body.onGround = true;
    vel.y = 0;
    body.fallSpeed = 0;
    out.landed = true;
    if (landSpeed > out.landSpeed) out.landSpeed = landSpeed;
    if (body.jumpBuffer > TIMER_EPS && canJump(body, intent)) doJump(body, out);
    return true;
  }

  pos.y = ny;
  if (-vel.y > body.fallSpeed) body.fallSpeed = -vel.y;
  if (vel.y < 0 && shouldSwim(world, nx, nz, ny)) {
    enterSwim(body, out, true);
    return false;
  }
  return true;
}

function stepGround(body: CharacterBody, intent: MoveIntent, dt: number, world: World, out: MoveEvents): void {
  const vel = body.vel;
  updateStance(body, intent, out);

  if (intent.jumpPressed) body.jumpBuffer = JUMP_BUFFER_TIME;
  if (body.jumpBuffer > TIMER_EPS && canJump(body, intent)) doJump(body, out);

  // Horizontal velocity.
  const yaw = fin(intent.yaw);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  const wx = -sy * inp.mz + cy * inp.mx;
  const wz = -cy * inp.mz - sy * inp.mx;
  const wishLen = Math.sqrt(wx * wx + wz * wz);
  if (body.onGround) {
    if (wishLen > 1e-3) {
      const s = groundSpeed(body, intent);
      accelerateXZ(vel, wx * s, wz * s, GROUND_ACCEL * dt);
    } else {
      applyFriction(vel, GROUND_FRICTION, dt);
    }
  } else if (wishLen > 1e-3) {
    const s = groundSpeed(body, intent);
    accelerateXZ(vel, wx * s, wz * s, AIR_ACCEL * dt);
  }

  // Sub-steps.
  const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const travel = (hs + Math.abs(vel.y)) * dt + 0.5 * CHAR_GRAVITY * dt * dt;
  let n = Math.ceil(travel / SUBSTEP_MAX_MOVE);
  n = n < 1 ? 1 : n > MAX_SUBSTEPS ? MAX_SUBSTEPS : n;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const cont = groundSubstep(body, intent, h, world, out);
    clampToBounds(world, body.pos, vel);
    if (!cont) return;
  }

  body.airTime = body.onGround ? 0 : body.airTime + dt;
  body.jumpBuffer = body.jumpBuffer > dt ? body.jumpBuffer - dt : 0;
}

// ---------------------------------------------------------------------------
// Swim mode
// ---------------------------------------------------------------------------

function stepSwim(body: CharacterBody, intent: MoveIntent, dt: number, world: World, out: MoveEvents): void {
  const pos = body.pos, vel = body.vel;
  body.stance = 'stand';
  body.onGround = false;
  body.airTime = 0;
  body.jumpBuffer = 0;
  body.fallSpeed = 0;
  if (intent.wantStance !== 'stand' && !intent.downed) out.stanceBlocked = true;

  const yaw = fin(intent.yaw);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const wx = -sy * inp.mz + cy * inp.mx;
  const wz = -cy * inp.mz - sy * inp.mx;
  const wishLen = Math.sqrt(wx * wx + wz * wz);
  if (wishLen > 1e-3) {
    const s = MOVE_SPEED.swim * inp.speedMul;
    accelerateXZ(vel, wx * s, wz * s, SWIM_ACCEL * dt);
  } else {
    const k = Math.exp(-SWIM_FRICTION * dt);
    vel.x *= k;
    vel.z *= k;
  }

  const height = STANCE_HEIGHT.stand;
  const target = world.waterLevel - SWIM_FEET_DEPTH;
  const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const travel = hs * dt + Math.abs(target - pos.y);
  let n = Math.ceil(travel / SUBSTEP_MAX_MOVE);
  n = n < 1 ? 1 : n > MAX_SUBSTEPS ? MAX_SUBSTEPS : n;
  const h = dt / n;
  const floatK = 1 - Math.exp(-SWIM_FLOAT_RATE * h);
  for (let i = 0; i < n; i++) {
    const y0 = pos.y;
    resolveCircle(pos.x + vel.x * h, pos.z + vel.z * h, R, y0 + STEP_HEIGHT, y0 + height, vel);
    pos.x = resolved.x;
    pos.z = resolved.z;
    let y = y0 + (target - y0) * floatK;
    // Wading out: the ground (beach, submerged box) lifts the feet.
    const g = groundBelow(world, pos.x, pos.z, Math.max(y, y0) + STEP_HEIGHT);
    if (y < g) y = g;
    pos.y = y;
    vel.y = (y - y0) / h;
    clampToBounds(world, pos, vel);
  }

  if (waterDepthBelow(world, pos.x, pos.z, pos.y + STEP_HEIGHT) < SWIM_EXIT_DEPTH) {
    // Shallow enough to walk: back to ground mode, standing on the ground.
    body.mode = 'ground';
    vel.y = 0;
    const g = groundBelow(world, pos.x, pos.z, pos.y + STEP_HEIGHT);
    if (g >= pos.y - STEP_DOWN) {
      pos.y = g;
      body.onGround = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Advance a character body in mode 'ground' or 'swim' by dt seconds (one tick), switching between
 * the two by water depth. Bodies in 'freefall' / 'parachute' are forwarded to stepDrop (chute
 * state taken from the mode); 'plane' and 'vehicle' bodies are not moved. Mutates only `body`
 * and `out` (returned; a new events object is allocated when omitted).
 */
export function stepCharacter(
  body: CharacterBody, intent: MoveIntent, dt: number, world: World, out: MoveEvents = createMoveEvents(),
): MoveEvents {
  if (body.mode === 'freefall' || body.mode === 'parachute') {
    return stepDrop(body, intent, dt, world, body.mode === 'parachute', out);
  }
  resetMoveEvents(out);
  if (body.mode !== 'ground' && body.mode !== 'swim') return out;
  if (!(dt > 0)) return out;
  if (dt > MAX_STEP_DT) dt = MAX_STEP_DT;

  const pos = body.pos, vel = body.vel;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return out;
  if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)) {
    vel.x = 0; vel.y = 0; vel.z = 0;
  }
  if (!isStance(body.stance)) body.stance = 'stand';
  if (!Number.isFinite(body.airTime)) body.airTime = 0;
  if (!Number.isFinite(body.jumpBuffer)) body.jumpBuffer = 0;
  if (!Number.isFinite(body.fallSpeed)) body.fallSpeed = 0;

  readInput(intent);

  // Gather colliders around everything this tick can reach.
  const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const maxSpeed = MOVE_SPEED.sprint * MAX_SPEED_MUL;
  gatherNear(world, pos.x, pos.z, R + (Math.max(hs, maxSpeed) + GROUND_ACCEL * dt) * dt + 0.5);

  if (body.mode === 'ground' && shouldSwim(world, pos.x, pos.z, pos.y)) {
    enterSwim(body, out, !body.onGround);
  }

  if (body.mode === 'swim') stepSwim(body, intent, dt, world, out);
  else stepGround(body, intent, dt, world, out);
  return out;
}
