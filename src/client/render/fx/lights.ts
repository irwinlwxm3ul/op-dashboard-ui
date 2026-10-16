// A small fixed pool of point lights for muzzle flashes and explosions.
//
// The light count never changes after construction: lights stay in the scene with intensity 0
// when idle, because adding/removing lights changes three.js' shader permutation and would cause
// a compile hitch on the first shot. The pool size is chosen from the quality at creation.

import * as THREE from 'three';

interface Slot {
  light: THREE.PointLight;
  remaining: number;
  duration: number;
  peak: number;
}

export class FlashLights {
  private readonly slots: Slot[] = [];
  readonly group = new THREE.Group();

  constructor(count: number) {
    this.group.name = 'fx-lights';
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffc27a, 0, 10, 2);
      light.castShadow = false;
      this.group.add(light);
      this.slots.push({ light, remaining: 0, duration: 1, peak: 0 });
    }
  }

  get size(): number {
    return this.slots.length;
  }

  /** Flash a light; `priority` lights (explosions) may steal a slot from a weaker flash. */
  flash(x: number, y: number, z: number, color: number, intensity: number, distance: number, duration: number): void {
    if (this.slots.length === 0) return;
    let best: Slot | null = null;
    let bestScore = Infinity;
    for (const s of this.slots) {
      const score = s.remaining <= 0 ? -1 : s.peak * (s.remaining / s.duration);
      if (score < bestScore) { bestScore = score; best = s; }
    }
    if (!best || bestScore > intensity) return;
    best.light.position.set(x, y, z);
    best.light.color.setHex(color);
    best.light.distance = distance;
    best.remaining = duration;
    best.duration = duration;
    best.peak = intensity;
    best.light.intensity = intensity;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.remaining <= 0) {
        if (s.light.intensity !== 0) s.light.intensity = 0;
        continue;
      }
      s.remaining -= dt;
      const k = Math.max(0, s.remaining / s.duration);
      s.light.intensity = s.peak * k * k;
    }
  }

  clear(): void {
    for (const s of this.slots) {
      s.remaining = 0;
      s.light.intensity = 0;
    }
  }

  dispose(): void {
    for (const s of this.slots) s.light.dispose();
    this.group.clear();
  }
}
