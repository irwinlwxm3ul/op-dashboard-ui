// MatchRunner tests: matchInit, snapshots (information hiding, interest management), input rate
// limiting, event routing, ping/pong, leaving and the end-of-match callback.
import { describe, expect, it } from 'vitest';
import { INPUT_BURST, MOVE_SPEED, SNAPSHOT_RATE, TICK_MS, TICK_RATE } from '../src/shared/constants';
import type { ClientMessage, ServerMessage, Snapshot } from '../src/shared/protocol';
import { MatchRunner } from '../src/shared/sim';
import type { BotDriver, SimView } from '../src/shared/sim';
import { damageInfo, damagePlayer } from '../src/shared/sim/combat';
import type { GameEvent, MatchConfig, PlayerInput, PlayerState, RockDef, TreeDef, World, WorldBox } from '../src/shared/types';
import { BTN } from '../src/shared/types';

const CONFIG: MatchConfig = {
  mode: 'br', seed: 1234, maxPlayers: 6, teamSize: 2, botFill: true, botDifficulty: 'normal',
  zoneSpeed: 1, infiniteAmmo: false,
};

class FakeClient {
  readonly msgs: ServerMessage[] = [];
  constructor(readonly id: string, readonly name: string, readonly team: number | null) {}
  send = (m: ServerMessage): void => {
    // Serialise like the network would (catches shared mutable references).
    this.msgs.push(JSON.parse(JSON.stringify(m)) as ServerMessage);
  };
  snaps(): Snapshot[] {
    return this.msgs.filter((m): m is Extract<ServerMessage, { t: 'snap' }> => m.t === 'snap').map((m) => m.s);
  }
  events(): GameEvent[] {
    return this.snaps().flatMap((s) => s.events);
  }
  init() {
    const m = this.msgs.find((x): x is Extract<ServerMessage, { t: 'matchInit' }> => x.t === 'matchInit');
    return m!.init;
  }
}

function setup(cfg: Partial<MatchConfig> = {}, teams: (number | null)[] = [0, 1, 0], driver?: (sim: SimView) => BotDriver) {
  const clients = teams.map((t, i) => new FakeClient(`c${i}`, `Player${i}`, t));
  let ended = 0;
  let results: unknown = null;
  const runner = new MatchRunner({
    config: { ...CONFIG, ...cfg },
    clients: clients.map((c) => ({ id: c.id, name: c.name, team: c.team, send: c.send })),
    botDriverFactory: driver,
    onEnd: (r) => { ended++; results = r; },
  });
  let now = 1000;
  runner.start(now);
  const advance = (ms: number, each?: () => void) => {
    const steps = Math.round(ms / TICK_MS);
    for (let i = 0; i < steps; i++) {
      if (each) each();
      now += TICK_MS;
      runner.update(now);
    }
  };
  return { runner, clients, advance, ended: () => ended, results: () => results, now: () => now };
}

function areaClear(w: World, x0: number, z0: number, x1: number, z1: number): boolean {
  const b: WorldBox[] = [], t: TreeDef[] = [], r: RockDef[] = [];
  w.queryBoxes(x0, z0, x1, z1, b);
  w.queryTrees(x0, z0, x1, z1, t);
  w.queryRocks(x0, z0, x1, z1, r);
  return b.length === 0 && t.length === 0 && r.length === 0;
}
/** Flat dry clear rectangle [x-hw, x+hw] x [z-len, z+hw] (players move towards -Z). */
function findOpen(w: World, len: number, hw = 4): { x: number; z: number } {
  const lim = w.half - len - 10;
  for (let z = -lim; z <= lim; z += 6) {
    for (let x = -lim; x <= lim; x += 6) {
      const h0 = w.heightAt(x, z);
      if (h0 < w.waterLevel + 2) continue;
      let ok = true;
      for (let d = 0; d <= len && ok; d += 2) {
        for (let e = -hw; e <= hw && ok; e += 2) {
          const hh = w.heightAt(x + e, z - d);
          if (Math.abs(hh - h0) > 1.5 || hh < w.waterLevel + 1.5) ok = false;
        }
      }
      if (ok && areaClear(w, x - hw, z - len, x + hw, z + hw)) return { x, z };
    }
  }
  throw new Error('no open area');
}
function placeOnGround(w: World, p: PlayerState, x: number, z: number): void {
  p.mode = 'ground';
  p.pos.x = x; p.pos.z = z; p.pos.y = w.groundAt(x, z);
  p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
  p.onGround = true;
}

describe('MatchRunner', () => {
  it('sends matchInit with the roster, loot and the client player, then snapshots', () => {
    const { runner, clients, advance } = setup();
    const sim = runner.sim;
    expect(sim.players.size).toBe(6); // 3 humans + 3 bots
    for (const c of clients) {
      const init = c.init();
      expect(init.you).not.toBeNull();
      expect(sim.players.get(init.you!)!.name).toBe(c.name);
      expect(init.team).toBe(c.team);
      expect(init.roster.length).toBe(6);
      expect(init.roster.filter((r) => r.isBot).length).toBe(3);
      expect(init.loot.length).toBe(sim.loot.size);
      expect(init.loot.length).toBeGreaterThan(100);
      expect(init.config).toEqual({ ...CONFIG });
      expect(init.tickRate).toBe(TICK_RATE);
      expect(init.snapshotRate).toBe(SNAPSHOT_RATE);
      // A first snapshot follows immediately.
      expect(c.msgs[1].t).toBe('snap');
    }
    advance(1000);
    const snaps = clients[0].snaps();
    // ~20 Hz.
    expect(snaps.length).toBeGreaterThanOrEqual(SNAPSHOT_RATE);
    expect(snaps.length).toBeLessThanOrEqual(SNAPSHOT_RATE + 2);
    const last = snaps[snaps.length - 1];
    expect(last.phase).toBe('plane');
    expect(last.plane).not.toBeNull();
    expect(last.self!.id).toBe(clients[0].init().you);
    expect(last.time).toBeCloseTo(sim.time * 1000, 3);
    expect(last.alive).toBe(6);
    expect(last.teamsAlive).toBe(3);
    // matchStart / planeStart / zonePhase are delivered once.
    const types = clients[0].events().map((e) => e.type);
    expect(types.filter((t) => t === 'matchStart').length).toBe(1);
    expect(types.filter((t) => t === 'planeStart').length).toBe(1);
  });

  it('never sends enemy hp or other players\' inventories; quantises positions', () => {
    const { runner, clients, advance } = setup();
    const sim = runner.sim;
    advance(500);
    const me = clients[0].init().you!;
    for (const p of sim.players.values()) {
      p.pos.x += 0.123456;
      p.ammo.ammo_556 = 77;
      p.items.medkit = 2;
    }
    advance(300);
    const snap = clients[0].snaps().at(-1)!;
    const myTeam = sim.players.get(me)!.team;
    let mates = 0, enemies = 0;
    // Plane riders are sent at the lowest rate: look at all recent snapshots.
    for (const np of clients[0].snaps().slice(-6).flatMap((s) => s.players)) {
      if (np.team === myTeam) {
        mates++;
        expect(np.hp).toBeDefined();
      } else {
        enemies++;
        expect(np.hp).toBeUndefined();
        expect(np.dhp).toBeUndefined();
      }
      for (const v of np.p) expect(Math.round(v * 100) / 100).toBe(v);
      expect(Math.round(np.y * 1000) / 1000).toBe(np.y);
    }
    expect(mates).toBeGreaterThanOrEqual(2);
    expect(enemies).toBeGreaterThan(0);
    const json = JSON.stringify(clients[0].snaps().map((s) => s.players));
    for (const key of ['ammo', 'items', 'weapons', 'armor', 'stats', 'health']) expect(json).not.toContain(`"${key}"`);
    expect(snap.self!.ammo.ammo_556).toBe(77);
  });

  it('rate limits input floods: the player never moves faster than sprinting', () => {
    const { runner, clients, advance } = setup({ botFill: false, maxPlayers: 2 }, [0, 1]);
    const sim = runner.sim;
    const id = clients[0].init().you!;
    const p = sim.players.get(id)!;
    const o = findOpen(sim.world, 18);
    for (const q of sim.players.values()) placeOnGround(sim.world, q, o.x, o.z);
    advance(200);
    const start = { x: p.pos.x, z: p.pos.z };
    let seq = 1000;
    const flood = () => {
      const inputs: PlayerInput[] = [];
      for (let k = 0; k < 100; k++) {
        inputs.push({ seq: ++seq, mx: 0, mz: 1, yaw: 0, pitch: 0, buttons: BTN.SPRINT, stance: 0, slot: -1, rt: 0 });
      }
      runner.handleMessage(clients[0].id, { t: 'input', inputs });
    };
    advance(2000, flood);
    const moved = Math.hypot(p.pos.x - start.x, p.pos.z - start.z);
    expect(moved).toBeGreaterThan(3);
    expect(moved).toBeLessThanOrEqual(MOVE_SPEED.sprint * 2 * 1.05 + 0.2);
    // Acks advance (the latest accepted inputs were processed) but never beyond what was sent.
    const self = clients[0].snaps().at(-1)!.self!;
    expect(self.ack).toBeGreaterThan(1000);
    expect(self.ack).toBeLessThanOrEqual(seq);
    // Duplicate / old seq numbers are ignored.
    const before = p.lastSeq;
    runner.handleMessage(clients[0].id, { t: 'input', inputs: [{ seq: 5, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: -1, rt: 0 }] });
    advance(100);
    expect(p.lastSeq).toBeGreaterThanOrEqual(before);
    expect(p.lastSeq).not.toBe(5);
    // Garbage inputs are dropped by validation.
    runner.handleMessage(clients[0].id, { t: 'input', inputs: [{ seq: 1e9, mx: NaN, mz: 0, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: -1, rt: 0 }] } as ClientMessage);
    advance(100);
    expect(Number.isFinite(p.pos.x)).toBe(true);
    expect(INPUT_BURST).toBeGreaterThan(0);
  });

  it('routes events by audience: private, ranged and global', () => {
    const { runner, clients, advance } = setup({ botFill: false, maxPlayers: 4 }, [0, 1, 0]);
    const sim = runner.sim;
    const [ia, ib, ic] = clients.map((c) => c.init().you!);
    const pa = sim.players.get(ia)!, pb = sim.players.get(ib)!, pc = sim.players.get(ic)!;
    const o = findOpen(sim.world, 4, 8);
    placeOnGround(sim.world, pa, o.x, o.z);
    placeOnGround(sim.world, pb, o.x + 5, o.z);
    // C is a teammate of A but far away.
    let far = { x: o.x + 400, z: o.z };
    if (!sim.world.inBounds(far.x, far.z) || sim.world.heightAt(far.x, far.z) < 1) far = { x: o.x - 400, z: o.z };
    placeOnGround(sim.world, pc, far.x, far.z);
    advance(300);
    for (const c of clients) c.msgs.length = 0;
    // Private: pickup goes to the picker only.
    const loot = sim.placeLootAt('bandage', 2, { x: pa.pos.x + 1, y: pa.pos.y + 0.05, z: pa.pos.z })!;
    runner.handleMessage(clients[0].id, {
      t: 'input', inputs: [{ seq: 1, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, stance: 0, slot: 0, rt: 0, actions: [{ a: 'pickup', id: loot.id }] }],
    });
    // Ranged: a reload near A and B (150 m) — C is 400 m away.
    pa.weapons[0] = { id: 'ar', mag: 10 };
    pa.ammo.ammo_556 = 60;
    pa.activeSlot = 0;
    runner.handleMessage(clients[0].id, {
      t: 'input', inputs: [{ seq: 2, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: BTN.RELOAD, stance: 0, slot: 0, rt: 0 }],
    });
    // Hit: attacker + victim only.
    const info = damageInfo(pb, 'ar', 'body');
    info.pos = pa.pos;
    info.from = pb.pos;
    info.emitHit = true;
    damagePlayer(sim, pa, 20, info);
    advance(200);
    const evA = clients[0].events().map((e) => e.type);
    const evB = clients[1].events().map((e) => e.type);
    const evC = clients[2].events().map((e) => e.type);
    expect(evA).toContain('pickup');
    expect(evB).not.toContain('pickup');
    expect(evC).not.toContain('pickup');
    expect(evA).toContain('reload');
    expect(evB).toContain('reload');
    expect(evC).not.toContain('reload');
    expect(evA).toContain('hit');
    expect(evB).toContain('hit');
    expect(evC).not.toContain('hit');
    // Global: a kill reaches everyone.
    const k = damageInfo(pb, 'ar', 'head');
    damagePlayer(sim, pa, 500, k);
    advance(100);
    expect(clients[2].events().map((e) => e.type)).toContain('knock');
    // Teammates' hp is visible, the attacker (enemy) is full-rate after the exchange.
    const lastA = clients[0].snaps().at(-1)!;
    expect(lastA.players.find((p) => p.id === ic)?.hp).toBeDefined();
  });

  it('answers pings with the sim clock and hands leaving players to the bots', () => {
    const removed: number[] = [];
    let updates = 0;
    const driver = (): BotDriver => ({ update: () => { updates++; }, onPlayerRemoved: (id) => removed.push(id) });
    const { runner, clients, advance } = setup({}, [0, 1, 0], driver);
    advance(500);
    expect(updates).toBe(runner.sim.tick);
    runner.handleMessage(clients[1].id, { t: 'ping', c: 42 });
    const pong = clients[1].msgs.find((m): m is Extract<ServerMessage, { t: 'pong' }> => m.t === 'pong')!;
    expect(pong.c).toBe(42);
    expect(pong.s).toBeGreaterThanOrEqual(runner.sim.time * 1000);
    expect(pong.s).toBeLessThan(runner.sim.time * 1000 + TICK_MS);
    const id = clients[1].init().you!;
    runner.handleMessage(clients[1].id, { t: 'leaveMatch' });
    const p = runner.sim.players.get(id)!;
    expect(p.isBot).toBe(true);
    expect(p.connected).toBe(false);
    expect(removed).toEqual([id]);
    const n = clients[1].msgs.length;
    advance(500);
    expect(clients[1].msgs.length).toBe(n);
    const st = runner.stats();
    expect(st.players).toBe(6);
    expect(st.bots).toBe(4);
    expect(st.tickMsAvg).toBeGreaterThanOrEqual(0);
    expect(st.tickMsMax).toBeGreaterThanOrEqual(st.tickMsAvg);
  });

  it('fires onEnd exactly once and reports dead players as gone after 5 s', () => {
    const { runner, clients, advance, ended, results } = setup({ botFill: false, maxPlayers: 3, teamSize: 1 }, [null, null, null]);
    const sim = runner.sim;
    const [ia, ib, ic] = clients.map((c) => c.init().you!);
    const o = findOpen(sim.world, 4, 8);
    for (const [i, id] of [ia, ib, ic].entries()) placeOnGround(sim.world, sim.players.get(id)!, o.x + i * 3, o.z);
    advance(300);
    damagePlayer(sim, sim.players.get(ic)!, 500, damageInfo(sim.players.get(ia)!, 'ar'));
    advance(1000);
    expect(clients[0].snaps().at(-1)!.players.some((p) => p.id === ic)).toBe(true);
    advance(5000);
    const gone = clients[0].snaps().flatMap((s) => s.gone ?? []);
    expect(gone).toEqual([ic]);
    expect(clients[0].snaps().at(-1)!.players.some((p) => p.id === ic)).toBe(false);
    expect(ended()).toBe(0);
    damagePlayer(sim, sim.players.get(ib)!, 500, damageInfo(sim.players.get(ia)!, 'ar'));
    advance(200);
    expect(runner.isOver()).toBe(true);
    expect(ended()).toBe(1);
    advance(1000);
    expect(ended()).toBe(1);
    const res = results() as { winnerTeam: number; players: { id: number; placement: number }[] };
    expect(res.winnerTeam).toBe(sim.players.get(ia)!.team);
    expect(res.players.find((p) => p.id === ia)!.placement).toBe(1);
    expect(clients[1].events().some((e) => e.type === 'matchEnd')).toBe(true);
  });

  it('drops the backlog after a long stall instead of spiralling', () => {
    const { runner, advance, now } = setup();
    advance(100);
    const t0 = runner.sim.tick;
    runner.update(now() + 10_000);
    expect(runner.sim.tick - t0).toBeLessThanOrEqual(5);
    expect(runner.sim.tick - t0).toBeGreaterThan(0);
  });
});
