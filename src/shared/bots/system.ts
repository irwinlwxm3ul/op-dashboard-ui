// Shared context of one bot driver: the sim view, navigation, global per-tick budgets and scratch
// objects. Behaviour modules receive it together with the bot's own state.

import { TICK_DT } from '../constants';
import { lineOfSight } from '../physics';
import type { SimView } from '../sim/view';
import type { EntityId, LootItem, PlayerState, TeamId, Vec3, VehicleState, World } from '../types';
import { mapInfoFor, type MapInfo } from './mapinfo';
import { navGridFor, type NavGrid } from './nav';
import { PathPlanner } from './pathfind';
import { skillFor, type BotSkill } from './skill';
import type { BotState } from './state';

/** Bots think every THINK_EVERY ticks (6 Hz at 30 Hz), staggered by id. */
export const THINK_EVERY = 5;
/** Global line-of-sight raycasts per tick shared by all bots. */
export const LOS_BUDGET_PER_TICK = 28;
/** Upper bound of raycasts one bot spends per think. */
export const MAX_LOS_PER_THINK = 4;
/** Part of the LOS budget kept for between-think target refreshes. */
export const LOS_REFRESH_RESERVE = 6;
/** Global A* node expansions per tick. */
export const NAV_BUDGET_PER_TICK = 1600;
/** Nav tiles that may be generated per tick (lazy grid). */
export const TILE_GEN_PER_TICK = 2;

const EMPTY_TEAM: readonly PlayerState[] = [];

export interface TeamPlan {
  landX: number;
  landZ: number;
  hasLanding: boolean;
}

export class BotSystem {
  readonly sim: SimView;
  readonly world: World;
  readonly grid: NavGrid;
  readonly planner: PathPlanner;
  readonly info: MapInfo;
  readonly skill: BotSkill;
  readonly bots = new Map<EntityId, BotState>();
  readonly teams = new Map<TeamId, TeamPlan>();
  /** Connected human per team (not dead) this tick, used for "follow the human" squads. */
  readonly teamHuman = new Map<TeamId, EntityId>();
  /** Lowest-id standing bot per team this tick (loose squad cohesion for bot squads). */
  readonly teamBotLeader = new Map<TeamId, EntityId>();
  private readonly teamLists = new Map<TeamId, PlayerState[]>();
  tick = 0;
  now = 0;
  dt = TICK_DT;
  losLeft = 0;
  /** Line-of-sight tests one thinking bot may spend this tick (fair share of the budget). */
  losPerThink = MAX_LOS_PER_THINK;
  /** Stats (tests / telemetry). */
  losUsed = 0;

  // Scratch (behaviour code is not re-entrant).
  readonly playerBuf: PlayerState[] = [];
  readonly playerBuf2: PlayerState[] = [];
  readonly lootBuf: LootItem[] = [];
  readonly vehicleBuf: VehicleState[] = [];
  readonly eye: Vec3 = { x: 0, y: 0, z: 0 };
  readonly eye2: Vec3 = { x: 0, y: 0, z: 0 };
  readonly pt: Vec3 = { x: 0, y: 0, z: 0 };
  readonly pt2: Vec3 = { x: 0, y: 0, z: 0 };
  readonly xz = { x: 0, z: 0 };

  constructor(sim: SimView) {
    this.sim = sim;
    this.world = sim.world;
    this.grid = navGridFor(sim.world);
    this.planner = new PathPlanner(this.grid);
    this.info = mapInfoFor(sim.world);
    this.skill = skillFor(sim.config.botDifficulty);
  }

  /** Budgeted line of sight; returns null when this tick's raycast budget is spent. */
  los(a: Vec3, b: Vec3): boolean | null {
    if (this.losLeft <= 0) return null;
    this.losLeft--;
    this.losUsed++;
    return lineOfSight(this.world, a, b);
  }

  /** Rebuild the per-team rosters (once per tick, no allocation after warm-up). */
  rebuildTeams(): void {
    for (const list of this.teamLists.values()) list.length = 0;
    this.teamHuman.clear();
    this.teamBotLeader.clear();
    for (const p of this.sim.players.values()) {
      let list = this.teamLists.get(p.team);
      if (!list) {
        list = [];
        this.teamLists.set(p.team, list);
      }
      list.push(p);
      if (p.life === 'dead') continue;
      if (!p.isBot && p.connected) this.teamHuman.set(p.team, p.id);
      if (p.isBot && p.life === 'alive') {
        const cur = this.teamBotLeader.get(p.team);
        if (cur === undefined || p.id < cur) this.teamBotLeader.set(p.team, p.id);
      }
    }
  }

  /** Every player of a team (any life state) as of this tick. */
  teamMembers(team: TeamId): readonly PlayerState[] {
    return this.teamLists.get(team) ?? EMPTY_TEAM;
  }

  teamPlan(team: TeamId): TeamPlan {
    let t = this.teams.get(team);
    if (!t) {
      t = { landX: 0, landZ: 0, hasLanding: false };
      this.teams.set(team, t);
    }
    return t;
  }

  /** The connected human leading this bot's team, if any (alive). */
  humanLeader(p: PlayerState): PlayerState | null {
    const id = this.teamHuman.get(p.team);
    if (id === undefined || id === p.id) return null;
    const h = this.sim.players.get(id);
    return h && h.life !== 'dead' ? h : null;
  }
}
