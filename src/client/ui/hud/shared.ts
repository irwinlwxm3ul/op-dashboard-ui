// State shared by the HUD widgets of one attached match.

import type { EntityId, World } from '../../../shared/types';
import type { ClientGameApi, FrameState, KeyAction, PlayerView } from '../../game/types';
import type { CameraState } from '../../render/contracts';
import type { MatchContext } from '../contracts';

/** Per-member colours for the local team (squad numbering 1..4), also used on the maps. */
export const MEMBER_COLORS = ['#f6c344', '#f08a3c', '#4fc3f7', '#7bd88f'] as const;

/** A local-only map waypoint shared by the minimap, full map and compass. */
export class Waypoint {
  active = false;
  x = 0;
  z = 0;
  version = 0;

  set(x: number, z: number): void {
    this.active = true;
    this.x = x;
    this.z = z;
    this.version++;
  }

  clear(): void {
    if (!this.active) return;
    this.active = false;
    this.version++;
  }
}

export interface HudEnv {
  readonly game: ClientGameApi;
  readonly context: MatchContext;
  readonly world: World;
  readonly waypoint: Waypoint;
  /** Current keybinds (KeyboardEvent.code per action). */
  keys: Record<KeyAction, string>;
  /** Local team members ordered by id (index → member number / colour). */
  readonly team: EntityId[];
  /** Colour for a local-team member, or null for others. */
  memberColor(id: EntityId): string | null;
  /** 1-based squad number for a local-team member, 0 for others. */
  memberNumber(id: EntityId): number;
}

/** Player the camera follows (self, or the spectated player). */
export function viewTarget(frame: FrameState): PlayerView | null {
  const id = frame.viewTargetId ?? frame.localId;
  return id === null ? null : frame.players.get(id) ?? null;
}

/** World position the HUD is centred on (self or spectated player). */
export function viewPos(frame: FrameState): { x: number; y: number; z: number } | null {
  const self = frame.self;
  if (self && (self.life !== 'dead' || frame.viewTargetId === null || frame.viewTargetId === self.id)) return self.pos;
  const vt = viewTarget(frame);
  return vt ? vt.pos : self ? self.pos : null;
}

/** A HUD widget updated every frame. */
export interface Widget {
  readonly el: HTMLElement;
  update(frame: FrameState, cam: CameraState, env: HudEnv, dt: number): void;
  /** Language or keybinds changed: drop cached text. */
  relabel(): void;
  /** Match detached / attached: reset transient state. */
  reset(): void;
}
