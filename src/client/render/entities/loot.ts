// Ground loot: every item kind is one geometry inside a single BatchedMesh (one draw call for all
// loot), drawn within LOOT_DRAW_DISTANCE of the camera with a gentle bob + spin, plus a soft additive
// ground ring per item (one InstancedMesh) so items read on grass. Picked-up items vanish at once.

import * as THREE from 'three';
import { ALL_ITEM_IDS, itemCategory } from '../../../shared/items';
import { hashFloat } from '../../../shared/rng';
import type { EntityId, ItemId, LootItem } from '../../../shared/types';
import { createEntityMaterial } from './materials';
import { RING_COLOR, buildLootGeometry } from './lootModels';

export const LOOT_DRAW_DISTANCE = 120;
const MAX_VISIBLE = 640;
/** Membership (which items are in range) is refreshed at this interval or after camera moves. */
const REFRESH_INTERVAL = 0.25;
const REFRESH_MOVE = 5;

interface LootEntry {
  id: EntityId;
  item: ItemId;
  inst: number;
  x: number;
  y: number;
  z: number;
  phase: number;
  stamp: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

export class LootRenderer {
  private readonly material = createEntityMaterial({ rim: false, fogScale: 1 });
  private readonly batch: THREE.BatchedMesh;
  private readonly geoIds = new Map<ItemId, number>();
  private readonly rings: THREE.InstancedMesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly active = new Map<EntityId, LootEntry>();
  private readonly pool: LootEntry[] = [];
  private readonly drop: EntityId[] = [];
  private stamp = 0;
  private refreshTimer = 0;
  private readonly lastRefreshPos = new THREE.Vector3(1e9, 0, 0);
  private time = 0;
  // Per-refresh parameters for the bound visitor.
  private readonly cam = new THREE.Vector3();
  private loot: ReadonlyMap<EntityId, LootItem> | null = null;

  constructor(parent: THREE.Object3D) {
    const geos: THREE.BufferGeometry[] = [];
    let verts = 0;
    for (const id of ALL_ITEM_IDS) {
      const g = buildLootGeometry(id);
      geos.push(g);
      verts += g.getAttribute('position').count;
    }
    this.batch = new THREE.BatchedMesh(MAX_VISIBLE, verts + 16, 0, this.material);
    this.batch.name = 'loot';
    this.batch.castShadow = false;
    this.batch.receiveShadow = true;
    this.batch.frustumCulled = false;
    ALL_ITEM_IDS.forEach((id, i) => {
      this.geoIds.set(id, this.batch.addGeometry(geos[i]));
      geos[i].dispose();
    });
    parent.add(this.batch);

    const ring = new THREE.RingGeometry(0.16, 0.34, 20, 1);
    ring.rotateX(-Math.PI / 2);
    // Radial alpha falloff baked as vertex colour intensity (additive: black = invisible).
    const pos = ring.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      const k = r < 0.2 ? 1 : 1 - (r - 0.2) / 0.14;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = Math.max(0, k);
    }
    ring.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.ringMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    });
    this.rings = new THREE.InstancedMesh(ring, this.ringMat, MAX_VISIBLE);
    this.rings.name = 'loot-rings';
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.setColorAt(0, _c.setRGB(1, 1, 1));
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 1;
    this.rings.count = 0;
    parent.add(this.rings);
  }

  private readonly visit = (item: LootItem): void => {
    const dx = item.pos.x - this.cam.x, dz = item.pos.z - this.cam.z, dy = item.pos.y - this.cam.y;
    if (dx * dx + dz * dz + dy * dy > LOOT_DRAW_DISTANCE * LOOT_DRAW_DISTANCE) return;
    let e = this.active.get(item.id);
    if (e && e.item !== item.item) {
      this.release(e);
      e = undefined;
    }
    if (!e) {
      if (this.active.size >= MAX_VISIBLE) return;
      const gid = this.geoIds.get(item.item);
      if (gid === undefined) return;
      e = this.pool.pop() ?? { id: 0, item: item.item, inst: -1, x: 0, y: 0, z: 0, phase: 0, stamp: 0 };
      e.id = item.id;
      e.item = item.item;
      e.inst = this.batch.addInstance(gid);
      e.phase = hashFloat(item.id, 99) * Math.PI * 2;
      this.active.set(item.id, e);
    }
    e.x = item.pos.x;
    e.y = item.pos.y;
    e.z = item.pos.z;
    e.stamp = this.stamp;
  };

  private readonly collect = (e: LootEntry): void => {
    if (e.stamp !== this.stamp || !this.loot?.has(e.id)) this.drop.push(e.id);
  };

  private release(e: LootEntry): void {
    this.batch.deleteInstance(e.inst);
    this.active.delete(e.id);
    e.inst = -1;
    this.pool.push(e);
  }

  update(loot: ReadonlyMap<EntityId, LootItem>, camPos: THREE.Vector3, dt: number): void {
    this.time += dt;
    this.refreshTimer -= dt;
    this.loot = loot;
    const moved = camPos.distanceToSquared(this.lastRefreshPos) > REFRESH_MOVE * REFRESH_MOVE;
    if (this.refreshTimer <= 0 || moved) {
      this.refreshTimer = REFRESH_INTERVAL;
      this.lastRefreshPos.copy(camPos);
      this.cam.copy(camPos);
      this.stamp++;
      loot.forEach(this.visit);
    } else {
      // Between refreshes keep every entry alive unless it was picked up.
      this.active.forEach(this.touch);
    }
    this.drop.length = 0;
    this.active.forEach(this.collect);
    for (const id of this.drop) {
      const e = this.active.get(id);
      if (e) this.release(e);
    }
    // Animate.
    this.ringCount = 0;
    this.active.forEach(this.animateEntry);
    const n = this.ringCount;
    this.rings.count = n;
    this.rings.visible = n > 0;
    if (n > 0) {
      this.rings.instanceMatrix.needsUpdate = true;
      if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    }
  }

  private readonly touch = (e: LootEntry): void => {
    e.stamp = this.stamp;
  };

  private ringCount = 0;

  private readonly animateEntry = (e: LootEntry): void => {
    const t = this.time;
    const bob = 0.03 + 0.025 * Math.sin(t * 2.1 + e.phase);
    _q.setFromAxisAngle(_up, t * 0.7 + e.phase);
    _p.set(e.x, e.y + bob, e.z);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    this.batch.setMatrixAt(e.inst, _m);
    const n = this.ringCount;
    if (n >= MAX_VISIBLE) return;
    const pulse = 1 + 0.08 * Math.sin(t * 3 + e.phase);
    _q.identity();
    _p.set(e.x, e.y + 0.015, e.z);
    _s.set(pulse, 1, pulse);
    _m.compose(_p, _q, _s);
    this.rings.setMatrixAt(n, _m);
    _c.setHex(RING_COLOR[itemCategory(e.item)]);
    this.rings.setColorAt(n, _c);
    this.ringCount = n + 1;
  };

  dispose(): void {
    this.batch.removeFromParent();
    this.batch.dispose();
    this.material.dispose();
    this.rings.removeFromParent();
    this.rings.geometry.dispose();
    this.rings.dispose();
    this.ringMat.dispose();
  }
}
