// Freefall and parachute movement (modes 'freefall' / 'parachute').
//
// Velocities ease exponentially toward input-dependent targets so the drop feels floaty but
// controllable. Landing (terrain, box tops such as roofs, rocks) or reaching deep water hands the
// body over to the character controller (mode 'ground' / 'swim').

import {
  FREEFALL_DIVE_SPEED, FREEFALL_HORIZONTAL, FREEFALL_SPEED, MOVE_SPEED, PARACHUTE_DESCENT, PARACHUTE_HORIZONTAL,
  PLAYER_RADIUS, STANCE_HEIGHT,
} from '../constants';
import type { CharacterBody, World } from '../types';
import {
  SUPPORT_TERRAIN, clampToBounds, gatherNear, resolveCircle, resolved, support, supportHeight, supportWalkable,
} from './colliders';
import type { MoveEvents, MoveIntent } from './types';
import { createMoveEvents, resetMoveEvents } from './types';
import {
  AIR_STEP, FREEFALL_BRAKE_RATE, FREEFALL_FLARE_SLOW, FREEFALL_GRAVITY, FREEFALL_HORIZONTAL_RATE, FREEFALL_STRAFE,
  FREEFALL_VERTICAL_RATE, MAX_STEP_DT, MAX_SUBSTEPS, PARACHUTE_BRAKE_FWD, PARACHUTE_DIVE_DESCENT, PARACHUTE_DRIFT,
  PARACHUTE_FLARE_DESCENT, PARACHUTE_HORIZONTAL_RATE, PARACHUTE_OPEN_RATE, PARACHUTE_STRAFE, PARACHUTE_VERTICAL_RATE,
  SUBSTEP_MAX_MOVE, SUPPORT_RADIUS, SWIM_ENTER_DEPTH, SWIM_FEET_DEPTH,
} from './tuning';
import { enterSwim } from './water';

const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);
const ease = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/**
 * Advance a dropping body by dt. `chuteOpen` selects parachute or freefall (and sets body.mode
 * accordingly). On touching the ground the body switches to mode 'ground' (or 'swim' in deep
 * water) with zero vertical velocity and `landed` / `landSpeed` are reported (landSpeed 0 in water).
 */
export function stepDrop(
  body: CharacterBody, intent: MoveIntent, dt: number, world: World, chuteOpen: boolean,
  out: MoveEvents = createMoveEvents(),
): MoveEvents {
  resetMoveEvents(out);
  if (!(dt > 0)) return out;
  if (dt > MAX_STEP_DT) dt = MAX_STEP_DT;
  const pos = body.pos, vel = body.vel;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return out;
  if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)) {
    vel.x = 0; vel.y = 0; vel.z = 0;
  }
  if (!Number.isFinite(body.airTime)) body.airTime = 0;
  if (!Number.isFinite(body.fallSpeed)) body.fallSpeed = 0;

  body.mode = chuteOpen ? 'parachute' : 'freefall';
  body.stance = 'stand';
  body.onGround = false;
  body.jumpBuffer = 0;

  // ---- input ----
  let mx = fin(intent.mx), mz = fin(intent.mz);
  const l2 = mx * mx + mz * mz;
  if (l2 > 1) { const il = 1 / Math.sqrt(l2); mx *= il; mz *= il; }
  const d = fin(intent.dive);
  let lean = d !== 0 ? d : mz;
  lean = lean < -1 ? -1 : lean > 1 ? 1 : lean;
  const yaw = fin(intent.yaw);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  const fx = -sy, fz = -cy, rx = cy, rz = -sy;

  // ---- velocity targets ----
  let fwdSpeed: number, strafe: number, maxH: number, hRate: number;
  if (!chuteOpen) {
    const descent = lean >= 0
      ? FREEFALL_SPEED + (FREEFALL_DIVE_SPEED - FREEFALL_SPEED) * lean
      : FREEFALL_SPEED * (1 + FREEFALL_FLARE_SLOW * lean);
    let dv = (-descent - vel.y) * ease(FREEFALL_VERTICAL_RATE, dt);
    // Speeding up is limited by (boosted) gravity: leaving the plane builds speed over ~2 s.
    const maxAccel = FREEFALL_GRAVITY * dt;
    if (dv < -maxAccel) dv = -maxAccel;
    vel.y += dv;
    fwdSpeed = lean > 0 ? FREEFALL_HORIZONTAL * lean : 0;
    strafe = mx * FREEFALL_HORIZONTAL * FREEFALL_STRAFE;
    maxH = FREEFALL_HORIZONTAL;
    hRate = lean < 0 ? FREEFALL_BRAKE_RATE : FREEFALL_HORIZONTAL_RATE;
  } else {
    const descent = lean >= 0
      ? PARACHUTE_DESCENT + (PARACHUTE_DIVE_DESCENT - PARACHUTE_DESCENT) * lean
      : PARACHUTE_DESCENT + (PARACHUTE_DESCENT - PARACHUTE_FLARE_DESCENT) * lean;
    const vRate = vel.y < -(PARACHUTE_DIVE_DESCENT + 1) ? PARACHUTE_OPEN_RATE : PARACHUTE_VERTICAL_RATE;
    vel.y += (-descent - vel.y) * ease(vRate, dt);
    const fwdFrac = lean >= 0
      ? PARACHUTE_DRIFT + (1 - PARACHUTE_DRIFT) * lean
      : PARACHUTE_DRIFT + (PARACHUTE_DRIFT - PARACHUTE_BRAKE_FWD) * lean;
    fwdSpeed = PARACHUTE_HORIZONTAL * fwdFrac;
    strafe = mx * PARACHUTE_HORIZONTAL * PARACHUTE_STRAFE;
    maxH = PARACHUTE_HORIZONTAL;
    hRate = PARACHUTE_HORIZONTAL_RATE;
  }
  let tx = fx * fwdSpeed + rx * strafe, tz = fz * fwdSpeed + rz * strafe;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (tl > maxH) { tx *= maxH / tl; tz *= maxH / tl; }
  const kh = ease(hRate, dt);
  vel.x += (tx - vel.x) * kh;
  vel.z += (tz - vel.z) * kh;

  // ---- integrate with collision ----
  const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const speed = Math.sqrt(hs * hs + vel.y * vel.y);
  gatherNear(world, pos.x, pos.z, PLAYER_RADIUS + hs * dt + 0.5);
  let n = Math.ceil((speed * dt) / SUBSTEP_MAX_MOVE);
  n = n < 1 ? 1 : n > MAX_SUBSTEPS ? MAX_SUBSTEPS : n;
  const h = dt / n;
  const height = STANCE_HEIGHT.stand;
  const wl = world.waterLevel;

  for (let i = 0; i < n; i++) {
    const x0 = pos.x, y0 = pos.y, z0 = pos.z;
    const ny = y0 + vel.y * h;
    resolveCircle(x0 + vel.x * h, z0 + vel.z * h, PLAYER_RADIUS, y0 + AIR_STEP, y0 + height, vel);
    const nx = resolved.x, nz = resolved.z;
    pos.x = nx;
    pos.z = nz;

    const sup = supportHeight(world, nx, nz, (ny > y0 ? ny : y0) + AIR_STEP, SUPPORT_RADIUS);
    if (ny <= sup) {
      pos.y = sup;
      clampToBounds(world, pos, vel);
      const landSpeed = vel.y < 0 ? -vel.y : 0;
      body.mode = 'ground';
      // Too-steep terrain: the character controller slides the body off it.
      body.onGround = support.kind !== SUPPORT_TERRAIN || supportWalkable(world, nx, nz);
      vel.y = 0;
      body.airTime = 0;
      body.fallSpeed = 0;
      limitLandingSpeed(body);
      out.landed = true;
      out.landSpeed = landSpeed;
      return out;
    }

    // Deep water: splash down at the surface and let the swim controller take over.
    if (ny <= wl && y0 > wl - SWIM_FEET_DEPTH && wl - sup > SWIM_ENTER_DEPTH) {
      pos.y = ny > wl - SWIM_FEET_DEPTH ? ny : wl - SWIM_FEET_DEPTH;
      clampToBounds(world, pos, vel);
      limitLandingSpeed(body);
      enterSwim(body, out, true);
      return out;
    }

    pos.y = ny;
    clampToBounds(world, pos, vel);
  }

  body.airTime += dt;
  if (-vel.y > body.fallSpeed) body.fallSpeed = -vel.y;
  return out;
}

/** Carry at most sprint speed of horizontal momentum into the ground controller. */
function limitLandingSpeed(body: CharacterBody): void {
  const v = body.vel;
  const hs = Math.sqrt(v.x * v.x + v.z * v.z);
  const max = MOVE_SPEED.sprint;
  if (hs > max) {
    v.x *= max / hs;
    v.z *= max / hs;
  }
}
