// Snapshot delta codec ("delta1").
//
// WebSocket delivery is reliable and ordered, so each snapshot can be encoded relative to the
// previous snapshot sent on the same connection without acks or keyframes. Per entity we send only
// the fields that changed since that entity was last sent; unchanged-but-relevant entities cost a
// few bytes ("[id]"). The decoder rebuilds full Snapshot objects copy-on-write, so snapshots the
// client still buffers for interpolation are never mutated.
//
// Encoder and decoder must be reset together on every matchInit.

import type { NetPlayer, NetProjectile, NetVehicle, SelfState, Snapshot } from './protocol';
import type { EntityId, PlaneState, ZoneState } from './types';

/** Marker key listing removed object keys inside a diff. */
const DEL = '$d';

type Obj = Record<string, unknown>;
const NOCHANGE: unique symbol = Symbol('nochange');
type Diff = unknown | typeof NOCHANGE;

const isPlainObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Obj, bo = b as Obj;
  for (const k in ao) if (ao[k] !== undefined && !deepEqual(ao[k], bo[k])) return false;
  for (const k in bo) if (bo[k] !== undefined && ao[k] === undefined) return false;
  return true;
}

/** Structural clone of JSON-like data (drops undefined values). */
function cloneJson<T>(x: T): T {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(cloneJson) as unknown as T;
  const out: Obj = {};
  for (const k in x as Obj) {
    const v = (x as Obj)[k];
    if (v !== undefined) out[k] = cloneJson(v);
  }
  return out as T;
}

/** Diff next against prev. Objects diff per key (recursively); arrays and primitives are replaced whole. */
export function diffValue(prev: unknown, next: unknown): Diff {
  if (isPlainObject(prev) && isPlainObject(next)) {
    let out: Obj | null = null;
    for (const k in next) {
      const nv = next[k];
      if (nv === undefined) continue;
      const d = diffValue(prev[k], nv);
      if (d !== NOCHANGE) (out ??= {})[k] = d;
    }
    let removed: string[] | null = null;
    for (const k in prev) {
      if (prev[k] !== undefined && next[k] === undefined) (removed ??= []).push(k);
    }
    if (removed) (out ??= {})[DEL] = removed;
    return out ?? NOCHANGE;
  }
  if (deepEqual(prev, next)) return NOCHANGE;
  return cloneJson(next);
}

/** Apply a diff produced by diffValue, returning a NEW value (prev is never mutated). */
export function applyDiff(prev: unknown, d: unknown): unknown {
  if (isPlainObject(d) && isPlainObject(prev)) {
    const out: Obj = { ...prev };
    for (const k in d) {
      if (k === DEL) continue;
      out[k] = applyDiff(prev[k], d[k]);
    }
    const removed = d[DEL];
    if (Array.isArray(removed)) for (const k of removed) delete out[k as string];
    return out;
  }
  if (isPlainObject(d)) {
    // No previous object: the diff is a full value (minus the removal marker).
    const out: Obj = {};
    for (const k in d) if (k !== DEL) out[k] = d[k];
    return out;
  }
  return d;
}

/** Wire format of a delta snapshot. */
export interface SnapDelta {
  tick: number;
  time: number;
  phase: Snapshot['phase'];
  alive: number;
  teamsAlive: number;
  /** Zone diff (omitted when unchanged) */
  z?: unknown;
  /** Plane diff; null = no plane (omitted when unchanged) */
  pl?: unknown;
  /** Players: [id] unchanged, [id, diff] changed/new */
  p: Array<[EntityId] | [EntityId, unknown]>;
  /** Vehicles: same as players */
  v: Array<[EntityId] | [EntityId, unknown]>;
  /** Projectiles are short-lived: sent whole */
  pr: NetProjectile[];
  /** Self diff (omitted when unchanged); null = no self */
  s?: unknown;
  gone?: EntityId[];
  events: Snapshot['events'];
  lootAdd?: Snapshot['lootAdd'];
  lootRemove?: Snapshot['lootRemove'];
}

export class SnapshotEncoder {
  private players = new Map<EntityId, NetPlayer>();
  private vehicles = new Map<EntityId, NetVehicle>();
  private self: SelfState | null = null;
  private zone: ZoneState | null = null;
  private plane: PlaneState | null = null;
  private first = true;

  reset(): void {
    this.players.clear();
    this.vehicles.clear();
    this.self = null;
    this.zone = null;
    this.plane = null;
    this.first = true;
  }

  encode(s: Snapshot): SnapDelta {
    const out: SnapDelta = {
      tick: s.tick, time: s.time, phase: s.phase, alive: s.alive, teamsAlive: s.teamsAlive,
      p: [], v: [], pr: s.projectiles, events: s.events,
    };
    const zd = diffValue(this.zone, s.zone);
    if (zd !== NOCHANGE || this.first) out.z = zd === NOCHANGE ? cloneJson(s.zone) : zd;
    this.zone = cloneJson(s.zone);
    if (this.first || !deepEqual(this.plane, s.plane)) out.pl = s.plane === null ? null : diffValue(this.plane, s.plane);
    if (out.pl === NOCHANGE) delete out.pl;
    this.plane = cloneJson(s.plane);

    for (const p of s.players) {
      const prev = this.players.get(p.id);
      const d = diffValue(prev, p);
      out.p.push(d === NOCHANGE ? [p.id] : [p.id, d]);
      this.players.set(p.id, cloneJson(p));
    }
    for (const v of s.vehicles) {
      const prev = this.vehicles.get(v.id);
      const d = diffValue(prev, v);
      out.v.push(d === NOCHANGE ? [v.id] : [v.id, d]);
      this.vehicles.set(v.id, cloneJson(v));
    }
    if (s.gone) {
      out.gone = s.gone;
      for (const id of s.gone) { this.players.delete(id); this.vehicles.delete(id); }
    }
    if (s.self === null) {
      if (this.self !== null || this.first) out.s = null;
      this.self = null;
    } else {
      const d = diffValue(this.self, s.self);
      if (d !== NOCHANGE) out.s = d;
      this.self = cloneJson(s.self);
    }
    if (s.lootAdd?.length) out.lootAdd = s.lootAdd;
    if (s.lootRemove?.length) out.lootRemove = s.lootRemove;
    this.first = false;
    return out;
  }
}

export class SnapshotDecoder {
  private players = new Map<EntityId, NetPlayer>();
  private vehicles = new Map<EntityId, NetVehicle>();
  private self: SelfState | null = null;
  private zone: ZoneState | null = null;
  private plane: PlaneState | null = null;

  reset(): void {
    this.players.clear();
    this.vehicles.clear();
    this.self = null;
    this.zone = null;
    this.plane = null;
  }

  decode(d: SnapDelta): Snapshot {
    if (d.z !== undefined) this.zone = applyDiff(this.zone, d.z) as ZoneState;
    if (d.pl !== undefined) this.plane = d.pl === null ? null : (applyDiff(this.plane, d.pl) as PlaneState);
    const players: NetPlayer[] = [];
    for (const e of d.p) {
      const id = e[0];
      let p = this.players.get(id);
      if (e.length === 2) {
        p = applyDiff(p, e[1]) as NetPlayer;
        this.players.set(id, p);
      }
      if (p) players.push(p);
    }
    const vehicles: NetVehicle[] = [];
    for (const e of d.v) {
      const id = e[0];
      let v = this.vehicles.get(id);
      if (e.length === 2) {
        v = applyDiff(v, e[1]) as NetVehicle;
        this.vehicles.set(id, v);
      }
      if (v) vehicles.push(v);
    }
    if (d.gone) for (const id of d.gone) { this.players.delete(id); this.vehicles.delete(id); }
    if (d.s !== undefined) this.self = d.s === null ? null : (applyDiff(this.self, d.s) as SelfState);
    const snap: Snapshot = {
      tick: d.tick, time: d.time, phase: d.phase, alive: d.alive, teamsAlive: d.teamsAlive,
      zone: this.zone as ZoneState, plane: this.plane, players, vehicles, projectiles: d.pr,
      self: this.self, events: d.events,
    };
    if (d.gone) snap.gone = d.gone;
    if (d.lootAdd) snap.lootAdd = d.lootAdd;
    if (d.lootRemove) snap.lootRemove = d.lootRemove;
    return snap;
  }
}
