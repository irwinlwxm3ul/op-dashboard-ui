// Items held in first person: healing items (bandage, first aid kit, medkit, energy drink, jerry
// can), a frag grenade for throws and a shotgun shell for shell-by-shell reloads. The imported
// item models replace the procedural stand-ins once loaded. Item-local origin = holding point.

import * as THREE from 'three';
import type { ConsumableId } from '../../../../shared/types';
import { ITEM_MODELS, loadMeshParts } from '../../../assets';
import { createGrenadeGeometry } from '../../fx/frags';
import { PartBuilder, type MatKey } from './parts';

export type HeldItemId = ConsumableId | 'frag' | 'shell';

function bandage(b: PartBuilder): void {
  b.cylY('bandage', 0.03, 0.03, 0.06, 0, 0, 0, 0, 0, Math.PI / 2, 14);   // roll lying sideways
  b.cylY('medWhite', 0.012, 0.012, 0.062, 0, 0, 0, 0, 0, Math.PI / 2, 8);
  b.box('bandage', 0.05, 0.002, 0.07, -0.02, -0.03, 0.03, 0.25, 0, 0);    // unrolled strip
}

function firstAid(b: PartBuilder): void {
  b.box('medWhite', 0.11, 0.075, 0.035, 0, 0, 0);
  b.box('medRed', 0.05, 0.014, 0.0365, 0, 0, 0);
  b.box('medRed', 0.014, 0.05, 0.0365, 0, 0, 0);
  b.box('darkMetal', 0.112, 0.006, 0.037, 0, 0.02, 0);                     // lid seam
}

function medkit(b: PartBuilder): void {
  b.box('medRed', 0.16, 0.11, 0.06, 0, 0, 0);
  b.box('medWhite', 0.06, 0.018, 0.0615, 0, 0, 0);
  b.box('medWhite', 0.018, 0.06, 0.0615, 0, 0, 0);
  b.box('darkMetal', 0.07, 0.012, 0.016, 0, 0.065, 0);                    // handle
  b.box('darkMetal', 0.162, 0.008, 0.062, 0, 0.03, 0);                    // seam
}

function energy(b: PartBuilder): void {
  b.cylY('can', 0.022, 0.022, 0.1, 0, 0, 0, 0, 0, 0, 14);
  b.cylY('metal', 0.019, 0.022, 0.008, 0, 0.054, 0, 0, 0, 0, 14);
  b.cylY('medWhite', 0.0222, 0.0222, 0.03, 0, 0.0, 0, 0, 0, 0, 14);        // label band
}

function jerry(b: PartBuilder): void {
  b.box('jerry', 0.17, 0.24, 0.08, 0, -0.06, 0);
  b.box('jerry', 0.04, 0.022, 0.07, -0.04, 0.072, 0);                     // handle bars
  b.box('jerry', 0.04, 0.022, 0.07, 0.03, 0.072, 0);
  b.cylY('darkMetal', 0.013, 0.015, 0.04, 0.07, 0.07, 0, 0, 0, -0.5, 10);  // spout
  for (let i = 0; i < 3; i++) b.box('jerry', 0.15, 0.012, 0.084, 0, -0.14 + i * 0.07, 0);
}

function shell(b: PartBuilder): void {
  b.cylY('shell', 0.0095, 0.0095, 0.052, 0, 0, 0, Math.PI / 2, 0, 0, 10);
  b.cylY('brass', 0.0102, 0.0102, 0.016, 0, 0, 0.032, Math.PI / 2, 0, 0, 10);
}

/**
 * How the imported item models (ITEM_MODELS: standing on y = 0, centred, front -Z) sit in the
 * hand relative to the procedural stand-ins (centred at the holding point): uniform scale (first
 * person keeps items a little smaller than life so they don't fill the view) and a yaw so the
 * printed face (cross, label) looks at the camera.
 */
const REAL_FIT: Record<RealItemId, { scale: number; yaw: number }> = {
  bandage: { scale: 0.75, yaw: 0 },
  firstaid: { scale: 0.48, yaw: Math.PI },
  medkit: { scale: 0.45, yaw: Math.PI },
  energy: { scale: 0.85, yaw: Math.PI },
  fuel: { scale: 0.5, yaw: Math.PI / 2 },
  frag: { scale: 0.72, yaw: 0 },
};
type RealItemId = Exclude<HeldItemId, 'shell'>;
const REAL_IDS = Object.keys(REAL_FIT) as RealItemId[];

/**
 * Every held item: a container per id holding the procedural stand-in, replaced by the imported
 * model (src/client/assets ITEM_MODELS via loadMeshParts) as soon as it loads. show/hide by id.
 */
export class HeldItems {
  readonly group = new THREE.Group();
  private readonly items = new Map<HeldItemId, THREE.Object3D>();
  private readonly procedural = new Map<HeldItemId, THREE.Object3D>();
  private readonly ownGeoms: THREE.BufferGeometry[] = [];
  private current: HeldItemId | null = null;
  private disposed = false;

  constructor(mats: Record<MatKey, THREE.Material>) {
    this.group.name = 'vm-held-items';
    const container = (id: HeldItemId, child: THREE.Object3D) => {
      const c = new THREE.Group();
      c.name = `held-${id}`;
      c.visible = false;
      c.add(child);
      this.group.add(c);
      this.items.set(id, c);
      this.procedural.set(id, child);
    };
    const make = (id: HeldItemId, fill: (b: PartBuilder) => void) => {
      const b = new PartBuilder(mats);
      fill(b);
      container(id, b.build(`held-${id}-proc`));
    };
    make('bandage', bandage);
    make('firstaid', firstAid);
    make('medkit', medkit);
    make('energy', energy);
    make('fuel', jerry);
    make('shell', shell);
    const gg = createGrenadeGeometry();
    this.ownGeoms.push(gg);
    const grenade = new THREE.Mesh(gg, mats.grenade);
    grenade.frustumCulled = false;
    grenade.scale.setScalar(1.05);
    container('frag', grenade);
    for (const id of REAL_IDS) {
      loadMeshParts(ITEM_MODELS[id].file).then((parts) => { if (parts) this.useReal(id, parts.geometry, parts.material); }, () => { /* keep procedural */ });
    }
  }

  /** Swap an item's procedural stand-in for the imported model (geometry/material shared). */
  private useReal(id: RealItemId, geometry: THREE.BufferGeometry, material: THREE.Material): void {
    if (this.disposed) return;
    const fit = REAL_FIT[id];
    const size = ITEM_MODELS[id].size;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `held-${id}-model`;
    mesh.frustumCulled = false;
    mesh.userData.shared = true;
    // Centre the model (it stands on y = 0) on the holding point.
    mesh.position.set(0, -size[1] / 2, 0);
    const fitGroup = new THREE.Group();
    fitGroup.rotation.y = fit.yaw;
    fitGroup.scale.setScalar(fit.scale);
    fitGroup.add(mesh);
    this.items.get(id)!.add(fitGroup);
    this.procedural.get(id)!.visible = false;
  }

  /** Show one item (or none). Returns the item's object for posing. */
  show(id: HeldItemId | null): THREE.Object3D | null {
    if (id !== this.current) {
      if (this.current) this.items.get(this.current)!.visible = false;
      if (id) this.items.get(id)!.visible = true;
      this.current = id;
    }
    return id ? this.items.get(id)! : null;
  }

  get shown(): HeldItemId | null {
    return this.current;
  }

  dispose(): void {
    this.disposed = true;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.shared && !this.ownGeoms.includes(m.geometry)) m.geometry.dispose();
    });
    for (const g of this.ownGeoms) g.dispose();
    this.group.removeFromParent();
  }
}
