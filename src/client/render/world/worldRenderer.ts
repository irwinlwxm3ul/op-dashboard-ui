// WorldRenderer: owns every static world visual (terrain, water, roads, buildings & props,
// vegetation, grass, blue zone, training range) and updates their LODs from the camera.
//
// Per frame (allocation free): terrain chunk LODs, building detail/shell switch, water follow,
// zone wall/ring, grass ring buffer; vegetation band membership a few times per second (or
// immediately when the zoom changes a lot). LOD distances are scaled by the camera FOV so scoped
// views get full detail at range.

import * as THREE from 'three';
import type { SurfaceMaterial, World } from '../../../shared/types';
import { SURFACE_LIST } from '../../../shared/world';
import type { CameraState, CreateWorldRenderer, RenderCore, WorldRenderer } from '../contracts';
import type { FrameState, Quality } from '../../game/types';
import { ENV } from '../core/environment';
import { qualityProfile } from '../core/quality';
import { BuildingRenderer } from './buildings';
import { GrassRenderer } from './grass';
import { createHeightTexture, type HeightTexture } from './heightTexture';
import { lodScaleForFov } from './lod';
import { RoadRenderer } from './roads';
import { createWorldUniforms, type WorldUniforms } from './shaders';
import { TerrainRenderer } from './terrain';
import { computeTerrainNormals, computeTerrainShading, type HeightFieldData, type TerrainShading } from './terrainData';
import { TrainingRenderer } from './training';
import { VegetationRenderer } from './vegetation';
import { WaterRenderer } from './water';
import { ZoneRenderer } from './zone';

export const createWorldRenderer: CreateWorldRenderer = (core: RenderCore, world: World): WorldRenderer =>
  new WorldRendererImpl(core, world);

class WorldRendererImpl implements WorldRenderer {
  private readonly core: RenderCore;
  private readonly world: World;
  private readonly root = new THREE.Group();
  private readonly uniforms: WorldUniforms;
  private readonly heightTex: HeightTexture;
  private readonly shading: TerrainShading;
  private readonly terrain: TerrainRenderer;
  private readonly water: WaterRenderer;
  private readonly roads: RoadRenderer;
  private readonly buildings: BuildingRenderer;
  private readonly vegetation: VegetationRenderer;
  private readonly grass: GrassRenderer;
  private readonly zone: ZoneRenderer;
  private readonly training: TrainingRenderer;
  private quality: Quality | null = null;
  private time = 0;
  private disposed = false;

  constructor(core: RenderCore, world: World) {
    this.core = core;
    this.world = world;
    this.root.name = 'world';
    this.root.matrixAutoUpdate = false;
    this.uniforms = createWorldUniforms();

    const field: HeightFieldData = {
      res: world.res,
      cell: world.cell,
      half: world.half,
      heights: world.heights,
      waterLevel: world.waterLevel,
    };
    const surfaceOf = (k: number): SurfaceMaterial => SURFACE_LIST[world.surface[k]] ?? 'grass';
    this.shading = computeTerrainShading(field, computeTerrainNormals(field), surfaceOf, world.seed);
    this.heightTex = createHeightTexture(field);

    this.terrain = new TerrainRenderer(field, this.shading);
    this.root.add(this.terrain.group);

    this.water = new WaterRenderer(world.waterLevel, core.sunDir, this.heightTex, this.uniforms);
    this.root.add(this.water.mesh);

    this.roads = new RoadRenderer(world);
    if (this.roads.mesh) this.root.add(this.roads.mesh);

    this.buildings = new BuildingRenderer(world);
    this.root.add(this.buildings.group);

    this.vegetation = new VegetationRenderer(world, this.uniforms);
    this.root.add(this.vegetation.group);

    this.grass = new GrassRenderer(world, this.shading, this.uniforms);
    this.root.add(this.grass.group);

    this.zone = new ZoneRenderer(world.heightAt, this.heightTex, this.uniforms, ENV.fogDensity);
    this.root.add(this.zone.group);

    this.training = new TrainingRenderer(world);
    this.root.add(this.training.group);

    this.root.updateMatrixWorld(true);
    core.scene.add(this.root);
    this.applyQuality(core.quality);
  }

  private applyQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    const p = qualityProfile(q);
    const maxAniso = this.core.renderer.capabilities.getMaxAnisotropy();
    const aniso = Math.max(1, Math.min(p.anisotropy, maxAniso));
    this.terrain.setLodDistances(p.terrainLod[0], p.terrainLod[1]);
    this.buildings.setDetailDistance(p.buildingDetailDistance);
    this.buildings.setAnisotropy(aniso);
    this.vegetation.setProfile(p.vegetation);
    this.vegetation.setShadows(p.shadows);
    this.vegetation.setAnisotropy(aniso, p.msaaSamples > 0);
    this.grass.configure(p.grass);
    this.training.setAnisotropy(aniso);
  }

  update(frame: FrameState, cam: CameraState, dt: number): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    this.time += step;
    const t = this.time;
    this.uniforms.uTime.value = t;
    this.uniforms.uWind.value = 0.85 + 0.22 * Math.sin(t * 0.21) + 0.12 * Math.sin(t * 0.73 + 1.3);

    if (this.core.quality !== this.quality) this.applyQuality(this.core.quality);

    const p = this.core.camera.position;
    const lodScale = lodScaleForFov(cam.fov);
    this.terrain.update(p.x, p.y, p.z, lodScale);
    this.water.update(p.x, p.z);
    this.buildings.update(p.x, p.y, p.z, lodScale);
    this.vegetation.update(p.x, p.y, p.z, lodScale, step);
    this.grass.update(p.x, p.z);
    const zoneEnabled = frame.config.mode !== 'training' && this.world.kind !== 'training';
    this.zone.update(frame.zone, zoneEnabled, this.world.half, step);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terrain.dispose();
    this.water.dispose();
    this.roads.dispose();
    this.buildings.dispose();
    this.vegetation.dispose();
    this.grass.dispose();
    this.zone.dispose();
    this.training.dispose();
    this.heightTex.dispose();
    this.root.removeFromParent();
  }
}
