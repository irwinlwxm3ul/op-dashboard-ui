// Character body backends. The player renderer decides WHO is drawn at which LOD (hysteresis,
// crossfades, pool limits, death fade) and computes per-frame data once; a backend decides HOW a
// near / mid body looks. The procedural soldier (crowd.ts) is the built-in backend and the permanent
// fallback; a skinned-glTF backend (AnimationMixer per player, clips picked from `logical`, weapon on
// the right-hand bone) can be plugged in with PlayersRenderer.setBodyBackends() at runtime. The far
// LOD silhouette impostor is not part of this abstraction (always the instanced capsule).

import type * as THREE from 'three';
import type { PlayerView } from '../../game/types';
import type { AnimState, SeatInfo } from './animator';
import type { LogicalAnim } from './animState';
import type { SoldierLook } from './crowd';

/** Everything a backend needs to draw one player for one frame (scratch object, do not retain). */
export interface BodyFrame {
  /** Model -> world (feet origin, facing -Z; vehicle orientation when seated). */
  root: THREE.Matrix4;
  /**
   * Procedural rig bone matrices in model space (see rig.ts `B`); always evaluated, so clip-based
   * backends may use e.g. rig[B.WEAPON] for aim-space weapon placement or rig[B.HEAD] for look-at.
   */
  rig: THREE.Matrix4[];
  look: SoldierLook;
  /** Draw the held weapon (false when unarmed or dead). */
  showWeapon: boolean;
  /** Signed dither fade code (lod.ts); never 0 when apply()/add() is called. */
  fade: number;
  /** Cast shadows (near LOD on shadow-enabled qualities). */
  shadows: boolean;
  /**
   * The body's bounds intersect the view frustum. Backends without their own culling (e.g. skinned
   * characters with frustumCulled = false) can skip drawing and animation updates when false.
   */
  onScreen: boolean;
  view: PlayerView;
  logical: LogicalAnim;
  /** Procedural animation state (smoothed lean, flinch / kick springs, blended pose incl. drop pitch). */
  anim: AnimState;
  /** Horizontal velocity in the model frame (x right, z backward), m/s. */
  moveX: number;
  moveZ: number;
  /** Aim pitch (rad) and aim yaw relative to the model facing (seated passengers). */
  aimPitch: number;
  aimYawRel: number;
  /** Vehicle seat (with rider contact points: hands on the controls, feet on the pegs) or null. */
  seat: SeatInfo | null;
  dt: number;
  time: number;
}

/** One pooled near-LOD body. */
export interface NearBody {
  readonly ownerId: number;
  apply(f: BodyFrame): void;
  hide(): void;
}

/** Pool of near-LOD bodies (one per close player). */
export interface NearBodyProvider {
  readonly name: string;
  /** Null when the pool is exhausted (the player then stays on the mid LOD). */
  acquire(ownerId: number): NearBody | null;
  release(body: NearBody): void;
  setCapacity(n: number): void;
  /**
   * Optional: outfit colours of the body a player gets (upper / lower body, linear), so the
   * procedural mid LOD can be tinted to match. Returns false when unknown.
   */
  outfitTint?(playerId: number, upper: THREE.Color, lower: THREE.Color): boolean;
  dispose(): void;
}

/** Batched mid-LOD renderer (begin / add per player / end every frame). */
export interface MidBodyRenderer {
  readonly name: string;
  begin(): void;
  add(f: BodyFrame): void;
  end(): void;
  /** Hide everything (used when this renderer is swapped out). */
  clear(): void;
  dispose(): void;
}
