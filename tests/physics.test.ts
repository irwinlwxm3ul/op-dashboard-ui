import { describe, expect, it } from 'vitest';
import {
  FREEFALL_DIVE_SPEED, FREEFALL_SPEED, JUMP_VELOCITY, GRAVITY, CHAR_GRAVITY_MUL, MOVE_SPEED, PARACHUTE_DESCENT,
  PLAYER_RADIUS, TICK_DT, EYE_HEIGHT,
} from '../src/shared/constants';
import { Rng } from '../src/shared/rng';
import type {
  CharacterBody, Hitbox, RayHit, RockDef, Stance, SurfaceMaterial, TreeDef, Vec3, World, WorldBox,
} from '../src/shared/types';
import {
  buildHitboxes, canStand, collideCircleXZ, createMoveEvents, createMoveIntent, eyePosition, lineOfSight,
  raycastHitboxes, raycastWorld, rayCapsule, stepCharacter, stepDrop, bodyHeight, PhysicsTuning,
} from '../src/shared/physics';
import type { HitboxPose, MoveEvents, MoveIntent } from '../src/shared/physics';

// ---------------------------------------------------------------------------
// Fake world
// ---------------------------------------------------------------------------

interface FakeWorldOpts {
  size?: number;
  cell?: number;
  height?: (x: number, z: number) => number;
  waterLevel?: number;
  boxes?: { min: Vec3; max: Vec3; blocksBullets?: boolean; material?: SurfaceMaterial }[];
  trees?: { x: number; z: number; r: number; h: number; y?: number }[];
  rocks?: { x: number; z: number; r: number; h: number; y?: number }[];
}

function makeWorld(o: FakeWorldOpts = {}): World {
  const size = o.size ?? 256;
  const cell = o.cell ?? 4;
  const half = size / 2;
  const res = Math.round(size / cell) + 1;
  const hf = o.height ?? (() => 0);
  const heights = new Float32Array(res * res);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) heights[j * res + i] = hf(-half + i * cell, -half + j * cell);
  const heightAt = (x: number, z: number): number => {
    const fx = Math.min(Math.max((x + half) / cell, 0), res - 1.000001);
    const fz = Math.min(Math.max((z + half) / cell, 0), res - 1.000001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h00 = heights[j * res + i], h10 = heights[j * res + i + 1];
    const h01 = heights[(j + 1) * res + i], h11 = heights[(j + 1) * res + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };
  const boxes: WorldBox[] = (o.boxes ?? []).map((b, id) => ({
    id: id + 100, min: { ...b.min }, max: { ...b.max }, kind: 'wall', material: b.material ?? 'concrete', color: 0,
    building: -1, blocksBullets: b.blocksBullets ?? true,
  }));
  const trees: TreeDef[] = (o.trees ?? []).map((t) => ({
    x: t.x, z: t.z, y: t.y ?? heightAt(t.x, t.z), r: t.r, h: t.h, kind: 'pine', scale: 1, rot: 0,
  }));
  const rocks: RockDef[] = (o.rocks ?? []).map((k, i) => ({
    x: k.x, z: k.z, y: k.y ?? heightAt(k.x, k.z), r: k.r, h: k.h, rot: 0, seed: i,
  }));
  const overlaps = (x0: number, z0: number, x1: number, z1: number, a0: number, b0: number, a1: number, b1: number) =>
    x0 <= a1 && x1 >= a0 && z0 <= b1 && z1 >= b0;
  return {
    seed: 1, kind: 'training', size, half, res, cell, heights, surface: new Uint8Array(res * res),
    waterLevel: o.waterLevel ?? -50,
    boxes, buildings: [], trees, rocks, bushes: [], roads: [], towns: [], lootSpawns: [], vehicleSpawns: [],
    training: null,
    heightAt,
    normalAt(x: number, z: number, out: Vec3 = { x: 0, y: 1, z: 0 }): Vec3 {
      const e = 0.25;
      const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
      const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const l = Math.hypot(dx, 1, dz);
      out.x = -dx / l; out.y = 1 / l; out.z = -dz / l;
      return out;
    },
    surfaceAt: () => 'grass',
    groundAt(x: number, z: number, fromY = Infinity): number {
      let g = heightAt(x, z);
      for (const b of boxes) {
        if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= fromY + 0.01 && b.max.y > g) g = b.max.y;
      }
      return g;
    },
    inBounds: (x: number, z: number) => Math.abs(x) <= half && Math.abs(z) <= half,
    queryBoxes(minX, minZ, maxX, maxZ, out) {
      out.length = 0;
      for (const b of boxes) if (overlaps(minX, minZ, maxX, maxZ, b.min.x, b.min.z, b.max.x, b.max.z)) out.push(b);
      return out;
    },
    queryTrees(minX, minZ, maxX, maxZ, out) {
      out.length = 0;
      for (const t of trees) if (overlaps(minX, minZ, maxX, maxZ, t.x - t.r, t.z - t.r, t.x + t.r, t.z + t.r)) out.push(t);
      return out;
    },
    queryRocks(minX, minZ, maxX, maxZ, out) {
      out.length = 0;
      for (const k of rocks) if (overlaps(minX, minZ, maxX, maxZ, k.x - k.r, k.z - k.r, k.x + k.r, k.z + k.r)) out.push(k);
      return out;
    },
  };
}

function makeBody(x = 0, y = 0, z = 0, stance: Stance = 'stand'): CharacterBody {
  return {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, onGround: true, airTime: 0, jumpBuffer: 0, stance, mode: 'ground',
    fallSpeed: 0,
  };
}

function intent(p: Partial<MoveIntent> = {}): MoveIntent {
  return { ...createMoveIntent(0), ...p };
}

/** Run n ticks with a fixed intent; returns events of the last tick and collects all of them. */
function run(body: CharacterBody, world: World, it: MoveIntent, n: number, all?: MoveEvents[]): MoveEvents {
  let ev = createMoveEvents();
  for (let i = 0; i < n; i++) {
    ev = stepCharacter(body, it, TICK_DT, world, createMoveEvents());
    all?.push(ev);
  }
  return ev;
}

const hspeed = (b: CharacterBody) => Math.hypot(b.vel.x, b.vel.z);
const G = GRAVITY * CHAR_GRAVITY_MUL;

// ---------------------------------------------------------------------------
// Character controller
// ---------------------------------------------------------------------------

describe('character controller', () => {
  it('accelerates to walk speed over a few ticks (not instantly) and stops with friction', () => {
    const w = makeWorld();
    const b = makeBody();
    stepCharacter(b, intent({ mz: 1 }), TICK_DT, w);
    expect(hspeed(b)).toBeGreaterThan(0.5);
    expect(hspeed(b)).toBeLessThan(MOVE_SPEED.walk * 0.6);
    run(b, w, intent({ mz: 1 }), 15);
    expect(hspeed(b)).toBeCloseTo(MOVE_SPEED.walk, 5);
    // yaw 0 faces -Z
    expect(b.vel.z).toBeLessThan(0);
    expect(Math.abs(b.vel.x)).toBeLessThan(1e-9);

    stepCharacter(b, intent(), TICK_DT, w);
    const afterOne = hspeed(b);
    expect(afterOne).toBeGreaterThan(0.5);
    expect(afterOne).toBeLessThan(MOVE_SPEED.walk);
    run(b, w, intent(), 15);
    expect(hspeed(b)).toBe(0);
    expect(b.pos.y).toBe(0);
    expect(b.onGround).toBe(true);
  });

  it('sprints only standing and moving forward; stance and modifiers scale speed', () => {
    const w = makeWorld();
    const cases: [Partial<MoveIntent>, Stance, number][] = [
      [{ mz: 1, sprint: true }, 'stand', MOVE_SPEED.sprint],
      [{ mx: 1, sprint: true }, 'stand', MOVE_SPEED.walk],
      [{ mz: 1, sprint: true, walk: true }, 'stand', MOVE_SPEED.slowWalk],
      [{ mz: 1, sprint: true, wantStance: 'crouch' }, 'crouch', MOVE_SPEED.crouch],
      [{ mz: 1, wantStance: 'prone' }, 'prone', MOVE_SPEED.prone],
      [{ mz: 1, downed: true }, 'prone', MOVE_SPEED.downedCrawl],
      [{ mz: 1, speedMul: 0.5 }, 'stand', MOVE_SPEED.walk * 0.5],
    ];
    for (const [p, stance, speed] of cases) {
      const b = makeBody(0, 0, 0, stance);
      run(b, w, intent({ wantStance: stance, ...p }), 30);
      expect(b.stance).toBe(stance);
      expect(hspeed(b)).toBeCloseTo(speed, 4);
    }
  });

  it('cannot pass through a 0.25 m wall even at very high speed', () => {
    const w = makeWorld({ boxes: [{ min: { x: -5, y: 0, z: -10.125 }, max: { x: 5, y: 3, z: -9.875 } }] });
    const b = makeBody();
    run(b, w, intent({ mz: 1, sprint: true, speedMul: 2 }), 90);
    expect(b.pos.z).toBeGreaterThan(-9.875 + PLAYER_RADIUS - 0.01);
    // Absurd velocity (e.g. after a vehicle ejection): still blocked.
    const c = makeBody(0, 0, -5);
    c.vel.z = -80;
    stepCharacter(c, intent({ mz: 1 }), TICK_DT, w);
    expect(c.pos.z).toBeGreaterThan(-9.875 + PLAYER_RADIUS - 0.01);
    // Slides along the wall instead of sticking.
    const d = makeBody(0, 0, -9.875 + PLAYER_RADIUS + 0.01);
    run(d, w, intent({ mz: 1, mx: 1 }), 15);
    expect(d.pos.x).toBeGreaterThan(1);
    expect(d.pos.z).toBeGreaterThan(-9.875 + PLAYER_RADIUS - 0.01);
  });

  it('climbs a staircase of 0.3 m steps and walks back down without leaving the ground', () => {
    const boxes: FakeWorldOpts['boxes'] = [];
    const steps = 10, rise = 0.3, depth = 0.32;
    for (let i = 0; i < steps; i++) {
      const zNear = -2 - i * depth;
      const zFar = i === steps - 1 ? -20 : zNear - depth;
      boxes.push({ min: { x: -1, y: 0, z: zFar }, max: { x: 1, y: (i + 1) * rise, z: zNear } });
    }
    const w = makeWorld({ boxes });
    const b = makeBody();
    const evs: MoveEvents[] = [];
    run(b, w, intent({ mz: 1 }), 90, evs);
    expect(b.pos.y).toBeCloseTo(steps * rise, 5);
    expect(b.pos.z).toBeLessThan(-6);
    expect(evs.some((e) => e.landed)).toBe(false);
    // Down again (yaw PI faces +Z): never airborne, no landing events (no bouncing).
    const down: MoveEvents[] = [];
    for (let i = 0; i < 120; i++) {
      down.push(stepCharacter(b, intent({ mz: 1, yaw: Math.PI }), TICK_DT, w, createMoveEvents()));
      expect(b.onGround).toBe(true);
    }
    expect(down.some((e) => e.landed)).toBe(false);
    expect(b.pos.y).toBe(0);
    expect(b.pos.z).toBeGreaterThan(0);
  });

  it('walks through a door, up an indoor staircase and onto the upper floor', () => {
    const boxes: FakeWorldOpts['boxes'] = [
      { min: { x: -5, y: 0, z: -10 }, max: { x: 5, y: 0.2, z: 0 } }, // ground slab
      { min: { x: -5, y: 0, z: -0.25 }, max: { x: -0.7, y: 6.4, z: 0 } }, // front wall, door gap 1.4 m
      { min: { x: 0.7, y: 0, z: -0.25 }, max: { x: 5, y: 6.4, z: 0 } },
      { min: { x: -0.7, y: 2.4, z: -0.25 }, max: { x: 0.7, y: 6.4, z: 0 } }, // lintel
      { min: { x: -5, y: 0, z: -10 }, max: { x: 5, y: 6.4, z: -9.75 } }, // back wall
      { min: { x: -5, y: 0, z: -10 }, max: { x: -4.75, y: 6.4, z: 0 } }, // side walls
      { min: { x: 4.75, y: 0, z: -10 }, max: { x: 5, y: 6.4, z: 0 } },
      { min: { x: -4.75, y: 3.2, z: -9.75 }, max: { x: 2, y: 3.4, z: -0.25 } }, // upper slab (stairwell open)
      { min: { x: 2, y: 3.2, z: -4 }, max: { x: 4.75, y: 3.4, z: -0.25 } },
    ];
    for (let i = 0; i < 11; i++) {
      // 11 steps of 0.2909 m rise from the slab (0.2) to the upper floor (3.4), 0.5 m deep, toward -Z.
      boxes.push({ min: { x: 2, y: 0, z: -4.5 - i * 0.5 }, max: { x: 4.75, y: 0.2 + (i + 1) * (3.2 / 11), z: -4 - i * 0.5 } });
    }
    const w = makeWorld({ boxes });
    const b = makeBody(0, 0, 3);
    const leg = (yaw: number, ticks: number) => run(b, w, intent({ mz: 1, yaw }), ticks);
    leg(0, 40); // through the door
    expect(b.pos.z).toBeLessThan(-1.5);
    expect(b.pos.y).toBeCloseTo(0.2, 6);
    leg(-Math.PI / 2, 22); // +X to the stairs
    expect(b.pos.x).toBeGreaterThan(2.5);
    expect(b.pos.x).toBeLessThan(4.4);
    leg(0, 50); // up the stairs (-Z)
    expect(b.pos.y).toBeCloseTo(3.4, 6);
    leg(Math.PI / 2, 25); // -X onto the upper floor
    expect(b.pos.x).toBeLessThan(1);
    expect(b.pos.y).toBeCloseTo(3.4, 6);
    expect(b.onGround).toBe(true);
    // Upstairs there is room to jump; downstairs the upper slab is the ceiling.
    expect(canStand(w, b.pos, 'stand')).toBe(true);
  });

  it('cannot step onto a 0.8 m box but steps onto a 0.4 m one', () => {
    const w = makeWorld({ boxes: [{ min: { x: -1, y: 0, z: -3 }, max: { x: 1, y: 0.8, z: -2 } }] });
    const b = makeBody();
    run(b, w, intent({ mz: 1, sprint: true }), 60);
    expect(b.pos.y).toBe(0);
    expect(b.pos.z).toBeGreaterThan(-2 + PLAYER_RADIUS - 0.01);

    const w2 = makeWorld({ boxes: [{ min: { x: -1, y: 0, z: -3 }, max: { x: 1, y: 0.4, z: -2 } }] });
    const c = makeBody();
    run(c, w2, intent({ mz: 1 }), 18);
    expect(c.pos.y).toBeCloseTo(0.4, 6);
  });

  it('jumps to about v^2 / 2g and lands with a landing event', () => {
    const w = makeWorld();
    const b = makeBody();
    const first = stepCharacter(b, intent({ jumpPressed: true }), TICK_DT, w);
    expect(first.jumped).toBe(true);
    let maxY = b.pos.y, landed: MoveEvents | null = null;
    for (let i = 0; i < 60 && !landed; i++) {
      const e = stepCharacter(b, intent(), TICK_DT, w);
      maxY = Math.max(maxY, b.pos.y);
      if (e.landed) landed = e;
    }
    const expected = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * G);
    expect(maxY).toBeGreaterThan(expected - 0.03);
    expect(maxY).toBeLessThanOrEqual(expected + 1e-6);
    expect(landed).not.toBeNull();
    expect(landed!.landSpeed).toBeGreaterThan(JUMP_VELOCITY * 0.9);
    expect(landed!.landSpeed).toBeLessThan(JUMP_VELOCITY * 1.15);
    expect(b.pos.y).toBe(0);
    expect(b.onGround).toBe(true);
  });

  it('does not jump while prone or downed, and stands up when jumping from a crouch', () => {
    const w = makeWorld();
    const p = makeBody(0, 0, 0, 'prone');
    expect(stepCharacter(p, intent({ wantStance: 'prone', jumpPressed: true }), TICK_DT, w).jumped).toBe(false);
    const d = makeBody(0, 0, 0, 'prone');
    expect(stepCharacter(d, intent({ downed: true, jumpPressed: true }), TICK_DT, w).jumped).toBe(false);
    const c = makeBody(0, 0, 0, 'crouch');
    const e = stepCharacter(c, intent({ wantStance: 'crouch', jumpPressed: true }), TICK_DT, w);
    expect(e.jumped).toBe(true);
    expect(c.stance).toBe('stand');
  });

  it('allows a jump shortly after walking off a ledge (coyote time) but not later', () => {
    const w = makeWorld({ boxes: [{ min: { x: -5, y: 0, z: -1 }, max: { x: 5, y: 3, z: 5 } }] });
    const tryJumpAfter = (ticksAirborne: number): boolean => {
      const b = makeBody(0, 3, 0);
      let n = 0;
      while (b.onGround && n++ < 200) stepCharacter(b, intent({ mz: 1 }), TICK_DT, w);
      expect(b.onGround).toBe(false);
      for (let i = 1; i < ticksAirborne; i++) stepCharacter(b, intent({ mz: 1 }), TICK_DT, w);
      return stepCharacter(b, intent({ mz: 1, jumpPressed: true }), TICK_DT, w).jumped;
    };
    expect(tryJumpAfter(1)).toBe(true);
    expect(tryJumpAfter(3)).toBe(true);
    expect(tryJumpAfter(6)).toBe(false);
    // No double jump inside the coyote window after a real jump.
    const b = makeBody();
    expect(stepCharacter(b, intent({ jumpPressed: true }), TICK_DT, w).jumped).toBe(true);
    expect(stepCharacter(b, intent({ jumpPressed: true }), TICK_DT, w).jumped).toBe(false);
  });

  it('buffers a jump pressed just before landing', () => {
    const w = makeWorld();
    const ticksToLand = (() => {
      const b = makeBody(0, 1.2, 0);
      b.onGround = false;
      for (let i = 1; i < 100; i++) if (stepCharacter(b, intent(), TICK_DT, w).landed) return i;
      return -1;
    })();
    expect(ticksToLand).toBeGreaterThan(5);
    const jumpWithLead = (lead: number): boolean => {
      const b = makeBody(0, 1.2, 0);
      b.onGround = false;
      let jumped = false;
      for (let i = 1; i <= ticksToLand + 3; i++) {
        const e = stepCharacter(b, intent({ jumpPressed: i === ticksToLand - lead }), TICK_DT, w);
        if (e.jumped) jumped = true;
      }
      return jumped;
    };
    expect(jumpWithLead(0)).toBe(true);
    expect(jumpWithLead(2)).toBe(true);
    expect(jumpWithLead(5)).toBe(false);
  });

  it('blocks standing up under a low ceiling and reports it', () => {
    const w = makeWorld({ boxes: [{ min: { x: -2, y: 1.5, z: -2 }, max: { x: 2, y: 1.8, z: 2 } }] });
    const b = makeBody(0, 0, 0, 'crouch');
    const e = stepCharacter(b, intent({ wantStance: 'stand' }), TICK_DT, w);
    expect(e.stanceBlocked).toBe(true);
    expect(b.stance).toBe('crouch');
    expect(canStand(w, b.pos, 'stand')).toBe(false);
    expect(canStand(w, b.pos, 'crouch')).toBe(true);
    // Prone -> stand gets as far as crouch.
    const p = makeBody(0, 0, 0, 'prone');
    expect(stepCharacter(p, intent({ wantStance: 'stand' }), TICK_DT, w).stanceBlocked).toBe(true);
    expect(p.stance).toBe('crouch');
    // Outside the cover it stands.
    const o = makeBody(5, 0, 0, 'crouch');
    expect(stepCharacter(o, intent({ wantStance: 'stand' }), TICK_DT, w).stanceBlocked).toBe(false);
    expect(o.stance).toBe('stand');
  });

  it('stops upward motion at ceilings', () => {
    const w = makeWorld({ boxes: [{ min: { x: -2, y: 2.2, z: -2 }, max: { x: 2, y: 2.5, z: 2 } }] });
    const b = makeBody();
    stepCharacter(b, intent({ jumpPressed: true }), TICK_DT, w);
    let maxTop = 0;
    for (let i = 0; i < 40; i++) {
      stepCharacter(b, intent(), TICK_DT, w);
      maxTop = Math.max(maxTop, b.pos.y + bodyHeight(b.stance));
    }
    expect(maxTop).toBeLessThanOrEqual(2.2 + 1e-6);
    expect(b.onGround).toBe(true);
  });

  it('collides with tree trunks and rocks', () => {
    const w = makeWorld({
      trees: [{ x: 0, z: -5, r: 0.3, h: 10 }],
      rocks: [{ x: 3, z: -5, r: 1, h: 1.5 }],
    });
    const b = makeBody();
    run(b, w, intent({ mz: 1 }), 60);
    expect(Math.hypot(b.pos.x, b.pos.z + 5)).toBeGreaterThan(0.3 + PLAYER_RADIUS - 0.01);
    const c = makeBody(3, 0, 0);
    run(c, w, intent({ mz: 1 }), 60);
    expect(Math.hypot(c.pos.x - 3, c.pos.z + 5)).toBeGreaterThan(1 + PLAYER_RADIUS - 0.01);
  });

  it('cannot walk up slopes steeper than the max slope', () => {
    // Flat until z = -10, then a 60 degree wall of terrain rising toward -Z.
    const slope = Math.tan((60 * Math.PI) / 180);
    const w = makeWorld({ cell: 1, height: (_x, z) => (z < -10 ? (-10 - z) * slope : 0) });
    const b = makeBody();
    run(b, w, intent({ mz: 1, sprint: true }), 150);
    expect(b.pos.y).toBeLessThan(1);
    // A gentle 20 degree slope is walkable.
    const gentle = Math.tan((20 * Math.PI) / 180);
    const w2 = makeWorld({ cell: 1, height: (_x, z) => (z < -2 ? (-2 - z) * gentle : 0) });
    const c = makeBody();
    run(c, w2, intent({ mz: 1 }), 90);
    expect(c.pos.y).toBeGreaterThan(3);
    expect(c.onGround).toBe(true);
  });

  it('slides down terrain that is too steep to stand on', () => {
    // 60 degree slope descending toward +Z down to a flat valley floor at z = 10.
    const slope = Math.tan((60 * Math.PI) / 180);
    const w = makeWorld({ cell: 1, height: (_x, z) => (z < 10 ? (10 - z) * slope : 0) });
    const b = makeBody(0, w.heightAt(0, 5), 5);
    const evs: MoveEvents[] = [];
    stepCharacter(b, intent(), TICK_DT, w);
    expect(b.onGround).toBe(false);
    run(b, w, intent(), 120, evs);
    expect(b.pos.z).toBeGreaterThan(10);
    expect(b.pos.y).toBeCloseTo(0, 4);
    expect(b.onGround).toBe(true);
    // Slide friction keeps the arrival below fall-damage speeds.
    const landing = evs.find((e) => e.landed)!;
    expect(landing.landSpeed).toBeLessThan(13);
    // It never sank into the slope.
    expect(b.pos.y).toBeGreaterThanOrEqual(w.heightAt(b.pos.x, b.pos.z) - 1e-6);
  });

  it('switches to swimming in deep water and back to walking in the shallows', () => {
    // Beach sloping into the sea toward +X; water level 0, depth 1.3 at x = 13.
    const w = makeWorld({ waterLevel: 0, height: (x) => 0 - x * 0.1 });
    const b = makeBody(0, 0, 0);
    const towardSea = intent({ mz: 1, yaw: -Math.PI / 2 });
    let entered = false;
    for (let i = 0; i < 400 && b.mode === 'ground'; i++) {
      if (stepCharacter(b, towardSea, TICK_DT, w).enteredWater) entered = true;
    }
    expect(b.mode).toBe('swim');
    expect(entered).toBe(true);
    expect(b.pos.x).toBeGreaterThan(12.9);
    run(b, w, intent({ mz: 1, yaw: -Math.PI / 2, wantStance: 'crouch', jumpPressed: true }), 120);
    expect(b.mode).toBe('swim');
    expect(b.stance).toBe('stand');
    expect(b.pos.y).toBeCloseTo(-PhysicsTuning.SWIM_FEET_DEPTH, 2);
    expect(hspeed(b)).toBeCloseTo(MOVE_SPEED.swim, 3);
    // Back to the beach.
    for (let i = 0; i < 600 && b.mode === 'swim'; i++) stepCharacter(b, intent({ mz: 1, yaw: Math.PI / 2 }), TICK_DT, w);
    expect(b.mode).toBe('ground');
    expect(w.waterLevel - w.heightAt(b.pos.x, b.pos.z)).toBeLessThan(PhysicsTuning.SWIM_EXIT_DEPTH + 0.05);
    run(b, w, intent({ mz: 1, yaw: Math.PI / 2 }), 60);
    expect(b.onGround).toBe(true);
    expect(b.pos.y).toBeCloseTo(w.heightAt(b.pos.x, b.pos.z), 4);
  });

  it('falling into deep water swims without a hard landing', () => {
    const w = makeWorld({ waterLevel: 0, height: () => -10 });
    const b = makeBody(0, 8, 0);
    b.onGround = false;
    const evs: MoveEvents[] = [];
    run(b, w, intent(), 120, evs);
    expect(b.mode).toBe('swim');
    const landing = evs.find((e) => e.landed);
    expect(landing?.enteredWater).toBe(true);
    expect(landing?.landSpeed).toBe(0);
    expect(b.pos.y).toBeCloseTo(-PhysicsTuning.SWIM_FEET_DEPTH, 2);
  });

  it('clamps to map bounds', () => {
    const w = makeWorld({ size: 64 });
    const b = makeBody(30, 0, 0);
    run(b, w, intent({ mz: 1, yaw: -Math.PI / 2, sprint: true }), 120);
    expect(b.pos.x).toBeLessThanOrEqual(w.half - 1);
  });

  it('is deterministic (same inputs give identical bodies)', () => {
    const mk = () => makeWorld({
      height: (x, z) => Math.sin(x * 0.05) * 2 + Math.cos(z * 0.07) * 1.5,
      boxes: [
        { min: { x: -3, y: -5, z: -12 }, max: { x: 3, y: 2.5, z: -11.8 } },
        { min: { x: 4, y: -5, z: -8 }, max: { x: 6, y: 0.9, z: -6 } },
      ],
      trees: [{ x: -2, z: -6, r: 0.3, h: 8 }],
      rocks: [{ x: 2, z: -3, r: 0.8, h: 1 }],
    });
    const sim = () => {
      const w = mk();
      const b = makeBody(0, w.heightAt(0, 0), 0);
      const rng = new Rng(42);
      const trace: number[] = [];
      for (let i = 0; i < 600; i++) {
        const it = intent({
          mx: rng.range(-1, 1) * 0.7, mz: rng.range(-0.2, 1) * 0.7, yaw: rng.range(-Math.PI, Math.PI),
          sprint: rng.chance(0.5), jumpPressed: rng.chance(0.05),
          wantStance: rng.pick(['stand', 'stand', 'crouch', 'prone'] as Stance[]),
        });
        stepCharacter(b, it, TICK_DT, w);
        trace.push(b.pos.x, b.pos.y, b.pos.z);
      }
      return { b, trace };
    };
    const a = sim(), c = sim();
    expect(c.b).toEqual(a.b);
    expect(c.trace).toEqual(a.trace);
  });
});

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

describe('freefall and parachute', () => {
  const dropBody = (y: number): CharacterBody => ({ ...makeBody(0, y, 0), onGround: false, mode: 'freefall' });

  it('freefall eases to terminal speed and dives faster', () => {
    const w = makeWorld({ size: 4096, cell: 64 });
    const b = dropBody(5000);
    stepDrop(b, intent(), TICK_DT, w, false);
    expect(-b.vel.y).toBeLessThan(2); // speed builds up, no instant snap
    for (let i = 0; i < 300; i++) stepDrop(b, intent(), TICK_DT, w, false);
    expect(-b.vel.y).toBeCloseTo(FREEFALL_SPEED, 0);
    expect(b.mode).toBe('freefall');
    for (let i = 0; i < 300; i++) stepDrop(b, intent({ mz: 1, dive: 1 }), TICK_DT, w, false);
    expect(-b.vel.y).toBeCloseTo(FREEFALL_DIVE_SPEED, 0);
    // Diving also moves forward (yaw 0 -> -Z).
    expect(b.vel.z).toBeLessThan(-20);
  });

  it('parachute descends at the nominal / dive / flare speeds', () => {
    const w = makeWorld();
    const settle = (mz: number): CharacterBody => {
      const b = dropBody(5000);
      b.vel.y = -FREEFALL_SPEED;
      for (let i = 0; i < 300; i++) stepDrop(b, intent({ mz, dive: mz }), TICK_DT, w, true);
      expect(b.mode).toBe('parachute');
      return b;
    };
    const n = settle(0), f = settle(1), s = settle(-1);
    expect(-n.vel.y).toBeCloseTo(PARACHUTE_DESCENT, 1);
    expect(-f.vel.y).toBeCloseTo(PhysicsTuning.PARACHUTE_DIVE_DESCENT, 1);
    expect(-s.vel.y).toBeCloseTo(PhysicsTuning.PARACHUTE_FLARE_DESCENT, 1);
    // Constant forward drift, faster with forward input, slower with back input.
    expect(-n.vel.z).toBeGreaterThan(2);
    expect(-f.vel.z).toBeGreaterThan(-n.vel.z);
    expect(-s.vel.z).toBeLessThan(-n.vel.z);
  });

  it('lands on a roof box and hands over to ground mode', () => {
    const w = makeWorld({ boxes: [{ min: { x: -6, y: 0, z: -60 }, max: { x: 6, y: 6, z: 6 } }] });
    const b = dropBody(40);
    b.mode = 'parachute';
    b.vel.y = -6;
    let ev: MoveEvents | null = null;
    for (let i = 0; i < 400; i++) {
      const e = stepDrop(b, intent(), TICK_DT, w, true);
      if (e.landed) { ev = e; break; }
    }
    expect(ev).not.toBeNull();
    expect(ev!.landSpeed).toBeGreaterThan(4);
    expect(ev!.landSpeed).toBeLessThan(8);
    expect(b.mode).toBe('ground');
    expect(b.onGround).toBe(true);
    expect(b.vel.y).toBe(0);
    expect(b.pos.y).toBe(6);
    // The ground controller takes it from here.
    run(b, w, intent(), 30);
    expect(b.pos.y).toBe(6);
  });

  it('splashes into deep water and starts swimming', () => {
    const w = makeWorld({ waterLevel: 0, height: () => -20 });
    const b = dropBody(30);
    b.mode = 'parachute';
    b.vel.y = -6;
    let ev: MoveEvents | null = null;
    for (let i = 0; i < 400 && !ev; i++) {
      const e = stepDrop(b, intent(), TICK_DT, w, true);
      if (e.landed) ev = e;
    }
    expect(ev?.enteredWater).toBe(true);
    expect(b.mode).toBe('swim');
  });

  it('clamps to map bounds', () => {
    const w = makeWorld({ size: 64 });
    const b = dropBody(200);
    b.vel.x = 70;
    for (let i = 0; i < 100; i++) stepDrop(b, intent(), TICK_DT, w, false);
    expect(b.pos.x).toBeLessThanOrEqual(w.half - 1);
  });
});

// ---------------------------------------------------------------------------
// Eye
// ---------------------------------------------------------------------------

describe('eyePosition', () => {
  it('uses stance eye heights, seated height and lean offsets', () => {
    const pos = { x: 1, y: 2, z: 3 };
    expect(eyePosition({ pos, stance: 'stand', mode: 'ground' }, 0, 0)).toEqual({ x: 1, y: 2 + EYE_HEIGHT.stand, z: 3 });
    expect(eyePosition({ pos, stance: 'crouch', mode: 'ground' }, 0, 0).y).toBeCloseTo(2 + EYE_HEIGHT.crouch, 9);
    expect(eyePosition({ pos, stance: 'prone', mode: 'ground' }, 0, 0).y).toBeCloseTo(2 + EYE_HEIGHT.prone, 9);
    expect(eyePosition({ pos, stance: 'crouch', mode: 'vehicle' }, 0, 0).y).toBeCloseTo(3.1, 9);
    expect(eyePosition({ pos, stance: 'crouch', mode: 'parachute' }, 0, 0).y).toBeCloseTo(2 + EYE_HEIGHT.stand, 9);
    const leanR = eyePosition({ pos, stance: 'stand', mode: 'ground' }, 1, 0);
    expect(leanR.x).toBeCloseTo(1.35, 9); // right(0) = +X
    expect(leanR.y).toBeCloseTo(2 + EYE_HEIGHT.stand - 0.05, 9);
    const leanL = eyePosition({ pos, stance: 'stand', mode: 'ground' }, -1, Math.PI / 2);
    expect(leanL.z).toBeCloseTo(3 + 0.35, 9); // right(PI/2) = -Z
  });
});

// ---------------------------------------------------------------------------
// Raycasts
// ---------------------------------------------------------------------------

describe('raycastWorld / lineOfSight', () => {
  const dir = (x: number, y: number, z: number): Vec3 => {
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
  };

  it('returns the nearest of terrain, boxes and trees', () => {
    const w = makeWorld({
      boxes: [{ min: { x: -2, y: 0, z: -20.2 }, max: { x: 2, y: 3, z: -20 }, material: 'wood' }],
      trees: [{ x: 0, z: -10, r: 0.4, h: 10 }],
    });
    const o = { x: 0, y: 1.5, z: 0 };
    const hit = raycastWorld(w, o, dir(0, 0, -1), 100)!;
    expect(hit.kind).toBe('tree');
    expect(hit.dist).toBeCloseTo(9.6, 6);
    expect(hit.normal.z).toBeCloseTo(1, 6);
    expect(hit.material).toBe('wood');

    const hb = raycastWorld(w, { x: 1.5, y: 1.5, z: 0 }, dir(0, 0, -1), 100)!;
    expect(hb.kind).toBe('box');
    expect(hb.dist).toBeCloseTo(20, 6);
    expect(hb.id).toBe(100);
    expect(hb.normal).toEqual({ x: 0, y: 0, z: 1 });

    const ht = raycastWorld(w, { x: 5, y: 2, z: 0 }, dir(0, -1, -1), 100)!;
    expect(ht.kind).toBe('terrain');
    expect(ht.dist).toBeCloseTo(2 * Math.SQRT2, 3);
    expect(ht.point.y).toBeCloseTo(0, 3);
    expect(ht.normal.y).toBeCloseTo(1, 6);

    // Out of range and misses.
    expect(raycastWorld(w, o, dir(0, 0, -1), 5)).toBeNull();
    expect(raycastWorld(w, o, dir(0, 1, 0), 500)).toBeNull();

    // Fills `out` in place.
    const out: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, kind: 'water', material: 'water' };
    expect(raycastWorld(w, o, dir(0, 0, -1), 100, out)).toBe(out);
    expect(out.kind).toBe('tree');
  });

  it('ignores boxes that do not block bullets', () => {
    const w = makeWorld({ boxes: [{ min: { x: -2, y: 0, z: -10.2 }, max: { x: 2, y: 3, z: -10 }, blocksBullets: false }] });
    expect(raycastWorld(w, { x: 0, y: 1, z: 0 }, dir(0, 0, -1), 50)).toBeNull();
  });

  it('hits rocks', () => {
    const w = makeWorld({ rocks: [{ x: 0, z: -10, r: 2, h: 1.5 }] });
    const hit = raycastWorld(w, { x: 0, y: 0.5, z: 0 }, dir(0, 0, -1), 50)!;
    expect(hit.kind).toBe('rock');
    expect(hit.dist).toBeGreaterThan(8);
    expect(hit.dist).toBeLessThan(8.3);
    expect(hit.material).toBe('rock');
  });

  it('matches a brute-force terrain intersection on hilly terrain', () => {
    const hf = (x: number, z: number) => 8 * Math.sin(x * 0.04) * Math.cos(z * 0.05) + 3 * Math.sin(x * 0.13 + z * 0.09);
    const w = makeWorld({ size: 512, height: hf });
    const rng = new Rng(7);
    let tested = 0;
    for (let i = 0; i < 200; i++) {
      const o = { x: rng.range(-200, 200), y: 0, z: rng.range(-200, 200) };
      o.y = w.heightAt(o.x, o.z) + rng.range(1, 30);
      const d = dir(rng.range(-1, 1), rng.range(-0.6, 0.05), rng.range(-1, 1));
      const hit = raycastWorld(w, o, d, 300);
      // Brute force at 5 cm resolution: first point below the terrain, and first point clearly
      // (> 2 cm) below it. The march may skip a grazing dip of a few millimetres, nothing more.
      let tAny = -1, tDeep = -1;
      for (let t = 0; t <= 300; t += 0.05) {
        const x = o.x + d.x * t, z = o.z + d.z * t;
        if (Math.abs(x) > w.half || Math.abs(z) > w.half) break;
        const f = o.y + d.y * t - w.heightAt(x, z);
        if (f < 0 && tAny < 0) tAny = t;
        if (f < -0.02) { tDeep = t; break; }
      }
      if (tAny < 0) {
        expect(hit).toBeNull();
      } else if (tDeep >= 0) {
        tested++;
        expect(hit).not.toBeNull();
        expect(hit!.kind).toBe('terrain');
        expect(hit!.dist).toBeGreaterThan(tAny - 0.06);
        expect(hit!.dist).toBeLessThan(tDeep + 0.06);
        expect(hit!.point.y).toBeCloseTo(w.heightAt(hit!.point.x, hit!.point.z), 2);
      }
    }
    expect(tested).toBeGreaterThan(50);
  });

  it('hits the water surface but line of sight ignores water', () => {
    const w = makeWorld({ waterLevel: 0, height: () => -5 });
    const a = { x: 0, y: 2, z: 0 }, b = { x: 0, y: -1, z: -6 };
    const hit = raycastWorld(w, a, dir(0, -2, -4), 50)!;
    expect(hit.kind).toBe('water');
    expect(hit.point.y).toBeCloseTo(0, 9);
    expect(hit.dist).toBeCloseTo(Math.hypot(2, 4), 6);
    expect(lineOfSight(w, a, b)).toBe(true);
  });

  it('lineOfSight is blocked by walls and terrain', () => {
    const w = makeWorld({
      boxes: [{ min: { x: -2, y: 0, z: -10.2 }, max: { x: 2, y: 3, z: -10 } }],
      height: (x) => (x > 40 && x < 50 ? 6 : 0),
    });
    const eye = { x: 0, y: 1.6, z: 0 };
    expect(lineOfSight(w, eye, { x: 0, y: 1.6, z: -20 })).toBe(false);
    expect(lineOfSight(w, eye, { x: 0, y: 5.5, z: -20 })).toBe(true);
    expect(lineOfSight(w, eye, { x: 5, y: 1.6, z: -20 })).toBe(true);
    expect(lineOfSight(w, eye, { x: 80, y: 1.6, z: 0 })).toBe(false);
    // Target resting on the ground is visible.
    expect(lineOfSight(w, eye, { x: 6, y: 0, z: 6 })).toBe(true);
    expect(lineOfSight(w, eye, eye)).toBe(true);
  });

  it('is fast on a typical island-sized world', () => {
    const rng = new Rng(3);
    const boxes: FakeWorldOpts['boxes'] = [];
    for (let i = 0; i < 1500; i++) {
      const x = rng.range(-480, 480), z = rng.range(-480, 480), sx = rng.range(0.2, 8), sz = rng.range(0.2, 8);
      boxes.push({ min: { x, y: 0, z }, max: { x: x + sx, y: rng.range(1, 6), z: z + sz } });
    }
    const trees: FakeWorldOpts['trees'] = [];
    for (let i = 0; i < 4000; i++) trees.push({ x: rng.range(-500, 500), z: rng.range(-500, 500), r: 0.3, h: rng.range(6, 14) });
    const rocks: FakeWorldOpts['rocks'] = [];
    for (let i = 0; i < 1200; i++) rocks.push({ x: rng.range(-500, 500), z: rng.range(-500, 500), r: rng.range(0.5, 2), h: rng.range(0.4, 1.5) });
    const w = makeWorld({
      size: 1024, cell: 4, boxes, trees, rocks,
      height: (x, z) => 12 * Math.sin(x * 0.01) * Math.cos(z * 0.012) + 4 * Math.sin(x * 0.05 + z * 0.03),
    });
    const pairs: [Vec3, Vec3][] = [];
    for (let i = 0; i < 2000; i++) {
      const ax = rng.range(-400, 400), az = rng.range(-400, 400), ang = rng.range(0, Math.PI * 2);
      const bx = ax + Math.cos(ang) * 100, bz = az + Math.sin(ang) * 100;
      pairs.push([
        { x: ax, y: w.heightAt(ax, az) + 1.6, z: az },
        { x: bx, y: w.heightAt(bx, bz) + 1.6, z: bz },
      ]);
    }
    lineOfSight(w, pairs[0][0], pairs[0][1]); // build the acceleration grid
    const hit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, kind: 'terrain', material: 'grass' };
    const d = { x: 0, y: 0, z: 0 };
    // CPU time (not wall clock) so the budget check is robust on a loaded machine.
    const cpuUs = () => { const u = process.cpuUsage(); return u.user + u.system; };
    let t0 = cpuUs();
    for (let rep = 0; rep < 5; rep++) for (const [a, b] of pairs) lineOfSight(w, a, b);
    const losUs = (cpuUs() - t0) / (pairs.length * 5);
    t0 = cpuUs();
    for (let rep = 0; rep < 5; rep++) {
      for (const [a, b] of pairs) {
        const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        d.x = (b.x - a.x) / l; d.y = (b.y - a.y) / l; d.z = (b.z - a.z) / l;
        raycastWorld(w, a, d, 1200, hit);
      }
    }
    const castUs = (cpuUs() - t0) / (pairs.length * 5);
    expect(losUs).toBeLessThan(50);
    expect(castUs).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// Hitboxes
// ---------------------------------------------------------------------------

describe('hitboxes', () => {
  const pose = (p: Partial<HitboxPose> = {}): HitboxPose => ({
    pos: { x: 0, y: 0, z: 0 }, yaw: 0, stance: 'stand', life: 'alive', mode: 'ground', lean: 0, ...p,
  });

  it('rayCapsule is exact against brute-force sampling', () => {
    const rng = new Rng(11);
    const segDist2 = (p: Vec3, a: Vec3, b: Vec3): number => {
      const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
      const l2 = bx * bx + by * by + bz * bz;
      let s = l2 > 0 ? ((p.x - a.x) * bx + (p.y - a.y) * by + (p.z - a.z) * bz) / l2 : 0;
      s = Math.max(0, Math.min(1, s));
      const dx = p.x - a.x - bx * s, dy = p.y - a.y - by * s, dz = p.z - a.z - bz * s;
      return dx * dx + dy * dy + dz * dz;
    };
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const a = { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const b = i % 10 === 0 ? { ...a } : { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const r = rng.range(0.05, 0.6);
      const o = { x: rng.range(-4, 4), y: rng.range(-4, 4), z: rng.range(-4, 4) };
      const target = { x: rng.range(-1, 1) - o.x, y: rng.range(-1, 1) - o.y, z: rng.range(-1, 1) - o.z };
      const l = Math.hypot(target.x, target.y, target.z);
      const d = { x: target.x / l, y: target.y / l, z: target.z / l };
      const t = rayCapsule(o, d, a, b, r, 20);
      const step = 0.0005;
      let tb = -1;
      const p = { x: 0, y: 0, z: 0 };
      for (let s = 0; s <= 20; s += step) {
        p.x = o.x + d.x * s; p.y = o.y + d.y * s; p.z = o.z + d.z * s;
        if (segDist2(p, a, b) <= r * r) { tb = s; break; }
      }
      if (tb < 0) {
        expect(t).toBe(-1);
      } else if (t < 0) {
        // Only a grazing ray may be missed by the analytic test: closest approach == r.
        expect(tb).toBeGreaterThan(0);
      } else {
        hits++;
        expect(Math.abs(t - tb)).toBeLessThan(step * 1.5);
      }
    }
    expect(hits).toBeGreaterThan(60);
    // Origin inside -> 0; maxDist respected.
    expect(rayCapsule({ x: 0, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.3, 10)).toBe(0);
    expect(rayCapsule({ x: -5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.3, 4)).toBe(-1);
    expect(rayCapsule({ x: -5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.3, 10)).toBeCloseTo(4.7, 9);
  });

  it('classifies head, body and limb hits on a standing player', () => {
    const boxes = buildHitboxes(pose());
    expect(boxes.length).toBeGreaterThanOrEqual(7);
    // Player faces -Z; shoot from the front.
    const shoot = (y: number, x = 0) => raycastHitboxes({ x, y, z: -20 }, { x: 0, y: 0, z: 1 }, 100, boxes);
    expect(shoot(1.65)?.part).toBe('head');
    expect(shoot(1.25)?.part).toBe('body');
    expect(shoot(0.4, 0.11)?.part).toBe('limb');
    expect(shoot(2.2)).toBeNull();
    const h = shoot(1.65)!;
    expect(h.t).toBeGreaterThan(19.7);
    expect(h.t).toBeLessThan(20);
    // Head shot from behind and from above.
    expect(raycastHitboxes({ x: 0, y: 1.65, z: 20 }, { x: 0, y: 0, z: -1 }, 100, boxes)?.part).toBe('head');
    expect(raycastHitboxes({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 100, boxes)?.part).toBe('head');
  });

  it('places the head at the eye for every stance and lean', () => {
    for (const stance of ['stand', 'crouch', 'prone'] as Stance[]) {
      for (const lean of [-1, 0, 1]) {
        for (const yaw of [0, 1.1, -2.5]) {
          const p = pose({ pos: { x: 3, y: 1, z: -2 }, stance, lean, yaw });
          const head = buildHitboxes(p).find((b) => b.part === 'head')!;
          const eye = eyePosition({ pos: p.pos, stance, mode: 'ground' }, lean, yaw);
          expect(Math.hypot(head.a.x - eye.x, head.a.y - eye.y, head.a.z - eye.z)).toBeLessThan(head.r);
        }
      }
    }
  });

  it('prone and downed hitboxes lie horizontally along the facing direction', () => {
    for (const p of [pose({ stance: 'prone', yaw: 0.7 }), pose({ stance: 'stand', life: 'downed', yaw: 0.7 })]) {
      const boxes = buildHitboxes(p);
      const fx = -Math.sin(0.7), fz = -Math.cos(0.7);
      let minY = Infinity, maxY = -Infinity, minF = Infinity, maxF = -Infinity;
      for (const b of boxes) {
        for (const q of [b.a, b.b]) {
          minY = Math.min(minY, q.y - b.r); maxY = Math.max(maxY, q.y + b.r);
          const f = q.x * fx + q.z * fz;
          minF = Math.min(minF, f - b.r); maxF = Math.max(maxF, f + b.r);
        }
      }
      expect(minY).toBeGreaterThanOrEqual(-0.01);
      expect(maxY).toBeLessThanOrEqual(0.6);
      expect(maxF - minF).toBeGreaterThan(1.5);
      const head = boxes.find((b) => b.part === 'head')!;
      expect(head.a.x * fx + head.a.z * fz).toBeGreaterThan(0.2);
      // A shot along the ground from the side at 1 m height misses.
      expect(raycastHitboxes({ x: -10, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 100, boxes)).toBeNull();
    }
  });

  it('crouch is lower, lean shifts the upper body, vehicle is seated, plane and dead are empty', () => {
    const top = (bs: Hitbox[]) => Math.max(...bs.map((b) => Math.max(b.a.y, b.b.y) + b.r));
    const stand = buildHitboxes(pose());
    const crouch = buildHitboxes(pose({ stance: 'crouch' }));
    expect(top(stand)).toBeGreaterThan(1.7);
    expect(top(crouch)).toBeLessThan(1.25);
    const lean = buildHitboxes(pose({ lean: 1 }));
    const headL = lean.find((b) => b.part === 'head')!;
    expect(headL.a.x).toBeCloseTo(0.35, 1);
    // Legs do not move with the lean.
    const legs = (bs: Hitbox[]) => bs.filter((b) => b.part === 'limb' && b.b.y < 0.5);
    expect(legs(lean)).toEqual(legs(stand));
    const seated = buildHitboxes(pose({ mode: 'vehicle', pos: { x: 0, y: 1, z: 0 } }));
    expect(seated.map((b) => b.part).sort()).toEqual(['body', 'head']);
    expect(seated.find((b) => b.part === 'head')!.a.y).toBeCloseTo(2.13, 2);
    expect(buildHitboxes(pose({ mode: 'plane' }))).toEqual([]);
    expect(buildHitboxes(pose({ life: 'dead' }))).toEqual([]);
    // Reuses the output array and its objects.
    const out: Hitbox[] = [];
    const r1 = buildHitboxes(pose(), out);
    const first = r1[0];
    const r2 = buildHitboxes(pose({ pos: { x: 5, y: 0, z: 0 } }), out);
    expect(r2).toBe(out);
    expect(r2[0]).toBe(first);
    expect(first.a.x).toBeCloseTo(5, 1);
    buildHitboxes(pose({ life: 'dead' }), out);
    expect(out.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Generic collision helper
// ---------------------------------------------------------------------------

describe('collideCircleXZ', () => {
  it('pushes a circle out of boxes, trunks and rocks within the vertical span', () => {
    const w = makeWorld({
      boxes: [{ min: { x: 0, y: 0, z: -1 }, max: { x: 2, y: 2, z: 1 } }],
      trees: [{ x: 10, z: 0, r: 0.4, h: 10 }],
      rocks: [{ x: 20, z: 0, r: 1, h: 1 }],
    });
    const p = { x: -0.2, y: 0, z: 0 };
    const r = collideCircleXZ(w, p, 0.5, 0.2, 1.5);
    expect(r.pushed).toBe(true);
    expect(r.nx).toBeCloseTo(-1, 9);
    expect(r.nz).toBeCloseTo(0, 9);
    expect(r.depth).toBeCloseTo(0.3, 9);
    expect(p.x).toBeCloseTo(-0.5, 9);
    // Above the box: no contact.
    const q = { x: -0.2, y: 0, z: 0 };
    expect(collideCircleXZ(w, q, 0.5, 2.5, 4).pushed).toBe(false);
    expect(q.x).toBe(-0.2);
    const t = { x: 10.5, y: 0, z: 0 };
    const rt = collideCircleXZ(w, t, 0.5, 0, 2);
    expect(rt.pushed).toBe(true);
    expect(Math.hypot(t.x - 10, t.z)).toBeCloseTo(0.9, 9);
    const k = { x: 20, y: 0, z: 1.2 };
    const rk = collideCircleXZ(w, k, 0.5, 0, 2);
    expect(rk.nz).toBeCloseTo(1, 9);
    expect(k.z).toBeCloseTo(1.5, 9);
  });
});
