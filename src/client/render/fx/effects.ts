// Effect recipes: compose particles, decals, lights and shock rings into impacts, blood, muzzle
// flashes, explosions, landing dust, splashes and parachute puffs. Counts scale with quality and
// distance; nothing here allocates per call (a single reusable ParticleSpec is filled).

import * as THREE from 'three';
import type { SurfaceMaterial, WeaponId, World } from '../../../shared/types';
import type { DecalSystem } from './decals';
import type { FlashLights } from './lights';
import { createSpec, resetSpec, type ParticleSpec, type ParticleSystem } from './particles';
import { CELL, DECAL } from './textures';

export type ImpactMaterial = SurfaceMaterial | 'flesh' | 'armor';

/** Linear-space colour triple from an sRGB hex. */
function lin(hex: number): [number, number, number] {
  const c = new THREE.Color().setHex(hex);
  return [c.r, c.g, c.b];
}

const COL = {
  dirtDust: lin(0x8a7458),
  dirtChunk: lin(0x4a3c2c),
  grassDust: lin(0x7d7a55),
  grassBits: lin(0x4f6b2a),
  sandDust: lin(0xcdb98a),
  roadDust: lin(0x77757a),
  rockDust: lin(0xa29f98),
  rockChunk: lin(0x6c6a66),
  concreteDust: lin(0xb4b1aa),
  woodDust: lin(0xa58a66),
  woodSplinter: lin(0x9a7346),
  metalDust: lin(0x5a5c60),
  snow: lin(0xf2f5fa),
  water: lin(0xdfeaf2),
  waterMist: lin(0xc9d9e3),
  blood: lin(0x7a0b0b),
  bloodDark: lin(0x3f0505),
  smokeDark: lin(0x2c2a28),
  smokeMid: lin(0x55524e),
  smokeLight: lin(0x8f8b85),
  gunSmoke: lin(0xb9b6b0),
  chute: lin(0xe9e4d6),
};

/** Sparks: hot HDR colours (linear). */
const SPARK_HOT: [number, number, number] = [4.0, 2.6, 1.1];
const SPARK_COOL: [number, number, number] = [1.6, 0.45, 0.08];
const ARMOR_HOT: [number, number, number] = [2.6, 3.2, 4.2];
const ARMOR_COOL: [number, number, number] = [0.4, 0.7, 1.4];
const FIRE_HOT: [number, number, number] = [5.0, 3.0, 1.2];
const FIRE_COOL: [number, number, number] = [0.9, 0.22, 0.04];
const FLASH: [number, number, number] = [3.2, 2.3, 1.2];

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

/** Shock wave ring pool (flat additive rings on the ground). */
class ShockRings {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshBasicMaterial[] = [];
  private readonly age: number[] = [];
  private readonly life: number[] = [];
  private readonly radius: number[] = [];
  private readonly geom: THREE.RingGeometry;

  constructor(count: number) {
    this.group.name = 'fx-shockrings';
    this.geom = new THREE.RingGeometry(0.82, 1, 48, 1);
    this.geom.rotateX(-Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe2b0, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });
      const m = new THREE.Mesh(this.geom, mat);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 4;
      this.group.add(m);
      this.meshes.push(m);
      this.mats.push(mat);
      this.age.push(1);
      this.life.push(0);
      this.radius.push(1);
    }
  }

  spawn(x: number, y: number, z: number, radius: number): void {
    let best = 0;
    for (let i = 1; i < this.meshes.length; i++) if (this.age[i] / Math.max(1e-3, this.life[i]) > this.age[best] / Math.max(1e-3, this.life[best])) best = i;
    const m = this.meshes[best];
    m.position.set(x, y, z);
    m.visible = true;
    this.age[best] = 0;
    this.life[best] = 0.45;
    this.radius[best] = radius;
  }

  update(dt: number): void {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (!m.visible) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        m.visible = false;
        continue;
      }
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      const s = Math.max(0.01, this.radius[i] * e);
      m.scale.set(s, 1, s);
      this.mats[i].opacity = 0.75 * (1 - t) * (1 - t);
    }
  }

  clear(): void {
    for (const m of this.meshes) m.visible = false;
  }

  dispose(): void {
    this.geom.dispose();
    for (const m of this.mats) m.dispose();
    this.group.clear();
  }
}

export class EffectRecipes {
  /** Global count multiplier from quality. */
  quality = 1;
  /** Whether point lights may be used for muzzle flashes. */
  muzzleLights = false;
  readonly rings: ShockRings;
  private readonly s: ParticleSpec = createSpec();
  private readonly nrm = { x: 0, y: 1, z: 0 };

  constructor(
    private readonly world: World,
    private readonly alpha: ParticleSystem,
    private readonly add: ParticleSystem,
    private readonly decals: DecalSystem,
    private readonly lights: FlashLights,
  ) {
    this.rings = new ShockRings(4);
  }

  private n(base: number, lod: number): number {
    const v = base * this.quality * lod;
    // Stochastic rounding keeps small counts statistically right.
    const f = Math.floor(v);
    return f + (Math.random() < v - f ? 1 : 0);
  }

  /** Random unit vector biased around n (spread 0 = n, 1 = hemisphere). Writes into the spec velocity scaled by speed. */
  private velAround(nx: number, ny: number, nz: number, spread: number, speed: number): void {
    let x = nx + (Math.random() * 2 - 1) * spread;
    let y = ny + (Math.random() * 2 - 1) * spread;
    let z = nz + (Math.random() * 2 - 1) * spread;
    if (x * nx + y * ny + z * nz < 0.05) { x += nx; y += ny; z += nz; }
    const l = Math.hypot(x, y, z) || 1;
    this.s.vx = (x / l) * speed;
    this.s.vy = (y / l) * speed;
    this.s.vz = (z / l) * speed;
  }

  private color(c0: readonly number[], c1: readonly number[], jitter = 0): void {
    const j = 1 + (Math.random() * 2 - 1) * jitter;
    this.s.r0 = c0[0] * j; this.s.g0 = c0[1] * j; this.s.b0 = c0[2] * j;
    this.s.r1 = c1[0] * j; this.s.g1 = c1[1] * j; this.s.b1 = c1[2] * j;
  }

  private at(x: number, y: number, z: number): ParticleSpec {
    const s = resetSpec(this.s);
    s.x = x; s.y = y; s.z = z;
    return s;
  }

  // ---------------------------------------------------------------------------------------------
  // Building blocks
  // ---------------------------------------------------------------------------------------------

  private dust(x: number, y: number, z: number, nx: number, ny: number, nz: number, col: readonly number[], count: number, size: number, speed: number, life: number): void {
    for (let i = 0; i < count; i++) {
      const s = this.at(x, y, z);
      this.velAround(nx, ny, nz, 0.6, speed * rnd(0.4, 1));
      s.vy += 0.3;
      s.life = life * rnd(0.7, 1.2);
      s.size0 = size * rnd(0.4, 0.7);
      s.size1 = size * rnd(1.6, 2.4);
      this.color(col, col, 0.12);
      s.alpha = rnd(0.45, 0.7);
      s.fadeIn = 0.08;
      s.fadePow = 1.4;
      s.drag = 3.2;
      s.gravity = -0.25;
      s.rot = rnd(0, 6.28);
      s.rotSpeed = rnd(-1, 1);
      s.cell = Math.random() < 0.5 ? CELL.DUST : CELL.SMOKE;
      this.alpha.emit(s);
    }
  }

  private chunks(x: number, y: number, z: number, nx: number, ny: number, nz: number, col: readonly number[], count: number, size: number, speed: number, cell: number): void {
    const floor = this.world.groundAt(x, z, y + 0.05);
    for (let i = 0; i < count; i++) {
      const s = this.at(x, y, z);
      this.velAround(nx, ny, nz, 0.9, speed * rnd(0.5, 1.1));
      s.vy += speed * 0.25;
      s.life = rnd(0.6, 1.3);
      s.size0 = s.size1 = size * rnd(0.5, 1.2);
      this.color(col, col, 0.2);
      s.alpha = 1;
      s.fadePow = 0.4;
      s.drag = 0.6;
      s.gravity = 9.81;
      s.rot = rnd(0, 6.28);
      s.rotSpeed = rnd(-14, 14);
      s.cell = cell;
      s.bounce = 0.3;
      s.floorY = floor + 0.01;
      this.alpha.emit(s);
    }
  }

  private sparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, speed: number, hot: readonly number[], cool: readonly number[], life = 0.35): void {
    const floor = this.world.groundAt(x, z, y + 0.05);
    for (let i = 0; i < count; i++) {
      const s = this.at(x, y, z);
      this.velAround(nx, ny, nz, 0.85, speed * rnd(0.35, 1.1));
      s.life = life * rnd(0.5, 1.2);
      s.size0 = 0.022; s.size1 = 0.012;
      this.color(hot, cool);
      s.alpha = 1;
      s.fadePow = 0.8;
      s.drag = 1.8;
      s.gravity = 9.81;
      s.cell = CELL.SPARK;
      s.stretch = 0.028;
      s.bounce = 0.35;
      s.floorY = floor + 0.005;
      this.add.emit(s);
    }
  }

  private flashSprite(x: number, y: number, z: number, size: number, col: readonly number[], life: number): void {
    const s = this.at(x, y, z);
    s.life = life;
    s.size0 = size * 0.7;
    s.size1 = size;
    this.color(col, col);
    s.alpha = 1;
    s.fadePow = 1.5;
    s.rot = rnd(0, 6.28);
    s.cell = CELL.STAR;
    this.add.emit(s);
  }

  // ---------------------------------------------------------------------------------------------
  // Public recipes
  // ---------------------------------------------------------------------------------------------

  /** Bullet impact on a surface. `lod` 0..1 from distance. */
  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, mat: ImpactMaterial, weapon: WeaponId | undefined, lod: number, decal: boolean): void {
    const k = weapon === 'shotgun' ? 0.55 : weapon === 'sniper' ? 1.5 : weapon === 'dmr' ? 1.25 : weapon === 'pistol' || weapon === 'smg' ? 0.85 : 1;
    // Lift the spawn off the surface so particles do not start inside it.
    const px = x + nx * 0.03, py = y + ny * 0.03, pz = z + nz * 0.03;
    const decalSize = (weapon === 'shotgun' ? 0.06 : 0.09) * (k > 1 ? 1.2 : 1);
    switch (mat) {
      case 'dirt':
      case 'grass':
      case 'sand':
      case 'snow':
      case 'road': {
        const dustCol = mat === 'grass' ? COL.grassDust : mat === 'sand' ? COL.sandDust : mat === 'snow' ? COL.snow : mat === 'road' ? COL.roadDust : COL.dirtDust;
        this.dust(px, py, pz, nx, ny + 0.6, nz, dustCol, this.n(5 * k, lod), 0.32 * k, 2.6, 1.1);
        // A thin vertical spurt reads well at distance.
        const s = this.at(px, py, pz);
        s.vx = nx * 1.5; s.vy = 3.5 + ny * 2; s.vz = nz * 1.5;
        s.life = 0.45; s.size0 = 0.12 * k; s.size1 = 0.35 * k;
        this.color(dustCol, dustCol);
        s.alpha = 0.8; s.fadePow = 1.5; s.drag = 4; s.gravity = 4; s.cell = CELL.DUST; s.stretch = 0.08;
        this.alpha.emit(s);
        this.chunks(px, py, pz, nx, ny + 0.8, nz, mat === 'grass' ? COL.grassBits : COL.dirtChunk, this.n(5 * k, lod), 0.035, 4.2, mat === 'grass' ? CELL.BLADE : CELL.CHUNK);
        if (mat === 'road') this.sparks(px, py, pz, nx, ny, nz, this.n(2, lod), 7, SPARK_HOT, SPARK_COOL, 0.2);
        if (decal && mat !== 'snow') this.decals.add(x, y, z, nx, ny, nz, decalSize * 1.4, mat === 'road' ? DECAL.HOLE : DECAL.DIRT, 18);
        break;
      }
      case 'rock':
      case 'concrete': {
        this.sparks(px, py, pz, nx, ny, nz, this.n(6 * k, lod), 9, SPARK_HOT, SPARK_COOL, 0.28);
        this.dust(px, py, pz, nx, ny, nz, mat === 'rock' ? COL.rockDust : COL.concreteDust, this.n(4 * k, lod), 0.28 * k, 2.2, 1.0);
        this.chunks(px, py, pz, nx, ny, nz, COL.rockChunk, this.n(5 * k, lod), 0.03, 4.5, CELL.CHUNK);
        if (decal) this.decals.add(x, y, z, nx, ny, nz, decalSize, DECAL.HOLE, 25);
        break;
      }
      case 'metal': {
        this.sparks(px, py, pz, nx, ny, nz, this.n(12 * k, lod), 11, SPARK_HOT, SPARK_COOL, 0.4);
        this.flashSprite(px, py, pz, 0.22 * k, SPARK_HOT, 0.05);
        this.dust(px, py, pz, nx, ny, nz, COL.metalDust, this.n(2, lod), 0.18, 1.5, 0.6);
        if (decal) this.decals.add(x, y, z, nx, ny, nz, decalSize * 0.8, DECAL.HOLE_METAL, 25);
        break;
      }
      case 'wood': {
        this.chunks(px, py, pz, nx, ny, nz, COL.woodSplinter, this.n(7 * k, lod), 0.05, 4.8, CELL.SPLINTER);
        this.dust(px, py, pz, nx, ny, nz, COL.woodDust, this.n(3 * k, lod), 0.24 * k, 1.8, 0.9);
        if (decal) this.decals.add(x, y, z, nx, ny, nz, decalSize, DECAL.HOLE_WOOD, 25);
        break;
      }
      case 'water':
        this.waterSplash(x, y, z, 0.35 * k, lod);
        break;
      case 'flesh':
        this.blood(x, y, z, nx, ny, nz, k, lod);
        break;
      case 'armor':
        this.armorSpark(x, y, z, nx, ny, nz, lod);
        break;
    }
  }

  /** Red mist puff + droplets for a flesh hit (direction = travel direction of the bullet). */
  blood(x: number, y: number, z: number, dx: number, dy: number, dz: number, k: number, lod: number): void {
    const mist = this.n(4 * Math.max(0.7, k), Math.max(lod, 0.6));
    for (let i = 0; i < mist; i++) {
      const s = this.at(x, y, z);
      this.velAround(dx, dy, dz, 1.1, rnd(0.6, 2.2));
      s.life = rnd(0.35, 0.7);
      s.size0 = 0.12; s.size1 = rnd(0.45, 0.75) * Math.min(1.4, k);
      this.color(COL.blood, COL.bloodDark, 0.15);
      s.alpha = rnd(0.55, 0.85); s.fadeIn = 0.05; s.fadePow = 1.3; s.drag = 5; s.gravity = 0.6;
      s.rot = rnd(0, 6.28); s.rotSpeed = rnd(-2, 2); s.cell = CELL.MIST;
      this.alpha.emit(s);
    }
    const drops = this.n(7 * k, lod);
    const floor = this.world.groundAt(x, z, y);
    for (let i = 0; i < drops; i++) {
      const s = this.at(x, y, z);
      this.velAround(dx, dy + 0.2, dz, 0.7, rnd(1.5, 4));
      s.life = rnd(0.4, 0.8);
      s.size0 = s.size1 = rnd(0.018, 0.035);
      this.color(COL.blood, COL.bloodDark);
      s.alpha = 0.95; s.fadePow = 0.5; s.drag = 0.8; s.gravity = 9.81; s.cell = CELL.DROP; s.stretch = 0.03;
      s.bounce = 0.05; s.floorY = floor + 0.01;
      this.alpha.emit(s);
    }
  }

  /** Blue-white sparks when armor absorbs a hit. */
  armorSpark(x: number, y: number, z: number, nx: number, ny: number, nz: number, lod: number): void {
    this.sparks(x, y, z, nx, ny, nz, this.n(10, Math.max(lod, 0.6)), 6, ARMOR_HOT, ARMOR_COOL, 0.25);
    this.flashSprite(x, y, z, 0.28, ARMOR_HOT, 0.06);
  }

  /** Third-person muzzle flash at (x,y,z) pointing along unit dir. */
  muzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, weapon: WeaponId, lod: number, light: boolean): void {
    const big = weapon === 'shotgun' || weapon === 'sniper' || weapon === 'dmr';
    const scale = weapon === 'pistol' ? 0.7 : weapon === 'smg' ? 0.8 : big ? 1.3 : 1;
    this.flashSprite(x, y, z, 0.42 * scale * rnd(0.85, 1.15), FLASH, 0.05);
    // Forward flame tongue.
    const s = this.at(x + dx * 0.05, y + dy * 0.05, z + dz * 0.05);
    s.vx = dx * 14 * scale; s.vy = dy * 14 * scale; s.vz = dz * 14 * scale;
    s.life = 0.05; s.size0 = 0.14 * scale; s.size1 = 0.1 * scale;
    this.color(FLASH, FLASH);
    s.alpha = 0.9; s.fadePow = 1.2; s.cell = CELL.FLAME; s.stretch = 0.028;
    this.add.emit(s);
    // Smoke wisp.
    const wisps = this.n(big ? 2 : 1, lod);
    for (let i = 0; i < wisps; i++) {
      const w = this.at(x, y, z);
      w.vx = dx * rnd(1, 2.5); w.vy = dy * rnd(1, 2.5) + 0.3; w.vz = dz * rnd(1, 2.5);
      w.life = rnd(0.5, 0.9); w.size0 = 0.08 * scale; w.size1 = 0.5 * scale;
      this.color(COL.gunSmoke, COL.gunSmoke);
      w.alpha = 0.22; w.fadeIn = 0.1; w.fadePow = 1.2; w.drag = 2.5; w.gravity = -0.4;
      w.rot = rnd(0, 6.28); w.rotSpeed = rnd(-1, 1); w.cell = CELL.SMOKE;
      this.alpha.emit(w);
    }
    if (light) this.lights.flash(x, y, z, 0xffb45e, big ? 40 : 22, big ? 12 : 9, 0.06);
  }

  /** Explosion blast (frag or vehicle). */
  explosion(x: number, y: number, z: number, radius: number, vehicle: boolean, lod: number): void {
    const R = Math.max(2, radius);
    const k = vehicle ? 1.5 : 1;
    const ground = this.world.groundAt(x, z, y + 0.5);
    const nearGround = y - ground < 2.5;
    const water = this.world.waterLevel > ground && Math.abs(y - this.world.waterLevel) < 2;
    this.lights.flash(x, y + 1, z, 0xffa860, vehicle ? 2600 : 1600, R * 7, vehicle ? 0.55 : 0.4);
    // Core flash
    {
      const s = this.at(x, y + 0.6, z);
      s.life = 0.14; s.size0 = R * 0.9 * k; s.size1 = R * 1.8 * k;
      this.color(FIRE_HOT, FIRE_HOT);
      s.alpha = 1; s.fadePow = 1.6; s.cell = CELL.GLOW;
      this.add.emit(s);
    }
    // Fireball
    const fire = this.n(14 * k, Math.max(lod, 0.7));
    for (let i = 0; i < fire; i++) {
      const s = this.at(x + rnd(-0.4, 0.4), y + rnd(0.2, 1), z + rnd(-0.4, 0.4));
      this.velAround(0, 1, 0, 1.1, rnd(3, 9) * k);
      s.life = rnd(0.45, 0.9) * (vehicle ? 1.4 : 1);
      s.size0 = rnd(0.8, 1.4) * k; s.size1 = rnd(2.4, 4.2) * k;
      this.color(FIRE_HOT, FIRE_COOL, 0.15);
      s.alpha = 1; s.fadeIn = 0.04; s.fadePow = 1.3; s.drag = 3.5; s.gravity = -2.5;
      s.rot = rnd(0, 6.28); s.rotSpeed = rnd(-2, 2); s.cell = CELL.FIRE;
      this.add.emit(s);
    }
    // Smoke column
    const smoke = this.n(16 * k, Math.max(lod, 0.6));
    for (let i = 0; i < smoke; i++) {
      const s = this.at(x + rnd(-0.8, 0.8), y + rnd(0.3, 1.5), z + rnd(-0.8, 0.8));
      this.velAround(0, 1, 0, 0.7, rnd(1.5, 5) * k);
      s.life = rnd(3, 6) * (vehicle ? 1.5 : 1);
      s.size0 = rnd(1.2, 2) * k; s.size1 = rnd(6, 10) * k;
      const c = Math.random() < 0.5 ? COL.smokeDark : COL.smokeMid;
      this.color(c, COL.smokeLight, 0.1);
      s.alpha = rnd(0.5, 0.75); s.fadeIn = 0.06; s.fadePow = 1.6; s.drag = 1.4; s.gravity = -0.9;
      s.rot = rnd(0, 6.28); s.rotSpeed = rnd(-0.5, 0.5); s.cell = CELL.SMOKE;
      this.alpha.emit(s);
    }
    // Debris
    this.chunks(x, y + 0.4, z, 0, 1, 0, COL.dirtChunk, this.n(18 * k, lod), 0.18, 14 * k, CELL.CHUNK);
    this.sparks(x, y + 0.4, z, 0, 1, 0, this.n(24 * k, lod), 22, SPARK_HOT, SPARK_COOL, 0.9);
    if (nearGround) {
      // Ground dust ring and shock wave.
      const ring = this.n(18 * k, lod);
      for (let i = 0; i < ring; i++) {
        const a = (i / ring) * Math.PI * 2 + rnd(-0.2, 0.2);
        const s = this.at(x, ground + 0.4, z);
        const sp = rnd(8, 14) * k;
        s.vx = Math.cos(a) * sp; s.vy = rnd(0.2, 1.2); s.vz = Math.sin(a) * sp;
        s.life = rnd(1.2, 2.2); s.size0 = 1; s.size1 = rnd(3.5, 5) * k;
        const c = water ? COL.waterMist : COL.dirtDust;
        this.color(c, c, 0.1);
        s.alpha = 0.55; s.fadeIn = 0.05; s.fadePow = 1.4; s.drag = 2.6; s.gravity = -0.2;
        s.rot = rnd(0, 6.28); s.cell = CELL.DUST;
        this.alpha.emit(s);
      }
      this.rings.spawn(x, ground + 0.15, z, R * 2.2 * k);
      if (!water) {
        const nrm = this.world.normalAt(x, z, this.nrm);
        this.decals.add(x, ground, z, nrm.x, nrm.y, nrm.z, R * 1.1 * k, DECAL.SCORCH, 45, 0.9);
      } else {
        this.waterSplash(x, this.world.waterLevel, z, 3 * k, lod);
      }
    }
  }

  /** Dust burst where a player lands (speed m/s). */
  landingDust(x: number, y: number, z: number, speed: number, lod: number): void {
    if (speed < 3.5) return;
    const mat = this.world.surfaceAt(x, z);
    if (mat === 'water') return;
    const k = Math.min(2, speed / 8);
    const col = mat === 'grass' ? COL.grassDust : mat === 'sand' ? COL.sandDust : mat === 'snow' ? COL.snow
      : mat === 'rock' || mat === 'concrete' || mat === 'road' ? COL.concreteDust : COL.dirtDust;
    const count = this.n(10 * k, lod);
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + rnd(-0.3, 0.3);
      const s = this.at(x + Math.cos(a) * 0.25, y + 0.1, z + Math.sin(a) * 0.25);
      const sp = rnd(1.5, 3.2) * k;
      s.vx = Math.cos(a) * sp; s.vy = rnd(0.1, 0.6); s.vz = Math.sin(a) * sp;
      s.life = rnd(0.7, 1.2); s.size0 = 0.25; s.size1 = rnd(0.9, 1.4) * k;
      this.color(col, col, 0.1);
      s.alpha = 0.5; s.fadeIn = 0.06; s.fadePow = 1.4; s.drag = 3.4; s.gravity = -0.1;
      s.rot = rnd(0, 6.28); s.rotSpeed = rnd(-1, 1); s.cell = CELL.DUST;
      this.alpha.emit(s);
    }
  }

  /** Fabric/air puff when a parachute opens (at canopy height). */
  chutePuff(x: number, y: number, z: number, lod: number): void {
    const count = this.n(12, lod);
    for (let i = 0; i < count; i++) {
      const s = this.at(x + rnd(-1.5, 1.5), y + rnd(-0.3, 0.6), z + rnd(-1.5, 1.5));
      this.velAround(0, 0.3, 0, 1.2, rnd(1.5, 4));
      s.life = rnd(0.6, 1.1); s.size0 = 0.6; s.size1 = rnd(2, 3);
      this.color(COL.chute, COL.chute, 0.05);
      s.alpha = 0.35; s.fadeIn = 0.1; s.fadePow = 1.5; s.drag = 3; s.cell = CELL.PUFF;
      this.alpha.emit(s);
    }
  }

  /** Water splash column at the surface; strength ~0.3 (bullet) .. 3 (explosion / body). */
  waterSplash(x: number, y: number, z: number, strength: number, lod: number): void {
    const k = Math.max(0.25, strength);
    const drops = this.n(10 * Math.sqrt(k), lod);
    for (let i = 0; i < drops; i++) {
      const s = this.at(x + rnd(-0.1, 0.1) * k, y + 0.02, z + rnd(-0.1, 0.1) * k);
      const up = rnd(2.5, 6) * Math.sqrt(k);
      s.vx = rnd(-1, 1) * k * 0.8; s.vy = up; s.vz = rnd(-1, 1) * k * 0.8;
      s.life = rnd(0.5, 0.9) * Math.min(1.6, Math.sqrt(k));
      s.size0 = s.size1 = rnd(0.04, 0.08) * Math.min(3, k);
      this.color(COL.water, COL.water);
      s.alpha = 0.9; s.fadePow = 0.6; s.drag = 0.8; s.gravity = 9.81; s.cell = CELL.DROP; s.stretch = 0.035;
      s.bounce = 0.01; s.floorY = y;
      this.alpha.emit(s);
    }
    const mist = this.n(4 * Math.sqrt(k), lod);
    for (let i = 0; i < mist; i++) {
      const s = this.at(x, y + 0.1, z);
      s.vx = rnd(-0.6, 0.6) * k; s.vy = rnd(0.5, 2) * Math.sqrt(k); s.vz = rnd(-0.6, 0.6) * k;
      s.life = rnd(0.6, 1.1); s.size0 = 0.2 * k; s.size1 = 0.9 * k;
      this.color(COL.waterMist, COL.waterMist);
      s.alpha = 0.45; s.fadeIn = 0.05; s.fadePow = 1.3; s.drag = 3; s.gravity = 0.5; s.cell = CELL.PUFF;
      this.alpha.emit(s);
    }
    // Spreading foam ring at the surface.
    const ring = this.at(x, y + 0.03, z);
    ring.life = 0.9; ring.size0 = 0.2 * k; ring.size1 = 1.6 * k;
    this.color(COL.water, COL.water);
    ring.alpha = 0.5; ring.fadePow = 1.2; ring.cell = CELL.RING;
    this.alpha.emit(ring);
  }

  /** Faint smoke trail puff behind a flying grenade. */
  fragTrail(x: number, y: number, z: number): void {
    const s = this.at(x, y, z);
    s.vy = 0.2;
    s.life = 0.5; s.size0 = 0.06; s.size1 = 0.22;
    this.color(COL.gunSmoke, COL.gunSmoke);
    s.alpha = 0.22; s.fadeIn = 0.1; s.fadePow = 1.2; s.drag = 2; s.rot = rnd(0, 6.28); s.cell = CELL.PUFF;
    this.alpha.emit(s);
  }

  update(dt: number): void {
    this.rings.update(dt);
  }

  dispose(): void {
    this.rings.dispose();
  }
}
