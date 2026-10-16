// Entity renderer: procedural soldiers (3 LODs with dithered crossfades, team accents, rim light,
// procedural animation), parachutes, vehicles (with damage smoke / fire), ground loot, the drop
// plane, training dummies and DOM nameplates / off-screen teammate markers.
//
// Draw-call budget (64 players, medium): near soldiers 1 each (pool of 12) + mid LOD 12 instanced
// parts + far impostors 1 + canopies 1; vehicles 1 batched mesh + 2 particle systems; loot 1 batched
// mesh + 1 ring layer; plane 3; dummies 1.

import * as THREE from 'three';
import { PLAYER_RENDER_DISTANCE } from '../../../shared/constants';
import type { EntityId, World } from '../../../shared/types';
import type { ClientEventBus, FrameState, Quality } from '../../game/types';
import type { CameraState, CreateEntityRenderer, EntityRenderer, RenderCore } from '../contracts';
import { DummyRenderer } from './dummies';
import { lodThresholds } from './lod';
import { LootRenderer } from './loot';
import { NameplateRenderer } from './nameplates';
import { PlaneRenderer } from './plane';
import { PlayersRenderer, type PlayersUpdateContext } from './players';
import { VehicleRenderer } from './vehicles';
import type { MidBodyRenderer, NearBodyProvider } from './bodies';
import { CHARACTER_VARIANT_IDS, loadCharacter } from '../../assets';
import { loadItemAssets, loadWeaponAssets } from './assetBridge';
import { CharacterLibrary, GltfNearProvider } from './gltfBodies';

export type { BodyFrame, MidBodyRenderer, NearBody, NearBodyProvider } from './bodies';
export type { LogicalAnim, LogicalAnimOverlay, LogicalAnimState, WeaponClass } from './animState';

export { teamColorHex, teamCss, LOCAL_TEAM_COLOR } from './palette';
export { selectLod, lodThresholds } from './lod';
export { strideLength } from './pose';

/** Near-LOD soldier pool size per quality preset. */
function nearCapacity(q: Quality): number {
  switch (q) {
    case 'low': return 6;
    case 'high': return 20;
    case 'ultra': return 28;
    default: return 12;
  }
}

/**
 * Entity renderer plus the hooks used to plug asset-based character bodies in (the far silhouette
 * impostor and the procedural soldier fallback stay built in).
 */
export interface EntityRendererInternals extends EntityRenderer {
  /** Scene group that owns every entity object; backends add their meshes under it. */
  readonly group: THREE.Group;
  /** Swap near / mid body backends; null restores the procedural soldier. */
  setBodyBackends(near: NearBodyProvider | null, mid: MidBodyRenderer | null): void;
  readonly bodyBackends: { near: string; mid: string };
}

class EntityRendererImpl implements EntityRendererInternals {
  private readonly root = new THREE.Group();
  private readonly players: PlayersRenderer;
  private readonly vehicles: VehicleRenderer;
  private readonly loot: LootRenderer;
  private readonly plane: PlaneRenderer;
  private readonly dummies: DummyRenderer;
  private readonly nameplates: NameplateRenderer;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly camPos = new THREE.Vector3();
  private readonly ctx: PlayersUpdateContext;
  private quality: Quality;
  private localId: EntityId | null = null;
  private time = 0;
  private disposed = false;
  private characters: CharacterLibrary | null = null;
  private gltfNear: GltfNearProvider | null = null;
  private readonly projScreen = new THREE.Matrix4();

  constructor(private readonly core: RenderCore, world: World, overlay: HTMLElement, events: ClientEventBus) {
    this.root.name = 'entities';
    core.scene.add(this.root);
    this.quality = core.quality;
    this.players = new PlayersRenderer(this.root, nearCapacity(this.quality));
    this.vehicles = new VehicleRenderer(this.root);
    this.loot = new LootRenderer(this.root);
    this.plane = new PlaneRenderer(this.root);
    this.dummies = new DummyRenderer(this.root, world);
    this.nameplates = new NameplateRenderer(overlay, core.canvas, world);
    this.ctx = {
      camPos: this.camPos,
      cam: { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov: 70, mode: 'menu', scope: null, ads: 0, hideLocalBody: false },
      lod: lodThresholds(this.quality),
      focalPx: 1000,
      shadows: this.quality !== 'low',
      time: 0,
      frustum: new THREE.Frustum(),
    };
    this.unsubscribe.push(
      events.on('hit', (ev) => {
        if (ev.source === 'zone' || ev.source === 'bleed' || ev.source === 'drown') return;
        this.players.onHit(ev.victim, ev.from, ev.pos, ev.damage);
      }),
      // Remote shooters only: the local shooter's kick comes from the predicted localShot.
      events.on('shot', (ev) => {
        if (ev.shooter !== this.localId) this.players.onShot(ev.shooter, ev.weapon);
      }),
      events.on('localShot', (ev) => {
        if (this.localId !== null) this.players.onShot(this.localId, ev.weapon);
      }),
      events.on('targetHit', (ev) => this.dummies.onHit(ev.target, ev.damage, ev.part === 'head')),
    );
    void this.loadAssets();
  }

  /**
   * Asynchronously swap in the curated models: real weapon and item meshes (third-person guns,
   * ground loot, worn gear), then the skinned glTF characters for the near LOD. The procedural soldier and guns stay
   * in use until then, and permanently if loading fails.
   */
  private async loadAssets(): Promise<void> {
    try {
      // Start the character downloads right away; they resolve from the loader cache later.
      for (const id of CHARACTER_VARIANT_IDS) void loadCharacter(id);
      const [weapons, items] = await Promise.all([loadWeaponAssets(), loadItemAssets()]);
      if (this.disposed) return;
      if (weapons.length) this.players.refreshWeaponModels();
      if (weapons.length || items.length) this.loot.refreshItems([...weapons, ...items]);
      // Gear meshes of the characters are built after the weapons registered (real guns in hand).
      const lib = await CharacterLibrary.load();
      if (!lib) return;
      if (this.disposed) {
        lib.dispose();
        return;
      }
      this.characters = lib;
      this.gltfNear = new GltfNearProvider(this.root, lib, nearCapacity(this.quality));
      this.players.setBodyBackends(this.gltfNear, null);
    } catch (err) {
      console.warn('[entities] asset models unavailable, keeping procedural models', err);
    }
  }

  get group(): THREE.Group {
    return this.root;
  }

  setBodyBackends(near: NearBodyProvider | null, mid: MidBodyRenderer | null): void {
    this.players.setBodyBackends(near, mid);
  }

  get bodyBackends(): { near: string; mid: string } {
    return this.players.backendNames;
  }

  update(frame: FrameState, cam: CameraState, dt: number): void {
    const step = Math.min(0.1, Math.max(0, dt));
    this.time += step;
    this.localId = frame.localId;
    if (this.core.quality !== this.quality) {
      this.quality = this.core.quality;
      this.players.setNearCapacity(nearCapacity(this.quality));
      this.ctx.lod = lodThresholds(this.quality);
      this.ctx.shadows = this.quality !== 'low';
    }
    this.camPos.set(cam.pos.x, cam.pos.y, cam.pos.z);
    const h = Math.max(1, this.core.canvas.height);
    const focal = h / 2 / Math.tan((Math.max(1, cam.fov) * Math.PI) / 360);
    this.ctx.cam = cam;
    this.ctx.focalPx = focal;
    this.ctx.time = this.time;
    const camera = this.core.camera;
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.ctx.frustum.setFromProjectionMatrix(this.projScreen);
    this.players.update(frame, this.ctx, step);
    this.vehicles.update(frame.vehicles, this.camPos, step, focal, PLAYER_RENDER_DISTANCE);
    this.loot.update(frame.loot, this.camPos, step);
    this.plane.update(frame, step);
    this.dummies.update(frame.trainingTargets, step);
    this.nameplates.update(frame, this.core.camera, this.players.entries, step);
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.nameplates.dispose();
    this.players.setBodyBackends(null, null);
    this.gltfNear?.dispose();
    this.characters?.dispose();
    this.players.dispose();
    this.vehicles.dispose();
    this.loot.dispose();
    this.plane.dispose();
    this.dummies.dispose();
    this.root.removeFromParent();
  }
}

export const createEntityRenderer: CreateEntityRenderer = (core, world, overlay, events): EntityRendererInternals =>
  new EntityRendererImpl(core, world, overlay, events);
