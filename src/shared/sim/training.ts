// Training ground: spawn points, give / respawn, static target boxes and moving / popup dummies
// (hit-tested as standing hitboxes) reporting targetHit read-outs to the shooter.

import { MAX_HEALTH } from '../constants';
import { WEAPONS, computeDamage, isAmmoId, isWeaponId, pickupItem } from '../items';
import { buildHitboxes, raycastHitboxes } from '../physics';
import type { HitboxPose } from '../physics';
import type {
  HitPart, ItemId, PlayerState, RayHit, TrainingLayout, TrainingTarget, Vec3, WeaponId, World, WorldBox,
} from '../types';
import type { TraceHit, TraceScratch } from './combat';
import type { GameSim } from './GameSim';
import { createPose } from './lagcomp';
import type { PlayerRt } from './players';
import { GIVE_AMMO, GIVE_COOLDOWN, GIVE_COUNTS, TARGET_HEAD_FRAC, TRAINING_SPAWN_SPACING } from './tuning';

/**
 * Position of a training target at sim time `timeSec` (seconds). Moving targets ping-pong between
 * `a` and `b` at `speed` m/s, deterministic from the time so the client renders the same thing.
 */
export function trainingTargetPosition(target: TrainingTarget, timeSec: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const a = target.a, b = target.b;
  if (target.kind !== 'moving' || !a || !b || !(target.speed && target.speed > 0)) {
    out.x = target.pos.x; out.y = target.pos.y; out.z = target.pos.z;
    return out;
  }
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (L < 1e-6) {
    out.x = a.x; out.y = a.y; out.z = a.z;
    return out;
  }
  const period = 2 * L;
  let s = (Math.max(0, timeSec) * target.speed) % period;
  if (s > L) s = period - s;
  const f = s / L;
  out.x = a.x + dx * f;
  out.y = a.y + dy * f;
  out.z = a.z + dz * f;
  return out;
}

export interface TrainingState {
  layout: TrainingLayout;
  /** Moving / popup targets (hit-tested as standing dummies). */
  dummies: TrainingTarget[];
  /** Target WorldBox id -> TrainingTarget id. */
  boxTarget: Map<number, number>;
  boxes: Map<number, WorldBox>;
}

export function createTrainingState(world: World): TrainingState | null {
  const layout = world.training;
  if (!layout) return null;
  const dummies = layout.targets.filter((t) => t.kind !== 'static');
  const boxTarget = new Map<number, number>();
  const boxes = new Map<number, WorldBox>();
  for (const b of world.boxes) {
    if (b.kind !== 'target') continue;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    let best = -1, bestD = 16; // within 4 m
    for (const t of layout.targets) {
      const d = (t.pos.x - cx) ** 2 + (t.pos.z - cz) ** 2;
      if (d < bestD) { bestD = d; best = t.id; }
    }
    if (best >= 0) {
      boxTarget.set(b.id, best);
      boxes.set(b.id, b);
    }
  }
  return { layout, dummies, boxTarget, boxes };
}

/** If a world ray hit is a training target box, classify the part and return the target id. */
export function targetBoxHit(sim: GameSim, wh: RayHit, out: TraceHit): number {
  const tr = sim.training;
  if (!tr || wh.kind !== 'box' || wh.id === undefined) return -1;
  const target = tr.boxTarget.get(wh.id);
  if (target === undefined) return -1;
  const b = tr.boxes.get(wh.id)!;
  const h = b.max.y - b.min.y;
  out.part = wh.point.y >= b.max.y - h * TARGET_HEAD_FRAC ? 'head' : 'body';
  return target;
}

const dummyPose: HitboxPose = createPose();
const dummyResult = { t: 0, part: 'body' as HitPart, target: -1 };

/** Nearest dummy hit along a ray (targets positioned at `time`). */
export function testTargetDummies(
  sim: GameSim, origin: Vec3, dir: Vec3, maxDist: number, time: number, sc: TraceScratch,
): { t: number; part: HitPart; target: number } {
  dummyResult.target = -1;
  dummyResult.t = maxDist;
  const tr = sim.training;
  if (!tr) return dummyResult;
  const fl = tr.layout.firingLine;
  for (let i = 0; i < tr.dummies.length; i++) {
    const t = tr.dummies[i];
    trainingTargetPosition(t, time, dummyPose.pos);
    const p = dummyPose.pos;
    // Broadphase: distance from the ray to the dummy centre.
    const wx = p.x - origin.x, wy = p.y + 0.9 - origin.y, wz = p.z - origin.z;
    let s = wx * dir.x + wy * dir.y + wz * dir.z;
    if (s < 0) s = 0; else if (s > dummyResult.t) s = dummyResult.t;
    const qx = wx - dir.x * s, qy = wy - dir.y * s, qz = wz - dir.z * s;
    if (qx * qx + qy * qy + qz * qz > 9) continue;
    dummyPose.yaw = Math.atan2(-(fl.x - p.x), -(fl.z - p.z));
    dummyPose.stance = 'stand';
    dummyPose.life = 'alive';
    dummyPose.mode = 'ground';
    dummyPose.lean = 0;
    const boxes = buildHitboxes(dummyPose, sc.boxes);
    const h = raycastHitboxes(origin, dir, dummyResult.t, boxes);
    if (h && h.t < dummyResult.t) {
      dummyResult.t = h.t;
      dummyResult.part = h.part;
      dummyResult.target = t.id;
    }
  }
  return dummyResult;
}

const NO_ARMOR = { vest: 0 as const, vestHp: 0, helmet: 0 as const, helmetHp: 0, pack: 0 as const };
const dmg = { health: 0, vestDmg: 0, helmetDmg: 0, armorHit: false, armorBroke: false };

/** targetHit read-out (private to the shooter). */
export function emitTargetHit(
  sim: GameSim, shooter: PlayerState, target: number, weapon: WeaponId, part: HitPart, distance: number,
): void {
  computeDamage(weapon, part, distance, NO_ARMOR, dmg);
  sim.emit({
    type: 'targetHit', target, damage: Math.round(dmg.health * 10) / 10, part,
    distance: Math.round(distance * 10) / 10,
  }, [shooter.id]);
}

/** Spawn point for training slot `index` (rows of 8 beside the spawn, facing spawnYaw). */
export function trainingSpawnPos(world: World, index: number, out: Vec3): Vec3 {
  const layout = world.training;
  const base = layout ? layout.spawn : { x: 0, y: 0, z: 0 };
  const yaw = layout ? layout.spawnYaw : 0;
  const col = (index % 8) - 3.5, row = Math.floor(index / 8);
  // right(yaw) = (cos, 0, -sin); back = (sin, 0, cos)
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const bx = Math.sin(yaw), bz = Math.cos(yaw);
  const x = base.x + rx * col * TRAINING_SPAWN_SPACING + bx * row * TRAINING_SPAWN_SPACING;
  const z = base.z + rz * col * TRAINING_SPAWN_SPACING + bz * row * TRAINING_SPAWN_SPACING;
  out.x = x;
  out.z = z;
  out.y = world.groundAt(x, z, base.y + 2);
  return out;
}

/** Reset a player to a training spawn point with full health (inventory is kept). */
export function respawnPlayer(sim: GameSim, rt: PlayerRt): void {
  const p = rt.p;
  if (p.vehicleId !== null) sim.ejectPlayer(p);
  trainingSpawnPos(sim.world, rt.spawnIndex, p.pos);
  p.yaw = sim.world.training ? sim.world.training.spawnYaw : p.yaw;
  p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
  p.onGround = false;
  p.airTime = 0;
  p.jumpBuffer = 0;
  p.fallSpeed = 0;
  p.stance = 'stand';
  p.mode = 'ground';
  p.life = 'alive';
  p.health = MAX_HEALTH;
  p.downedHp = 0;
  p.knockCount = 0;
  p.parachuteOpen = false;
  p.use = null;
  p.revive = null;
  p.revivedBy = null;
  p.reloadTimer = 0;
  p.reloadTotal = 0;
  p.drawTimer = 0;
  p.ads = 0;
  p.recoilPitch = 0;
  p.recoilYaw = 0;
  p.sprayCount = 0;
  p.bloom = 0;
  p.killerId = null;
  p.spectating = null;
  p.lastAttacker = null;
  p.lastAttackerWeapon = null;
  p.stats.spawnTime = sim.time;
  rt.respawnTimer = 0;
  sim.emit({ type: 'spawned', player: p.id });
}

/** Action `give` (training only, rate limited): add an item like a weapon rack would. */
export function giveItem(sim: GameSim, rt: PlayerRt, item: ItemId): void {
  const p = rt.p;
  if (sim.config.mode !== 'training' || p.life !== 'alive' || rt.giveCooldown > 0) return;
  rt.giveCooldown = GIVE_COOLDOWN;
  let count = 1;
  let mag: number | undefined;
  if (isWeaponId(item)) mag = WEAPONS[item].magSize;
  else if (isAmmoId(item)) count = GIVE_AMMO;
  else count = GIVE_COUNTS[item] ?? 1;
  const res = pickupItem(p, item, count, mag);
  for (const d of res.dropped) sim.placeLoot(d.item, d.count, p.pos, p.pos.y, d.mag);
  if (res.taken > 0) sim.emit({ type: 'pickup', player: p.id, item, count: res.taken }, [p.id]);
}
