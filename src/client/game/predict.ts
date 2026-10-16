// Local player prediction: runs the same per-input rules as the authoritative GameSim on a copy
// of the player's state (movement via the shared physics stepCharacter / stepDrop, weapon cadence,
// ammo, reload / draw timers, ADS blend, spray / bloom, server recoil via the shared items
// functions, plane jump / chute, driver-side vehicle physics via stepVehicle) so the client shows
// the result of an input immediately and re-simulates unacknowledged inputs on top of every
// authoritative snapshot.
//
// Shared-friendly: no DOM and no client state; everything comes in through arguments. The rules
// mirror src/shared/sim; the tuning constants are imported from the sim so they cannot drift.

import { AUTO_CHUTE_HEIGHT, DOWNED_BLEED_PER_SEC, MIN_CHUTE_DROP, REVIVE_TIME, TICK_DT } from '../../shared/constants';
import { clamp } from '../../shared/math';
import { hash32, hashFloat } from '../../shared/rng';
import {
  CONSUMABLES, WEAPONS, boostSpeedMul, fireInterval, recoilForShot, recoverRecoil, shotDirections, spreadCone, tickBoost,
} from '../../shared/items';
import type { RecoilKick, SpreadContext } from '../../shared/items';
import { createMoveEvents, createMoveIntent, eyePosition, stepCharacter, stepDrop } from '../../shared/physics';
import type { MoveEvents, MoveIntent } from '../../shared/physics';
import type { NetVehicle, SelfState } from '../../shared/protocol';
import { LIFE_CODES, MODE_CODES } from '../../shared/protocol';
import {
  ADS_MOVE_MUL, FISTS_DRAW_TIME, MAX_RECOIL_PITCH, MAX_RECOIL_YAW, MOVE_DEADZONE, PITCH_LIMIT, PLANE_JUMP_BACK,
  PLANE_JUMP_CARRY, PLANE_JUMP_SPREAD, SPRAY_RESET_INTERVALS, SPRINT_MIN_FORWARD,
} from '../../shared/sim/tuning';
import { BTN, STANCE_FROM_CODE } from '../../shared/types';
import type {
  MatchConfig, MovementMode, PlaneState, PlayerInput, PlayerState, Vec3, VehicleState, VehicleType, WeaponDef, WeaponId,
  WeaponInstance, World,
} from '../../shared/types';
import { VEHICLES, stepVehicle } from '../../shared/vehicles';
import type { VehicleControls, VehicleStepEvents } from '../../shared/vehicles';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Client mirror of the sim's per-player runtime data that is not networked. */
export interface PredictRt {
  /** Seconds the trigger has been released (spray reset). */
  releaseTime: number;
  /** Sim time (s) of the last shot (recoil recovery pause). */
  lastShotTime: number;
  /** Effective sprint state of the last tick. */
  sprinting: boolean;
  /** Smoothed driver throttle / yaw rate of the predicted vehicle (not networked). */
  vehThrottle: number;
  vehYawRate: number;
}

export function createPredictRt(): PredictRt {
  return { releaseTime: 1e9, lastShotTime: -1e9, sprinting: false, vehThrottle: 0, vehYawRate: 0 };
}

export function copyPredictRt(dst: PredictRt, src: PredictRt): PredictRt {
  dst.releaseTime = src.releaseTime;
  dst.lastShotTime = src.lastShotTime;
  dst.sprinting = src.sprinting;
  dst.vehThrottle = src.vehThrottle;
  dst.vehYawRate = src.vehYawRate;
  return dst;
}

export interface PredictEnv {
  world: World;
  config: MatchConfig;
  /** Sim time (s) at the start of this tick. */
  time: number;
  /** Plane state (with `traveled` valid at `planeTime`) or null. */
  plane: PlaneState | null;
  planeTime: number;
  /** Type of the vehicle the player sits in (null on foot). */
  seatVehicle: VehicleType | null;
  /** Vehicle driven by the player (predicted in place) or null. */
  vehicle: VehicleState | null;
  /** Nearby vehicles for driver-side collisions (may include `vehicle`). */
  others: VehicleState[];
}

/** Things that happened during one predicted tick (for local feedback events). */
export interface TickEvents {
  move: MoveEvents;
  shot: boolean;
  weapon: WeaponId | null;
  shotIndex: number;
  ballistic: boolean;
  shotOrigin: Vec3;
  shotDirs: Vec3[];
  dryFire: boolean;
  reloadStarted: boolean;
  reloadEmpty: boolean;
  reloadDone: boolean;
  switched: boolean;
  leftPlane: boolean;
  chuteOpened: boolean;
  vehicle: VehicleStepEvents;
}

export function createTickEvents(): TickEvents {
  return {
    move: createMoveEvents(), shot: false, weapon: null, shotIndex: 0, ballistic: false,
    shotOrigin: { x: 0, y: 0, z: 0 }, shotDirs: [], dryFire: false, reloadStarted: false, reloadEmpty: false,
    reloadDone: false, switched: false, leftPlane: false, chuteOpened: false,
    vehicle: { crash: 0, crashPos: null, inWater: false },
  };
}

function resetTickEvents(ev: TickEvents): void {
  const m = ev.move;
  m.jumped = m.landed = m.stanceBlocked = m.enteredWater = false;
  m.landSpeed = 0;
  ev.shot = ev.dryFire = ev.reloadStarted = ev.reloadEmpty = ev.reloadDone = false;
  ev.switched = ev.leftPlane = ev.chuteOpened = ev.ballistic = false;
  ev.weapon = null;
  ev.vehicle.crash = 0;
  ev.vehicle.crashPos = null;
  ev.vehicle.inWater = false;
}

// ---------------------------------------------------------------------------
// Helpers shared with the sim rules
// ---------------------------------------------------------------------------

export function activeWeapon(p: PlayerState): WeaponDef | null {
  if (p.activeSlot < 0) return null;
  const inst = p.weapons[p.activeSlot as 0 | 1 | 2];
  return inst ? WEAPONS[inst.id] : null;
}

/** Combined movement speed multiplier (weapon, ADS slow, healing, boost). */
export function movementSpeedMul(p: PlayerState): number {
  const w = activeWeapon(p);
  const adsMul = 1 + (ADS_MOVE_MUL - 1) * p.ads;
  const useMul = p.use ? CONSUMABLES[p.use.item].moveMul : 1;
  return (w ? w.moveSpeedMul : 1) * adsMul * useMul * boostSpeedMul(p.boost);
}

/** Whether the player's current seat / mode allows shooting. */
export function canShootFrom(p: PlayerState, vehicleType: VehicleType | null): boolean {
  if (p.life !== 'alive') return false;
  if (p.mode === 'ground') return true;
  if (p.mode === 'vehicle') {
    if (!vehicleType || p.seat < 0) return false;
    return VEHICLES[vehicleType].seatCanShoot[p.seat] === true;
  }
  return false;
}

/** Spread cone for the player's current state (also drives the dynamic crosshair). */
const spreadCtx: SpreadContext = { ads: 0, speed: 0, airborne: false, stance: 'stand', bloom: 0 };
export function currentSpread(p: PlayerState, w: WeaponDef): number {
  spreadCtx.ads = p.ads;
  spreadCtx.speed = Math.hypot(p.vel.x, p.vel.z);
  spreadCtx.airborne = p.mode === 'ground' ? !p.onGround : false;
  spreadCtx.stance = p.stance;
  spreadCtx.bloom = p.bloom;
  return spreadCone(w, spreadCtx);
}

/** Driver controls from an input (throttle = forward axis, steer = strafe axis, right positive). */
export function vehicleControls(input: PlayerInput, out: VehicleControls): VehicleControls {
  const b = input.buttons;
  out.throttle = input.mz;
  out.steer = input.mx;
  out.handbrake = (b & (BTN.JUMP | BTN.HANDBRAKE)) !== 0;
  out.boost = (b & (BTN.SPRINT | BTN.BOOST)) !== 0;
  return out;
}

/**
 * Ground / swim MoveIntent exactly as the sim's player tick builds it. `pressed` = buttons that
 * went down this tick. Returns the effective sprint state (gates ADS in the weapon step).
 */
export function buildMoveIntent(p: PlayerState, input: PlayerInput, pressed: number, out: MoveIntent): boolean {
  const held = input.buttons;
  const w = activeWeapon(p);
  const downed = p.life === 'downed';
  const firingIntent = (held & BTN.FIRE) !== 0 && w !== null && !downed;
  const wantSprint = (held & BTN.SPRINT) !== 0 && !firingIntent && !downed;
  const wantStance = downed ? 'prone' : STANCE_FROM_CODE[input.stance] ?? 'stand';
  const sprinting = wantSprint && p.mode === 'ground' && p.stance === 'stand' && wantStance === 'stand'
    && input.mz > SPRINT_MIN_FORWARD && (held & BTN.WALK) === 0;
  out.mx = input.mx;
  out.mz = input.mz;
  out.yaw = p.yaw;
  out.sprint = wantSprint;
  out.walk = (held & BTN.WALK) !== 0;
  out.jumpPressed = (pressed & BTN.JUMP) !== 0 && !downed;
  out.wantStance = wantStance;
  out.speedMul = movementSpeedMul(p);
  out.downed = downed;
  out.dive = 0;
  return sprinting;
}

/** Freefall / parachute intent (the sim ignores everything but the axes and heading). */
export function buildDropIntent(p: PlayerState, input: PlayerInput, out: MoveIntent): MoveIntent {
  out.mx = input.mx;
  out.mz = input.mz;
  out.yaw = p.yaw;
  out.sprint = false;
  out.walk = false;
  out.jumpPressed = false;
  out.wantStance = 'stand';
  out.speedMul = 1;
  out.downed = false;
  out.dive = input.mz;
  return out;
}

/** Plane distance travelled at sim time t given a state sampled at `stateTime`. */
export function planeTraveledAt(plane: PlaneState, stateTime: number, t: number): number {
  const d = plane.active ? plane.traveled + (t - stateTime) * plane.speed : plane.traveled;
  return clamp(d, 0, plane.length);
}

/** Plane position at sim time t (writes into out). */
export function planePositionAt(plane: PlaneState, stateTime: number, t: number, out: Vec3): Vec3 {
  const f = plane.length > 0 ? planeTraveledAt(plane, stateTime, t) / plane.length : 0;
  out.x = plane.start.x + (plane.end.x - plane.start.x) * f;
  out.y = plane.altitude;
  out.z = plane.start.z + (plane.end.z - plane.start.z) * f;
  return out;
}

// ---------------------------------------------------------------------------
// The predicted tick
// ---------------------------------------------------------------------------

const intent = createMoveIntent();
const kick: RecoilKick = { pitch: 0, yaw: 0 };
const ctl: VehicleControls = { throttle: 0, steer: 0, handbrake: false, boost: false };
const planeScratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Advance the predicted player by one input (one TICK_DT), mirroring the sim's per-player tick:
 * aim, actions (plane jump / chute predicted), lean, movement, weapons, item use / revive
 * progress, boost and bleeding. `prevButtons` = buttons of the previous input. Mutates `p` / `rt`
 * (and `env.vehicle` when driving); fills `ev` with what happened.
 */
export function predictTick(
  p: PlayerState, rt: PredictRt, input: PlayerInput, prevButtons: number, env: PredictEnv, ev: TickEvents,
): void {
  resetTickEvents(ev);
  const dt = TICK_DT;
  const held = input.buttons;
  const pressed = held & ~prevButtons;
  p.yaw = input.yaw;
  p.pitch = input.pitch > PITCH_LIMIT ? PITCH_LIMIT : input.pitch < -PITCH_LIMIT ? -PITCH_LIMIT : input.pitch;
  p.lastSeq = input.seq;
  if (p.life === 'dead') {
    p.lastButtons = held;
    return;
  }

  // ---- Actions with an immediate, predictable result (the rest is server validated) ----------
  if (input.actions) {
    for (const a of input.actions) {
      if (a.a === 'jump') {
        if (p.mode === 'plane' && p.life === 'alive' && env.plane) {
          // The sim advances the plane before the players: during a tick it is at end-of-tick time.
          const pp = planePositionAt(env.plane, env.planeTime, env.time + dt, planeScratch);
          if (env.world.inBounds(pp.x, pp.z)) jumpFromPlane(p, env, pp, ev);
        }
      } else if (a.a === 'chute') {
        if (p.mode === 'freefall' && p.life === 'alive' && p.jumpY - p.pos.y >= MIN_CHUTE_DROP) openChute(p, ev);
      }
    }
  }

  // ---- Lean (on foot, standing or crouched) ----------------------------------------------------
  const leanR = (held & BTN.LEAN_R) !== 0, leanL = (held & BTN.LEAN_L) !== 0;
  p.lean = p.life === 'alive' && p.mode === 'ground' && p.stance !== 'prone' && leanR !== leanL ? (leanR ? 1 : -1) : 0;

  // ---- Movement ----------------------------------------------------------------------------------
  rt.sprinting = false;
  switch (p.mode) {
    case 'plane':
      if (env.plane) planePositionAt(env.plane, env.planeTime, env.time + dt, p.pos);
      p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
      break;
    case 'freefall':
    case 'parachute': {
      if (p.mode === 'freefall') {
        const g = Math.max(env.world.groundAt(p.pos.x, p.pos.z, p.pos.y), env.world.waterLevel);
        if (p.pos.y - g <= AUTO_CHUTE_HEIGHT) openChute(p, ev);
      }
      buildDropIntent(p, input, intent);
      stepDrop(p, intent, dt, env.world, p.parachuteOpen, ev.move);
      if (ev.move.landed || (p.mode !== 'freefall' && p.mode !== 'parachute')) p.parachuteOpen = false;
      break;
    }
    case 'vehicle': {
      const v = env.vehicle;
      if (v && p.seat === 0 && p.life === 'alive' && v.id === p.vehicleId) {
        vehicleControls(input, ctl);
        v.throttle = rt.vehThrottle;
        v.yawRate = rt.vehYawRate;
        stepVehicle(v, ctl, dt, env.world, env.others, ev.vehicle);
        rt.vehThrottle = v.throttle;
        rt.vehYawRate = v.yawRate;
      }
      break;
    }
    default: {
      // ground / swim
      rt.sprinting = buildMoveIntent(p, input, pressed, intent);
      if (p.use && (rt.sprinting || (pressed & BTN.JUMP) !== 0)) p.use = null;
      stepCharacter(p, intent, dt, env.world, ev.move);
      if (ev.move.jumped) p.use = null;
      break;
    }
  }

  // ---- Weapons -----------------------------------------------------------------------------------
  tickWeapons(p, rt, input, pressed, env, ev);

  // ---- Item use / revive progress (completion effects are server side) ---------------------------
  if (p.use) {
    if (p.life !== 'alive') p.use = null;
    else {
      p.use.elapsed += dt;
      if (p.use.elapsed >= p.use.total) p.use = null;
    }
  }
  if (p.revive) {
    const still = Math.abs(input.mx) < MOVE_DEADZONE && Math.abs(input.mz) < MOVE_DEADZONE;
    const shooting = (held & BTN.FIRE) !== 0 && activeWeapon(p) !== null;
    if (p.life !== 'alive' || p.mode !== 'ground' || (held & BTN.INTERACT) === 0 || !still || shooting) p.revive = null;
    else {
      p.revive.elapsed += dt;
      if (p.revive.elapsed >= REVIVE_TIME) p.revive = null;
    }
  }

  tickBoost(p, dt);
  if (p.life === 'downed' && p.revivedBy === null) {
    p.downedHp = Math.max(0, p.downedHp - DOWNED_BLEED_PER_SEC * (1 + 0.5 * (p.knockCount - 1)) * dt);
  }
  p.lastButtons = held;
}

/** Leave the plane (mirrors the sim): behind it with a seeded per-player spread and a little speed. */
function jumpFromPlane(p: PlayerState, env: PredictEnv, pp: Vec3, ev: TickEvents): void {
  const plane = env.plane!;
  const l = plane.length > 0 ? plane.length : 1;
  const dx = (plane.end.x - plane.start.x) / l, dz = (plane.end.z - plane.start.z) / l;
  const seed = env.config.seed;
  const back = PLANE_JUMP_BACK + hashFloat(seed, p.id, 1) * PLANE_JUMP_SPREAD;
  const side = (hashFloat(seed, p.id, 2) - 0.5) * 2 * PLANE_JUMP_SPREAD;
  const lim = env.world.half - 1;
  p.pos.x = clamp(pp.x - dx * back - dz * side, -lim, lim);
  p.pos.z = clamp(pp.z - dz * back + dx * side, -lim, lim);
  p.pos.y = pp.y - 2;
  p.vel.x = dx * plane.speed * PLANE_JUMP_CARRY;
  p.vel.y = 0;
  p.vel.z = dz * plane.speed * PLANE_JUMP_CARRY;
  p.mode = 'freefall';
  p.onGround = false;
  p.airTime = 0;
  p.fallSpeed = 0;
  p.jumpBuffer = 0;
  p.parachuteOpen = false;
  p.stance = 'stand';
  p.jumpY = p.pos.y;
  ev.leftPlane = true;
}

function openChute(p: PlayerState, ev: TickEvents): void {
  if (p.parachuteOpen) return;
  p.parachuteOpen = true;
  p.mode = 'parachute';
  ev.chuteOpened = true;
}

function canReload(p: PlayerState, w: WeaponDef, inst: WeaponInstance, infinite: boolean): boolean {
  return inst.mag < w.magSize && (infinite || (p.ammo[w.ammo] || 0) > 0);
}

function startReload(p: PlayerState, w: WeaponDef, inst: WeaponInstance, ev: TickEvents): void {
  const empty = inst.mag === 0;
  const total = w.reloadPerShell ?? (empty ? w.reloadEmptyTime : w.reloadTime);
  p.reloadTimer = total;
  p.reloadTotal = total;
  p.ads = 0;
  p.use = null;
  ev.reloadStarted = true;
  ev.reloadEmpty = empty;
}

function finishReload(p: PlayerState, w: WeaponDef, inst: WeaponInstance, infinite: boolean, ev: TickEvents): void {
  const reserve = p.ammo[w.ammo] || 0;
  if (w.reloadPerShell) {
    if (infinite || reserve > 0) {
      inst.mag = Math.min(w.magSize, inst.mag + 1);
      if (!infinite) p.ammo[w.ammo] = reserve - 1;
    }
    if (canReload(p, w, inst, infinite)) {
      p.reloadTimer += w.reloadPerShell;
      p.reloadTotal = w.reloadPerShell;
      if (p.reloadTimer <= 0) p.reloadTimer = w.reloadPerShell;
      return;
    }
  } else {
    const need = w.magSize - inst.mag;
    const take = infinite ? need : Math.min(need, reserve);
    inst.mag += take;
    if (!infinite) p.ammo[w.ammo] = reserve - take;
  }
  p.reloadTimer = 0;
  p.reloadTotal = 0;
  ev.reloadDone = true;
}

function cancelReload(p: PlayerState): void {
  p.reloadTimer = 0;
  p.reloadTotal = 0;
}

/**
 * Weapon handling for one tick, mirroring the sim's updateWeapons (runs after movement so shots
 * originate from the new position). `pressed` = buttons that went down this tick.
 */
function tickWeapons(p: PlayerState, rt: PredictRt, input: PlayerInput, pressed: number, env: PredictEnv, ev: TickEvents): void {
  const dt = TICK_DT;
  const held = input.buttons;
  const infinite = env.config.infiniteAmmo;
  if (p.throwCooldown > 0) p.throwCooldown = Math.max(0, p.throwCooldown - dt);
  if (p.drawTimer > 0) p.drawTimer = Math.max(0, p.drawTimer - dt);
  if (p.fireCooldown > 0) p.fireCooldown -= dt;
  const alive = p.life === 'alive';
  const modeOk = canShootFrom(p, env.seatVehicle);

  // Slot switching (requested slot must hold a weapon; -1 = fists).
  if (alive && input.slot !== p.activeSlot && (p.mode === 'ground' || p.mode === 'vehicle')) {
    if (input.slot === -1 || p.weapons[input.slot]) {
      p.activeSlot = input.slot;
      cancelReload(p);
      p.use = null;
      p.ads = 0;
      p.sprayCount = 0;
      const nw = activeWeapon(p);
      p.drawTimer = nw ? nw.drawTime : FISTS_DRAW_TIME;
      ev.switched = true;
    }
  }
  // A slot may have been emptied (drop / swap): fall back to fists.
  if (p.activeSlot >= 0 && !p.weapons[p.activeSlot as 0 | 1 | 2]) {
    p.activeSlot = -1;
    cancelReload(p);
    p.ads = 0;
  }
  const inst = p.activeSlot >= 0 ? p.weapons[p.activeSlot as 0 | 1 | 2] : null;
  const w = inst ? WEAPONS[inst.id] : null;

  // Reload progress (also continues while swimming / riding).
  if (p.reloadTimer > 0) {
    if (!w || !inst || !alive) cancelReload(p);
    else {
      p.reloadTimer -= dt;
      if (p.reloadTimer <= 0) finishReload(p, w, inst, infinite, ev);
    }
  }

  const fireHeld = (held & BTN.FIRE) !== 0;
  const fireEdge = (pressed & BTN.FIRE) !== 0;
  let fired = false;
  if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - (w ? w.bloomRecovery : 1) * dt);

  if (w && inst) {
    const trigger = w.fireMode === 'auto' ? fireHeld : fireEdge;
    if (fireEdge && p.use) p.use = null;
    if (trigger && p.reloadTimer > 0 && w.reloadPerShell && inst.mag > 0) cancelReload(p);
    if ((pressed & BTN.RELOAD) && alive && (modeOk || p.mode === 'swim') && p.reloadTimer <= 0 && p.drawTimer <= 0
      && canReload(p, w, inst, infinite)) {
      startReload(p, w, inst, ev);
    }
    if (trigger && modeOk && p.drawTimer <= 0 && p.reloadTimer <= 0 && !p.use) {
      if (inst.mag <= 0) {
        if (canReload(p, w, inst, infinite)) startReload(p, w, inst, ev);
        else if (fireEdge) ev.dryFire = true;
      } else if (p.fireCooldown <= 1e-9) {
        p.revive = null;
        fireShot(p, rt, w, inst, env, ev);
        p.fireCooldown += fireInterval(w);
        fired = true;
      }
    }
  }
  if (!fired && p.fireCooldown < 0) p.fireCooldown = 0;

  // Spray index resets once the trigger has been released long enough.
  const interval = w ? fireInterval(w) : 0.1;
  if (fireHeld && w) rt.releaseTime = 0;
  else {
    rt.releaseTime += dt;
    if (rt.releaseTime > SPRAY_RESET_INTERVALS * interval) p.sprayCount = 0;
  }

  // Recoil recovery: none while a spray is in progress (a shot within 1.5 fire intervals).
  const spraying = w !== null && env.time - rt.lastShotTime < SPRAY_RESET_INTERVALS * interval;
  if (p.recoilPitch !== 0 || p.recoilYaw !== 0) {
    recoverRecoil(w, p.recoilPitch, p.recoilYaw, dt, spraying, kick);
    p.recoilPitch = kick.pitch;
    p.recoilYaw = kick.yaw;
  }

  // ADS blend.
  const adsWanted = (held & BTN.ADS) !== 0 && w !== null && modeOk && !rt.sprinting && !p.use
    && p.reloadTimer <= 0 && p.drawTimer <= 0;
  if (w && adsWanted) p.ads = Math.min(1, p.ads + dt / Math.max(0.05, w.adsTime));
  else if (p.ads > 0) p.ads = w ? Math.max(0, p.ads - dt / Math.max(0.05, w.adsTime)) : 0;
}

/** One trigger pull (mirrors the sim's fireWeapon): ammo, seeded spread, server recoil. */
function fireShot(p: PlayerState, rt: PredictRt, w: WeaponDef, inst: WeaponInstance, env: PredictEnv, ev: TickEvents): void {
  inst.mag -= 1;
  const shotIndex = p.shotCounter;
  const seed = hash32(p.id, shotIndex);
  p.shotCounter++;
  p.stats.shotsFired++;
  eyePosition(p, p.lean, p.yaw, ev.shotOrigin);
  const effYaw = p.yaw + p.recoilYaw;
  let effPitch = p.pitch + p.recoilPitch;
  if (effPitch > PITCH_LIMIT) effPitch = PITCH_LIMIT; else if (effPitch < -PITCH_LIMIT) effPitch = -PITCH_LIMIT;
  const cone = currentSpread(p, w);
  shotDirections(w, effYaw, effPitch, cone, seed, ev.shotDirs);
  recoilForShot(w, p.sprayCount, seed, p.stance, p.ads, kick);
  p.recoilPitch = Math.min(MAX_RECOIL_PITCH, p.recoilPitch + kick.pitch);
  p.recoilYaw = Math.max(-MAX_RECOIL_YAW, Math.min(MAX_RECOIL_YAW, p.recoilYaw + kick.yaw));
  p.sprayCount++;
  p.bloom = Math.min(w.bloomMax, p.bloom + w.bloomPerShot);
  rt.lastShotTime = env.time;
  ev.shot = true;
  ev.weapon = w.id;
  ev.shotIndex = shotIndex;
  ev.ballistic = !w.hitscan;
}

// ---------------------------------------------------------------------------
// State conversion (snapshot -> predicted state)
// ---------------------------------------------------------------------------

const MODE_LIST = MODE_CODES as readonly MovementMode[];

/** A predicted PlayerState initialised from the first authoritative SelfState. */
export function createPredictedPlayer(s: SelfState, name: string, team: number): PlayerState {
  const p: PlayerState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: false, airTime: 0, jumpBuffer: 0,
    stance: 'stand', mode: 'ground', fallSpeed: 0, id: s.id, name, team, isBot: false, connected: true,
    yaw: 0, pitch: 0, recoilPitch: 0, recoilYaw: 0, lean: 0, life: 'alive', health: 100, boost: 0,
    downedHp: 0, knockCount: 0,
    armor: { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 },
    weapons: [null, null, null], activeSlot: -1,
    ammo: { ...s.ammo }, items: { ...s.items },
    fireCooldown: 0, reloadTimer: 0, reloadTotal: 0, drawTimer: 0, ads: 0, sprayCount: 0, bloom: 0,
    shotCounter: 0, use: null, revive: null, revivedBy: null, vehicleId: null, seat: -1,
    parachuteOpen: false, jumpY: 0, lastSeq: 0, lastButtons: 0, throwCooldown: 0,
    stats: { ...s.stats }, placement: 0, killerId: null, spectating: null, lastAttacker: null,
    lastAttackerWeapon: null,
  };
  applySelfState(p, s);
  return p;
}

/** Overwrite the predicted state with an authoritative SelfState (deep copies, no aliasing). */
export function applySelfState(p: PlayerState, s: SelfState): void {
  p.id = s.id;
  p.pos.x = s.pos[0]; p.pos.y = s.pos[1]; p.pos.z = s.pos[2];
  p.vel.x = s.vel[0]; p.vel.y = s.vel[1]; p.vel.z = s.vel[2];
  p.onGround = s.onGround;
  p.airTime = s.airTime;
  p.jumpBuffer = s.jumpBuffer;
  p.fallSpeed = s.fallSpeed;
  p.stance = STANCE_FROM_CODE[s.stance] ?? 'stand';
  p.mode = MODE_LIST[s.mode] ?? 'ground';
  p.life = (LIFE_CODES[s.life] ?? 'alive') as PlayerState['life'];
  p.health = s.health;
  p.boost = s.boost;
  p.downedHp = s.downedHp;
  const a = p.armor, sa = s.armor;
  a.vest = sa.vest; a.vestHp = sa.vestHp; a.helmet = sa.helmet; a.helmetHp = sa.helmetHp; a.pack = sa.pack;
  for (let i = 0; i < 3; i++) {
    const src = s.weapons[i];
    const dst = p.weapons[i];
    if (!src) p.weapons[i] = null;
    else if (dst) { dst.id = src.id; dst.mag = src.mag; }
    else p.weapons[i] = { id: src.id, mag: src.mag };
  }
  p.activeSlot = s.activeSlot;
  for (const k in s.ammo) p.ammo[k as keyof typeof s.ammo] = s.ammo[k as keyof typeof s.ammo];
  for (const k in s.items) p.items[k as keyof typeof s.items] = s.items[k as keyof typeof s.items];
  p.fireCooldown = s.fireCooldown;
  p.reloadTimer = s.reloadTimer;
  p.reloadTotal = s.reloadTotal;
  p.drawTimer = s.drawTimer;
  p.ads = s.ads;
  p.sprayCount = s.sprayCount;
  p.bloom = s.bloom;
  p.shotCounter = s.shotCounter;
  p.recoilPitch = s.recoilPitch;
  p.recoilYaw = s.recoilYaw;
  p.use = s.use ? { ...s.use } : null;
  p.revive = s.revive ? { ...s.revive } : null;
  p.revivedBy = s.revivedBy;
  p.vehicleId = s.vehicleId;
  p.seat = s.seat;
  p.parachuteOpen = s.parachuteOpen;
  p.jumpY = s.jumpY;
  p.throwCooldown = s.throwCooldown;
  Object.assign(p.stats, s.stats);
  p.placement = s.placement;
  p.spectating = s.spectating;
  p.killerId = s.killerId;
}

/** Full VehicleState from a network vehicle (fields not networked are derived). */
export function vehicleFromNet(n: NetVehicle): VehicleState {
  const v: VehicleState = {
    id: n.id, type: n.t, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0,
    yawRate: 0, speed: 0, steer: 0, throttle: 0, rpm: 0, health: 0, fuel: 0, seats: [], onGround: true,
    destroyed: false, burnTimer: 0, lastDriver: null,
  };
  applyNetVehicle(v, n);
  return v;
}

/** Overwrite a VehicleState with network data (keeps the non-networked yawRate / throttle). */
export function applyNetVehicle(v: VehicleState, n: NetVehicle): void {
  v.id = n.id;
  v.type = n.t;
  v.pos.x = n.p[0]; v.pos.y = n.p[1]; v.pos.z = n.p[2];
  v.vel.x = n.v[0]; v.vel.y = n.v[1]; v.vel.z = n.v[2];
  v.yaw = n.r[0];
  v.pitch = n.r[1];
  v.roll = n.r[2];
  v.speed = -Math.sin(v.yaw) * v.vel.x - Math.cos(v.yaw) * v.vel.z;
  v.steer = n.steer;
  v.rpm = n.rpm;
  v.health = n.hp;
  v.fuel = n.fuel;
  v.seats.length = n.seats.length;
  for (let i = 0; i < n.seats.length; i++) v.seats[i] = n.seats[i];
  v.destroyed = n.destroyed;
  v.burnTimer = n.burning ? Math.max(v.burnTimer, 0.01) : 0;
  const def = VEHICLES[n.t];
  v.onGround = def ? true : v.onGround;
}
