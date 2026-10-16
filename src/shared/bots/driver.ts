// BotDriver: called once per tick before GameSim.step(); produces exactly one PlayerInput per
// bot through sim.queueInput (the same validated path human inputs take).
//
// Per tick: global budgets are reset (LOS raycasts, A* expansions, nav tile generation), the
// path planner runs, then every bot is ticked. Bots "think" (perception, goal selection,
// planning) at ~6 Hz staggered by id and steer / aim / fire every tick.

import { TICK_DT } from '../constants';
import { clamp, wrapAngle } from '../math';
import type { BotDriver, SimView } from '../sim/view';
import type { EntityId, PlayerState } from '../types';
import { warmBallistics, weaponAt } from './aim';
import { brainAct, brainThink, downedAct, downedThink, type ActOut } from './brain';
import { combatAct, manageWeapon, steerAim } from './combat';
import { dropTick, planeTick } from './drop';
import { moveAxes } from './movement';
import { findContact, perceive, refreshTarget, selectTarget } from './perception';
import { createBotState, type BotGoal, type BotState } from './state';
import {
  BotSystem, LOS_BUDGET_PER_TICK, NAV_BUDGET_PER_TICK, THINK_EVERY, TILE_GEN_PER_TICK,
} from './system';
import { vehicleTick } from './vehicle';

/** Read-only snapshot of a bot's mind (debugging / tests). */
export interface BotDebugInfo {
  goal: BotGoal;
  landing: { x: number; z: number } | null;
  dest: { x: number; z: number } | null;
  targetId: EntityId | null;
  visible: EntityId[];
  pathPoints: number;
  aimYaw: number;
  aimPitch: number;
}

export interface BotDriverStats {
  bots: number;
  losChecks: number;
  pathSearches: number;
  pathCacheHits: number;
  navTiles: number;
}

/** BotDriver plus introspection used by tests and tooling. */
export interface BotDriverEx extends BotDriver {
  inspect(id: EntityId): BotDebugInfo | null;
  stats(): BotDriverStats;
}

const PITCH_MAX = 1.55;

class Driver implements BotDriverEx {
  private readonly sys: BotSystem;
  private readonly out: ActOut = { mx: 0, mz: 0, buttons: 0, stance: 0 };
  private readonly axes = { mx: 0, mz: 0 };
  private nextSlot = 0;

  constructor(sim: SimView) {
    this.sys = new BotSystem(sim);
    warmBallistics();
  }

  update(dt: number): void {
    const sys = this.sys, sim = sys.sim;
    sys.tick++;
    sys.dt = dt > 0 ? dt : TICK_DT;
    sys.now = sim.time;
    sys.losLeft = LOS_BUDGET_PER_TICK;
    sys.grid.genBudget = TILE_GEN_PER_TICK;
    if (sim.phase === 'waiting' || sim.phase === 'ended') return;
    sys.rebuildTeams();
    sys.planner.step(NAV_BUDGET_PER_TICK);
    for (const p of sim.players.values()) {
      if (!p.isBot || p.life === 'dead') continue;
      let b = sys.bots.get(p.id);
      if (!b) {
        b = createBotState(p, sim.config.seed, this.nextSlot++ % THINK_EVERY, sys.world.buildings.length);
        sys.bots.set(p.id, b);
      }
      this.tickBot(b, p);
    }
    if (sys.tick % 150 === 0) {
      for (const [id] of sys.bots) {
        const p = sim.players.get(id);
        if (!p || !p.isBot) this.drop(id);
      }
    }
  }

  onPlayerRemoved(id: EntityId): void {
    this.drop(id);
  }

  private drop(id: EntityId): void {
    const b = this.sys.bots.get(id);
    if (!b) return;
    this.sys.planner.cancel(b.path);
    this.sys.bots.delete(id);
  }

  private tickBot(b: BotState, p: PlayerState): void {
    const sys = this.sys;
    const think = !b.thoughtOnce || (sys.tick + b.thinkSlot) % THINK_EVERY === 0;
    b.thoughtOnce = true;
    b.actions.length = 0;
    const out = this.out, axes = this.axes;
    out.mx = 0;
    out.mz = 0;
    out.buttons = 0;
    out.stance = 0;
    let footAxes = false;
    switch (p.mode) {
      case 'plane':
        b.goal = 'plane';
        planeTick(sys, b, p, think);
        break;
      case 'freefall':
      case 'parachute':
        b.goal = 'drop';
        dropTick(sys, b, p, think, axes);
        out.mx = axes.mx;
        out.mz = axes.mz;
        break;
      case 'vehicle': {
        if (think) {
          perceive(sys, b, p);
          selectTarget(sys, b, p);
        }
        b.goal = p.seat === 0 ? 'drive' : 'passenger';
        out.buttons = vehicleTick(sys, b, p, think, axes);
        if (p.seat === 0) {
          out.mx = axes.mx;
          out.mz = axes.mz;
        } else {
          // Passengers may shoot from seats that allow it (validated by the sim).
          const c = findContact(b, b.targetId);
          if (c && c.visible) {
            if (think) manageWeapon(sys, b, p, true, Math.hypot(c.x - p.pos.x, c.z - p.pos.z));
            b.moveScale = 0;
            out.buttons |= combatAct(sys, b, p);
          } else {
            steerAim(sys, b, sys.now < b.alertUntil ? b.alertYaw : b.aimYaw, 0, 0.5);
          }
        }
        break;
      }
      default:
        footAxes = true;
        if (p.life === 'downed') {
          if (think) downedThink(sys, b, p);
          downedAct(sys, b, p, out);
        } else {
          if (think) brainThink(sys, b, p);
          else if (b.targetId >= 0 && (sys.tick + b.id) % 3 === 0) refreshTarget(sys, b, p);
          brainAct(sys, b, p, out);
        }
    }
    this.emit(b, p, footAxes);
  }

  private emit(b: BotState, p: PlayerState, footAxes: boolean): void {
    const sys = this.sys;
    const comp = sys.skill.recoilComp;
    const yaw = wrapAngle(b.aimYaw - comp * p.recoilYaw);
    const pitch = clamp(b.aimPitch - comp * p.recoilPitch, -PITCH_MAX, PITCH_MAX);
    const out = this.out;
    if (footAxes) {
      moveAxes(b, yaw, this.axes);
      out.mx = this.axes.mx;
      out.mz = this.axes.mz;
    }
    b.seq = Math.max(b.seq, p.lastSeq) + 1;
    const inp = b.input;
    inp.seq = b.seq;
    inp.mx = clamp(out.mx, -1, 1);
    inp.mz = clamp(out.mz, -1, 1);
    inp.yaw = yaw;
    inp.pitch = pitch;
    inp.buttons = out.buttons;
    inp.stance = out.stance;
    inp.slot = b.wantSlot >= 0 && !weaponAt(p, b.wantSlot) ? p.activeSlot : b.wantSlot;
    inp.rt = sys.now * 1000;
    inp.actions = b.actions.length > 0 ? b.actions : undefined;
    sys.sim.queueInput(p.id, inp);
  }

  inspect(id: EntityId): BotDebugInfo | null {
    const b = this.sys.bots.get(id);
    if (!b) return null;
    const visible: EntityId[] = [];
    for (const c of b.contacts) if (c.id >= 0 && c.visible) visible.push(c.id);
    return {
      goal: b.goal,
      landing: b.hasLanding ? { x: b.landX, z: b.landZ } : null,
      dest: b.hasDest ? { x: b.destX, z: b.destZ } : null,
      targetId: b.targetId >= 0 ? b.targetId : null,
      visible,
      pathPoints: b.path.count,
      aimYaw: b.aimYaw,
      aimPitch: b.aimPitch,
    };
  }

  stats(): BotDriverStats {
    const s = this.sys;
    return {
      bots: s.bots.size,
      losChecks: s.losUsed,
      pathSearches: s.planner.searches,
      pathCacheHits: s.planner.cacheHits,
      navTiles: s.grid.tilesGenerated,
    };
  }
}

/** Drives every player with isBot === true via sim.queueInput. */
export function createBotDriver(sim: SimView): BotDriverEx {
  return new Driver(sim);
}
