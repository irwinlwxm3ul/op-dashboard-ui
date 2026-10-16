// Ballistic bullets (DMR / sniper) and frag grenades, plus explosions.
//
// Bullets fly in server time with sub-steps <= PROJECTILE_SUBSTEP; each segment is tested against
// the world, against player hitboxes from the lag-compensation history at (t - rewind) and
// against vehicles. Frags bounce off terrain / boxes and explode after their fuse.

import { MAX_PROJECTILES, TICK_DT } from '../constants';
import { THROWABLES, WEAPONS, computeDamage, fragDamage, launchVelocity, stepBallistic } from '../items';
import { lineOfSight, raycastWorld } from '../physics';
import type {
  DamageSource, EntityId, PlayerState, Projectile, RayHit, Vec3, VehicleState, WeaponDef,
} from '../types';
import {
  bodyCenter, createTraceHit, damageInfo, damagePlayer, emitImpact, gatherCandidates, projectileHitPlayer,
  traceRay,
} from './combat';
import type { GameSim } from './GameSim';
import {
  EVENT_RANGE, FRAG_FRICTION, FRAG_GRAVITY, FRAG_RESTITUTION, FRAG_REST_SPEED, FRAG_VEHICLE_MUL,
  NOISE_EXPLOSION_RADIUS, PROJECTILE_LIFETIME, PROJECTILE_SUBSTEP, THROW_INHERIT, THROW_UP_BIAS,
  VEHICLE_BULLET_MUL,
} from './tuning';
import { damageVehicle } from './vehiclesSim';

const NO_ARMOR = { vest: 0 as const, vestHp: 0, helmet: 0 as const, helmetHp: 0, pack: 0 as const };

function addProjectile(sim: GameSim, pr: Projectile): boolean {
  if (sim.projList.length >= MAX_PROJECTILES) {
    // Make room by dropping the oldest bullet (grenades are never dropped).
    let idx = -1;
    for (let i = 0; i < sim.projList.length; i++) {
      if (sim.projList[i].kind === 'bullet') { idx = i; break; }
    }
    if (idx < 0) return false;
    removeProjectileAt(sim, idx);
  }
  sim.projectiles.set(pr.id, pr);
  sim.projList.push(pr);
  return true;
}

function removeProjectileAt(sim: GameSim, idx: number): void {
  const pr = sim.projList[idx];
  sim.projList.splice(idx, 1);
  sim.projectiles.delete(pr.id);
}

/** Spawn a ballistic bullet along `dir` (muzzle velocity, zeroed at 100 m). Returns its id or -1. */
export function spawnBullet(
  sim: GameSim, shooter: PlayerState, w: WeaponDef, origin: Vec3, dir: Vec3, rewind: number,
): EntityId {
  const vel = launchVelocity(w, dir, { x: 0, y: 0, z: 0 });
  const pr: Projectile = {
    id: sim.allocId(),
    owner: shooter.id,
    kind: 'bullet',
    weapon: w.id,
    pos: { x: origin.x, y: origin.y, z: origin.z },
    vel,
    born: sim.time,
    rewind,
    fuse: 0,
    traveled: 0,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    damage: w.damage,
  };
  return addProjectile(sim, pr) ? pr.id : -1;
}

const throwEye: Vec3 = { x: 0, y: 0, z: 0 };
const throwPos: Vec3 = { x: 0, y: 0, z: 0 };

/** Throw a frag along the effective aim with an upward bias. Returns the projectile id or -1. */
export function spawnFrag(sim: GameSim, p: PlayerState): EntityId {
  sim.eyePos(p.id, throwEye);
  const yaw = p.yaw + p.recoilYaw;
  const pitch = Math.min(1.45, Math.max(-1.45, p.pitch + p.recoilPitch + THROW_UP_BIAS));
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
  throwPos.x = throwEye.x + dx * 0.4;
  throwPos.y = throwEye.y + dy * 0.4;
  throwPos.z = throwEye.z + dz * 0.4;
  if (!lineOfSight(sim.world, throwEye, throwPos)) {
    throwPos.x = throwEye.x; throwPos.y = throwEye.y; throwPos.z = throwEye.z;
  }
  const f = THROWABLES.frag;
  const pr: Projectile = {
    id: sim.allocId(),
    owner: p.id,
    kind: 'frag',
    weapon: 'frag',
    pos: { x: throwPos.x, y: throwPos.y, z: throwPos.z },
    vel: {
      x: dx * f.throwSpeed + p.vel.x * THROW_INHERIT,
      y: dy * f.throwSpeed + p.vel.y * THROW_INHERIT,
      z: dz * f.throwSpeed + p.vel.z * THROW_INHERIT,
    },
    born: sim.time,
    rewind: 0,
    fuse: f.fuse,
    traveled: 0,
    origin: { x: throwEye.x, y: throwEye.y, z: throwEye.z },
    damage: f.damage,
  };
  return addProjectile(sim, pr) ? pr.id : -1;
}

const seg0: Vec3 = { x: 0, y: 0, z: 0 };
const segDir: Vec3 = { x: 0, y: 0, z: 0 };
const hitPt: Vec3 = { x: 0, y: 0, z: 0 };
const bulletHit = createTraceHit();
const dmgOut = { health: 0, vestDmg: 0, helmetDmg: 0, armorHit: false, armorBroke: false };

/** Advance a bullet one tick. Returns false when it is consumed. */
function updateBullet(sim: GameSim, pr: Projectile, dt: number): boolean {
  const w = WEAPONS[pr.weapon as WeaponDef['id']];
  const shooter = sim.players.get(pr.owner);
  if (!w || !shooter) return false;
  const n = Math.max(1, Math.round(dt / PROJECTILE_SUBSTEP));
  const h = dt / n;
  // One candidate gather per tick, around this tick's flight path, with hitboxes at the middle
  // of the tick minus the shooter's rewind (the history clamps to the newest tick).
  const speed = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z);
  const midX = pr.pos.x + pr.vel.x * dt * 0.5, midZ = pr.pos.z + pr.vel.z * dt * 0.5;
  const hitTime = sim.time + dt * 0.5 - pr.rewind;
  gatherCandidates(sim, shooter, hitTime, sim.traceScratch, midX, midZ, speed * dt * 0.5 + 25);
  for (let k = 0; k < n; k++) {
    seg0.x = pr.pos.x; seg0.y = pr.pos.y; seg0.z = pr.pos.z;
    stepBallistic(pr.pos, pr.vel, w, h);
    const sx = pr.pos.x - seg0.x, sy = pr.pos.y - seg0.y, sz = pr.pos.z - seg0.z;
    const L = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (L < 1e-9) continue;
    segDir.x = sx / L; segDir.y = sy / L; segDir.z = sz / L;
    const tr = traceRay(sim, seg0, segDir, L, sim.traceScratch, hitTime, null, bulletHit);
    if (tr.kind !== 'none') {
      const dist = pr.traveled + tr.t;
      hitPt.x = seg0.x + segDir.x * tr.t;
      hitPt.y = seg0.y + segDir.y * tr.t;
      hitPt.z = seg0.z + segDir.z * tr.t;
      switch (tr.kind) {
        case 'player':
          projectileHitPlayer(sim, shooter, w, tr.player!, tr.part, dist, hitPt, pr.origin);
          break;
        case 'vehicle':
          computeDamage(w.id, 'body', dist, NO_ARMOR, dmgOut);
          damageVehicle(sim, tr.vehicle!, dmgOut.health * VEHICLE_BULLET_MUL, shooter);
          emitImpact(sim, hitPt, tr.world.normal, 'metal', w.id, shooter.id);
          break;
        default:
          if (tr.target >= 0) sim.trainingTargetHit(shooter, tr.target, w.id, tr.part, dist);
          if (tr.kind === 'world') emitImpact(sim, hitPt, tr.world.normal, tr.world.material, w.id, shooter.id);
          break;
      }
      return false;
    }
    pr.traveled += L;
  }
  const lim = sim.world.half + 50;
  if (sim.time + dt - pr.born >= PROJECTILE_LIFETIME) return false;
  if (pr.pos.x < -lim || pr.pos.x > lim || pr.pos.z < -lim || pr.pos.z > lim || pr.pos.y < sim.world.waterLevel - 60) return false;
  return true;
}

const fragHit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, kind: 'terrain', material: 'dirt' };

/** Advance a grenade one tick (bounce physics). Returns false when it exploded. */
function updateFrag(sim: GameSim, pr: Projectile, dt: number): boolean {
  const v = pr.vel;
  const resting = v.x === 0 && v.y === 0 && v.z === 0;
  if (!resting) {
    const n = Math.max(1, Math.round(dt / PROJECTILE_SUBSTEP));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      v.y -= FRAG_GRAVITY * h;
      const L = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * h;
      if (L < 1e-9) continue;
      segDir.x = (v.x * h) / L; segDir.y = (v.y * h) / L; segDir.z = (v.z * h) / L;
      const wh = raycastWorld(sim.world, pr.pos, segDir, L, fragHit);
      if (!wh) {
        pr.pos.x += v.x * h; pr.pos.y += v.y * h; pr.pos.z += v.z * h;
        pr.traveled += L;
        continue;
      }
      const nn = wh.normal;
      pr.pos.x = wh.point.x + nn.x * 0.05;
      pr.pos.y = wh.point.y + nn.y * 0.05;
      pr.pos.z = wh.point.z + nn.z * 0.05;
      if (wh.kind === 'water') {
        // Sinks / floats where it landed.
        v.x = 0; v.y = 0; v.z = 0;
        break;
      }
      // Reflect: normal component with restitution, tangential with friction.
      const vn = v.x * nn.x + v.y * nn.y + v.z * nn.z;
      const tx = v.x - vn * nn.x, ty = v.y - vn * nn.y, tz = v.z - vn * nn.z;
      v.x = tx * FRAG_FRICTION - vn * FRAG_RESTITUTION * nn.x;
      v.y = ty * FRAG_FRICTION - vn * FRAG_RESTITUTION * nn.y;
      v.z = tz * FRAG_FRICTION - vn * FRAG_RESTITUTION * nn.z;
      if (nn.y > 0.7 && Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) < FRAG_REST_SPEED) {
        v.x = 0; v.y = 0; v.z = 0;
        break;
      }
    }
    const lim = sim.world.half - 1;
    if (pr.pos.x < -lim) { pr.pos.x = -lim; v.x = Math.abs(v.x) * FRAG_RESTITUTION; }
    if (pr.pos.x > lim) { pr.pos.x = lim; v.x = -Math.abs(v.x) * FRAG_RESTITUTION; }
    if (pr.pos.z < -lim) { pr.pos.z = -lim; v.z = Math.abs(v.z) * FRAG_RESTITUTION; }
    if (pr.pos.z > lim) { pr.pos.z = lim; v.z = -Math.abs(v.z) * FRAG_RESTITUTION; }
  }
  pr.fuse -= dt;
  if (pr.fuse <= 0) {
    const owner = sim.players.get(pr.owner) ?? null;
    explode(sim, pr.pos, THROWABLES.frag.radius, THROWABLES.frag.damage, owner, 'frag', 'frag', null, null);
    return false;
  }
  return true;
}

/** Advance all projectiles one tick. */
export function updateProjectiles(sim: GameSim, dt: number = TICK_DT): void {
  const list = sim.projList;
  for (let i = 0; i < list.length;) {
    const pr = list[i];
    const alive = pr.kind === 'bullet' ? updateBullet(sim, pr, dt) : updateFrag(sim, pr, dt);
    // Updates never add or remove other projectiles (explosions do not spawn any).
    if (alive) i++;
    else removeProjectileAt(sim, i);
  }
}

const explNear: PlayerState[] = [];
const explFrom: Vec3 = { x: 0, y: 0, z: 0 };
const explC: Vec3 = { x: 0, y: 0, z: 0 };
const explInfo = damageInfo(null, 'frag');

/**
 * Explosion at `pos`: damage with linear falloff to players with line of sight (and vehicles),
 * explosion event and noise. `exclude` players / `excludeVehicle` were already handled.
 */
export function explode(
  sim: GameSim, pos: Vec3, radius: number, maxDamage: number, attacker: PlayerState | null,
  source: DamageSource, evSource: 'frag' | 'vehicle', exclude: PlayerState[] | null, excludeVehicle: VehicleState | null,
): void {
  const p = { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: Math.round(pos.z * 100) / 100 };
  sim.emit({ type: 'explosion', pos: p, radius, source: evSource }, undefined, p, EVENT_RANGE.explosion);
  sim.addNoise(p, attacker ? attacker.id : -1, 'explosion', NOISE_EXPLOSION_RADIUS);
  explFrom.x = pos.x; explFrom.y = pos.y + 0.25; explFrom.z = pos.z;
  sim.playersNear(pos.x, pos.z, radius + 1, explNear);
  for (let i = 0; i < explNear.length; i++) {
    const v = explNear[i];
    if (v.life === 'dead' || v.mode === 'plane') continue;
    if (exclude && exclude.indexOf(v) >= 0) continue;
    bodyCenter(v, explC);
    const d = Math.hypot(explC.x - pos.x, explC.y - pos.y, explC.z - pos.z);
    if (d >= radius) continue;
    if (!lineOfSight(sim.world, explFrom, explC)) {
      // Head poking over cover still counts.
      explC.y += 0.6;
      if (!lineOfSight(sim.world, explFrom, explC)) continue;
    }
    const dmg = source === 'frag' ? fragDamage(d) : maxDamage * (1 - d / radius);
    explInfo.attacker = attacker;
    explInfo.source = source;
    explInfo.part = 'body';
    explInfo.pos = explC;
    explInfo.from = pos;
    explInfo.emitHit = attacker !== null;
    explInfo.distance = attacker ? Math.hypot(attacker.pos.x - v.pos.x, attacker.pos.z - v.pos.z) : d;
    damagePlayer(sim, v, dmg, explInfo);
  }
  const vl = sim.vehicleList;
  for (let i = 0; i < vl.length; i++) {
    const veh = vl[i];
    if (veh === excludeVehicle || veh.destroyed) continue;
    const d = Math.max(0, Math.hypot(veh.pos.x - pos.x, veh.pos.y - pos.y, veh.pos.z - pos.z) - 1.5);
    if (d >= radius) continue;
    const base = source === 'frag' ? fragDamage(d) * FRAG_VEHICLE_MUL : maxDamage * (1 - d / radius);
    damageVehicle(sim, veh, base, attacker);
  }
}
