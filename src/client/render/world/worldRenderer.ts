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
import { qualityProfile, type QualityProfile, type VegetationProfile } from '../core/quality';
import { BuildingRenderer } from './buildings';
import { GrassRenderer } from './grass';
import { planProps, type PropPlan } from './propPlacement';
import { PropRenderer, PropVisibility } from './props';
import { createHeightTexture, type HeightTexture } from './heightTexture';
import { lodScaleForFov } from './lod';
import { RoadRenderer } from './roads';
import { createWorldUniforms, type WorldUniforms } from './shaders';
import { TerrainRenderer } from './terrain';
import { computeTerrainNormals, computeTerrainShading, type HeightFieldData, type TerrainShading } from './terrainData';
import { TrainingRenderer } from './training';
import { VegetationRenderer, applySetQuality } from './vegetation';
import { assetVegetationSet, proceduralVegetationSet, type VegetationModelSet } from './vegetationSets';
import { assetGrassSet, loadWorldAssets, type LoadedWorldAssets } from './worldAssets';
import { WaterRenderer } from './water';
import { ZoneRenderer } from './zone';

function variantKey(v: Readonly<VegetationProfile>): string {
  return `${v.treeVariants}/${v.rockVariants}/${v.bushVariants}`;
}

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
  private vegetation: VegetationRenderer;
  private vegSet: VegetationModelSet;
  /** Variant counts the current vegetation renderer was built with. */
  private vegVariants = '';
  private readonly propPlans: PropPlan[];
  private readonly propVis: PropVisibility;
  private props: PropRenderer | null = null;
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

    this.propPlans = planProps(world.boxes);
    this.propVis = new PropVisibility(this.propPlans.length);
    const propPids = new Map<number, number>();
    this.propPlans.forEach((p, i) => propPids.set(p.boxId, i + 1));
    this.buildings = new BuildingRenderer(world, propPids, this.propVis);
    this.root.add(this.buildings.group);

    // Procedural vegetation right away; the glTF models replace it once loaded.
    const p0 = qualityProfile(core.quality);
    this.vegSet = proceduralVegetationSet(this.uniforms);
    this.vegetation = new VegetationRenderer(world, this.vegSet, p0.vegetation);
    this.vegVariants = variantKey(p0.vegetation);
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
    void loadWorldAssets().then((a) => this.onAssets(a), () => undefined);
  }

  /** Swap procedural vegetation / grass / prop boxes for the loaded models (keeps fallbacks on failure). */
  private onAssets(a: LoadedWorldAssets): void {
    if (this.disposed) return;
    try {
      if (a.nature) {
        const set = assetVegetationSet(a.nature, this.uniforms);
        if (set) {
          const old = this.vegSet;
          this.vegSet = set;
          this.rebuildVegetation(qualityProfile(this.quality ?? this.core.quality));
          old.dispose();
        }
      }
      if (a.grass) {
        const g = assetGrassSet(a.grass, this.uniforms, this.grass.fade);
        if (g) this.grass.setModels(g);
      }
      if (a.props.size > 0 && this.propPlans.length > 0) {
        this.props = new PropRenderer(this.propPlans, this.propVis, a.props);
        this.root.add(this.props.group);
      }
      this.quality = null;
      this.applyQuality(this.core.quality);
    } catch (err) {
      console.warn('[world] asset models unavailable, keeping procedural fallbacks', err);
    }
  }

  private rebuildVegetation(p: QualityProfile): void {
    const next = new VegetationRenderer(this.world, this.vegSet, p.vegetation);
    next.setShadows(p.shadows);
    this.vegetation.dispose();
    this.vegetation = next;
    this.vegVariants = variantKey(p.vegetation);
    this.root.add(next.group);
    next.group.updateMatrixWorld(true);
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
    if (variantKey(p.vegetation) !== this.vegVariants) this.rebuildVegetation(p);
    this.vegetation.setProfile(p.vegetation);
    this.vegetation.setShadows(p.shadows);
    applySetQuality(this.vegSet, aniso, p.msaaSamples > 0);
    this.grass.configure(p.grass);
    this.grass.setMsaa(p.msaaSamples > 0);
    this.props?.setModelDistance(p.propModelDistance);
    this.props?.setShadows(p.shadows);
    this.props?.setAnisotropy(aniso, p.msaaSamples > 0);
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
    this.props?.update(p.x, p.y, p.z, lodScale, step);
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
    this.vegSet.dispose();
    this.props?.dispose();
    this.propVis.dispose();
    this.grass.dispose();
    this.zone.dispose();
    this.training.dispose();
    this.heightTex.dispose();
    this.root.removeFromParent();
  }
}
