// First-person muzzle flash: a camera-facing star plus two crossed flame tongues along the barrel
// (additive, from the shared FX sprite atlas) and a brief point light that lights the gun and
// hands. Each shot randomises roll and scale so consecutive flashes never look identical.

import * as THREE from 'three';
import { CELL, getSpriteAtlas, mapUvToCell } from '../../fx/textures';

const FLASH_TIME = 0.055;

export class MuzzleFlash {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private readonly star: THREE.Mesh;
  private readonly flameA: THREE.Mesh;
  private readonly flameB: THREE.Mesh;
  private readonly starMat: THREE.MeshBasicMaterial;
  private readonly flameMat: THREE.MeshBasicMaterial;
  private readonly geoms: THREE.BufferGeometry[] = [];
  private t = 0;
  private scale = 1;
  private peakLight = 0;

  constructor() {
    this.group.name = 'vm-muzzle-flash';
    const atlas = getSpriteAtlas();
    const common = { map: atlas, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false } as const;
    this.starMat = new THREE.MeshBasicMaterial({ ...common, color: new THREE.Color(1.0, 0.78, 0.45) });
    this.flameMat = new THREE.MeshBasicMaterial({ ...common, color: new THREE.Color(1.0, 0.62, 0.28), side: THREE.DoubleSide });

    const starGeom = new THREE.PlaneGeometry(1, 1);
    mapUvToCell(starGeom, CELL.STAR);
    // Flame tongue: base at the muzzle, extending forward (-Z).
    const flameGeom = new THREE.PlaneGeometry(0.38, 1);
    mapUvToCell(flameGeom, CELL.FLAME);
    flameGeom.translate(0, 0.42, 0);
    flameGeom.rotateX(-Math.PI / 2);
    this.geoms.push(starGeom, flameGeom);

    this.star = new THREE.Mesh(starGeom, this.starMat);
    this.flameA = new THREE.Mesh(flameGeom, this.flameMat);
    this.flameB = new THREE.Mesh(flameGeom, this.flameMat);
    this.flameB.rotation.z = Math.PI / 2;
    for (const m of [this.star, this.flameA, this.flameB]) {
      m.frustumCulled = false;
      m.renderOrder = 10;
      this.group.add(m);
    }
    this.light = new THREE.PointLight(0xffb060, 0, 2.2, 2);
    this.light.castShadow = false;
    this.group.visible = false;
  }

  /** Trigger a flash with a size multiplier (per gun). */
  fire(size: number): void {
    this.t = FLASH_TIME;
    this.scale = size * (0.8 + Math.random() * 0.45);
    this.group.rotation.z = Math.random() * Math.PI * 2;
    this.group.visible = true;
    this.peakLight = 3.5 * size;
    this.light.intensity = this.peakLight;
  }

  update(dt: number): void {
    if (this.t <= 0) {
      if (this.group.visible) this.group.visible = false;
      if (this.light.intensity !== 0) this.light.intensity = 0;
      return;
    }
    this.t -= dt;
    const k = Math.max(0, this.t / FLASH_TIME);
    const s = this.scale;
    this.star.scale.setScalar(0.11 * s * (0.75 + 0.25 * k));
    this.flameA.scale.set(0.11 * s, 1, 0.24 * s * (0.7 + 0.3 * k));
    this.flameB.scale.copy(this.flameA.scale);
    this.starMat.opacity = k;
    this.flameMat.opacity = k * 0.9;
    this.light.intensity = this.peakLight * k;
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    this.starMat.dispose();
    this.flameMat.dispose();
    this.light.dispose();
    this.group.removeFromParent();
    this.light.removeFromParent();
  }
}
