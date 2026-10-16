// CONTRACT (owned by the integrator). Interfaces between the app main loop and the rendering /
// game-feel modules, so they can be built in parallel.
//
// Frame order (src/client/app):
//   game.update(dt) -> frame = game.getFrame()
//   feel.update(frame, dt)                       // shake/kick/bob/overlays/sounds
//   cam = viewRig.update(frame, feel.state, dt)  // positions core.camera, viewmodel
//   worldRenderer.update(frame, cam, dt)
//   entityRenderer.update(frame, cam, dt)
//   fx.update(frame, cam, dt)
//   core.render()
//   ui.updateHud(frame, cam, dt)

import type * as THREE from 'three';
import type { ScopeKind, Vec3, World } from '../../shared/types';
import type { ClientEventBus, FrameState, Quality } from '../game/types';

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

/** Owned by src/client/render/core (render-world track). */
export interface RenderCore {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  /** Normalised direction TOWARD the sun (for lighting / shadows). */
  readonly sunDir: THREE.Vector3;
  readonly quality: Quality;
  setQuality(q: Quality, renderScale: number): void;
  resize(): void;
  render(): void;
  stats(): RenderStats;
  dispose(): void;
}

export type CameraViewMode = 'fpp' | 'tpp' | 'scope' | 'plane' | 'freefall' | 'parachute' | 'vehicle' | 'spectate' | 'death' | 'menu';

export interface CameraState {
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical FOV degrees actually applied */
  fov: number;
  mode: CameraViewMode;
  /** Scope overlay to draw (UI) when fully scoped, else null */
  scope: ScopeKind | null;
  /** 0..1 ADS blend */
  ads: number;
  /** True when the local player's own body should be hidden (first person) */
  hideLocalBody: boolean;
}

/** Transient game-feel values produced by src/client/feel each frame. */
export interface FeelState {
  /** Trauma based camera shake offsets (radians) */
  shake: { pitch: number; yaw: number; roll: number };
  /** Cosmetic recoil camera kick (radians), separate from server recoil */
  kick: { pitch: number; yaw: number; roll: number };
  /** FOV punch in degrees (positive widens) */
  fovPunch: number;
  /** Viewmodel kick: back (m), up (m), rotation (rad), sideways (m) */
  vm: { back: number; up: number; rot: number; side: number };
  /** Landing camera dip in meters (negative = down) */
  landDip: number;
  /** Head bob phase (radians) and amount 0..1 */
  bob: { phase: number; amount: number };
  /** 0..1 low health intensity (vignette/desaturation already applied by feel; exposed for others) */
  lowHealth: number;
}

/** Owned by src/client/render/world. */
export interface WorldRenderer {
  update(frame: FrameState, cam: CameraState, dt: number): void;
  dispose(): void;
}

/** Owned by src/client/render/entities. Nameplates/markers are DOM elements in overlay. */
export interface EntityRenderer {
  update(frame: FrameState, cam: CameraState, dt: number): void;
  dispose(): void;
}

/** Owned by src/client/render/view: camera rig + first-person viewmodel. */
export interface ViewRig {
  update(frame: FrameState, feel: FeelState, dt: number): CameraState;
  dispose(): void;
}

/** Owned by src/client/render/fx: tracers, muzzle flashes (third person), impacts, blood, explosions, projectiles, casings, dust. */
export interface FxRenderer {
  update(frame: FrameState, cam: CameraState, dt: number): void;
  dispose(): void;
}

/** Owned by src/client/feel. */
export interface Feel {
  readonly state: FeelState;
  update(frame: FrameState, cam: CameraState | null, dt: number): void;
  dispose(): void;
}

// Factory signatures (each module's index.ts exports exactly this name):
export type CreateRenderCore = (container: HTMLElement) => RenderCore;
export type CreateWorldRenderer = (core: RenderCore, world: World) => WorldRenderer;
export type CreateEntityRenderer = (core: RenderCore, world: World, overlay: HTMLElement, events: ClientEventBus) => EntityRenderer;
export type CreateViewRig = (core: RenderCore, world: World, events: ClientEventBus) => ViewRig;
export type CreateFxRenderer = (core: RenderCore, world: World, events: ClientEventBus) => FxRenderer;
export type CreateFeel = (events: ClientEventBus, overlay: HTMLElement) => Feel;
