// Snapshot encoding: quantised network views of players / vehicles / projectiles and the private
// SelfState. Enemy health and other players' inventories are never encoded (information hiding).

import { LIFE_CODES, MODE_CODES, PF } from '../protocol';
import type { NetPlayer, NetProjectile, NetVehicle, SelfState } from '../protocol';
import { capacity, usedCapacity } from '../items';
import type { PlayerState, Projectile, VehicleState } from '../types';
import { STANCE_CODE } from '../types';
import type { GameSim } from './GameSim';
import { FIRING_FLAG_TIME } from './tuning';

/** Round to centimetres. */
export const q2 = (x: number): number => Math.round(x * 100) / 100;
/** Round angles to 1e-3 rad. */
export const q3 = (x: number): number => Math.round(x * 1000) / 1000;

const MODE_INDEX: Record<string, number> = {};
MODE_CODES.forEach((m, i) => { MODE_INDEX[m] = i; });
const LIFE_INDEX: Record<string, number> = {};
LIFE_CODES.forEach((l, i) => { LIFE_INDEX[l] = i; });

export function modeCode(p: PlayerState): number {
  return MODE_INDEX[p.mode] ?? 3;
}
export function lifeCode(p: PlayerState): number {
  return LIFE_INDEX[p.life] ?? 0;
}

function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** PF flags visible to everyone (animation state). */
export function playerFlags(sim: GameSim, p: PlayerState): number {
  const rt = sim.rtById.get(p.id);
  let f = 0;
  if (rt && sim.time - rt.lastShotTime <= FIRING_FLAG_TIME) f |= PF.FIRING;
  if (p.reloadTimer > 0) f |= PF.RELOADING;
  if (p.ads > 0.5) f |= PF.ADS;
  if (p.use) f |= PF.HEALING;
  if (p.revive) f |= PF.REVIVING;
  if (p.parachuteOpen) f |= PF.CHUTE;
  if (p.lean < 0) f |= PF.LEAN_L;
  if (p.lean > 0) f |= PF.LEAN_R;
  if (rt && rt.sprinting) f |= PF.SPRINT;
  if (p.mode === 'swim') f |= PF.SWIM;
  if (p.onGround) f |= PF.ON_GROUND;
  if (p.revivedBy !== null) f |= PF.BEING_REVIVED;
  if (p.drawTimer > 0) f |= PF.DRAWING;
  if (p.isBot) f |= PF.BOT;
  return f;
}

/** Public view of a player. `withHp` only for the receiver's teammates. */
export function netPlayer(sim: GameSim, p: PlayerState, withHp: boolean): NetPlayer {
  const w = p.activeSlot !== -1 ? p.weapons[p.activeSlot] : null;
  const np: NetPlayer = {
    id: p.id,
    p: [q2(p.pos.x), q2(p.pos.y), q2(p.pos.z)],
    v: [q2(p.vel.x), q2(p.vel.y), q2(p.vel.z)],
    y: q3(wrap(p.yaw + p.recoilYaw)),
    pt: q3(p.pitch + p.recoilPitch),
    s: STANCE_CODE[p.stance],
    m: modeCode(p),
    l: lifeCode(p),
    team: p.team,
    w: w ? w.id : null,
    f: playerFlags(sim, p),
    g: [p.armor.helmet, p.armor.vest, p.armor.pack],
  };
  if (p.vehicleId !== null) {
    np.veh = p.vehicleId;
    np.seat = p.seat;
  }
  if (withHp) {
    np.hp = Math.round(p.health * 10) / 10;
    np.dhp = Math.round(p.downedHp * 10) / 10;
  }
  return np;
}

export function netVehicle(v: VehicleState): NetVehicle {
  return {
    id: v.id,
    t: v.type,
    p: [q2(v.pos.x), q2(v.pos.y), q2(v.pos.z)],
    v: [q2(v.vel.x), q2(v.vel.y), q2(v.vel.z)],
    r: [q3(v.yaw), q3(v.pitch), q3(v.roll)],
    steer: q3(v.steer),
    rpm: Math.round(v.rpm),
    hp: Math.round(v.health),
    fuel: Math.round(v.fuel * 10) / 10,
    seats: v.seats.slice(),
    destroyed: v.destroyed,
    burning: !v.destroyed && v.health <= 0,
  };
}

export function netProjectile(pr: Projectile): NetProjectile {
  return {
    id: pr.id,
    o: pr.owner,
    k: pr.kind,
    w: pr.weapon,
    p: [q2(pr.pos.x), q2(pr.pos.y), q2(pr.pos.z)],
    v: [q2(pr.vel.x), q2(pr.vel.y), q2(pr.vel.z)],
  };
}

/** Full private state of the receiving player (deep copies: snapshots may be sent later). */
export function selfState(p: PlayerState): SelfState {
  return {
    id: p.id,
    ack: p.lastSeq,
    pos: [p.pos.x, p.pos.y, p.pos.z],
    vel: [p.vel.x, p.vel.y, p.vel.z],
    onGround: p.onGround,
    airTime: p.airTime,
    jumpBuffer: p.jumpBuffer,
    fallSpeed: p.fallSpeed,
    stance: STANCE_CODE[p.stance],
    mode: modeCode(p),
    life: lifeCode(p),
    health: Math.round(p.health * 100) / 100,
    boost: Math.round(p.boost * 100) / 100,
    downedHp: Math.round(p.downedHp * 100) / 100,
    armor: { ...p.armor },
    weapons: [
      p.weapons[0] ? { ...p.weapons[0] } : null,
      p.weapons[1] ? { ...p.weapons[1] } : null,
      p.weapons[2] ? { ...p.weapons[2] } : null,
    ],
    activeSlot: p.activeSlot,
    ammo: { ...p.ammo },
    items: { ...p.items },
    capacity: [Math.round(usedCapacity(p) * 100) / 100, capacity(p)],
    fireCooldown: p.fireCooldown,
    reloadTimer: p.reloadTimer,
    reloadTotal: p.reloadTotal,
    drawTimer: p.drawTimer,
    ads: p.ads,
    sprayCount: p.sprayCount,
    bloom: p.bloom,
    shotCounter: p.shotCounter,
    recoilPitch: p.recoilPitch,
    recoilYaw: p.recoilYaw,
    use: p.use ? { ...p.use } : null,
    revive: p.revive ? { ...p.revive } : null,
    revivedBy: p.revivedBy,
    vehicleId: p.vehicleId,
    seat: p.seat,
    parachuteOpen: p.parachuteOpen,
    jumpY: p.jumpY,
    throwCooldown: p.throwCooldown,
    stats: { ...p.stats },
    placement: p.placement,
    spectating: p.spectating,
    killerId: p.killerId,
  };
}
