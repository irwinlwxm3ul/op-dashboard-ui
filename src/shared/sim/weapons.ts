// Server-authoritative weapon handling: slot switching (draw), ADS blend, reloads (tactical /
// empty / shell-by-shell), fire cadence per fire mode, spread, recoil, bloom, dry fire.
//
// Cadence rule (mirrored by client prediction): at the start of a tick a positive fireCooldown is
// reduced by TICK_DT; the weapon fires when fireCooldown <= 0 and the trigger condition holds
// (auto: FIRE held, semi / bolt / pump: FIRE pressed this tick), then fireCooldown += fireInterval.
// A negative cooldown that did not result in a shot is reset to 0, so the long-run rate never
// exceeds the weapon's rpm.

import { TICK_DT } from '../constants';
import { WEAPONS, fireInterval, recoilForShot, recoverRecoil, shotDirections, spreadCone } from '../items';
import type { RecoilKick, SpreadContext } from '../items';
import { hash32 } from '../rng';
import type { PlayerInput, PlayerState, Vec3, WeaponDef, WeaponInstance } from '../types';
import { BTN } from '../types';
import { fireHitscan, rewindFor } from './combat';
import type { GameSim } from './GameSim';
import type { PlayerRt } from './players';
import { spawnBullet } from './projectiles';
import {
  EVENT_RANGE, FISTS_DRAW_TIME, MAX_RECOIL_PITCH, MAX_RECOIL_YAW, PITCH_LIMIT, SPRAY_RESET_INTERVALS,
} from './tuning';
import { seatCanShoot } from './vehiclesSim';

export function activeWeapon(p: PlayerState): WeaponInstance | null {
  return p.activeSlot !== -1 ? p.weapons[p.activeSlot] : null;
}
export function activeDef(p: PlayerState): WeaponDef | null {
  const w = activeWeapon(p);
  return w ? WEAPONS[w.id] : null;
}

export function cancelReload(p: PlayerState): void {
  p.reloadTimer = 0;
  p.reloadTotal = 0;
}

export function cancelUse(p: PlayerState): void {
  p.use = null;
}

/** Whether the player is in a position to use weapons at all (mode / seat / life). */
export function weaponModeOk(sim: GameSim, p: PlayerState): boolean {
  if (p.life !== 'alive') return false;
  if (p.mode === 'ground') return true;
  if (p.mode === 'vehicle' && p.vehicleId !== null) {
    const v = sim.vehicles.get(p.vehicleId);
    return !!v && seatCanShoot(v, p.seat);
  }
  return false;
}

export function switchSlot(sim: GameSim, rt: PlayerRt, slot: -1 | 0 | 1 | 2): void {
  const p = rt.p;
  p.activeSlot = slot;
  cancelReload(p);
  cancelUse(p);
  p.ads = 0;
  p.sprayCount = 0;
  const inst = slot !== -1 ? p.weapons[slot] : null;
  const def = inst ? WEAPONS[inst.id] : null;
  p.drawTimer = def ? def.drawTime : FISTS_DRAW_TIME;
  sim.emit({ type: 'draw', player: p.id, weapon: def ? def.id : null }, undefined, p.pos, EVENT_RANGE.near);
}

export function canReload(sim: GameSim, p: PlayerState, w: WeaponDef, inst: WeaponInstance): boolean {
  return inst.mag < w.magSize && (sim.config.infiniteAmmo || (p.ammo[w.ammo] || 0) > 0);
}

export function startReload(sim: GameSim, p: PlayerState, w: WeaponDef, inst: WeaponInstance): void {
  const empty = inst.mag === 0;
  const total = w.reloadPerShell ?? (empty ? w.reloadEmptyTime : w.reloadTime);
  p.reloadTimer = total;
  p.reloadTotal = total;
  p.ads = 0;
  cancelUse(p);
  sim.emit({ type: 'reload', player: p.id, weapon: w.id, empty }, undefined, p.pos, EVENT_RANGE.near);
}

function finishReload(sim: GameSim, p: PlayerState, w: WeaponDef, inst: WeaponInstance): void {
  const infinite = sim.config.infiniteAmmo;
  const reserve = p.ammo[w.ammo] || 0;
  if (w.reloadPerShell) {
    if (infinite || reserve > 0) {
      inst.mag = Math.min(w.magSize, inst.mag + 1);
      if (!infinite) p.ammo[w.ammo] = reserve - 1;
    }
    if (canReload(sim, p, w, inst)) {
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
}

const eye: Vec3 = { x: 0, y: 0, z: 0 };
const dirs: Vec3[] = [];
const kick: RecoilKick = { pitch: 0, yaw: 0 };
const ctx: SpreadContext = { ads: 0, speed: 0, airborne: false, stance: 'stand', bloom: 0 };

/** One trigger pull: ammo, seeded spread, server recoil, hitscan trace or projectile spawn. */
function fireWeapon(sim: GameSim, rt: PlayerRt, w: WeaponDef, inst: WeaponInstance, input: PlayerInput): void {
  const p = rt.p;
  inst.mag -= 1;
  const shotIndex = p.shotCounter;
  const seed = hash32(p.id, shotIndex);
  p.shotCounter++;
  p.stats.shotsFired++;
  sim.eyePos(p.id, eye);
  const effYaw = p.yaw + p.recoilYaw;
  let effPitch = p.pitch + p.recoilPitch;
  if (effPitch > PITCH_LIMIT) effPitch = PITCH_LIMIT; else if (effPitch < -PITCH_LIMIT) effPitch = -PITCH_LIMIT;
  ctx.ads = p.ads;
  ctx.speed = Math.hypot(p.vel.x, p.vel.z);
  ctx.airborne = p.mode === 'ground' && !p.onGround;
  ctx.stance = p.stance;
  ctx.bloom = p.bloom;
  const cone = spreadCone(w, ctx);
  shotDirections(w, effYaw, effPitch, cone, seed, dirs);
  recoilForShot(w, p.sprayCount, seed, p.stance, p.ads, kick);
  p.recoilPitch = Math.min(MAX_RECOIL_PITCH, p.recoilPitch + kick.pitch);
  p.recoilYaw = Math.max(-MAX_RECOIL_YAW, Math.min(MAX_RECOIL_YAW, p.recoilYaw + kick.yaw));
  p.sprayCount++;
  p.bloom = Math.min(w.bloomMax, p.bloom + w.bloomPerShot);
  rt.lastShotTime = sim.time;
  const origin = { x: Math.round(eye.x * 100) / 100, y: Math.round(eye.y * 100) / 100, z: Math.round(eye.z * 100) / 100 };
  const rewind = rewindFor(sim, rt, input.rt);
  const ends: Vec3[] = [];
  let projectiles: number[] | undefined;
  if (w.hitscan) {
    fireHitscan(sim, p, w, eye, dirs, rewind, ends);
  } else {
    projectiles = [];
    for (let i = 0; i < dirs.length; i++) {
      const id = spawnBullet(sim, p, w, eye, dirs[i], rewind);
      if (id >= 0) projectiles.push(id);
    }
  }
  const ev: { type: 'shot'; shooter: number; weapon: WeaponDef['id']; origin: Vec3; ends: Vec3[]; projectiles?: number[]; shotIndex: number } = {
    type: 'shot', shooter: p.id, weapon: w.id, origin, ends, shotIndex,
  };
  if (projectiles) ev.projectiles = projectiles;
  sim.emit(ev, undefined, origin, EVENT_RANGE.shot);
  sim.addNoise(origin, p.id, 'shot', w.loudness);
}

/**
 * Per-tick weapon handling (after movement so shots originate from the new position).
 * `pressed` = buttons that went down this tick.
 */
export function updateWeapons(sim: GameSim, rt: PlayerRt, input: PlayerInput, pressed: number, dt: number = TICK_DT): void {
  const p = rt.p;
  const held = input.buttons;
  if (p.throwCooldown > 0) p.throwCooldown = Math.max(0, p.throwCooldown - dt);
  if (p.drawTimer > 0) p.drawTimer = Math.max(0, p.drawTimer - dt);
  if (p.fireCooldown > 0) p.fireCooldown -= dt;
  const alive = p.life === 'alive';
  const modeOk = weaponModeOk(sim, p);

  // Slot switching (requested slot must hold a weapon; -1 = fists).
  if (alive && input.slot !== p.activeSlot && (p.mode === 'ground' || p.mode === 'vehicle')) {
    if (input.slot === -1 || p.weapons[input.slot]) switchSlot(sim, rt, input.slot);
  }
  // A slot may have been emptied (drop / swap): fall back to fists.
  if (p.activeSlot !== -1 && !p.weapons[p.activeSlot]) {
    p.activeSlot = -1;
    cancelReload(p);
    p.ads = 0;
  }
  const inst = activeWeapon(p);
  const w = inst ? WEAPONS[inst.id] : null;

  // Reload progress (also continues while swimming / riding).
  if (p.reloadTimer > 0) {
    if (!w || !inst || !alive) cancelReload(p);
    else {
      p.reloadTimer -= dt;
      if (p.reloadTimer <= 0) finishReload(sim, p, w, inst);
    }
  }

  const fireHeld = (held & BTN.FIRE) !== 0;
  const fireEdge = (pressed & BTN.FIRE) !== 0;
  let fired = false;
  // Bloom decays continuously.
  if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - (w ? w.bloomRecovery : 1) * dt);

  if (w && inst) {
    const trigger = w.fireMode === 'auto' ? fireHeld : fireEdge;
    if (fireEdge && p.use) cancelUse(p);
    // Shell-by-shell reloads are interrupted by firing.
    if (trigger && p.reloadTimer > 0 && w.reloadPerShell && inst.mag > 0) cancelReload(p);
    // Manual reload.
    if ((pressed & BTN.RELOAD) && alive && (modeOk || p.mode === 'swim') && p.reloadTimer <= 0 && p.drawTimer <= 0
      && canReload(sim, p, w, inst)) {
      startReload(sim, p, w, inst);
    }
    if (trigger && modeOk && p.drawTimer <= 0 && p.reloadTimer <= 0 && !p.use) {
      if (inst.mag <= 0) {
        if (canReload(sim, p, w, inst)) startReload(sim, p, w, inst);
        else if (fireEdge) sim.emit({ type: 'dryfire', player: p.id }, undefined, p.pos, EVENT_RANGE.near);
      } else if (p.fireCooldown <= 1e-9) {
        if (p.revive) sim.cancelRevive(p);
        fireWeapon(sim, rt, w, inst, input);
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
  const spraying = w !== null && sim.time - rt.lastShotTime < SPRAY_RESET_INTERVALS * interval;
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
