// Bot perception: what a human in the bot's shoes could know.
//
// * Vision: enemies inside the view cone (peripheral vision is shorter), within a range scaled by
//   difficulty and the target's stance / movement / muzzle flash, confirmed with line-of-sight
//   raycasts (chest, then head for peekers) from a global per-tick budget. Crouched / prone
//   targets inside bushes are hidden beyond close range.
// * Hearing: shots, explosions, vehicles and footsteps from sim.noises give a bearing and a rough
//   position to investigate (never the exact player).
// * Damage: getting hit gives the attacker's bearing (like the directional damage indicator).
// Enemy health, armour and inventory are never read.

import { hyp } from './util';
import { EYE_HEIGHT } from '../constants';
import { angleDiff, yawTo } from '../math';
import type { PlayerState } from '../types';
import { bushCoverHeight } from './mapinfo';
import { MAX_CONTACTS, type BotState, type Contact } from './state';
import type { BotSystem } from './system';

/** Forget contacts not seen for this long (s). */
const FORGET_AFTER = 25;
/** A contact's visibility flag expires if not re-checked within this time (s). */
const VISIBILITY_TTL = 0.45;
/** Max line-of-sight tests one bot spends per think. */
const MAX_LOS_PER_THINK = 4;
const MAX_CANDIDATES = 6;
/** Re-acquiring a contact lost for less than this keeps a short reaction. */
const REACQUIRE_WINDOW = 1.5;

const candId = new Int32Array(MAX_CANDIDATES);
const candPri = new Float64Array(MAX_CANDIDATES);
const candDist = new Float64Array(MAX_CANDIDATES);

/** Aim height above the feet for centre mass. */
export function chestHeight(q: PlayerState): number {
  if (q.life === 'downed') return 0.3;
  if (q.mode === 'vehicle') return 0.8;
  if (q.mode === 'swim') return 0.2;
  switch (q.stance) {
    case 'crouch': return 0.8;
    case 'prone': return 0.25;
    default: return 1.22;
  }
}

/** Head height above the feet. */
export function headHeight(q: PlayerState): number {
  if (q.life === 'downed') return 0.32;
  if (q.mode === 'vehicle') return 1.12;
  if (q.mode === 'swim') return 0.45;
  return q.stance === 'crouch' ? EYE_HEIGHT.crouch + 0.02 : q.stance === 'prone' ? EYE_HEIGHT.prone : EYE_HEIGHT.stand + 0.02;
}

export function findContact(b: BotState, id: number): Contact | null {
  if (id < 0) return null;
  for (let i = 0; i < MAX_CONTACTS; i++) if (b.contacts[i].id === id) return b.contacts[i];
  return null;
}

function allocContact(b: BotState, id: number): Contact {
  let oldest = b.contacts[0];
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const c = b.contacts[i];
    if (c.id < 0) {
      oldest = c;
      break;
    }
    if (c.lastSeen < oldest.lastSeen) oldest = c;
  }
  oldest.id = id;
  oldest.visible = false;
  oldest.lastSeen = -1e9;
  oldest.lastCheck = -1e9;
  oldest.firstSeen = 0;
  oldest.ready = 0;
  return oldest;
}

function isEnemy(sys: BotSystem, b: BotState, q: PlayerState): boolean {
  return q.id !== b.id && q.life !== 'dead' && q.mode !== 'plane' && !sys.sim.sameTeam(b.id, q.id);
}

/** Detection range for target q (m). */
function detectRange(sys: BotSystem, q: PlayerState): number {
  let r = sys.skill.visionRange;
  if (q.life === 'downed') r *= 0.6;
  else if (q.mode === 'vehicle') r *= 1.35;
  else if (q.mode === 'freefall' || q.mode === 'parachute') r *= 1.5;
  else if (q.stance === 'crouch') r *= 0.75;
  else if (q.stance === 'prone') r *= 0.45;
  const sp = hyp(q.vel.x, q.vel.z);
  if (sp > 5.5) r *= 1.15;
  if (q.fireCooldown > 0) r *= 1.5; // muzzle flash / tracer
  return r;
}

/** Update the visibility of one contact with up to two raycasts. Returns false when out of budget. */
function checkVisibility(sys: BotSystem, b: BotState, q: PlayerState, dist: number): boolean {
  const t = sys.now;
  const eye = sys.eye;
  const pt = sys.pt;
  pt.x = q.pos.x;
  pt.y = q.pos.y + chestHeight(q);
  pt.z = q.pos.z;
  let vis = sys.los(eye, pt);
  if (vis === null) return false;
  if (!vis) {
    pt.y = q.pos.y + headHeight(q);
    const v2 = sys.los(eye, pt);
    vis = v2 === true;
  }
  if (vis && dist > 22) {
    // Concealment: a still, low target inside a bush is invisible beyond close range.
    const sp = hyp(q.vel.x, q.vel.z);
    if (sp < 1.5 && q.fireCooldown <= 0) {
      const bush = bushCoverHeight(sys.world, sys.info, q.pos.x, q.pos.z);
      if (bush > 0 && headHeight(q) < bush + 0.1) vis = false;
    }
  }
  let c = findContact(b, q.id);
  if (vis) {
    if (!c) c = allocContact(b, q.id);
    if (!c.visible) {
      const gap = t - c.lastSeen;
      const sk = sys.skill;
      const react = gap < REACQUIRE_WINDOW ? sk.reaction * 0.35 : sk.reaction * (0.8 + 0.4 * b.rng.next());
      c.firstSeen = t;
      c.ready = t + react;
    }
    c.visible = true;
    c.lastSeen = t;
    c.x = q.pos.x;
    c.y = q.pos.y;
    c.z = q.pos.z;
    c.vx = q.vel.x;
    c.vz = q.vel.z;
    c.downed = q.life === 'downed';
  } else if (c) {
    c.visible = false;
  }
  if (c) c.lastCheck = t;
  return true;
}

/** Full perception pass (vision, hearing, damage awareness). Called on think ticks. */
export function perceive(sys: BotSystem, b: BotState, p: PlayerState): void {
  const sim = sys.sim;
  const t = sys.now;
  const sk = sys.skill;
  // Age contacts.
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const c = b.contacts[i];
    if (c.id < 0) continue;
    const q = sim.players.get(c.id);
    if (!q || q.life === 'dead' || t - c.lastSeen > FORGET_AFTER) {
      c.id = -1;
      c.visible = false;
      continue;
    }
    if (c.visible && t - c.lastCheck > VISIBILITY_TTL) c.visible = false;
  }
  damageAwareness(sys, b, p);
  hear(sys, b, p);

  const eye = sim.eyePos(b.id, sys.eye);
  const maxRange = sk.visionRange * 1.5;
  const near = sim.playersNear(p.pos.x, p.pos.z, maxRange, sys.playerBuf);
  let nc = 0;
  for (let i = 0; i < near.length; i++) {
    const q = near[i];
    if (!isEnemy(sys, b, q)) continue;
    const dx = q.pos.x - eye.x, dz = q.pos.z - eye.z, dy = q.pos.y + 1 - eye.y;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let range = detectRange(sys, q);
    const off = Math.abs(angleDiff(b.aimYaw, yawTo(eye, q.pos)));
    const tracked = q.id === b.targetId && t - (findContact(b, q.id)?.lastSeen ?? -1e9) < 0.6;
    if (d > 3.5) {
      if (off > sk.fovHalf + (tracked ? 0.5 : 0)) continue;
      if (off > sk.fovHalf * 0.55) range *= 0.6;
    }
    if (d > range) continue;
    let pri = d;
    if (q.id === b.targetId) pri *= 0.4;
    // Insert into the small candidate list (sorted by priority).
    let k = nc < MAX_CANDIDATES ? nc++ : MAX_CANDIDATES;
    if (k === MAX_CANDIDATES) {
      if (pri >= candPri[MAX_CANDIDATES - 1]) continue;
      k = MAX_CANDIDATES - 1;
    }
    while (k > 0 && candPri[k - 1] > pri) {
      candPri[k] = candPri[k - 1];
      candId[k] = candId[k - 1];
      candDist[k] = candDist[k - 1];
      k--;
    }
    candPri[k] = pri;
    candId[k] = q.id;
    candDist[k] = d;
  }
  let spent = 0;
  for (let i = 0; i < nc && spent < MAX_LOS_PER_THINK; i++) {
    const q = sim.players.get(candId[i]);
    if (!q) continue;
    const c = findContact(b, q.id);
    if (c && t - c.lastCheck < 0.1) continue;
    if (!checkVisibility(sys, b, q, candDist[i])) break;
    spent++;
  }
}

/** Cheap between-think refresh of the engaged target (one raycast). */
export function refreshTarget(sys: BotSystem, b: BotState, p: PlayerState): void {
  const c = findContact(b, b.targetId);
  if (!c || sys.now - c.lastSeen > 1.0) return;
  const q = sys.sim.players.get(c.id);
  if (!q || q.life === 'dead') return;
  sys.sim.eyePos(b.id, sys.eye);
  const d = hyp(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
  if (d > detectRange(sys, q) * 1.2) {
    c.visible = false;
    return;
  }
  checkVisibility(sys, b, q, d);
}

/** Choose the target among visible contacts (closest threat, attackers first, downed last). */
export function selectTarget(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  let best: Contact | null = null;
  let bestScore = Infinity;
  let anyVisible = false;
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const c = b.contacts[i];
    if (c.id < 0 || !c.visible) continue;
    anyVisible = true;
    let s = hyp(c.x - p.pos.x, c.z - p.pos.z);
    if (c.downed) s += 70;
    if (p.lastAttacker === c.id && t - b.lastDamageTime < 3) s -= 15;
    if (c.id === b.targetId) s -= 12;
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (anyVisible) b.lastContactTime = t;
  if (best) {
    if (best.id !== b.targetId) {
      const sk = sys.skill;
      b.targetId = best.id;
      b.errYaw = b.rng.gauss() * sk.aimErrorStart;
      b.errPitch = b.rng.gauss() * sk.aimErrorStart * 0.5;
      b.aimHead = b.rng.chance(sk.headshotBias);
      b.burstLeft = 0;
      b.burstPauseUntil = 0;
      b.prevBearing = yawTo(p.pos, best);
    }
    return;
  }
  // Keep remembering the last target for a while (pre-aim / push / frag), else drop it.
  const cur = findContact(b, b.targetId);
  if (!cur || t - cur.lastSeen > 10) b.targetId = -1;
}

function damageAwareness(sys: BotSystem, b: BotState, p: PlayerState): void {
  const t = sys.now;
  if (p.health < b.lastHealth - 0.5) {
    const src = p.lastAttackerWeapon;
    if (src !== 'zone' && src !== 'fall' && p.lastAttacker !== null && p.lastAttacker !== b.id) {
      b.lastDamageTime = t;
      const a = sys.sim.players.get(p.lastAttacker);
      if (a) {
        // Directional damage indicator: bearing only, with some error.
        const bearing = yawTo(p.pos, a.pos) + b.rng.gauss() * 0.12;
        b.alertYaw = bearing;
        b.alertUntil = t + 1.6;
        const d = 25 + b.rng.next() * 30;
        b.investigateX = p.pos.x - Math.sin(bearing) * d;
        b.investigateZ = p.pos.z - Math.cos(bearing) * d;
        b.investigateTime = t;
      }
      // Flinch.
      b.errYaw += b.rng.gauss() * sys.skill.aimErrorStart * 0.35;
      b.errPitch += b.rng.gauss() * sys.skill.aimErrorStart * 0.25;
    }
  }
  b.lastHealth = p.health;
}

function hear(sys: BotSystem, b: BotState, p: PlayerState): void {
  const sim = sys.sim;
  const noises = sim.noises;
  const t = sys.now;
  let bestW = 0, bx = 0, bz = 0, bd = 0;
  for (let i = 0; i < noises.length; i++) {
    const n = noises[i];
    if (n.time <= b.lastHeard || n.source === b.id) continue;
    const src = sim.players.get(n.source);
    if (src && sim.sameTeam(b.id, src.id)) continue;
    const dx = n.pos.x - p.pos.x, dz = n.pos.z - p.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const r = n.radius * sys.skill.hearing;
    if (d > r) continue;
    const kw = n.kind === 'shot' || n.kind === 'explosion' ? 3 : n.kind === 'vehicle' ? 1.5 : n.kind === 'footstep' ? 1.2 : 0.4;
    const w = kw * (1.05 - d / r);
    if (w > bestW) {
      bestW = w;
      bx = n.pos.x;
      bz = n.pos.z;
      bd = d;
    }
  }
  b.lastHeard = t;
  if (bestW <= 0) return;
  // Rough position: error grows with distance.
  b.investigateX = bx + b.rng.gauss() * bd * 0.07;
  b.investigateZ = bz + b.rng.gauss() * bd * 0.07;
  b.investigateTime = t;
  if (t - b.lastContactTime > 1) {
    b.alertYaw = Math.atan2(-(b.investigateX - p.pos.x), -(b.investigateZ - p.pos.z));
    b.alertUntil = t + 1.2 + b.rng.next() * 0.8;
  }
}
