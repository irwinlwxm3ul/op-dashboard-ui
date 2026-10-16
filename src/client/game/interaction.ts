// Client-side interaction prompt resolution (what pressing the interact key would do right now).
// Pure: everything comes in through InteractionEnv so it can be unit tested without a game.
// Ranges are slightly tighter than the server's checks so a shown prompt is always accepted.

import { INTERACT_RANGE, MIN_CHUTE_DROP, REVIVE_RANGE, VEHICLE_ENTER_RANGE } from '../../shared/constants';
import { DEG } from '../../shared/math';
import type {
  ClientAction, ConsumableId, EntityId, ItemId, LifeState, LootItem, MovementMode, Stance, ThrowableId, TrainingLayout,
  Vec3, World,
} from '../../shared/types';
import type { Interaction, PlayerView, VehicleView } from './types';

/** Loot whose direction is within this angle of the crosshair counts as "pointed at". */
const CROSSHAIR_ANGLE = 9 * DEG;
/** Max angle off the look direction for loot to count as "in view". */
const VIEW_ANGLE = 65 * DEG;
/** Angle weight (meters per radian) when ranking loot in view. */
const ANGLE_WEIGHT = 2.5;
/** Fuel below this is considered empty (show refuel instead of enter). */
const EMPTY_FUEL = 0.5;

export interface InteractionSelf {
  id: EntityId;
  team: number;
  pos: Vec3;
  stance: Stance;
  mode: MovementMode;
  life: LifeState;
  vehicleId: EntityId | null;
  seat: number;
  parachuteOpen: boolean;
  jumpY: number;
  items: Record<ConsumableId | ThrowableId, number>;
}

export interface InteractionEnv {
  world: World;
  self: InteractionSelf;
  /** Eye position and normalised look direction (crosshair). */
  eye: Vec3;
  look: Vec3;
  /** Current plane position (plane mode) or null. */
  planePos: Vec3 | null;
  players: ReadonlyMap<EntityId, PlayerView>;
  vehicles: ReadonlyMap<EntityId, VehicleView>;
  /** Loot items near the player (any superset of the items within range). */
  nearbyLoot: readonly LootItem[];
  /** Training racks (training ground only). */
  training: TrainingLayout | null;
  /** Line of sight test (eye -> point); omit to skip occlusion checks. */
  lineOfSight?: (a: Vec3, b: Vec3) => boolean;
  /** Precise "close enough to enter" test (vehicle OBB); defaults to a centre distance check. */
  vehicleNear?: (v: VehicleView, center: Vec3) => boolean;
}

/**
 * Interaction ranges used by the prompt. The server accepts slightly more (latency slack), so a
 * prompt that is shown is always accepted.
 */
export const PROMPT_RANGE = {
  loot: INTERACT_RANGE,
  vehicle: VEHICLE_ENTER_RANGE + 0.25,
  revive: REVIVE_RANGE + 0.1,
  rack: INTERACT_RANGE,
} as const;

const scratchTarget: Vec3 = { x: 0, y: 0, z: 0 };
const center: Vec3 = { x: 0, y: 0, z: 0 };

/** Body centre used by the server for interaction distances. */
export function bodyCenterOf(s: { pos: Vec3; mode: MovementMode; stance: Stance; life: LifeState }, out: Vec3): Vec3 {
  out.x = s.pos.x;
  out.z = s.pos.z;
  out.y = s.pos.y + (s.mode === 'vehicle' ? 0.8 : s.stance === 'prone' || s.life === 'downed' ? 0.25 : s.stance === 'crouch' ? 0.6 : 0.9);
  return out;
}

function reset(out: Interaction, kind: Interaction['kind'], hold: boolean): Interaction {
  out.kind = kind;
  out.hold = hold;
  out.targetId = undefined;
  out.item = undefined;
  out.count = undefined;
  out.vehicleType = undefined;
  out.seat = undefined;
  out.name = undefined;
  return out;
}

/** Eye distance of the last angleTo() call (avoids allocating a result object). */
let lastDist = 0;

/** Angle between the look direction and the direction from the eye to p (radians). */
function angleTo(eye: Vec3, look: Vec3, p: Vec3): number {
  const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
  const d = Math.hypot(dx, dy, dz);
  lastDist = d;
  if (d < 1e-6) return 0;
  const c = (dx * look.x + dy * look.y + dz * look.z) / d;
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Server rule: the item (+0.15 m) must be visible from the eye or from the body centre. */
function visible(env: InteractionEnv, p: Vec3): boolean {
  if (!env.lineOfSight) return true;
  scratchTarget.x = p.x;
  scratchTarget.y = p.y + 0.15;
  scratchTarget.z = p.z;
  return env.lineOfSight(env.eye, scratchTarget) || env.lineOfSight(center, scratchTarget);
}

/** First free seat of a vehicle (driver preferred), or -1. */
export function firstFreeSeat(v: VehicleView): number {
  for (let i = 0; i < v.seats.length; i++) if (v.seats[i] === null) return i;
  return -1;
}

/**
 * Resolve the interaction prompt. Priority: plane jump, open chute, exit vehicle, revive a downed
 * teammate, loot under the crosshair, vehicle (enter / refuel), training rack, other loot in view.
 * Writes into `out` and returns it, or returns null when nothing is available.
 */
export function resolveInteraction(env: InteractionEnv, out: Interaction): Interaction | null {
  const s = env.self;
  if (s.life !== 'alive') return null;

  if (s.mode === 'plane') {
    const p = env.planePos;
    return p && env.world.inBounds(p.x, p.z) ? reset(out, 'jump', false) : null;
  }
  if (s.mode === 'freefall') {
    return !s.parachuteOpen && s.jumpY - s.pos.y >= MIN_CHUTE_DROP ? reset(out, 'chute', false) : null;
  }
  if (s.mode === 'parachute') return null;
  bodyCenterOf(s, center);

  if (s.vehicleId !== null || s.mode === 'vehicle') {
    const r = reset(out, 'exit', false);
    if (s.vehicleId !== null) {
      r.targetId = s.vehicleId;
      r.vehicleType = env.vehicles.get(s.vehicleId)?.type;
    }
    r.seat = s.seat;
    return r;
  }

  // Revive the nearest downed teammate in range.
  let reviveBest: PlayerView | null = null;
  let reviveDist = PROMPT_RANGE.revive;
  for (const p of env.players.values()) {
    if (p.isSelf || !p.isTeammate || p.life !== 'downed') continue;
    const d = dist3(p.pos, s.pos);
    if (d <= reviveDist) {
      reviveDist = d;
      reviveBest = p;
    }
  }
  if (reviveBest) {
    const r = reset(out, 'revive', true);
    r.targetId = reviveBest.id;
    r.name = reviveBest.name;
    return r;
  }

  // Loot ranking: crosshair target first, otherwise the best item in view.
  let aimed: LootItem | null = null;
  let aimedAngle = CROSSHAIR_ANGLE;
  let viewBest: LootItem | null = null;
  let viewScore = Infinity;
  for (const l of env.nearbyLoot) {
    if (Math.min(dist3(l.pos, s.pos), dist3(l.pos, center)) > PROMPT_RANGE.loot) continue;
    const angle = angleTo(env.eye, env.look, l.pos);
    const dist = lastDist;
    if (angle <= aimedAngle) {
      aimedAngle = angle;
      aimed = l;
    }
    if (angle <= VIEW_ANGLE) {
      const score = dist + angle * ANGLE_WEIGHT;
      if (score < viewScore) {
        viewScore = score;
        viewBest = l;
      }
    }
  }
  if (aimed && visible(env, aimed.pos)) return lootInteraction(out, aimed);

  // Vehicles: nearest usable one in range.
  let veh: VehicleView | null = null;
  let vehDist = Infinity;
  for (const v of env.vehicles.values()) {
    if (v.destroyed) continue;
    const d = dist3(v.pos, center);
    if (d < vehDist && (d <= PROMPT_RANGE.vehicle || (env.vehicleNear !== undefined && env.vehicleNear(v, center)))) {
      vehDist = d;
      veh = v;
    }
  }
  if (veh) {
    if (veh.fuel < EMPTY_FUEL && (s.items.fuel ?? 0) > 0) {
      const r = reset(out, 'refuel', false);
      r.targetId = veh.id;
      r.vehicleType = veh.type;
      r.item = 'fuel';
      return r;
    }
    const seat = firstFreeSeat(veh);
    if (seat >= 0) {
      const r = reset(out, 'enter', false);
      r.targetId = veh.id;
      r.vehicleType = veh.type;
      r.seat = seat;
      return r;
    }
  }

  // Training ground weapon racks.
  if (env.training) {
    let rackItem: ItemId | null = null;
    let rackScore = Infinity;
    for (const rack of env.training.racks) {
      if (dist3(rack.pos, s.pos) > PROMPT_RANGE.rack + 0.6) continue;
      const angle = angleTo(env.eye, env.look, rack.pos);
      const dist = lastDist;
      if (angle > VIEW_ANGLE) continue;
      const score = dist + angle * ANGLE_WEIGHT * 2;
      if (score < rackScore) {
        rackScore = score;
        rackItem = rack.item;
      }
    }
    if (rackItem && (!viewBest || rackScore < viewScore)) {
      const r = reset(out, 'give', false);
      r.item = rackItem;
      return r;
    }
  }

  if (viewBest && visible(env, viewBest.pos)) return lootInteraction(out, viewBest);
  return null;
}

function lootInteraction(out: Interaction, l: LootItem): Interaction {
  const r = reset(out, 'pickup', false);
  r.targetId = l.id;
  r.item = l.item;
  r.count = l.count;
  return r;
}

/** The action the interact key sends for an interaction (null if it needs none). */
export function interactionAction(i: Interaction): ClientAction | null {
  switch (i.kind) {
    case 'jump': return { a: 'jump' };
    case 'chute': return { a: 'chute' };
    case 'exit': return { a: 'exit' };
    case 'pickup': return i.targetId !== undefined ? { a: 'pickup', id: i.targetId } : null;
    case 'revive': return i.targetId !== undefined ? { a: 'revive', id: i.targetId } : null;
    case 'enter': return i.targetId !== undefined ? { a: 'enter', id: i.targetId } : null;
    case 'refuel': return { a: 'use', item: 'fuel' };
    case 'give': return i.item ? { a: 'give', item: i.item } : null;
    default: return null;
  }
}
