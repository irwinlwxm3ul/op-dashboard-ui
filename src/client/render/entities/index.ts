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

class EntityRendererImpl implements EntityRenderer {
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
      cam: null as unknown as CameraState,
      lod: lodThresholds(this.quality),
      focalPx: 1000,
      shadows: this.quality !== 'low',
      time: 0,
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
    this.players.update(frame, this.ctx, step);
    this.vehicles.update(frame.vehicles, this.camPos, step, focal, PLAYER_RENDER_DISTANCE);
    this.loot.update(frame.loot, this.camPos, step);
    this.plane.update(frame, step);
    this.dummies.update(frame.trainingTargets, step);
    this.nameplates.update(frame, this.core.camera, this.players.entries, step);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.nameplates.dispose();
    this.players.dispose();
    this.vehicles.dispose();
    this.loot.dispose();
    this.plane.dispose();
    this.dummies.dispose();
    this.root.removeFromParent();
  }
}

export const createEntityRenderer: CreateEntityRenderer = (core, world, overlay, events) =>
  new EntityRendererImpl(core, world, overlay, events);
