// Bot AI tests: a minimal SimView mock backed by real generated worlds and hand-made players.
import { beforeAll, describe, expect, it } from 'vitest';
import { INTERACT_RANGE, PLANE_ALTITUDE, PLANE_SPEED, STEP_HEIGHT, TICK_DT } from '../src/shared/constants';
import { emptyInventory } from '../src/shared/items';
import { angleDiff, forward, right } from '../src/shared/math';
import {
  createMoveEvents, createMoveIntent, eyePosition, lineOfSight, stepCharacter,
} from '../src/shared/physics';
import { Rng } from '../src/shared/rng';
import type { BotDriver, NoiseEvent, SimView } from '../src/shared/sim/view';
import type {
  BotDifficulty, EntityId, LootItem, MatchConfig, MatchPhase, PlaneState, PlayerInput, PlayerState,
  Projectile, TeamId, Vec3, VehicleState, World, ZoneState,
} from '../src/shared/types';
import { BTN, STANCE_FROM_CODE } from '../src/shared/types';
import { generateWorld } from '../src/shared/world';
import { createBotDriver, botName } from '../src/shared/bots';
import type { BotDriverEx } from '../src/shared/bots';
import { NavGrid, NF_BLOCKED } from '../src/shared/bots/nav';
import { PathPlanner, newPathRequest, PATH_DONE } from '../src/shared/bots/pathfind';

// ---------------------------------------------------------------------------
// Mock simulation
// ---------------------------------------------------------------------------

function makePlayer(id: EntityId, team: TeamId, pos: Vec3, isBot = true): PlayerState {
  const inv = emptyInventory();
  return {
    pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, onGround: true, airTime: 0, jumpBuffer: 0,
    stance: 'stand', mode: 'ground', fallSpeed: 0,
    id, name: `p${id}`, team, isBot, connected: !isBot,
    yaw: 0, pitch: 0, recoilPitch: 0, recoilYaw: 0, lean: 0,
    life: 'alive', health: 100, boost: 0, downedHp: 0, knockCount: 0,
    armor: { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 },
    weapons: [null, null, null], activeSlot: -1,
    ammo: inv.ammo, items: inv.items,
    fireCooldown: 0, reloadTimer: 0, reloadTotal: 0, drawTimer: 0, ads: 0, sprayCount: 0, bloom: 0, shotCounter: 0,
    use: null, revive: null, revivedBy: null, vehicleId: null, seat: -1, parachuteOpen: false, jumpY: 0,
    lastSeq: 0, lastButtons: 0, throwCooldown: 0,
    stats: { kills: 0, knocks: 0, damage: 0, headshots: 0, revives: 0, longestKill: 0, shotsFired: 0, shotsHit: 0, spawnTime: 0, deathTime: 0 },
    placement: 0, killerId: null, spectating: null, lastAttacker: null, lastAttackerWeapon: null,
  };
}

function arm(p: PlayerState, weapon: 'ar' | 'smg' | 'sniper' = 'ar'): void {
  p.weapons[0] = { id: weapon, mag: weapon === 'sniper' ? 5 : 30 };
  p.activeSlot = 0;
  if (weapon === 'sniper') p.ammo.ammo_300 = 20;
  else if (weapon === 'smg') p.ammo.ammo_9mm = 90;
  else p.ammo.ammo_556 = 90;
}

interface Recorded { time: number; input: PlayerInput }

class MockSim implements SimView {
  readonly config: MatchConfig;
  readonly world: World;
  time = 0;
  tick = 0;
  phase: MatchPhase = 'playing';
  readonly players = new Map<EntityId, PlayerState>();
  readonly vehicles = new Map<EntityId, VehicleState>();
  readonly loot = new Map<EntityId, LootItem>();
  readonly projectiles = new Map<EntityId, Projectile>();
  zone: ZoneState;
  plane: PlaneState | null = null;
  noises: NoiseEvent[] = [];
  readonly inputs = new Map<EntityId, Recorded[]>();
  readonly last = new Map<EntityId, PlayerInput>();
  /** Move players with the real character controller using their latest input. */
  physics = false;
  private nextId = 1;
  private readonly intent = createMoveIntent();
  private readonly ev = createMoveEvents();

  constructor(world: World, difficulty: BotDifficulty = 'normal') {
    this.world = world;
    this.config = {
      mode: 'br', seed: 7, maxPlayers: 64, teamSize: 1, botFill: true, botDifficulty: difficulty, zoneSpeed: 1, infiniteAmmo: false,
    };
    // Zone not started (stage pre covers everything).
    const r = world.half * Math.SQRT2 + 10;
    this.zone = { phase: 0, stage: 'pre', cx: 0, cz: 0, r, nx: 0, nz: 0, nr: r, timer: 0, stageTotal: 0, damagePerSec: 0 };
  }

  addPlayer(team: TeamId, pos: Vec3, isBot = true): PlayerState {
    const p = makePlayer(this.nextId++, team, pos, isBot);
    this.players.set(p.id, p);
    this.inputs.set(p.id, []);
    return p;
  }

  addLoot(item: LootItem['item'], pos: Vec3, count = 1): LootItem {
    const l: LootItem = { id: this.nextId++, item, count, pos: { ...pos } };
    this.loot.set(l.id, l);
    return l;
  }

  queueInput(id: EntityId, input: PlayerInput): void {
    const copy: PlayerInput = { ...input, actions: input.actions ? input.actions.slice() : undefined };
    this.inputs.get(id)?.push({ time: this.time, input: copy });
    this.last.set(id, copy);
  }

  lootNear(x: number, z: number, radius: number, out: LootItem[]): LootItem[] {
    out.length = 0;
    for (const l of this.loot.values()) if (Math.hypot(l.pos.x - x, l.pos.z - z) <= radius) out.push(l);
    return out;
  }
  playersNear(x: number, z: number, radius: number, out: PlayerState[]): PlayerState[] {
    out.length = 0;
    for (const p of this.players.values()) if (Math.hypot(p.pos.x - x, p.pos.z - z) <= radius) out.push(p);
    return out;
  }
  vehiclesNear(x: number, z: number, radius: number, out: VehicleState[]): VehicleState[] {
    out.length = 0;
    for (const v of this.vehicles.values()) if (Math.hypot(v.pos.x - x, v.pos.z - z) <= radius) out.push(v);
    return out;
  }
  eyePos(id: EntityId, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const p = this.players.get(id)!;
    return eyePosition(p, p.lean, p.yaw, out);
  }
  sameTeam(a: EntityId, b: EntityId): boolean {
    const pa = this.players.get(a), pb = this.players.get(b);
    return !!pa && !!pb && pa.team === pb.team;
  }

  /** Advance one tick (after the driver queued inputs). */
  step(): void {
    for (const p of this.players.values()) {
      const inp = this.last.get(p.id);
      if (!inp) continue;
      p.lastSeq = inp.seq;
      p.lastButtons = inp.buttons;
      p.yaw = inp.yaw;
      p.pitch = inp.pitch;
      if (this.physics && p.mode === 'ground' && p.life === 'alive') {
        const it = this.intent;
        it.mx = inp.mx;
        it.mz = inp.mz;
        it.yaw = inp.yaw;
        it.sprint = (inp.buttons & BTN.SPRINT) !== 0;
        it.walk = (inp.buttons & BTN.WALK) !== 0;
        it.jumpPressed = (inp.buttons & BTN.JUMP) !== 0;
        it.wantStance = STANCE_FROM_CODE[inp.stance];
        stepCharacter(p, it, TICK_DT, this.world, this.ev);
      }
    }
    this.time += TICK_DT;
    this.tick++;
  }

  run(driver: BotDriver, ticks: number, each?: () => void): void {
    for (let i = 0; i < ticks; i++) {
      driver.update(TICK_DT);
      this.step();
      each?.();
    }
  }
}

/** World direction of an input's movement axes. */
function moveDir(inp: PlayerInput): { x: number; z: number } {
  const r = right(inp.yaw), f = forward(inp.yaw);
  return { x: r.x * inp.mx + f.x * inp.mz, z: r.z * inp.mx + f.z * inp.mz };
}

function ground(w: World, x: number, z: number): Vec3 {
  return { x, y: w.heightAt(x, z), z };
}

/** A free, flat, open spot with free space around it (no boxes / trees nearby). */
function openSpot(w: World, grid: NavGrid, rng: Rng, clear = 15): Vec3 {
  for (let k = 0; k < 20000; k++) {
    const x = (rng.next() - 0.5) * w.size * 0.7, z = (rng.next() - 0.5) * w.size * 0.7;
    if (w.heightAt(x, z) < w.waterLevel + 1) continue;
    let ok = true;
    for (let dz = -clear; dz <= clear && ok; dz += 3) {
      for (let dx = -clear; dx <= clear && ok; dx += 3) {
        if (grid.flagsAt(x + dx, z + dz) & NF_BLOCKED) ok = false;
      }
    }
    if (!ok) continue;
    const boxes = w.queryBoxes(x - clear, z - clear, x + clear, z + clear, []);
    const trees = w.queryTrees(x - clear, z - clear, x + clear, z + clear, []);
    const rocks = w.queryRocks(x - clear, z - clear, x + clear, z + clear, []);
    if (boxes.length || trees.length || rocks.length) continue;
    const n = w.normalAt(x, z);
    if (n.y < 0.95) continue;
    return ground(w, x, z);
  }
  throw new Error('no open spot');
}

const fired = (r: Recorded): boolean => (r.input.buttons & BTN.FIRE) !== 0;

// ---------------------------------------------------------------------------

let island: World;
let grid: NavGrid;

beforeAll(() => {
  island = generateWorld(4242, 'island');
  grid = new NavGrid(island);
});

describe('bot names', () => {
  it('are original, bounded and deterministic', () => {
    const a = new Rng(5), b = new Rng(5);
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = botName(a);
      expect(n).toBe(botName(b));
      expect(n.length).toBeGreaterThan(0);
      expect(n.length).toBeLessThanOrEqual(16);
      names.add(n);
    }
    expect(names.size).toBeGreaterThan(150);
  });
});

describe('plane phase', () => {
  it('jumps near the closest point of the flight path to its landing target', () => {
    const sim = new MockSim(island);
    sim.phase = 'plane';
    const lim = island.half + 60;
    const plane: PlaneState = {
      start: { x: -lim, z: -80 }, end: { x: lim, z: 60 }, altitude: PLANE_ALTITUDE, speed: PLANE_SPEED,
      startTime: 0, traveled: 0, length: 0, active: true,
    };
    plane.length = Math.hypot(plane.end.x - plane.start.x, plane.end.z - plane.start.z);
    sim.plane = plane;
    const dx = (plane.end.x - plane.start.x) / plane.length, dz = (plane.end.z - plane.start.z) / plane.length;
    const bot = sim.addPlayer(1, { x: plane.start.x, y: PLANE_ALTITUDE, z: plane.start.z });
    bot.mode = 'plane';
    const driver = createBotDriver(sim) as BotDriverEx;
    let jumpAt = -1;
    for (let i = 0; i < 3000 && jumpAt < 0; i++) {
      plane.traveled = Math.min(plane.length, plane.traveled + PLANE_SPEED * TICK_DT);
      const f = plane.traveled / plane.length;
      bot.pos.x = plane.start.x + (plane.end.x - plane.start.x) * f;
      bot.pos.z = plane.start.z + (plane.end.z - plane.start.z) * f;
      driver.update(TICK_DT);
      sim.step();
      const last = sim.last.get(bot.id)!;
      if (last.actions?.some((a) => a.a === 'jump')) jumpAt = plane.traveled;
    }
    expect(jumpAt).toBeGreaterThan(0);
    const info = driver.inspect(bot.id)!;
    expect(info.landing).not.toBeNull();
    const land = info.landing!;
    const along = (land.x - plane.start.x) * dx + (land.z - plane.start.z) * dz;
    const lateral = Math.abs((land.x - plane.start.x) * dz - (land.z - plane.start.z) * dx);
    expect(lateral).toBeLessThan(600);
    // Jumped a little before (or at) the closest point, never far past it.
    expect(jumpAt).toBeLessThanOrEqual(along + 40);
    expect(jumpAt).toBeGreaterThan(along - 220);
    expect(island.inBounds(bot.pos.x, bot.pos.z)).toBe(true);

    // Freefall: steers toward the landing spot.
    bot.mode = 'freefall';
    bot.jumpY = bot.pos.y;
    sim.run(driver, 40);
    const inp = sim.last.get(bot.id)!;
    const want = Math.atan2(-(land.x - bot.pos.x), -(land.z - bot.pos.z));
    expect(Math.abs(angleDiff(inp.yaw, want))).toBeLessThan(0.3);
    expect(inp.mz).toBeGreaterThan(0);
  });
});

describe('looting', () => {
  it('a bot next to loot sends a pickup action with that loot id', () => {
    const sim = new MockSim(island);
    const spot = openSpot(island, grid, new Rng(11));
    const bot = sim.addPlayer(1, spot);
    const item = sim.addLoot('ar', { x: spot.x + 1.2, y: spot.y + 0.05, z: spot.z }, 1);
    item.mag = 20;
    const driver = createBotDriver(sim);
    let picked = false;
    sim.run(driver, 60, () => {
      const inp = sim.last.get(bot.id)!;
      if (inp.actions?.some((a) => a.a === 'pickup' && a.id === item.id)) picked = true;
    });
    expect(picked).toBe(true);
  });
});

describe('combat', () => {
  function duel(difficulty: BotDifficulty, offset: number) {
    const sim = new MockSim(island, difficulty);
    const spot = openSpot(island, grid, new Rng(23));
    const bot = sim.addPlayer(1, spot);
    arm(bot);
    // Enemy ~30 m ahead (bot faces -Z with yaw 0), slightly off-centre but inside the view cone.
    const enemy = sim.addPlayer(2, ground(island, spot.x + offset, spot.z - 30));
    const e1 = sim.eyePos(bot.id), e2 = sim.eyePos(enemy.id);
    expect(lineOfSight(island, e1, e2)).toBe(true);
    return { sim, bot, enemy };
  }

  it('turns toward a visible enemy and fires only after its reaction time', () => {
    const { sim, bot, enemy } = duel('normal', 8);
    const driver = createBotDriver(sim) as BotDriverEx;
    sim.run(driver, 90);
    const rec = sim.inputs.get(bot.id)!;
    const firstFire = rec.find(fired);
    expect(firstFire).toBeDefined();
    // Normal reaction ~0.45 s (randomised +-20 %); detection happens at a think tick >= t0.
    expect(firstFire!.time).toBeGreaterThanOrEqual(0.45 * 0.8 - 1e-6);
    for (const r of rec) if (r.time < 0.45 * 0.8 - 1e-6) expect(fired(r)).toBe(false);
    // Aim is on the enemy.
    const bearing = Math.atan2(-(enemy.pos.x - bot.pos.x), -(enemy.pos.z - bot.pos.z));
    expect(Math.abs(angleDiff(firstFire!.input.yaw, bearing))).toBeLessThan(0.1);
    expect(driver.inspect(bot.id)!.targetId).toBe(enemy.id);
  });

  it('easy bots react slower than hard bots', () => {
    const times: number[] = [];
    for (const d of ['easy', 'hard'] as const) {
      const { sim, bot } = duel(d, 4);
      const driver = createBotDriver(sim);
      sim.run(driver, 120);
      const f = sim.inputs.get(bot.id)!.find(fired);
      expect(f).toBeDefined();
      times.push(f!.time);
    }
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[0]).toBeGreaterThanOrEqual(0.8 * 0.8 - 1e-6);
  });

  it('does not see an enemy behind a wall', () => {
    // Find a solid exterior wall with open ground on both sides.
    let setup: { a: Vec3; b: Vec3 } | null = null;
    for (const box of island.boxes) {
      if (box.kind !== 'wall' || !box.blocksBullets) continue;
      const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
      if (Math.max(sx, sz) < 4 || box.max.y - box.min.y < 2.5) continue;
      const alongX = sx > sz;
      const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
      const nx = alongX ? 0 : 1, nz = alongX ? 1 : 0;
      const a = ground(island, cx - nx * 3, cz - nz * 3);
      const b = ground(island, cx + nx * 3, cz + nz * 3);
      if (grid.flagsAt(a.x, a.z) & NF_BLOCKED || grid.flagsAt(b.x, b.z) & NF_BLOCKED) continue;
      if (Math.abs(a.y - b.y) > 0.6 || box.min.y > Math.min(a.y, b.y) + 0.3) continue;
      const ea = { x: a.x, y: a.y + 1.6, z: a.z }, eb = { x: b.x, y: b.y + 1.6, z: b.z };
      if (lineOfSight(island, ea, eb)) continue;
      setup = { a, b };
      break;
    }
    expect(setup).not.toBeNull();
    const { a, b } = setup!;
    const sim = new MockSim(island, 'hard');
    const bot = sim.addPlayer(1, a);
    arm(bot);
    bot.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z)); // looking straight at the wall / enemy
    const enemy = sim.addPlayer(2, b);
    const driver = createBotDriver(sim) as BotDriverEx;
    sim.run(driver, 90);
    expect(sim.inputs.get(bot.id)!.some(fired)).toBe(false);
    const info = driver.inspect(bot.id)!;
    expect(info.visible).not.toContain(enemy.id);
    expect(info.targetId).toBeNull();
  });
});

describe('support', () => {
  it('low health with no enemies around uses a heal item', () => {
    const sim = new MockSim(island);
    const bot = sim.addPlayer(1, openSpot(island, grid, new Rng(31)));
    bot.health = 30;
    bot.lastAttackerWeapon = 'zone';
    bot.items.bandage = 5;
    bot.items.firstaid = 2;
    const driver = createBotDriver(sim) as BotDriverEx;
    let used: string | null = null;
    sim.run(driver, 60, () => {
      const a = sim.last.get(bot.id)!.actions?.find((x) => x.a === 'use');
      if (a && a.a === 'use' && !used) used = a.item;
    });
    expect(used).not.toBeNull();
    expect(['firstaid', 'bandage', 'medkit']).toContain(used);
    expect(driver.inspect(bot.id)!.goal).toBe('heal');
  });
});

describe('zone', () => {
  it('a bot outside the zone moves toward the safe area', () => {
    const sim = new MockSim(island);
    const spot = openSpot(island, grid, new Rng(41));
    const bot = sim.addPlayer(1, spot);
    // Zone 160 m away, the bot is outside the current (blue) circle.
    const ang = Math.atan2(-spot.z, -spot.x);
    const cx = spot.x + Math.cos(ang) * 160, cz = spot.z + Math.sin(ang) * 160;
    sim.zone = { phase: 2, stage: 'shrinking', cx, cz, r: 120, nx: cx, nz: cz, nr: 60, timer: 30, stageTotal: 60, damagePerSec: 1 };
    const driver = createBotDriver(sim) as BotDriverEx;
    sim.run(driver, 45);
    expect(driver.inspect(bot.id)!.goal).toBe('zone');
    const rec = sim.inputs.get(bot.id)!.slice(-15);
    let sx = 0, sz = 0;
    for (const r of rec) {
      const d = moveDir(r.input);
      sx += d.x;
      sz += d.z;
    }
    const l = Math.hypot(sx, sz);
    expect(l).toBeGreaterThan(0.5);
    const tx = cx - spot.x, tz = cz - spot.z;
    const cos = (sx * tx + sz * tz) / (l * Math.hypot(tx, tz));
    expect(cos).toBeGreaterThan(0.7);
    // With physics the bot actually closes the distance.
    sim.physics = true;
    const d0 = Math.hypot(bot.pos.x - cx, bot.pos.z - cz);
    sim.run(driver, 150);
    expect(Math.hypot(bot.pos.x - cx, bot.pos.z - cz)).toBeLessThan(d0 - 15);
  });
});

describe('navigation', () => {
  /** True if (x, z) at floor height y is inside a box that blocks a standing character. */
  function insideBox(x: number, z: number, y: number): boolean {
    const boxes = island.queryBoxes(x - 0.01, z - 0.01, x + 0.01, z + 0.01, []);
    for (const b of boxes) {
      if (x <= b.min.x || x >= b.max.x || z <= b.min.z || z >= b.max.z) continue;
      if (b.max.y > y + STEP_HEIGHT && b.min.y < y + 1.7) return true;
    }
    return false;
  }

  it('A* path from outside a building to an indoor loot spawn goes through a door gap', () => {
    const planner = new PathPlanner(grid);
    const req = newPathRequest();
    let checked = 0;
    for (const bld of island.buildings) {
      if (checked >= 12) break;
      const spawn = island.lootSpawns.find((s) => s.indoor && s.pos.x > bld.min.x + 0.6 && s.pos.x < bld.max.x - 0.6 &&
        s.pos.z > bld.min.z + 0.6 && s.pos.z < bld.max.z - 0.6 && s.pos.y - island.heightAt(s.pos.x, s.pos.z) < 1.5);
      if (!spawn) continue;
      const sx = bld.min.x - 7, sz = (bld.min.z + bld.max.z) / 2;
      if (grid.flagsAt(sx, sz) & NF_BLOCKED) continue;
      checked++;
      const status = planner.findPathNow(req, sx, sz, spawn.pos.x, spawn.pos.z);
      expect(status).toBe(PATH_DONE);
      expect(req.partial).toBe(false);
      const ex = req.pts[(req.count - 1) * 2], ez = req.pts[(req.count - 1) * 2 + 1];
      expect(Math.hypot(ex - spawn.pos.x, ez - spawn.pos.z)).toBeLessThan(0.6);
      // Sample the whole polyline: never inside a wall / box, and it does enter the footprint.
      let px = sx, pz = sz, entered = false;
      const floor = spawn.pos.y - 0.05;
      for (let i = 0; i < req.count; i++) {
        const qx = req.pts[i * 2], qz = req.pts[i * 2 + 1];
        const n = Math.ceil(Math.hypot(qx - px, qz - pz) / 0.1);
        for (let k = 0; k <= n; k++) {
          const x = px + ((qx - px) * k) / Math.max(1, n), z = pz + ((qz - pz) * k) / Math.max(1, n);
          const inside = x > bld.min.x && x < bld.max.x && z > bld.min.z && z < bld.max.z;
          if (inside) entered = true;
          const y = inside ? floor : island.heightAt(x, z);
          expect(insideBox(x, z, y)).toBe(false);
        }
        px = qx;
        pz = qz;
      }
      expect(entered).toBe(true);

      // The real character controller can follow the path to the loot.
      const body = makePlayer(999, 9, ground(island, sx, sz));
      const intent = createMoveIntent();
      const ev = createMoveEvents();
      let wp = 0;
      for (let tick = 0; tick < 30 * 40 && wp < req.count; tick++) {
        const tx = req.pts[wp * 2], tz = req.pts[wp * 2 + 1];
        const d = Math.hypot(tx - body.pos.x, tz - body.pos.z);
        if (d < (wp === req.count - 1 ? 0.4 : 0.6)) {
          wp++;
          continue;
        }
        intent.yaw = Math.atan2(-(tx - body.pos.x), -(tz - body.pos.z));
        intent.mx = 0;
        intent.mz = Math.min(1, d);
        stepCharacter(body, intent, TICK_DT, island, ev);
      }
      const dist = Math.hypot(body.pos.x - spawn.pos.x, body.pos.z - spawn.pos.z);
      expect(dist).toBeLessThan(INTERACT_RANGE - 1);
      expect(Math.abs(body.pos.y - spawn.pos.y)).toBeLessThan(1);
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('performance', () => {
  it('60 bots cost well under 3 ms per tick on average', () => {
    const sim = new MockSim(island, 'hard');
    sim.physics = true;
    const rng = new Rng(77);
    // Spread squads over the towns (buildings, loot and each other to look at).
    for (let i = 0; i < 60; i++) {
      const town = island.towns[i % island.towns.length];
      let x = 0, z = 0;
      for (let k = 0; k < 50; k++) {
        x = town.x + (rng.next() - 0.5) * town.r * 1.6;
        z = town.z + (rng.next() - 0.5) * town.r * 1.6;
        if (!(grid.flagsAt(x, z) & NF_BLOCKED)) break;
      }
      const p = sim.addPlayer(Math.floor(i / 4), ground(island, x, z));
      p.yaw = rng.next() * Math.PI * 2;
      if (i % 2 === 0) arm(p, i % 4 === 0 ? 'ar' : 'smg');
    }
    for (let i = 0; i < 300; i++) {
      const s = island.lootSpawns[(i * 7) % island.lootSpawns.length];
      sim.addLoot(i % 3 === 0 ? 'ammo_556' : i % 3 === 1 ? 'bandage' : 'vest2', s.pos, i % 3 === 0 ? 30 : 1);
    }
    sim.zone = { phase: 1, stage: 'waiting', cx: 0, cz: 0, r: 700, nx: 40, nz: -30, nr: 320, timer: 60, stageTotal: 100, damagePerSec: 0.4 };
    const driver = createBotDriver(sim) as BotDriverEx;
    // Warm up (lazy nav tiles, first paths).
    sim.run(driver, 60);
    const N = 300;
    let total = 0, worst = 0;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      driver.update(TICK_DT);
      const dt = performance.now() - t0;
      total += dt;
      worst = Math.max(worst, dt);
      sim.step();
    }
    const avg = total / N;
    // eslint-disable-next-line no-console
    console.log(`bots: avg ${avg.toFixed(3)} ms / tick, worst ${worst.toFixed(2)} ms`, driver.stats());
    expect(avg).toBeLessThan(3);
    // Bots actually moved around.
    let moved = 0;
    for (const p of sim.players.values()) if (Math.hypot(p.vel.x, p.vel.z) > 0.5) moved++;
    expect(moved).toBeGreaterThan(10);
  });
});
