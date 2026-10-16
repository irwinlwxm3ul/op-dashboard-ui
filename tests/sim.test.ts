// GameSim tests against the real Stage A modules (world, physics, items, vehicles) with scripted
// players (no bots). Test locations are searched in the generated world so they stay valid when
// world generation is tuned.
import { describe, expect, it } from 'vitest';
import {
  DOWNED_BLEED_PER_SEC, DOWNED_HEALTH, FALL_DAMAGE_PER_MS, FALL_DAMAGE_SPEED, HITBOX_HISTORY_MS, MAX_REWIND_MS,
  MIN_CHUTE_DROP, REVIVE_TIME, TICK_DT,
} from '../src/shared/constants';
import { GEAR, THROWABLES, WEAPONS, computeDamage, fireInterval, sightDrop, simulateTrajectory } from '../src/shared/items';
import { lineOfSight } from '../src/shared/physics';
import { Rng } from '../src/shared/rng';
import { GameSim, TRAINING_TARGET_CENTER_HEIGHT, ZONE_PHASES, ZONE_PRE_TIME, trainingTargetPosition } from '../src/shared/sim';
import type { SimEvent } from '../src/shared/sim';
import { damageInfo, damagePlayer } from '../src/shared/sim/combat';
import { VEHICLES, exitPosition } from '../src/shared/vehicles';
import type {
  GameEvent, MatchConfig, PlayerInput, PlayerState, RockDef, TreeDef, Vec3, WeaponId, World, WorldBox,
} from '../src/shared/types';
import { BTN } from '../src/shared/types';

const SEED = 1234;
const BASE: MatchConfig = {
  mode: 'br', seed: SEED, maxPlayers: 8, teamSize: 1, botFill: false, botDifficulty: 'normal',
  zoneSpeed: 1, infiniteAmmo: false,
};
const NO_ARMOR = { vest: 0 as const, vestHp: 0, helmet: 0 as const, helmetHp: 0, pack: 0 as const };

type Ev<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;

/** Scripted-input harness: every placed player gets an input every tick (idle unless overridden). */
class Harness {
  readonly sim: GameSim;
  readonly events: SimEvent[] = [];
  private readonly seq = new Map<number, number>();
  private readonly idle = new Map<number, Partial<PlayerInput>>();

  constructor(cfg: Partial<MatchConfig> = {}) {
    this.sim = new GameSim({ ...BASE, ...cfg });
  }
  get world(): World { return this.sim.world; }
  add(name: string, team?: number): number {
    const id = this.sim.addPlayer({ name, isBot: false, team });
    expect(id).toBeGreaterThan(0);
    return id;
  }
  p(id: number): PlayerState { return this.sim.players.get(id)!; }
  /** Teleport a player onto the ground (test setup). */
  place(id: number, x: number, z: number, yaw = 0): void {
    const p = this.p(id);
    p.mode = 'ground';
    p.pos.x = x; p.pos.z = z; p.pos.y = this.world.groundAt(x, z);
    p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
    p.onGround = true; p.airTime = 0; p.fallSpeed = 0; p.parachuteOpen = false; p.stance = 'stand';
    p.yaw = yaw;
    this.idle.set(id, { ...(this.idle.get(id) ?? {}), yaw, pitch: 0 });
  }
  setIdle(id: number, o: Partial<PlayerInput>): void {
    this.idle.set(id, { ...(this.idle.get(id) ?? {}), ...o });
  }
  input(id: number, o: Partial<PlayerInput> = {}): void {
    const p = this.p(id);
    const s = (this.seq.get(id) ?? 0) + 1;
    this.seq.set(id, s);
    this.sim.queueInput(id, {
      seq: s, mx: 0, mz: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0, stance: 0, slot: p.activeSlot,
      rt: this.sim.time * 1000, ...o,
    });
  }
  /** Step n ticks; `each` may return per-player input overrides for that tick. */
  step(n = 1, each?: (i: number) => Record<number, Partial<PlayerInput>> | void): void {
    for (let i = 0; i < n; i++) {
      const ov = (each && each(i)) || {};
      for (const [id, idle] of this.idle) this.input(id, { ...idle, ...(ov[id] ?? {}) });
      this.sim.step();
      for (const e of this.sim.drainEvents()) this.events.push(e);
      this.sim.drainLootDelta();
    }
  }
  stepUntil(pred: () => boolean, maxTicks: number, each?: (i: number) => Record<number, Partial<PlayerInput>> | void): number {
    for (let i = 0; i < maxTicks; i++) {
      if (pred()) return i;
      this.step(1, each ? () => each(i) : undefined);
    }
    return pred() ? maxTicks : -1;
  }
  /** Pull events emitted outside step() (direct damage calls, start()). */
  collect(): void {
    for (const e of this.sim.drainEvents()) this.events.push(e);
  }
  of<T extends GameEvent['type']>(type: T): Ev<T>[] {
    this.collect();
    return this.events.filter((e) => e.ev.type === type).map((e) => e.ev as Ev<T>);
  }
  simEvents(type: GameEvent['type']): SimEvent[] {
    this.collect();
    return this.events.filter((e) => e.ev.type === type);
  }
  clearEvents(): void {
    this.sim.drainEvents();
    this.events.length = 0;
  }
  /** Give a weapon in `slot` and draw it. */
  arm(id: number, weapon: WeaponId, slot: 0 | 1 | 2 = 0, reserve = 120): void {
    const p = this.p(id);
    const w = WEAPONS[weapon];
    p.weapons[slot] = { id: weapon, mag: w.magSize };
    p.ammo[w.ammo] = reserve;
    this.setIdle(id, { slot });
    // Stale queued inputs may delay the switch by a few ticks.
    this.stepUntil(() => p.activeSlot === slot && p.drawTimer === 0, Math.ceil(w.drawTime / TICK_DT) + 12);
    expect(p.activeSlot).toBe(slot);
    expect(p.drawTimer).toBe(0);
  }
  aimAt(id: number, target: Vec3): { yaw: number; pitch: number } {
    const e = this.sim.eyePos(id);
    const dx = target.x - e.x, dy = target.y - e.y, dz = target.z - e.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
  }
  /** Centre of the torso capsule of a player's (rewound) hitboxes. */
  torso(id: number, time = this.sim.time): Vec3 {
    const hb = this.sim.rewindHitboxes(id, time);
    const t = hb.find((h) => h.part === 'body' && (h.a.x !== h.b.x || h.a.y !== h.b.y || h.a.z !== h.b.z))!;
    expect(t).toBeTruthy();
    return { x: (t.a.x + t.b.x) / 2, y: (t.a.y + t.b.y) / 2, z: (t.a.z + t.b.z) / 2 };
  }
}

/** Everyone out of the plane and onto the ground so the sim is in the 'playing' phase. */
function startOnGround(h: Harness, spots: Record<number, [number, number, number?]>): void {
  h.sim.start();
  for (const [id, [x, z, yaw]] of Object.entries(spots)) h.place(Number(id), x, z, yaw ?? 0);
  h.step(2);
  expect(h.sim.phase).toBe('playing');
}

function areaClear(w: World, x0: number, z0: number, x1: number, z1: number): boolean {
  const b: WorldBox[] = [], t: TreeDef[] = [], r: RockDef[] = [];
  w.queryBoxes(x0, z0, x1, z1, b);
  w.queryTrees(x0, z0, x1, z1, t);
  w.queryRocks(x0, z0, x1, z1, r);
  return b.length === 0 && t.length === 0 && r.length === 0;
}

/** Flat dry open rectangle [x-w0, x+w1] x [z-len, z+3] with no colliders. */
function findOpen(w: World, len: number, w0: number, w1: number): { x: number; z: number } {
  const lim = w.half - len - Math.max(w0, w1) - 10;
  for (let z = -lim; z <= lim; z += 6) {
    for (let x = -lim; x <= lim; x += 6) {
      const h0 = w.heightAt(x, z);
      if (h0 < w.waterLevel + 2) continue;
      let ok = true;
      for (let dz = 0; dz <= len && ok; dz += 2) {
        for (let dx = -w0; dx <= w1 && ok; dx += 4) {
          const h = w.heightAt(x + dx, z - dz);
          if (Math.abs(h - h0) > 1.2 || h < w.waterLevel + 1.5) ok = false;
        }
      }
      if (ok && areaClear(w, x - w0, z - len - 3, x + w1, z + 3)) return { x, z };
    }
  }
  throw new Error('no open area found');
}

describe('GameSim combat', () => {
  it('AR at 20 m deals the expected damage with a hit event; a vest reduces it', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Shooter');
    const b = h.add('Target');
    const o = findOpen(h.world, 26, 4, 4);
    // Target faces away from the shooter (arms on the far side).
    startOnGround(h, { [a]: [o.x, o.z, Math.PI], [b]: [o.x, o.z - 20, 0] });
    h.arm(a, 'ar');
    const aim = h.aimAt(a, h.torso(b));
    h.setIdle(a, { ...aim, buttons: BTN.ADS });
    h.step(10);
    expect(h.p(a).ads).toBe(1);
    h.clearEvents();
    h.step(1, () => ({ [a]: { buttons: BTN.ADS | BTN.FIRE } }));
    const shots = h.of('shot');
    expect(shots.length).toBe(1);
    const hits = h.of('hit');
    expect(hits.length).toBe(1);
    const hit = hits[0];
    expect(hit.attacker).toBe(a);
    expect(hit.victim).toBe(b);
    expect(hit.part).toBe('body');
    expect(hit.distance).toBeGreaterThan(19);
    expect(hit.distance).toBeLessThan(21);
    const expected = computeDamage('ar', 'body', 20, NO_ARMOR).health;
    expect(hit.damage).toBeCloseTo(expected, 0);
    expect(h.p(b).health).toBeCloseTo(100 - expected, 3);
    expect(hit.result).toBe('damage');
    expect(hit.armor).toBe(false);
    // Hit events are private to attacker and victim.
    expect(h.simEvents('hit')[0].to).toEqual([a, b]);
    expect(h.p(a).stats.shotsHit).toBe(1);
    expect(h.p(a).stats.damage).toBeCloseTo(expected, 3);

    // Vest level 2 absorbs part of the next body shot.
    const pb = h.p(b);
    pb.armor.vest = 2;
    pb.armor.vestHp = GEAR.vest2.durability;
    const before = pb.health;
    h.step(30); // trigger released, recoil recovered
    h.clearEvents();
    h.step(1, () => ({ [a]: { buttons: BTN.ADS | BTN.FIRE } }));
    const hit2 = h.of('hit')[0];
    expect(hit2).toBeTruthy();
    expect(hit2.armor).toBe(true);
    const reduced = expected * (1 - GEAR.vest2.reduction);
    expect(before - pb.health).toBeCloseTo(reduced, 3);
    expect(pb.armor.vestHp).toBeCloseTo(GEAR.vest2.durability - expected, 3);
  });

  it('lag compensation hits where the client saw the target and clamps the rewind', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Shooter');
    const b = h.add('Runner');
    const o = findOpen(h.world, 26, 4, 40);
    startOnGround(h, { [a]: [o.x, o.z, Math.PI], [b]: [o.x, o.z - 20, 0] });
    h.arm(a, 'ar');
    h.setIdle(a, { buttons: BTN.ADS });
    // Target strafes right (+X) at walking speed.
    h.setIdle(b, { mx: 1 });
    h.step(30);
    expect(Math.hypot(h.p(b).vel.x, h.p(b).vel.z)).toBeGreaterThan(4);

    /** Wait for the cooldown, then one shot aimed at the torso `back` s ago with rt = now - rtBack. */
    const shotAt = (back: number, rtBack: number) => {
      h.step(15);
      const now = h.sim.time;
      const aim = h.aimAt(a, h.torso(b, now - back));
      h.clearEvents();
      h.step(1, () => ({ [a]: { ...aim, buttons: BTN.ADS | BTN.FIRE, rt: (now - rtBack) * 1000 } }));
      expect(h.of('shot').length).toBe(1);
      return h.of('hit').filter((e) => e.victim === b).length;
    };
    // Aim at the position 200 ms ago with rt 200 ms ago -> hit.
    expect(shotAt(0.2, 0.2)).toBe(1);
    // Same aim but claiming to see the present (no rewind) -> miss (target moved ~1 m).
    expect(shotAt(0.2, 0)).toBe(0);
    expect(shotAt(0.2, 0.2)).toBe(1);
    // rt older than MAX_REWIND_MS is clamped: aiming at the 500 ms old position misses ...
    expect(shotAt(0.5, 0.5)).toBe(0);
    // ... while the clamped (250 ms) position is hit.
    expect(shotAt(MAX_REWIND_MS / 1000, 0.5)).toBe(1);
    expect(h.sim.rewindHitboxes(b, h.sim.time - HITBOX_HISTORY_MS / 1000 + 0.05).length).toBeGreaterThan(0);
  });

  it('sniper bullets have travel time (~0.4 s at 300 m) and drop', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Sniper');
    const b = h.add('Target');
    const w = h.world;
    // Find a 300 m clear line between two flat dry spots.
    let spot: { x: number; z: number } | null = null;
    for (let z = -100; z <= 420 && !spot; z += 10) {
      for (let x = -400; x <= 400 && !spot; x += 10) {
        const ha = w.heightAt(x, z), hb = w.heightAt(x, z - 300);
        if (ha < 2 || hb < 2 || Math.abs(ha - hb) > 15) continue;
        if (!areaClear(w, x - 3, z - 3, x + 3, z + 3) || !areaClear(w, x - 3, z - 303, x + 3, z - 297)) continue;
        let ok = true;
        for (const dy of [0, 0.7, 1.4]) {
          if (!lineOfSight(w, { x, y: ha + 1.62 + dy, z }, { x, y: hb + 1.2 + dy, z: z - 300 })) ok = false;
        }
        if (ok) spot = { x, z };
      }
    }
    expect(spot).not.toBeNull();
    startOnGround(h, { [a]: [spot!.x, spot!.z, Math.PI], [b]: [spot!.x, spot!.z - 300, 0] });
    h.arm(a, 'sniper');
    const sn = WEAPONS.sniper;
    const torso = h.torso(b);
    const aim = h.aimAt(a, torso);
    const eye = h.sim.eyePos(a);
    const dist = Math.hypot(torso.x - eye.x, torso.z - eye.z);
    // Hold over by the bullet drop below the (100 m zeroed) sight line.
    const hold = Math.atan2(sightDrop(sn, dist), dist);
    const pitch = aim.pitch + hold;
    h.setIdle(a, { yaw: aim.yaw, pitch, buttons: BTN.ADS });
    h.step(15);
    h.clearEvents();
    h.step(1, () => ({ [a]: { buttons: BTN.ADS | BTN.FIRE } }));
    const shot = h.of('shot')[0];
    expect(shot).toBeTruthy();
    expect(shot.projectiles?.length).toBe(1);
    expect(h.of('hit').length).toBe(0);
    const pid = shot.projectiles![0];
    const t0 = h.sim.time - TICK_DT; // shot happened at the start of that tick
    // Sample the flight: the bullet falls below the aim line by the sight drop.
    const dir = { x: -Math.sin(aim.yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(aim.yaw) * Math.cos(pitch) };
    let maxDropErr = 0;
    let sampled = 0;
    const hitTick = h.stepUntil(() => h.of('hit').length > 0, 60, () => {
      const pr = h.sim.projectiles.get(pid);
      if (pr) {
        const d = Math.hypot(pr.pos.x - eye.x, pr.pos.z - eye.z);
        const lineY = eye.y + (dir.y / Math.hypot(dir.x, dir.z)) * d;
        const drop = lineY - pr.pos.y;
        if (d > 150) {
          maxDropErr = Math.max(maxDropErr, Math.abs(drop - sightDrop(sn, d)));
          sampled++;
        }
      }
      return {};
    });
    expect(hitTick).toBeGreaterThan(0);
    const hit = h.of('hit')[0];
    expect(hit.victim).toBe(b);
    const flight = h.sim.time - t0;
    const expectedTof = simulateTrajectory(sn, dist).time;
    expect(expectedTof).toBeGreaterThan(0.35);
    expect(Math.abs(flight - expectedTof)).toBeLessThan(0.07);
    expect(sampled).toBeGreaterThan(2);
    expect(sightDrop(sn, 300)).toBeGreaterThan(0.3);
    expect(maxDropErr).toBeLessThan(0.15);
    expect(h.sim.projectiles.has(pid)).toBe(false);
  });

  it('fire rate never exceeds the weapon rpm, whatever the input does', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Spammer');
    const o = findOpen(h.world, 6, 4, 4);
    startOnGround(h, { [a]: [o.x, o.z, 0] });
    h.arm(a, 'ar');
    const p = h.p(a);
    h.setIdle(a, { pitch: 0.6 });
    const start = p.stats.shotsFired;
    // Full auto for 2 s, plus extra inputs queued every tick.
    h.step(60, () => {
      for (let k = 0; k < 5; k++) h.input(a, { pitch: 0.6, buttons: BTN.FIRE });
      return { [a]: { pitch: 0.6, buttons: BTN.FIRE } };
    });
    const ar = p.stats.shotsFired - start;
    const maxAr = Math.floor(2 / fireInterval(WEAPONS.ar)) + 1;
    expect(ar).toBeLessThanOrEqual(maxAr);
    expect(ar).toBeGreaterThanOrEqual(maxAr - 3);

    // Semi-auto pistol with the trigger toggled every tick.
    h.arm(a, 'pistol', 2);
    const s2 = p.stats.shotsFired;
    h.step(90, (i) => ({ [a]: { pitch: 0.6, buttons: i % 2 === 0 ? BTN.FIRE : 0 } }));
    const pistol = p.stats.shotsFired - s2;
    expect(pistol).toBeLessThanOrEqual(Math.floor(3 / fireInterval(WEAPONS.pistol)) + 1);
    expect(pistol).toBeGreaterThan(10);
    // Holding the trigger of a semi weapon fires once.
    h.step(10);
    p.weapons[2]!.mag = 15;
    p.reloadTimer = 0;
    p.reloadTotal = 0;
    const s3 = p.stats.shotsFired;
    h.step(30, () => ({ [a]: { pitch: 0.6, buttons: BTN.FIRE } }));
    expect(p.stats.shotsFired - s3).toBe(1);
  });

  it('recoil accumulates server side regardless of the client aim', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Sprayer');
    const o = findOpen(h.world, 6, 4, 4);
    startOnGround(h, { [a]: [o.x, o.z, 0] });
    h.arm(a, 'ar');
    h.setIdle(a, { pitch: 0.4, buttons: BTN.ADS });
    h.step(10);
    h.clearEvents();
    // The client never moves its aim (pitch stays 0.4) while spraying.
    h.step(36, () => ({ [a]: { pitch: 0.4, buttons: BTN.ADS | BTN.FIRE } }));
    const shots = h.of('shot').filter((s) => s.shooter === a);
    expect(shots.length).toBeGreaterThan(10);
    const pitchOf = (s: Ev<'shot'>) => {
      const e = s.ends[0];
      return Math.atan2(e.y - s.origin.y, Math.hypot(e.x - s.origin.x, e.z - s.origin.z));
    };
    expect(pitchOf(shots[shots.length - 1]) - pitchOf(shots[0])).toBeGreaterThan(0.02);
    const p = h.p(a);
    expect(p.recoilPitch).toBeGreaterThan(0.02);
    expect(p.pitch).toBeCloseTo(0.4, 6);
    expect(p.sprayCount).toBe(shots.length);
    // Released: recoil recovers and the spray resets.
    h.step(60, () => ({ [a]: { pitch: 0.4 } }));
    expect(Math.abs(p.recoilPitch)).toBeLessThan(1e-3);
    expect(p.sprayCount).toBe(0);
  });

  it('frag grenades bounce, explode after the fuse and hurt players in line of sight', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Thrower');
    const b = h.add('Victim');
    const o = findOpen(h.world, 26, 4, 4);
    startOnGround(h, { [a]: [o.x, o.z, 0], [b]: [o.x, o.z - 9, 0] });
    h.p(a).items.frag = 2;
    h.clearEvents();
    h.step(1, () => ({ [a]: { pitch: 0.1, actions: [{ a: 'throw' }] } }));
    const th = h.of('throw')[0];
    expect(th).toBeTruthy();
    expect(h.p(a).items.frag).toBe(1);
    expect(h.sim.projectiles.get(th.projectile)?.kind).toBe('frag');
    const ticks = h.stepUntil(() => h.of('explosion').length > 0, 200);
    expect(ticks * TICK_DT).toBeGreaterThan(THROWABLES.frag.fuse - 0.2);
    expect(h.sim.projectiles.has(th.projectile)).toBe(false);
    const ex = h.of('explosion')[0];
    const pb = h.p(b);
    const d = Math.hypot(ex.pos.x - pb.pos.x, ex.pos.z - pb.pos.z);
    if (d < THROWABLES.frag.radius - 1) expect(pb.health).toBeLessThan(100);
  });
});

describe('downed, revive, bleed out, elimination', () => {
  function squads(n = 3) {
    const h = new Harness({ maxPlayers: n * 2, teamSize: 2 });
    const ids: number[][] = [];
    for (let t = 0; t < n; t++) ids.push([h.add(`T${t}a`, t), h.add(`T${t}b`, t)]);
    const o = findOpen(h.world, 26, 4, 30);
    const spots: Record<number, [number, number, number?]> = {};
    ids.forEach((team, t) => team.forEach((id, k) => { spots[id] = [o.x + t * 8 + k * 1.2, o.z - 5]; }));
    startOnGround(h, spots);
    return { h, ids };
  }
  const hurt = (h: Harness, victim: number, attacker: number | null, amount: number) => {
    const info = damageInfo(attacker !== null ? h.p(attacker) : null, 'ar', 'body');
    info.pos = h.p(victim).pos;
    info.from = attacker !== null ? h.p(attacker).pos : null;
    info.emitHit = attacker !== null;
    return damagePlayer(h.sim, h.p(victim), amount, info);
  };

  it('knock -> teammate revive (hold interact, stand still)', () => {
    const { h, ids } = squads(2);
    const [a0, a1] = ids[0];
    const [b0] = ids[1];
    expect(hurt(h, a0, b0, 150)).toBe('knock');
    const pa = h.p(a0);
    expect(pa.life).toBe('downed');
    expect(pa.downedHp).toBe(DOWNED_HEALTH);
    expect(pa.knockCount).toBe(1);
    expect(h.of('knock')[0]).toMatchObject({ attacker: b0, victim: a0 });
    expect(h.p(b0).stats.knocks).toBe(1);
    // Downed players cannot shoot.
    pa.weapons[0] = { id: 'ar', mag: 30 };
    const fired = pa.stats.shotsFired;
    h.place(a1, pa.pos.x + 1, pa.pos.z);
    h.step(1, () => ({ [a1]: { actions: [{ a: 'revive', id: a0 }], buttons: BTN.INTERACT }, [a0]: { slot: 0, buttons: BTN.FIRE } }));
    expect(h.p(a1).revive?.target).toBe(a0);
    expect(pa.revivedBy).toBe(a1);
    const hp0 = pa.downedHp;
    h.step(30, () => ({ [a1]: { buttons: BTN.INTERACT }, [a0]: { slot: 0, buttons: BTN.FIRE } }));
    // Bleeding is paused while being revived.
    expect(pa.downedHp).toBe(hp0);
    const n = Math.ceil(REVIVE_TIME / TICK_DT) - 28;
    h.step(n, () => ({ [a1]: { buttons: BTN.INTERACT }, [a0]: { slot: 0, buttons: BTN.FIRE } }));
    expect(pa.stats.shotsFired).toBe(fired);
    expect(h.of('revived')[0]).toMatchObject({ reviver: a1, target: a0 });
    expect(pa.life).toBe('alive');
    expect(pa.health).toBe(10);
    expect(h.p(a1).stats.revives).toBe(1);
  });

  it('a revive is interrupted by moving and the second knock bleeds faster', () => {
    const { h, ids } = squads(2);
    const [a0, a1] = ids[0];
    const [b0] = ids[1];
    hurt(h, a0, b0, 150);
    h.p(a0).life = 'alive';
    h.p(a0).health = 100;
    expect(hurt(h, a0, b0, 150)).toBe('knock');
    expect(h.p(a0).knockCount).toBe(2);
    h.place(a1, h.p(a0).pos.x + 1, h.p(a0).pos.z);
    h.step(1, () => ({ [a1]: { actions: [{ a: 'revive', id: a0 }], buttons: BTN.INTERACT } }));
    h.step(20, () => ({ [a1]: { buttons: BTN.INTERACT } }));
    expect(h.p(a1).revive).not.toBeNull();
    h.step(1, () => ({ [a1]: { buttons: BTN.INTERACT, mz: 1 } }));
    expect(h.p(a1).revive).toBeNull();
    expect(h.p(a0).revivedBy).toBeNull();
    const before = h.p(a0).downedHp;
    h.step(30);
    expect(before - h.p(a0).downedHp).toBeCloseTo(DOWNED_BLEED_PER_SEC * 1.5 * 30 * TICK_DT, 3);
  });

  it('bleeding out kills and credits the knocker', () => {
    const { h, ids } = squads(2);
    const [a0] = ids[0];
    const [b0] = ids[1];
    hurt(h, a0, b0, 100);
    expect(h.p(a0).life).toBe('downed');
    h.step(Math.floor((DOWNED_HEALTH / DOWNED_BLEED_PER_SEC - 1) / TICK_DT));
    expect(h.p(a0).life).toBe('downed');
    h.step(Math.ceil(1.5 / TICK_DT));
    expect(h.p(a0).life).toBe('dead');
    const kill = h.of('kill').find((k) => k.victim === a0)!;
    expect(kill).toMatchObject({ attacker: b0, source: 'bleed', finished: false });
    expect(h.p(b0).stats.kills).toBe(1);
    expect(h.p(a0).killerId).toBe(b0);
    // Dead players spectate a living teammate.
    expect(h.p(a0).spectating).toBe(ids[0][1]);
  });

  it('team elimination, placement, loot spill and the winner', () => {
    const { h, ids } = squads(3);
    const [a0, a1] = ids[0];
    const [b0, b1] = ids[1];
    const [c0, c1] = ids[2];
    h.p(a1).weapons[0] = { id: 'smg', mag: 12 };
    h.p(a1).ammo.ammo_9mm = 40;
    h.p(a1).armor.vest = 1;
    h.p(a1).armor.vestHp = 50;
    const lootBefore = h.sim.loot.size;
    expect(hurt(h, a0, c0, 120)).toBe('knock');
    // Last standing member of team 0 dies outright; the downed teammate dies with the team.
    expect(hurt(h, a1, c0, 120)).toBe('kill');
    expect(h.p(a0).life).toBe('dead');
    expect(h.p(a1).life).toBe('dead');
    const elim = h.of('teamEliminated');
    expect(elim).toEqual([{ type: 'teamEliminated', team: 0, placement: 3 }]);
    expect(h.p(a0).placement).toBe(3);
    expect(h.p(a1).placement).toBe(3);
    expect(h.p(c0).stats.kills).toBe(2);
    // The dead player's inventory is on the ground.
    expect(h.sim.loot.size).toBe(lootBefore + 3);
    expect([...h.sim.loot.values()].some((l) => l.item === 'smg' && l.mag === 12)).toBe(true);
    expect(h.p(a1).weapons[0]).toBeNull();
    // Dead -> spectate the killer when the team is gone.
    expect(h.p(a1).spectating).toBe(c0);
    hurt(h, b0, c1, 500);
    expect(h.sim.phase).toBe('playing');
    hurt(h, b1, c1, 500);
    hurt(h, b0, c1, 500);
    expect(h.p(b0).life).toBe('dead');
    expect(h.sim.isOver()).toBe(true);
    expect(h.sim.phase).toBe('ended');
    const end = h.of('matchEnd')[0];
    expect(end).toBeTruthy();
    const res = h.sim.results();
    expect(res.winnerTeam).toBe(2);
    expect(res.players.filter((p) => p.placement === 1).map((p) => p.id).sort()).toEqual([c0, c1].sort());
    expect(res.players.find((p) => p.id === b0)!.placement).toBe(2);
    expect(res.players[0].placement).toBe(1);
    // No more damage after the end.
    expect(hurt(h, c0, null, 50)).toBe('none');
  });

  it('landing hard causes fall damage', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Faller');
    const o = findOpen(h.world, 6, 4, 4);
    startOnGround(h, { [a]: [o.x, o.z, 0] });
    const p = h.p(a);
    p.pos.y += 9;
    p.onGround = false;
    h.clearEvents();
    h.stepUntil(() => h.of('land').length > 0, 120);
    const land = h.of('land')[0];
    expect(land.speed).toBeGreaterThan(FALL_DAMAGE_SPEED);
    expect(100 - p.health).toBeCloseTo((land.speed - FALL_DAMAGE_SPEED) * FALL_DAMAGE_PER_MS, 0);
  });
});

describe('zone', () => {
  it('runs the phase timeline, keeps circles nested on land and damages outside', () => {
    const speed = 0.25;
    const h = new Harness({ maxPlayers: 2, zoneSpeed: speed });
    const a = h.add('Inside');
    const b = h.add('Outside');
    h.sim.start();
    expect(h.of('zonePhase')[0]).toMatchObject({ phase: 0, stage: 'pre' });
    const o = findOpen(h.world, 4, 4, 4);
    h.place(a, o.x, o.z);
    h.place(b, o.x + 2, o.z);
    const z = h.sim.zone;
    const pre = h.stepUntil(() => z.stage === 'waiting', 2000);
    expect(pre * TICK_DT).toBeCloseTo(ZONE_PRE_TIME * speed, 0);
    expect(z.phase).toBe(1);
    expect(z.nr).toBe(ZONE_PHASES[0].radius);
    expect(Math.hypot(z.nx - z.cx, z.nz - z.cz) + z.nr).toBeLessThanOrEqual(z.r + 1e-6);
    expect(h.world.heightAt(z.nx, z.nz)).toBeGreaterThan(h.world.waterLevel);
    const wait = h.stepUntil(() => z.stage === 'shrinking', 5000);
    expect(wait * TICK_DT).toBeCloseTo(ZONE_PHASES[0].wait * speed, 0);
    const r0 = z.r;
    h.step(Math.round((ZONE_PHASES[0].shrink * speed) / 2 / TICK_DT));
    expect(z.r).toBeLessThan(r0);
    expect(z.r).toBeGreaterThan(ZONE_PHASES[0].radius);
    h.stepUntil(() => z.phase === 2, 5000);
    expect(z.stage).toBe('waiting');
    expect(z.r).toBeCloseTo(ZONE_PHASES[0].radius, 6);
    expect(Math.hypot(z.nx - z.cx, z.nz - z.cz) + z.nr).toBeLessThanOrEqual(z.r + 1e-6);
    const stages = h.of('zonePhase').map((e) => `${e.phase}:${e.stage}`);
    expect(stages).toEqual(['0:pre', '1:waiting', '1:shrinking', '2:waiting']);
    // Inside player is safe, the outside one takes armor-ignoring damage.
    let ia = { x: z.cx, z: z.cz };
    if (h.world.heightAt(ia.x, ia.z) < 1) ia = { x: z.nx, z: z.nz };
    h.place(a, ia.x, ia.z);
    const ang = Math.atan2(z.cz, z.cx) + Math.PI;
    const far = Math.min(h.world.half - 5, z.r + 60);
    h.place(b, Math.max(-h.world.half + 5, Math.min(h.world.half - 5, z.cx + Math.cos(ang) * far)),
      Math.max(-h.world.half + 5, Math.min(h.world.half - 5, z.cz + Math.sin(ang) * far)));
    const pb = h.p(b);
    expect(Math.hypot(pb.pos.x - z.cx, pb.pos.z - z.cz)).toBeGreaterThan(z.r);
    pb.armor.vest = 3;
    pb.armor.vestHp = 250;
    const hpA = h.p(a).health, hpB = pb.health;
    h.step(60);
    expect(h.p(a).health).toBe(hpA);
    expect(hpB - pb.health).toBeCloseTo(ZONE_PHASES[1].damage * 60 * TICK_DT, 2);
    expect(pb.armor.vestHp).toBe(250);
  });

  it('training has no zone damage', () => {
    const sim = new GameSim({ ...BASE, mode: 'training', maxPlayers: 4 });
    expect(sim.zone.stage).toBe('final');
    expect(sim.zone.damagePerSec).toBe(0);
    expect(sim.zone.r).toBeGreaterThan(sim.world.half * 4);
  });
});

describe('plane and drop', () => {
  it('plane -> jump -> freefall -> auto chute -> landing', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Jumper');
    h.sim.start();
    const plane = h.sim.plane!;
    expect(h.sim.phase).toBe('plane');
    expect(plane.altitude).toBe(320);
    // Path passes within 200 m of the centre and starts beyond the map edge.
    const t = Math.max(0, Math.min(1, -((plane.start.x * (plane.end.x - plane.start.x)) + plane.start.z * (plane.end.z - plane.start.z)) / plane.length ** 2));
    const cx = plane.start.x + (plane.end.x - plane.start.x) * t, cz = plane.start.z + (plane.end.z - plane.start.z) * t;
    expect(Math.hypot(cx, cz)).toBeLessThanOrEqual(200 + 1e-6);
    expect(h.world.inBounds(plane.start.x, plane.start.z)).toBe(false);
    const p = h.p(a);
    expect(p.mode).toBe('plane');
    // Jumping outside the map is refused.
    h.input(a, { actions: [{ a: 'jump' }] });
    h.sim.step();
    expect(p.mode).toBe('plane');
    // Ride to the closest point to the centre and jump.
    const ticks = Math.floor((t * plane.length) / plane.speed / TICK_DT);
    h.setIdle(a, { yaw: p.yaw });
    h.step(Math.max(0, ticks - h.sim.tick));
    expect(p.mode).toBe('plane');
    expect(p.pos.y).toBe(plane.altitude);
    h.step(1, () => ({ [a]: { actions: [{ a: 'jump' }] } }));
    expect(p.mode).toBe('freefall');
    expect(h.of('jumpPlane').length).toBe(1);
    expect(p.jumpY).toBeGreaterThan(300);
    // Chute cannot open right away.
    h.step(1, () => ({ [a]: { actions: [{ a: 'chute' }] } }));
    expect(p.jumpY - p.pos.y).toBeLessThan(MIN_CHUTE_DROP);
    expect(p.parachuteOpen).toBe(false);
    h.step(1);
    expect(h.sim.phase).toBe('playing');
    // Auto chute at AUTO_CHUTE_HEIGHT.
    h.stepUntil(() => p.parachuteOpen, 900);
    expect(p.mode).toBe('parachute');
    expect(h.of('chuteOpen').length).toBe(1);
    const ground = Math.max(h.world.groundAt(p.pos.x, p.pos.z, p.pos.y), h.world.waterLevel);
    expect(p.pos.y - ground).toBeLessThanOrEqual(121);
    expect(p.pos.y - ground).toBeGreaterThan(90);
    h.stepUntil(() => h.of('land').length > 0, 2400);
    expect(['ground', 'swim']).toContain(p.mode);
    expect(p.parachuteOpen).toBe(false);
    expect(p.health).toBe(100);
  });

  it('players still aboard are ejected at 90% of the flight', () => {
    const h = new Harness({ maxPlayers: 3 });
    h.add('A');
    h.add('B');
    h.sim.start();
    const plane = h.sim.plane!;
    h.step(Math.ceil((plane.length * 0.9) / plane.speed / TICK_DT) + 2);
    for (const p of h.sim.players.values()) expect(p.mode === 'freefall' || p.mode === 'parachute').toBe(true);
    expect(h.of('jumpPlane').length).toBe(2);
  });
});

describe('loot', () => {
  it('initial loot spawns from world loot spawns and pickups are validated', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Looter');
    expect(h.sim.loot.size).toBeGreaterThan(h.world.lootSpawns.length * 0.5);
    const o = findOpen(h.world, 14, 4, 4);
    startOnGround(h, { [a]: [o.x, o.z, 0] });
    const p = h.p(a);
    const y = h.world.groundAt(o.x, o.z - 1.5) + 0.05;
    const near = h.sim.placeLootAt('bandage', 3, { x: o.x, y, z: o.z - 1.5 })!;
    const far = h.sim.placeLootAt('medkit', 1, { x: o.x, y: h.world.groundAt(o.x, o.z - 10) + 0.05, z: o.z - 10 })!;
    expect(h.sim.lootNear(o.x, o.z, 2, []).map((l) => l.id)).toContain(near.id);
    h.step(1, () => ({ [a]: { actions: [{ a: 'pickup', id: far.id }] } }));
    expect(p.items.medkit).toBe(0);
    expect(h.sim.loot.has(far.id)).toBe(true);
    h.step(1, () => ({ [a]: { actions: [{ a: 'pickup', id: near.id }] } }));
    expect(p.items.bandage).toBe(3);
    expect(h.sim.loot.has(near.id)).toBe(false);
    const pick = h.simEvents('pickup')[0];
    expect(pick.to).toEqual([a]);
    // Weapon pickup with its magazine; replaced weapons are dropped at the player.
    p.weapons[0] = { id: 'smg', mag: 5 };
    p.weapons[1] = { id: 'shotgun', mag: 2 };
    p.activeSlot = 0;
    const gun = h.sim.placeLootAt('ar', 1, { x: o.x + 1, y, z: o.z - 1 }, 17)!;
    h.step(1, () => ({ [a]: { slot: 0, actions: [{ a: 'pickup', id: gun.id }] } }));
    expect(p.weapons[0]).toEqual({ id: 'ar', mag: 17 });
    expect([...h.sim.loot.values()].some((l) => l.item === 'smg' && l.mag === 5)).toBe(true);
  });

  it('pickup through a wall is rejected', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Looter');
    const w = h.world;
    // A thin bullet-blocking wall with floor on both sides at its base.
    let found: { px: number; pz: number; lx: number; lz: number; y: number } | null = null;
    for (const b of w.boxes) {
      if (found) break;
      if (b.kind !== 'wall' || !b.blocksBullets || b.max.y - b.min.y < 2.4) continue;
      const tx = b.max.x - b.min.x, tz = b.max.z - b.min.z;
      if (Math.min(tx, tz) > 0.4 || Math.max(tx, tz) < 2.5) continue;
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      const alongX = tx < tz; // wall thin in x: sides are -x / +x
      const s1 = alongX ? { x: b.min.x - 0.9, z: cz } : { x: cx, z: b.min.z - 0.9 };
      const s2 = alongX ? { x: b.max.x + 0.9, z: cz } : { x: cx, z: b.max.z + 0.9 };
      const g1 = w.groundAt(s1.x, s1.z, b.min.y + 0.5), g2 = w.groundAt(s2.x, s2.z, b.min.y + 0.5);
      if (Math.abs(g1 - b.min.y) > 0.3 || Math.abs(g2 - b.min.y) > 0.3) continue;
      if (!areaClear(w, s1.x - 0.4, s1.z - 0.4, s1.x + 0.4, s1.z + 0.4)) continue;
      found = { px: s1.x, pz: s1.z, lx: s2.x, lz: s2.z, y: g2 };
    }
    expect(found).not.toBeNull();
    h.sim.start();
    h.place(a, found!.px, found!.pz);
    h.step(2);
    const it = h.sim.placeLootAt('ammo_556', 30, { x: found!.lx, y: found!.y + 0.05, z: found!.lz })!;
    h.step(1, () => ({ [a]: { actions: [{ a: 'pickup', id: it.id }] } }));
    expect(h.p(a).ammo.ammo_556).toBe(0);
    expect(h.sim.loot.has(it.id)).toBe(true);
  });

  it('drop and use: healing items heal on completion, capped', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Medic');
    const o = findOpen(h.world, 6, 4, 4);
    startOnGround(h, { [a]: [o.x, o.z, 0] });
    const p = h.p(a);
    p.items.bandage = 2;
    p.health = 90;
    h.step(1, () => ({ [a]: { actions: [{ a: 'use', item: 'bandage' }] } }));
    expect(p.use).toBeNull(); // above the 75 cap: refused
    p.health = 50;
    h.step(1, () => ({ [a]: { actions: [{ a: 'use', item: 'bandage' }] } }));
    expect(p.use?.item).toBe('bandage');
    h.stepUntil(() => p.use === null, 200);
    expect(p.health).toBeCloseTo(60, 0);
    expect(p.items.bandage).toBe(1);
    expect(h.simEvents('useDone')[0].to).toEqual([a]);
    // Cancelled by jumping.
    h.step(1, () => ({ [a]: { actions: [{ a: 'use', item: 'bandage' }] } }));
    expect(p.use).not.toBeNull();
    h.step(1, () => ({ [a]: { buttons: BTN.JUMP } }));
    expect(p.use).toBeNull();
    expect(p.items.bandage).toBe(1);
    // Drop leaves it on the ground.
    const before = h.sim.loot.size;
    h.step(20);
    h.step(1, () => ({ [a]: { actions: [{ a: 'drop', item: 'bandage' }] } }));
    expect(p.items.bandage).toBe(0);
    expect(h.sim.loot.size).toBe(before + 1);
  });
});

describe('vehicles', () => {
  it('enter, drive (fuel), crash damage, refuel, bail out', () => {
    const h = new Harness({ maxPlayers: 2 });
    const a = h.add('Driver');
    h.sim.start();
    expect(h.sim.vehicles.size).toBeGreaterThan(0);
    expect(h.sim.vehicles.size).toBeLessThanOrEqual(24);
    // Pick a vehicle with clear space ahead.
    const v = [...h.sim.vehicles.values()].find((veh) => {
      const fx = -Math.sin(veh.yaw), fz = -Math.cos(veh.yaw);
      for (let d = 4; d <= 30; d += 2) {
        const x = veh.pos.x + fx * d, z = veh.pos.z + fz * d;
        if (!areaClear(h.world, x - 2, z - 2, x + 2, z + 2)) return false;
        if (h.world.heightAt(x, z) < 1) return false;
      }
      return true;
    }) ?? [...h.sim.vehicles.values()][0];
    const def = VEHICLES[v.type];
    expect(v.fuel).toBeGreaterThanOrEqual(def.fuelMax * 0.3 - 1e-6);
    expect(v.fuel).toBeLessThanOrEqual(def.fuelMax * 0.9 + 1e-6);
    const ex = exitPosition(v, 0, h.world);
    h.place(a, ex.x, ex.z, v.yaw);
    h.step(2);
    const p = h.p(a);
    h.step(1, () => ({ [a]: { actions: [{ a: 'enter', id: v.id }] } }));
    expect(p.mode).toBe('vehicle');
    expect(p.vehicleId).toBe(v.id);
    expect(p.seat).toBe(0);
    expect(v.seats[0]).toBe(a);
    expect(h.of('vehicleEnter')[0]).toMatchObject({ player: a, vehicle: v.id, seat: 0 });
    // Drive forward.
    const start = { ...v.pos };
    const fuel0 = v.fuel;
    h.step(60, () => ({ [a]: { mz: 1 } }));
    expect(Math.hypot(v.pos.x - start.x, v.pos.z - start.z)).toBeGreaterThan(5);
    expect(v.fuel).toBeLessThan(fuel0);
    expect(Math.hypot(p.pos.x - v.pos.x, p.pos.z - v.pos.z)).toBeLessThan(3);
    // Out of fuel: the engine gives no drive.
    h.step(60, () => ({ [a]: { mz: -1 } }));
    h.step(60);
    v.fuel = 0;
    const s0 = { ...v.pos };
    h.step(45, () => ({ [a]: { mz: 1 } }));
    expect(Math.hypot(v.pos.x - s0.x, v.pos.z - s0.z)).toBeLessThan(1.5);
    // Refuel with a jerry can from the driver seat.
    p.items.fuel = 1;
    h.step(1, () => ({ [a]: { actions: [{ a: 'use', item: 'fuel' }] } }));
    expect(p.use?.item).toBe('fuel');
    h.stepUntil(() => p.use === null, 400);
    expect(v.fuel).toBeCloseTo(def.fuelMax * 0.5, 3);
    expect(p.items.fuel).toBe(0);
    // Crash: drop the vehicle from height.
    const hp0 = v.health, php0 = p.health;
    v.pos.y += 30;
    v.vel.x = 0; v.vel.y = 0; v.vel.z = 0;
    h.clearEvents();
    h.stepUntil(() => h.of('vehicleCrash').length > 0, 150);
    expect(h.of('vehicleCrash').length).toBeGreaterThan(0);
    expect(v.health).toBeLessThan(hp0);
    expect(p.health).toBeLessThan(php0);
    // Bail out at speed hurts.
    h.step(30);
    if (p.life === 'alive') {
      const hp1 = p.health;
      v.vel.x = -Math.sin(v.yaw) * 20; v.vel.z = -Math.cos(v.yaw) * 20; v.vel.y = 0;
      h.step(1, () => ({ [a]: { actions: [{ a: 'exit' }] } }));
      expect(p.mode).toBe('ground');
      expect(p.vehicleId).toBeNull();
      expect(v.seats[0]).toBeNull();
      expect(hp1 - p.health).toBeCloseTo((20 - 8) * 3, 0);
      expect(h.of('vehicleExit').length).toBe(1);
    }
  });

  it('a destroyed vehicle burns, explodes and stays a wreck', () => {
    const h = new Harness({ maxPlayers: 2 });
    h.add('Nobody');
    h.sim.start();
    const v = [...h.sim.vehicles.values()][0];
    // Health 0 starts the burn timer (as bullets / crashes do through damageVehicle).
    v.health = 0;
    v.burnTimer = 5;
    h.stepUntil(() => v.destroyed, 200);
    expect(v.destroyed).toBe(true);
    expect(h.of('vehicleDestroyed').length).toBe(1);
    expect(h.of('explosion')[0]).toMatchObject({ source: 'vehicle' });
    expect(h.sim.vehicles.has(v.id)).toBe(true);
  });
});

describe('training ground', () => {
  it('give / respawn / infinite ammo and target read-outs', () => {
    const h = new Harness({ mode: 'training', maxPlayers: 4, infiniteAmmo: true });
    const a = h.add('Trainee');
    h.sim.start();
    expect(h.sim.phase).toBe('playing');
    expect(h.sim.plane).toBeNull();
    const p = h.p(a);
    expect(p.mode).toBe('ground');
    expect(h.of('spawned').length).toBe(1);
    const layout = h.world.training!;
    expect(Math.hypot(p.pos.x - layout.spawn.x, p.pos.z - layout.spawn.z)).toBeLessThan(20);
    h.setIdle(a, { yaw: layout.spawnYaw });
    // Give, rate limited (two in one tick -> one).
    h.step(1, () => ({ [a]: { actions: [{ a: 'give', item: 'ar' }, { a: 'give', item: 'ammo_556' }] } }));
    expect(p.weapons[0]).toEqual({ id: 'ar', mag: 30 });
    expect(p.ammo.ammo_556).toBe(0);
    h.step(10);
    h.step(1, () => ({ [a]: { actions: [{ a: 'give', item: 'ammo_556' }] } }));
    expect(p.ammo.ammo_556).toBe(60);
    // Infinite ammo: reload refills the mag without consuming the reserve.
    h.setIdle(a, { slot: 0 });
    h.step(30);
    p.weapons[0]!.mag = 3;
    p.ammo.ammo_556 = 0;
    h.step(1, () => ({ [a]: { buttons: BTN.RELOAD } }));
    h.step(Math.ceil(WEAPONS.ar.reloadTime / TICK_DT) + 2);
    expect(p.weapons[0]!.mag).toBe(30);
    expect(p.ammo.ammo_556).toBe(0);
    // Respawn resets health and position.
    p.health = 20;
    p.pos.x += 30;
    h.step(1, () => ({ [a]: { actions: [{ a: 'respawn' }] } }));
    expect(p.health).toBe(100);
    expect(Math.hypot(p.pos.x - layout.spawn.x, p.pos.z - layout.spawn.z)).toBeLessThan(20);
    // Death auto-respawns after 3 s (inventory kept).
    const info = damageInfo(null, 'fall');
    damagePlayer(h.sim, p, 200, info);
    expect(p.life).toBe('dead');
    h.step(Math.ceil(3 / TICK_DT) + 2);
    expect(p.life).toBe('alive');
    expect(p.weapons[0]?.id).toBe('ar');

    // Moving targets ping-pong deterministically (base position = target centre - 1.3 m).
    const moving = layout.targets.find((t) => t.kind === 'moving' && t.a && t.b && t.speed)!;
    expect(moving).toBeTruthy();
    const L = Math.hypot(moving.b!.x - moving.a!.x, moving.b!.z - moving.a!.z);
    const m0 = trainingTargetPosition(moving, 0);
    expect(m0.x).toBeCloseTo(moving.a!.x, 6);
    expect(m0.y).toBeCloseTo(moving.a!.y - TRAINING_TARGET_CENTER_HEIGHT, 6);
    expect(trainingTargetPosition(moving, L / moving.speed!).x).toBeCloseTo(moving.b!.x, 6);
    expect(trainingTargetPosition(moving, (2 * L) / moving.speed!).x).toBeCloseTo(moving.a!.x, 6);
    expect(trainingTargetPosition(moving, (0.5 * L) / moving.speed!).x).toBeCloseTo((moving.a!.x + moving.b!.x) / 2, 6);

    const fl = layout.firingLine;
    const shootFrom = (x: number, z: number, aimAt: Vec3) => {
      h.place(a, x, z);
      h.setIdle(a, { slot: 0 });
      h.step(25);
      const aim = h.aimAt(a, aimAt);
      h.setIdle(a, { ...aim, slot: 0, buttons: BTN.ADS });
      h.step(15);
      h.clearEvents();
      h.step(1, () => ({ [a]: { buttons: BTN.ADS | BTN.FIRE } }));
      return h.simEvents('targetHit');
    };
    // Static 25 m target (a steel plate box): body and head (top 22 %) read-outs.
    const target = layout.targets.filter((t) => t.kind === 'static').sort((x, y) => x.range - y.range)[0];
    const box = h.world.boxes.find((bx) => bx.id === target.id)!;
    expect(box.kind).toBe('target');
    const bc = { x: (box.min.x + box.max.x) / 2, y: box.min.y + (box.max.y - box.min.y) * 0.45, z: (box.min.z + box.max.z) / 2 };
    let th = shootFrom(target.pos.x, fl.z - 1, bc);
    expect(th.length).toBe(1);
    expect(th[0].to).toEqual([a]);
    let ev = th[0].ev as Ev<'targetHit'>;
    expect(ev.target).toBe(target.id);
    expect(ev.part).toBe('body');
    expect(Math.abs(ev.distance - target.range)).toBeLessThan(3);
    expect(ev.damage).toBeCloseTo(computeDamage('ar', 'body', ev.distance, NO_ARMOR).health, 0);
    th = shootFrom(target.pos.x, fl.z - 1, { ...bc, y: box.max.y - 0.15 });
    ev = th[0].ev as Ev<'targetHit'>;
    expect(ev.part).toBe('head');
    expect(ev.damage).toBeCloseTo(computeDamage('ar', 'head', ev.distance, NO_ARMOR).health, 0);
    // Moving target: hit-tested as a standing dummy at its (time-based) position.
    h.setIdle(a, { slot: 0 });
    h.place(a, (moving.a!.x + moving.b!.x) / 2, fl.z - 1);
    h.step(25);
    const tShot = h.sim.time;
    const base = trainingTargetPosition(moving, tShot);
    const aim = h.aimAt(a, { x: base.x, y: base.y + 1.2, z: base.z });
    h.setIdle(a, { ...aim, slot: 0, buttons: BTN.ADS });
    h.clearEvents();
    // Aim at where it is now and claim to see exactly that time (no rewind).
    h.step(1, () => ({ [a]: { ...aim, buttons: BTN.ADS | BTN.FIRE, rt: tShot * 1000 } }));
    const mh = h.of('targetHit');
    expect(mh.length).toBe(1);
    expect(mh[0].target).toBe(moving.id);
  });
});

describe('determinism and performance', () => {
  /** Trivial scripted driver: jumps, wanders, picks up nearby loot, shoots the nearest enemy. */
  function runScripted(seed: number, players: number, ticks: number, teamSize: 1 | 2 | 4 = 2, cluster = false) {
    const sim = new GameSim({ ...BASE, seed, maxPlayers: players, teamSize, botFill: true });
    sim.fillBots();
    sim.start();
    if (cluster) {
      // Everyone on the ground within ~100 m of each other: a dense firefight.
      const crng = new Rng(seed);
      let i = 0;
      for (const p of sim.players.values()) {
        let x = 0, z = 0;
        for (let k = 0; k < 50; k++) {
          const a = crng.next() * Math.PI * 2, r = 20 + crng.next() * 80;
          x = Math.cos(a) * r; z = Math.sin(a) * r;
          if (sim.world.heightAt(x, z) > 1) break;
        }
        p.mode = 'ground';
        p.pos.x = x; p.pos.z = z; p.pos.y = sim.world.groundAt(x, z);
        p.onGround = true;
        p.yaw = (i++ % 8) * 0.8;
      }
    }
    const rng = new Rng(seed ^ 0x9e37);
    const seq = new Map<number, number>();
    const near: PlayerState[] = [];
    const loot: ReturnType<GameSim['lootNear']> = [];
    let total = 0;
    let worst = 0;
    for (let t = 0; t < ticks; t++) {
      for (const p of sim.players.values()) {
        if (p.life === 'dead') continue;
        const s = (seq.get(p.id) ?? 0) + 1;
        seq.set(p.id, s);
        const actions: PlayerInput['actions'] = [];
        let yaw = p.yaw + (rng.next() - 0.5) * 0.2;
        let pitch = 0;
        let buttons = rng.chance(0.3) ? BTN.SPRINT : 0;
        let slot: PlayerInput['slot'] = p.activeSlot;
        if (p.mode === 'plane' && sim.plane && sim.plane.traveled > sim.plane.length * (0.25 + rng.next() * 0.5) && rng.chance(0.05)) actions.push({ a: 'jump' });
        if (p.mode === 'ground') {
          if (!p.weapons[0]) {
            p.weapons[0] = { id: 'ar', mag: 30 };
            p.ammo.ammo_556 = 300;
          }
          slot = 0;
          sim.lootNear(p.pos.x, p.pos.z, 2.5, loot);
          if (loot.length && rng.chance(0.1)) actions.push({ a: 'pickup', id: loot[0].id });
          sim.playersNear(p.pos.x, p.pos.z, 60, near);
          const enemy = near.find((o) => o.team !== p.team && o.life !== 'dead' && o.mode === 'ground');
          if (enemy) {
            const e = sim.eyePos(p.id);
            yaw = Math.atan2(-(enemy.pos.x - e.x), -(enemy.pos.z - e.z));
            pitch = Math.atan2(enemy.pos.y + 1.2 - e.y, Math.hypot(enemy.pos.x - e.x, enemy.pos.z - e.z));
            buttons = BTN.FIRE | BTN.ADS;
          }
          if (rng.chance(0.01)) buttons |= BTN.JUMP;
        }
        sim.queueInput(p.id, {
          seq: s, mx: 0, mz: 1, yaw, pitch, buttons, stance: 0, slot, rt: sim.time * 1000 - 100, actions,
        });
      }
      const t0 = performance.now();
      sim.step();
      const ms = performance.now() - t0;
      total += ms;
      if (t > 30) worst = Math.max(worst, ms);
      sim.drainEvents();
      sim.drainLootDelta();
    }
    return { sim, avg: total / ticks, worst };
  }

  it('two sims with the same seed and inputs produce identical state', () => {
    const a = runScripted(4242, 16, 30 * 45);
    const b = runScripted(4242, 16, 30 * 45);
    const snap = (sim: GameSim) => JSON.stringify({
      t: sim.time, ph: sim.phase, z: sim.zone,
      p: [...sim.players.values()], v: [...sim.vehicles.values()], pr: [...sim.projectiles.values()],
      l: [...sim.loot.values()],
    });
    const sa = snap(a.sim);
    expect(sa).toBe(snap(b.sim));
    // The script actually exercised combat.
    const shots = [...a.sim.players.values()].reduce((s, p) => s + p.stats.shotsFired, 0);
    expect(shots).toBeGreaterThan(0);
  });

  it('a 64-player match steps well within the tick budget', () => {
    const drop = runScripted(99, 64, 30 * 60);
    console.log(`[sim perf] 64 players, drop phase: avg ${drop.avg.toFixed(2)} ms/tick, worst ${drop.worst.toFixed(1)} ms`);
    expect(drop.avg).toBeLessThan(20);
    const fight = runScripted(7, 64, 30 * 30, 2, true);
    const shots = [...fight.sim.players.values()].reduce((s, p) => s + p.stats.shotsFired, 0);
    const dead = [...fight.sim.players.values()].filter((p) => p.life !== 'alive').length;
    console.log(`[sim perf] 64 players, firefight: avg ${fight.avg.toFixed(2)} ms/tick, worst ${fight.worst.toFixed(1)} ms, shots ${shots}, down/dead ${dead}`);
    expect(shots).toBeGreaterThan(500);
    expect(fight.avg).toBeLessThan(20);
  });
});
