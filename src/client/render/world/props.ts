// Instanced prop models (crates, containers, concrete barriers, sandbag walls, fences) dressing
// the world's prop boxes near the camera. Each planned box has a pid in the merged procedural
// prop meshes; a small visibility texture hides the box while its model is shown, so beyond the
// model distance the cheap merged boxes are drawn instead (chain-link fences simply vanish).
// Collision boxes are untouched - this is purely visual. One InstancedMesh per model part, all
// parts of a model sharing the instance buffers; membership is re-banded a few times a second.

import * as THREE from 'three';
import type { WorldPropId } from '../../assets';
import { selectBand } from './lod';
import type { PropPlan } from './propPlacement';

const UPDATE_INTERVAL = 0.25;
const HYSTERESIS = 8;
const VIS_WIDTH = 256;
/**
 * Model distance per prop relative to the quality's propModelDistance: heavy models (chain-link
 * panels ~1 500 tris each, military crates, sandbag walls) switch to their boxes sooner.
 */
const DISTANCE_SCALE: Partial<Record<WorldPropId, number>> = {
  fence_chainlink: 0.5,
  crate_military: 0.7,
  sandbag_wall: 0.8,
};

/** Per-pid on/off flags for the merged prop boxes (pid 0 = boxes that are always drawn). */
export class PropVisibility {
  readonly data: Uint8Array;
  readonly texture: THREE.DataTexture;
  readonly width = VIS_WIDTH;

  constructor(count: number) {
    const rows = Math.max(1, Math.ceil((count + 1) / VIS_WIDTH));
    this.data = new Uint8Array(VIS_WIDTH * rows).fill(255);
    this.texture = new THREE.DataTexture(this.data, VIS_WIDTH, rows, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  set(pid: number, visible: boolean): void {
    const v = visible ? 255 : 0;
    if (this.data[pid] === v) return;
    this.data[pid] = v;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

export interface PropModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

interface ModelSlot {
  meshes: THREE.InstancedMesh[];
  lead: THREE.InstancedMesh;
  cap: number;
  count: number;
}

export class PropRenderer {
  readonly group = new THREE.Group();
  private readonly plans: readonly PropPlan[];
  private readonly vis: PropVisibility;
  private readonly slots = new Map<WorldPropId, ModelSlot>();
  private readonly band: Uint8Array;
  /** 1 / per-model distance scale (scaled distances are compared with the shared edge). */
  private readonly distMul: Float32Array;
  private readonly edges = [140];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private timer = UPDATE_INTERVAL;
  private force = true;
  private shadows = true;

  /** `models` maps each loaded prop model to its parts; plans whose model is missing keep their box. */
  constructor(plans: readonly PropPlan[], vis: PropVisibility, models: ReadonlyMap<WorldPropId, PropModelPart[]>) {
    this.group.name = 'prop-models';
    this.plans = plans;
    this.vis = vis;
    this.band = new Uint8Array(plans.length).fill(1);
    this.distMul = new Float32Array(plans.length);
    plans.forEach((p, i) => {
      this.distMul[i] = 1 / (DISTANCE_SCALE[p.placements[0].model] ?? 1);
    });
    const counts = new Map<WorldPropId, number>();
    for (const p of plans) for (const pl of p.placements) counts.set(pl.model, (counts.get(pl.model) ?? 0) + 1);
    for (const [id, cap] of counts) {
      const parts = models.get(id);
      if (!parts || parts.length === 0) continue;
      const meshes: THREE.InstancedMesh[] = [];
      let lead: THREE.InstancedMesh | null = null;
      for (const part of parts) {
        const mat = part.material.clone();
        this.materials.push(mat);
        const geo = new THREE.BufferGeometry();
        for (const [n, a] of Object.entries(part.geometry.attributes)) geo.setAttribute(n, a);
        if (part.geometry.index) geo.setIndex(part.geometry.index);
        this.geometries.push(geo);
        const mesh = new THREE.InstancedMesh(geo, mat, cap);
        mesh.name = `prop-${id}`;
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.receiveShadow = true;
        if (lead) {
          mesh.instanceMatrix = lead.instanceMatrix;
          mesh.instanceColor = lead.instanceColor;
        } else {
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
          lead = mesh;
        }
        meshes.push(mesh);
        this.group.add(mesh);
      }
      if (lead) this.slots.set(id, { meshes, lead, cap, count: 0 });
    }
    this.applyShadows();
  }

  /** True when this plan's models are available (otherwise its box always stays visible). */
  private hasModels(p: PropPlan): boolean {
    for (const pl of p.placements) if (!this.slots.has(pl.model)) return false;
    return true;
  }

  setModelDistance(d: number): void {
    if (this.edges[0] !== d) {
      this.edges[0] = d;
      this.force = true;
    }
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.applyShadows();
  }

  private applyShadows(): void {
    for (const [id, s] of this.slots) {
      const casts = id !== 'fence_wood' && id !== 'fence_chainlink';
      for (const m of s.meshes) m.castShadow = this.shadows && casts;
    }
  }

  setAnisotropy(a: number, msaa: boolean): void {
    for (const m of this.materials) {
      const sm = m as THREE.MeshStandardMaterial;
      for (const t of [sm.map, sm.normalMap, sm.roughnessMap]) {
        if (t && t.anisotropy !== a) {
          t.anisotropy = a;
          t.needsUpdate = true;
        }
      }
      if (sm.alphaTest > 0 && sm.alphaToCoverage !== msaa) {
        sm.alphaToCoverage = msaa;
        sm.needsUpdate = true;
      }
    }
  }

  update(cx: number, cy: number, cz: number, lodScale: number, dt: number): void {
    this.timer += dt;
    if (!this.force && this.timer < UPDATE_INTERVAL) return;
    this.timer = 0;
    let changed = this.force;
    this.force = false;
    for (let i = 0; i < this.plans.length; i++) {
      const p = this.plans[i];
      if (!this.hasModels(p)) continue;
      const d = Math.max(0, Math.hypot(p.cx - cx, p.cy - cy, p.cz - cz) - p.radius) * lodScale * this.distMul[i];
      const b = selectBand(d, this.band[i], this.edges, HYSTERESIS);
      if (b !== this.band[i]) {
        this.band[i] = b;
        changed = true;
      }
      // pid = plan index + 1: box hidden while the model is shown (and always for hideFar props).
      this.vis.set(i + 1, b !== 0 && !p.hideFar);
    }
    if (changed) this.rebuild();
  }

  private rebuild(): void {
    for (const s of this.slots.values()) s.count = 0;
    for (let i = 0; i < this.plans.length; i++) {
      if (this.band[i] !== 0) continue;
      const p = this.plans[i];
      for (const pl of p.placements) {
        const s = this.slots.get(pl.model);
        if (!s || s.count >= s.cap) continue;
        const k = s.count++;
        (s.lead.instanceMatrix.array as Float32Array).set(pl.m, k * 16);
        const col = s.lead.instanceColor!.array as Float32Array;
        col[k * 3] = p.tint[0];
        col[k * 3 + 1] = p.tint[1];
        col[k * 3 + 2] = p.tint[2];
      }
    }
    for (const s of this.slots.values()) {
      for (const m of s.meshes) {
        m.count = s.count;
        m.visible = s.count > 0;
      }
      if (s.count === 0) continue;
      s.lead.instanceMatrix.clearUpdateRanges();
      s.lead.instanceMatrix.addUpdateRange(0, s.count * 16);
      s.lead.instanceMatrix.needsUpdate = true;
      s.lead.instanceColor!.clearUpdateRanges();
      s.lead.instanceColor!.addUpdateRange(0, s.count * 3);
      s.lead.instanceColor!.needsUpdate = true;
    }
  }

  /** Restores every box (models removed) and frees GPU resources (shared glTF textures stay). */
  dispose(): void {
    for (let i = 0; i < this.plans.length; i++) this.vis.set(i + 1, true);
    for (const s of this.slots.values()) s.lead.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}
