// WorldRenderer: owns every static world visual (terrain, water, roads, buildings & props,
// vegetation, grass, blue zone, training range) and updates their LODs from the camera.

import * as THREE from 'three';
import type { SurfaceMaterial, World } from '../../../shared/types';
import { SURFACE_LIST } from '../../../shared/world';
import type { CameraState, CreateWorldRenderer, RenderCore, WorldRenderer } from '../contracts';
import type { FrameState, Quality } from '../../game/types';
import { ENV } from '../core/environment';
import { qualityProfile, type QualityProfile } from '../core/quality';
import { createHeightTexture, type HeightTexture } from './heightTexture';
import { lodScaleForFov } from './lod';
import { createWorldUniforms, type WorldUniforms } from './shaders';
import { TerrainRenderer } from './terrain';
import { computeTerrainNormals, computeTerrainShading, type HeightFieldData, type TerrainShading } from './terrainData';
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
  private readonly zone: ZoneRenderer;
  private quality: Quality | null = null;
  private profile: QualityProfile = qualityProfile('medium');
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

    this.zone = new ZoneRenderer(world.heightAt, this.heightTex, this.uniforms, ENV.fogDensity);
    this.root.add(this.zone.group);

    core.scene.add(this.root);
    this.applyQuality(core.quality);
  }

  private applyQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    const p = qualityProfile(q);
    this.profile = p;
    this.terrain.setLodDistances(p.terrainLod[0], p.terrainLod[1]);
  }

  update(frame: FrameState, cam: CameraState, dt: number): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    this.time += step;
    this.uniforms.uTime.value = this.time;
    const t = this.time;
    this.uniforms.uWind.value = 0.85 + 0.22 * Math.sin(t * 0.21) + 0.12 * Math.sin(t * 0.73 + 1.3);

    if (this.core.quality !== this.quality) this.applyQuality(this.core.quality);

    const p = this.core.camera.position;
    const lodScale = lodScaleForFov(cam.fov);
    this.terrain.update(p.x, p.y, p.z, lodScale);
    this.water.update(p.x, p.z);
    const zoneEnabled = frame.config.mode !== 'training' && this.world.kind !== 'training';
    this.zone.update(frame.zone, zoneEnabled, this.world.half, step);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terrain.dispose();
    this.water.dispose();
    this.zone.dispose();
    this.heightTex.dispose();
    this.root.removeFromParent();
  }
}
