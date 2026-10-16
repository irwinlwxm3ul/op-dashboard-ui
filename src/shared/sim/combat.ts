// Damage pipeline (health / downed / death, kill credit, team elimination, placement, win),
// inventory spill, spectating and the hitscan tracer with lag-compensated hitboxes.

import { DOWNED_HEALTH, MAX_REWIND_MS, PLAYER_RADIUS } from '../constants';
import {
  AMMO_IDS, CONSUMABLE_IDS, THROWABLE_IDS, applyArmorDamage, computeDamage, gearIdFor,
} from '../items';
import type { DamageResult } from '../items';
import { buildHitboxes, lineOfSight, raycastHitboxes, raycastWorld } from '../physics';
import type { HitboxPose } from '../physics';
import { hashFloat } from '../rng';
import { raycastVehicle } from '../vehicles';
import type {
  ArmorState, DamageSource, EntityId, Hitbox, HitPart, ItemId, PlayerState, RayHit, TeamId, Vec3,
  VehicleState, WeaponDef,
} from '../types';
import type { GameSim, TeamInfo } from './GameSim';
import { createPose } from './lagcomp';
import { damageVehicle, ejectFromVehicle } from './vehiclesSim';
import { targetBoxHit, testTargetDummies } from './training';
import {
  EVENT_RANGE, NOISE_IMPACT_RADIUS, RAY_BROADPHASE, SPILL_RADIUS, TRAINING_RESPAWN_DELAY,
  VEHICLE_BULLET_MUL,
} from './tuning';

export type HitResult = 'none' | 'damage' | 'knock' | 'kill';

/** Extra information about a damage application (scratch object, reused). */
export interface DamageInfo {
  attacker: PlayerState | null;
  source: DamageSource;
  part: HitPart;
  distance: number;
  /** Hit point and attacker position (hit events); null = no hit event. */
  pos: Vec3 | null;
  from: Vec3 | null;
  armorHit: boolean;
  armorBroke: boolean;
  /** Emit a hit event (only meaningful with an attacker). */
  emitHit: boolean;
}

export function damageInfo(attacker: PlayerState | null, source: DamageSource, part: HitPart = 'body'): DamageInfo {
  return {
    attacker, source, part, distance: 0, pos: null, from: null, armorHit: false, armorBroke: false, emitHit: false,
  };
}

const NO_ARMOR: ArmorState = { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 };

function attackerWeaponTag(source: DamageSource): PlayerState['lastAttackerWeapon'] {
  switch (source) {
    case 'explosion': return 'vehicle';
    case 'bleed':
    case 'drown': return null;
    default: return source;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function rv(v: Vec3): Vec3 {
  return { x: round2(v.x), y: round2(v.y), z: round2(v.z) };
}

/**
 * Apply `amount` damage (already armor-reduced by the caller where applicable) to a player.
 * Alive players lose health and are knocked or killed at 0; downed players lose downedHp.
 * Friendly fire is off (self damage is allowed).
 */
export function damagePlayer(sim: GameSim, v: PlayerState, amount: number, info: DamageInfo): HitResult {
  if (v.life === 'dead' || !(amount > 0) || sim.phase === 'ended' || v.mode === 'plane') return 'none';
  const a = info.attacker;
  if (a && a !== v && a.team === v.team) return 'none';
  const enemy = a !== null && a !== v;
  let dealt: number;
  let result: HitResult;
  if (v.life === 'alive') {
    dealt = Math.min(v.health, amount);
    v.health -= amount;
    result = v.health <= 0 ? (shouldKnock(sim, v) ? 'knock' : 'kill') : 'damage';
  } else {
    dealt = Math.min(v.downedHp, amount);
    v.downedHp -= amount;
    result = v.downedHp <= 0 ? 'kill' : 'damage';
  }
  if (enemy) {
    a.stats.damage += dealt;
    v.lastAttacker = a.id;
    v.lastAttackerWeapon = attackerWeaponTag(info.source);
  }
  if (info.emitHit && a && info.pos) {
    sim.emit({
      type: 'hit', attacker: a.id, victim: v.id, damage: Math.round(dealt * 10) / 10, part: info.part,
      armor: info.armorHit, armorBroke: info.armorBroke, pos: rv(info.pos), from: rv(info.from ?? info.pos),
      source: info.source, result, distance: Math.round(info.distance),
    }, [a.id, v.id]);
  }
  if (result === 'knock') {
    knockPlayer(sim, v, enemy ? a : null, info.source, info.part === 'head', info.distance);
  } else if (result === 'kill') {
    const wasDowned = v.life === 'downed';
    // Credit: the finishing enemy (also recorded as lastAttacker above) or whoever hurt them last.
    const credit = enemy ? a.id : v.lastAttacker;
    killPlayer(sim, v, credit, info.source, info.part === 'head', info.distance, wasDowned && enemy);
  }
  return result;
}

/** Downed instead of dead: squads only, while a teammate is still standing. */
function shouldKnock(sim: GameSim, v: PlayerState): boolean {
  if (sim.config.mode !== 'br' || sim.config.teamSize <= 1) return false;
  const team = sim.teams[v.team];
  if (!team) return false;
  for (const m of team.members) if (m !== v && m.life === 'alive') return true;
  return false;
}

function knockPlayer(
  sim: GameSim, v: PlayerState, attacker: PlayerState | null, source: DamageSource, headshot: boolean, distance: number,
): void {
  const rt = sim.rtById.get(v.id)!;
  v.life = 'downed';
  v.health = 0;
  v.downedHp = DOWNED_HEALTH;
  v.knockCount++;
  v.stance = 'prone';
  v.ads = 0;
  v.lean = 0;
  v.sprayCount = 0;
  v.reloadTimer = 0;
  v.reloadTotal = 0;
  v.use = null;
  cancelRevive(sim, v);
  rt.knockDistance = distance;
  rt.knockHeadshot = headshot;
  if (attacker) attacker.stats.knocks++;
  sim.emit({
    type: 'knock', attacker: attacker ? attacker.id : null, victim: v.id, source, headshot,
    distance: Math.round(distance),
  });
}

/** Stop `p`'s own revive (and release the target). */
export function cancelRevive(sim: GameSim, p: PlayerState): void {
  if (!p.revive) return;
  const t = sim.players.get(p.revive.target);
  if (t && t.revivedBy === p.id) t.revivedBy = null;
  p.revive = null;
}

/** Stop whoever is reviving `target`. */
function releaseReviver(sim: GameSim, target: PlayerState): void {
  if (target.revivedBy === null) return;
  const r = sim.players.get(target.revivedBy);
  if (r && r.revive && r.revive.target === target.id) r.revive = null;
  target.revivedBy = null;
}

export function killPlayer(
  sim: GameSim, v: PlayerState, credit: EntityId | null, source: DamageSource, headshot: boolean,
  distance: number, finished: boolean,
): void {
  if (v.life === 'dead') return;
  const rt = sim.rtById.get(v.id)!;
  if (v.vehicleId !== null) ejectFromVehicle(sim, v, false);
  v.life = 'dead';
  v.health = 0;
  v.downedHp = 0;
  v.ads = 0;
  v.lean = 0;
  v.reloadTimer = 0;
  v.reloadTotal = 0;
  v.drawTimer = 0;
  v.use = null;
  v.parachuteOpen = false;
  v.vel.x = 0; v.vel.z = 0;
  cancelRevive(sim, v);
  releaseReviver(sim, v);
  v.stats.deathTime = sim.time;
  v.killerId = credit;
  const killer = credit !== null ? sim.players.get(credit) ?? null : null;
  if (killer && killer !== v && killer.team !== v.team) {
    killer.stats.kills++;
    if (distance > killer.stats.longestKill) killer.stats.longestKill = Math.round(distance * 10) / 10;
  }
  sim.emit({
    type: 'kill', attacker: credit, victim: v.id, source, headshot, distance: Math.round(distance), finished,
  });
  if (sim.config.mode === 'training') {
    rt.respawnTimer = TRAINING_RESPAWN_DELAY;
  } else {
    spillInventory(sim, v);
  }
  v.spectating = pickSpectateTarget(sim, v);
  if (sim.config.mode === 'br') checkTeam(sim, v.team);
}

/** After a death: when nobody in the team is standing, downed members die and the team is out. */
function checkTeam(sim: GameSim, teamId: TeamId): void {
  const team = sim.teams[teamId];
  if (!team || team.eliminated) return;
  for (const m of team.members) if (m.life === 'alive') return;
  team.eliminated = true; // set first: the kills below re-enter checkTeam
  for (const m of team.members) {
    if (m.life === 'downed') {
      const rt = sim.rtById.get(m.id)!;
      killPlayer(sim, m, m.lastAttacker, 'bleed', rt.knockHeadshot, rt.knockDistance, false);
    }
  }
  const remaining = teamsInGame(sim);
  team.placement = remaining + 1;
  for (const m of team.members) m.placement = team.placement;
  sim.emit({ type: 'teamEliminated', team: team.id, placement: team.placement });
  if (remaining <= 1 && sim.phase !== 'ended') {
    let winner: TeamInfo | null = null;
    for (const t of sim.teams) if (!t.eliminated && t.members.length > 0) winner = t;
    if (winner) {
      winner.placement = 1;
      for (const m of winner.members) m.placement = 1;
    }
    // Everyone fell in the same tick: the last team eliminated (placement 1 by count) wins.
    sim.endMatch(winner ? winner.id : team.placement === 1 ? team.id : null);
  }
}

/** Teams that still have a member who is not dead. */
export function teamsInGame(sim: GameSim): number {
  let n = 0;
  for (const t of sim.teams) {
    if (t.eliminated || t.members.length === 0) continue;
    for (const m of t.members) {
      if (m.life !== 'dead') { n++; break; }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Spill / spectate
// ---------------------------------------------------------------------------------------------

const spillPos: Vec3 = { x: 0, y: 0, z: 0 };
const spillFrom: Vec3 = { x: 0, y: 0, z: 0 };

/** Drop a dead player's whole inventory as loot on a small ring around the body. */
export function spillInventory(sim: GameSim, p: PlayerState): void {
  const drops: { item: ItemId; count: number; mag?: number }[] = [];
  for (let s = 0; s < 3; s++) {
    const w = p.weapons[s];
    if (w) drops.push({ item: w.id, count: 1, mag: w.mag });
    p.weapons[s] = null;
  }
  p.activeSlot = -1;
  for (const id of AMMO_IDS) {
    if (p.ammo[id] > 0) drops.push({ item: id, count: p.ammo[id] });
    p.ammo[id] = 0;
  }
  for (const id of CONSUMABLE_IDS) {
    if (p.items[id] > 0) drops.push({ item: id, count: p.items[id] });
    p.items[id] = 0;
  }
  for (const id of THROWABLE_IDS) {
    if (p.items[id] > 0) drops.push({ item: id, count: p.items[id] });
    p.items[id] = 0;
  }
  const a = p.armor;
  if (a.vest > 0) drops.push({ item: gearIdFor('vest', a.vest)!, count: 1, mag: Math.ceil(a.vestHp) });
  if (a.helmet > 0) drops.push({ item: gearIdFor('helmet', a.helmet)!, count: 1, mag: Math.ceil(a.helmetHp) });
  if (a.pack > 0) drops.push({ item: gearIdFor('pack', a.pack)!, count: 1 });
  a.vest = 0; a.vestHp = 0; a.helmet = 0; a.helmetHp = 0; a.pack = 0;
  const n = drops.length;
  if (n === 0) return;
  const rot = hashFloat(sim.config.seed, p.id, sim.tick) * Math.PI * 2;
  const radius = SPILL_RADIUS + 0.08 * n;
  spillFrom.x = p.pos.x;
  spillFrom.y = p.pos.y + 0.5;
  spillFrom.z = p.pos.z;
  for (let i = 0; i < n; i++) {
    const ang = rot + (i / n) * Math.PI * 2;
    spillPos.x = p.pos.x + Math.cos(ang) * radius;
    spillPos.z = p.pos.z + Math.sin(ang) * radius;
    spillPos.y = p.pos.y + 0.5;
    // Keep items out of walls: fall back to the body position when the ring point is blocked.
    if (!lineOfSight(sim.world, spillFrom, spillPos)) {
      spillPos.x = p.pos.x + Math.cos(ang) * 0.15;
      spillPos.z = p.pos.z + Math.sin(ang) * 0.15;
    }
    sim.placeLoot(drops[i].item, drops[i].count, spillPos, p.pos.y, drops[i].mag);
  }
}

/** Spectate target for a dead player: a living teammate, else the killer (chain), else anyone. */
export function pickSpectateTarget(sim: GameSim, p: PlayerState): EntityId | null {
  const team = sim.teams[p.team];
  if (team) {
    if (p.spectating !== null) {
      const cur = sim.players.get(p.spectating);
      if (cur && cur.team === p.team && cur.life !== 'dead') return cur.id;
    }
    for (const m of team.members) if (m !== p && m.life !== 'dead') return m.id;
  }
  let k = p.killerId;
  for (let i = 0; i < 8 && k !== null; i++) {
    const kp = sim.players.get(k);
    if (!kp) break;
    if (kp.life !== 'dead') return kp.id;
    k = kp.killerId;
  }
  for (const o of sim.playerList) if (o !== p && o.life !== 'dead') return o.id;
  return null;
}

/** Valid manual spectate target: teammates while the team lives, else any living player. */
export function canSpectate(sim: GameSim, p: PlayerState, id: EntityId): boolean {
  const t = sim.players.get(id);
  if (!t || t === p || t.life === 'dead') return false;
  const team = sim.teams[p.team];
  const teamAlive = !!team && team.members.some((m) => m !== p && m.life !== 'dead');
  return teamAlive ? t.team === p.team : true;
}

// ---------------------------------------------------------------------------------------------
// Hit testing (shared by hitscan and ballistic projectiles)
// ---------------------------------------------------------------------------------------------

export interface TraceHit {
  kind: 'none' | 'world' | 'player' | 'vehicle' | 'dummy';
  t: number;
  player: PlayerState | null;
  vehicle: VehicleState | null;
  part: HitPart;
  /** Training target id for dummies / target boxes (-1 otherwise). */
  target: number;
  world: RayHit;
}

export function createTraceHit(): TraceHit {
  return {
    kind: 'none', t: 0, player: null, vehicle: null, part: 'body', target: -1,
    world: { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, kind: 'terrain', material: 'dirt' },
  };
}

/** Per-sim scratch for rewound candidate poses. */
export class TraceScratch {
  poses: HitboxPose[] = [];
  owners: PlayerState[] = [];
  count = 0;
  boxes: Hitbox[] = [];
  ensure(n: number): void {
    while (this.poses.length < n) this.poses.push(createPose());
  }
}

/**
 * Gather candidate players for a shot at hitbox time `time`: rewound poses of every living enemy
 * (excluding the shooter and teammates — friendly fire is off and teammates do not block).
 * `nearX/Z/R` limits the gather to players whose current position is within R (XZ) of a point.
 */
export function gatherCandidates(
  sim: GameSim, shooter: PlayerState, time: number, sc: TraceScratch, nearX: number, nearZ: number, nearR: number,
): void {
  const list = sim.playerList;
  sc.ensure(list.length);
  sc.count = 0;
  const r2 = nearR * nearR;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === shooter || o.team === shooter.team || o.life === 'dead' || o.mode === 'plane') continue;
    const dx = o.pos.x - nearX, dz = o.pos.z - nearZ;
    if (dx * dx + dz * dz > r2) continue;
    const pose = sc.poses[sc.count];
    if (!sim.history.poseAt(o.id, time, pose)) continue;
    if (pose.life === 'dead' || pose.mode === 'plane') continue;
    sc.owners[sc.count] = o;
    sc.count++;
  }
}

/** Squared distance from point c to the ray segment o + d*t, t in [0, maxT]. */
function segDistSq(o: Vec3, d: Vec3, maxT: number, cx: number, cy: number, cz: number): number {
  const wx = cx - o.x, wy = cy - o.y, wz = cz - o.z;
  let t = wx * d.x + wy * d.y + wz * d.z;
  if (t < 0) t = 0; else if (t > maxT) t = maxT;
  const px = wx - d.x * t, py = wy - d.y * t, pz = wz - d.z * t;
  return px * px + py * py + pz * pz;
}

/**
 * Nearest hit along a ray against the world, the gathered candidates (rewound hitboxes),
 * training dummies (at `dummyTime`) and vehicles (current pose, excluding `ownVehicle`).
 * Occupants of a vehicle are hit through that vehicle's hull (open seats / windows).
 */
export function traceRay(
  sim: GameSim, origin: Vec3, dir: Vec3, maxDist: number, sc: TraceScratch, dummyTime: number,
  ownVehicle: EntityId | null, out: TraceHit,
): TraceHit {
  out.kind = 'none';
  out.player = null;
  out.vehicle = null;
  out.target = -1;
  out.t = maxDist;
  const wh = raycastWorld(sim.world, origin, dir, maxDist, out.world);
  let best = maxDist;
  if (wh) {
    best = wh.dist;
    out.kind = 'world';
    out.t = best;
    const tgt = targetBoxHit(sim, wh, out);
    if (tgt >= 0) out.target = tgt;
  }
  // Players (rewound hitboxes).
  const bc = RAY_BROADPHASE * RAY_BROADPHASE;
  let pBest = best;
  let pHit: PlayerState | null = null;
  let pPart: HitPart = 'body';
  for (let i = 0; i < sc.count; i++) {
    const pose = sc.poses[i];
    const cy = pose.pos.y + (pose.mode === 'vehicle' ? 0.8 : 0.9);
    if (segDistSq(origin, dir, pBest, pose.pos.x, cy, pose.pos.z) > bc) continue;
    const boxes = buildHitboxes(pose, sc.boxes);
    if (boxes.length === 0) continue;
    const h = raycastHitboxes(origin, dir, pBest, boxes);
    if (h && h.t < pBest) {
      pBest = h.t;
      pHit = sc.owners[i];
      pPart = h.part;
    }
  }
  // Training dummies (moving / popup targets).
  if (sim.training) {
    const d = testTargetDummies(sim, origin, dir, Math.min(pBest, best), dummyTime, sc);
    if (d.target >= 0 && d.t < Math.min(pBest, best)) {
      out.kind = 'dummy';
      out.t = d.t;
      out.part = d.part;
      out.target = d.target;
      best = d.t;
      if (pBest > best) { pHit = null; pBest = best; }
    }
  }
  // Vehicles (current pose).
  let vBest = Math.min(best, pBest);
  let vHit: VehicleState | null = null;
  const vl = sim.vehicleList;
  for (let i = 0; i < vl.length; i++) {
    const v = vl[i];
    if (v.id === ownVehicle) continue;
    if (segDistSq(origin, dir, vBest, v.pos.x, v.pos.y, v.pos.z) > 25) continue;
    const t = raycastVehicle(v, origin, dir, vBest);
    if (t >= 0 && t < vBest) {
      // Occupants of this vehicle remain hittable through the hull.
      if (pHit && pHit.vehicleId === v.id) continue;
      vBest = t;
      vHit = v;
    }
  }
  if (vHit) {
    out.kind = 'vehicle';
    out.t = vBest;
    out.vehicle = vHit;
    out.target = -1;
    return out;
  }
  if (pHit && pBest <= best) {
    out.kind = 'player';
    out.t = pBest;
    out.player = pHit;
    out.part = pPart;
    out.target = -1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hitscan shots
// ---------------------------------------------------------------------------------------------

const dmgScratch: DamageResult = { health: 0, vestDmg: 0, helmetDmg: 0, armorHit: false, armorBroke: false };
const PART_RANK: Record<HitPart, number> = { limb: 0, body: 1, head: 2 };

/** Per-shot aggregation of pellet damage per victim. */
class ShotAgg {
  victims: PlayerState[] = [];
  dmg: number[] = [];
  part: HitPart[] = [];
  armorHit: boolean[] = [];
  armorBroke: boolean[] = [];
  pos: Vec3[] = [];
  dist: number[] = [];
  n = 0;
  reset(): void { this.n = 0; }
  add(v: PlayerState, d: number, part: HitPart, r: DamageResult, pos: Vec3, dist: number): void {
    let i = this.victims.indexOf(v);
    if (i < 0 || i >= this.n) {
      i = this.n++;
      this.victims[i] = v;
      this.dmg[i] = 0;
      this.part[i] = part;
      this.armorHit[i] = false;
      this.armorBroke[i] = false;
      if (!this.pos[i]) this.pos[i] = { x: 0, y: 0, z: 0 };
      this.pos[i].x = pos.x; this.pos[i].y = pos.y; this.pos[i].z = pos.z;
      this.dist[i] = dist;
    }
    this.dmg[i] += d;
    if (PART_RANK[part] > PART_RANK[this.part[i]]) this.part[i] = part;
    this.armorHit[i] = this.armorHit[i] || r.armorHit;
    this.armorBroke[i] = this.armorBroke[i] || r.armorBroke;
  }
}
const agg = new ShotAgg();
const traceOut = createTraceHit();
const hitPoint: Vec3 = { x: 0, y: 0, z: 0 };
const info = damageInfo(null, 'ar');

/**
 * Pellet damage to a player hit (armor applied to alive victims; downed victims take raw damage).
 * Returns the health damage.
 */
export function pelletDamage(w: WeaponDef, victim: PlayerState, part: HitPart, distance: number): DamageResult {
  if (victim.life === 'alive') {
    computeDamage(w.id, part, distance, victim.armor, dmgScratch);
    applyArmorDamage(victim.armor, dmgScratch);
  } else {
    computeDamage(w.id, part, distance, NO_ARMOR, dmgScratch);
  }
  return dmgScratch;
}

/** Emit an impact event and a little bit of noise for bots. */
export function emitImpact(sim: GameSim, pos: Vec3, normal: Vec3, material: RayHit['material'], weapon: WeaponDef['id'] | undefined, shooter: EntityId): void {
  const p = rv(pos);
  const ev: { type: 'impact'; pos: Vec3; normal: Vec3; material: RayHit['material']; weapon?: WeaponDef['id'] } = {
    type: 'impact', pos: p, normal: { x: Math.round(normal.x * 1000) / 1000, y: Math.round(normal.y * 1000) / 1000, z: Math.round(normal.z * 1000) / 1000 }, material,
  };
  if (weapon) ev.weapon = weapon;
  sim.emit(ev, undefined, p, EVENT_RANGE.impact);
  sim.addNoise(p, shooter, 'impact', NOISE_IMPACT_RADIUS);
}

/** Lag-compensated rewind (s) for an input render time `rtMs`. */
export function rewindFor(sim: GameSim, rtMs: number): number {
  const now = sim.time * 1000;
  const r = now - rtMs;
  return (r > 0 ? (r < MAX_REWIND_MS ? r : MAX_REWIND_MS) : 0) / 1000;
}

/**
 * Resolve a hitscan trigger pull: trace every pellet (rewound hitboxes), apply aggregated damage
 * per victim, vehicles take VEHICLE_BULLET_MUL of the weapon damage, training targets report.
 * Writes pellet end points into `ends` (allocated: they go into the shot event).
 */
export function fireHitscan(
  sim: GameSim, shooter: PlayerState, w: WeaponDef, origin: Vec3, dirs: Vec3[], rewind: number, ends: Vec3[],
): void {
  const sc = sim.traceScratch;
  const hitTime = sim.time - rewind;
  gatherCandidates(sim, shooter, hitTime, sc, origin.x, origin.z, w.range + 20);
  agg.reset();
  let impacts = 0;
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    const h = traceRay(sim, origin, d, w.range, sc, hitTime, shooter.vehicleId, traceOut);
    hitPoint.x = origin.x + d.x * h.t;
    hitPoint.y = origin.y + d.y * h.t;
    hitPoint.z = origin.z + d.z * h.t;
    ends.push(rv(hitPoint));
    switch (h.kind) {
      case 'player': {
        const r = pelletDamage(w, h.player!, h.part, h.t);
        agg.add(h.player!, r.health, h.part, r, hitPoint, h.t);
        break;
      }
      case 'vehicle': {
        computeDamage(w.id, 'body', h.t, NO_ARMOR, dmgScratch);
        damageVehicle(sim, h.vehicle!, dmgScratch.health * VEHICLE_BULLET_MUL, shooter);
        if (impacts++ < 3) emitImpact(sim, hitPoint, h.world.normal, 'metal', w.id, shooter.id);
        break;
      }
      case 'dummy':
      case 'world': {
        if (h.target >= 0) sim.trainingTargetHit(shooter, h.target, w.id, h.part, h.t);
        if (h.kind === 'world' && impacts++ < 3) emitImpact(sim, hitPoint, h.world.normal, h.world.material, w.id, shooter.id);
        break;
      }
      default:
        break;
    }
  }
  applyShotDamage(sim, shooter, w.id, origin);
}

/** Apply the aggregated per-victim damage of one shot (hit events, stats). */
export function applyShotDamage(sim: GameSim, shooter: PlayerState, weapon: WeaponDef['id'], origin: Vec3): void {
  if (agg.n === 0) return;
  shooter.stats.shotsHit++;
  for (let i = 0; i < agg.n; i++) {
    const v = agg.victims[i];
    if (agg.part[i] === 'head') shooter.stats.headshots++;
    emitImpact(sim, agg.pos[i], UP, agg.armorHit[i] ? 'armor' : 'flesh', weapon, shooter.id);
    info.attacker = shooter;
    info.source = weapon;
    info.part = agg.part[i];
    info.distance = agg.dist[i];
    info.pos = agg.pos[i];
    info.from = origin;
    info.armorHit = agg.armorHit[i];
    info.armorBroke = agg.armorBroke[i];
    info.emitHit = true;
    damagePlayer(sim, v, agg.dmg[i], info);
  }
  agg.reset();
}

/** Single-hit helper for projectiles (one pellet). */
export function projectileHitPlayer(
  sim: GameSim, shooter: PlayerState, w: WeaponDef, victim: PlayerState, part: HitPart, distance: number,
  pos: Vec3, origin: Vec3,
): void {
  agg.reset();
  const r = pelletDamage(w, victim, part, distance);
  agg.add(victim, r.health, part, r, pos, distance);
  applyShotDamage(sim, shooter, w.id, origin);
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Player body centre (for explosions / interactions). */
export function bodyCenter(p: PlayerState, out: Vec3): Vec3 {
  out.x = p.pos.x;
  out.z = p.pos.z;
  out.y = p.pos.y + (p.mode === 'vehicle' ? 0.8 : p.stance === 'prone' || p.life === 'downed' ? 0.25 : p.stance === 'crouch' ? 0.6 : 0.9);
  return out;
}

export { PLAYER_RADIUS };
