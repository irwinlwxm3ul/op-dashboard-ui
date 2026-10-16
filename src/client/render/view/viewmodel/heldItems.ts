// Procedural items held in first person: healing items (bandage, first aid kit, medkit, energy
// drink, jerry can), a frag grenade for throws and a shotgun shell for shell-by-shell reloads.
// Item-local origin is where the holding hand sits.

import * as THREE from 'three';
import type { ConsumableId } from '../../../../shared/types';
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

/** Build every held item once; show/hide by id. */
export class HeldItems {
  readonly group = new THREE.Group();
  private readonly items = new Map<HeldItemId, THREE.Object3D>();
  private readonly ownGeoms: THREE.BufferGeometry[] = [];
  private current: HeldItemId | null = null;

  constructor(mats: Record<MatKey, THREE.Material>) {
    this.group.name = 'vm-held-items';
    const make = (id: HeldItemId, fill: (b: PartBuilder) => void) => {
      const b = new PartBuilder(mats);
      fill(b);
      const g = b.build(`held-${id}`);
      g.visible = false;
      this.group.add(g);
      this.items.set(id, g);
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
    grenade.visible = false;
    grenade.scale.setScalar(1.05);
    this.group.add(grenade);
    this.items.set('frag', grenade);
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
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !this.ownGeoms.includes(m.geometry)) m.geometry.dispose();
    });
    for (const g of this.ownGeoms) g.dispose();
    this.group.removeFromParent();
  }
}
