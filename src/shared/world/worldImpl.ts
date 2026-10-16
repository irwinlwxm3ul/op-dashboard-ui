// Concrete World implementation: plain data arrays plus spatial grids that back the queries.
// Generation code fills the arrays and calls reindex*() once a category is complete; the same
// object is then returned to callers (methods are arrow properties so they survive destructuring).

import { WATER_LEVEL } from '../constants';
import type {
  BoxKind, BuildingDef, BushDef, LootSpawn, MapKind, RoadSegment, RockDef, SurfaceMaterial, TownDef,
  TrainingLayout, TreeDef, Vec3, VehicleSpawn, World, WorldBox,
} from '../types';
import { SpatialGrid } from './grid';
import { Heightfield } from './heightfield';
import { SURFACE_LIST } from './surfaces';

/** Cell sizes (m) of the query grids. */
const BOX_CELL = 8;
const VEG_CELL = 16;

export class GeneratedWorld implements World {
  readonly seed: number;
  readonly kind: MapKind;
  readonly size: number;
  readonly half: number;
  readonly res: number;
  readonly cell: number;
  readonly heights: Float32Array;
  readonly surface: Uint8Array;
  readonly waterLevel = WATER_LEVEL;
  boxes: WorldBox[] = [];
  buildings: BuildingDef[] = [];
  trees: TreeDef[] = [];
  rocks: RockDef[] = [];
  bushes: BushDef[] = [];
  roads: RoadSegment[] = [];
  towns: TownDef[] = [];
  lootSpawns: LootSpawn[] = [];
  vehicleSpawns: VehicleSpawn[] = [];
  training: TrainingLayout | null = null;

  readonly hf: Heightfield;
  private boxGrid: SpatialGrid;
  private treeGrid: SpatialGrid;
  private rockGrid: SpatialGrid;

  constructor(seed: number, kind: MapKind, hf: Heightfield) {
    this.seed = seed;
    this.kind = kind;
    this.hf = hf;
    this.size = hf.size;
    this.half = hf.half;
    this.res = hf.res;
    this.cell = hf.cell;
    this.heights = hf.h;
    this.surface = new Uint8Array(hf.res * hf.res);
    const empty = new Float64Array(0);
    this.boxGrid = new SpatialGrid(this.half, BOX_CELL, empty, 0);
    this.treeGrid = new SpatialGrid(this.half, VEG_CELL, empty, 0);
    this.rockGrid = new SpatialGrid(this.half, VEG_CELL, empty, 0);
  }

  /** Rebuild the box grid after boxes were added. */
  reindexBoxes(): void {
    const n = this.boxes.length, b = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const bx = this.boxes[i];
      b[i * 4] = bx.min.x;
      b[i * 4 + 1] = bx.min.z;
      b[i * 4 + 2] = bx.max.x;
      b[i * 4 + 3] = bx.max.z;
    }
    this.boxGrid = new SpatialGrid(this.half, BOX_CELL, b, n);
  }

  /** Rebuild the tree and rock grids. */
  reindexVegetation(): void {
    const nt = this.trees.length, bt = new Float64Array(nt * 4);
    for (let i = 0; i < nt; i++) {
      const t = this.trees[i];
      bt[i * 4] = t.x - t.r;
      bt[i * 4 + 1] = t.z - t.r;
      bt[i * 4 + 2] = t.x + t.r;
      bt[i * 4 + 3] = t.z + t.r;
    }
    this.treeGrid = new SpatialGrid(this.half, VEG_CELL, bt, nt);
    const nr = this.rocks.length, br = new Float64Array(nr * 4);
    for (let i = 0; i < nr; i++) {
      const r = this.rocks[i];
      br[i * 4] = r.x - r.r;
      br[i * 4 + 1] = r.z - r.r;
      br[i * 4 + 2] = r.x + r.r;
      br[i * 4 + 3] = r.z + r.r;
    }
    this.rockGrid = new SpatialGrid(this.half, VEG_CELL, br, nr);
  }

  heightAt = (x: number, z: number): number => this.hf.heightAt(x, z);

  normalAt = (x: number, z: number, out: Vec3 = { x: 0, y: 1, z: 0 }): Vec3 => this.hf.normalAt(x, z, out);

  /** Terrain surface at the nearest heightmap vertex; 'water' where the terrain is under water. */
  surfaceAt = (x: number, z: number): SurfaceMaterial => {
    if (this.hf.heightAt(x, z) < this.waterLevel) return 'water';
    const res = this.res, last = res - 1;
    let ix = Math.round((x + this.half) / this.cell), iz = Math.round((z + this.half) / this.cell);
    if (!(ix > 0)) ix = 0; else if (ix > last) ix = last;
    if (!(iz > 0)) iz = 0; else if (iz > last) iz = last;
    return SURFACE_LIST[this.surface[iz * res + ix]] ?? 'grass';
  };

  /**
   * Highest walkable surface under (x, z) whose height is at or below fromY + 0.01: the terrain or
   * the top of any box containing the point in XZ. The terrain is always a candidate (it is the
   * answer when fromY lies below it).
   */
  groundAt = (x: number, z: number, fromY: number = Infinity): number => {
    let g = this.hf.heightAt(x, z);
    const lim = fromY + 0.01;
    const grid = this.boxGrid;
    if (grid.count === 0 || !(Math.abs(x) <= this.half && Math.abs(z) <= this.half)) return g;
    const c = grid.cellAt(x, z), boxes = this.boxes;
    for (let k = grid.cellBegin(c), e = grid.cellEnd(c); k < e; k++) {
      const b = boxes[grid.itemAt(k)];
      const top = b.max.y;
      if (top > g && top <= lim && x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) g = top;
    }
    return g;
  };

  inBounds = (x: number, z: number): boolean => Math.abs(x) <= this.half && Math.abs(z) <= this.half;

  /** Boxes whose XZ footprint overlaps the rectangle (inclusive). `out` is cleared first. */
  queryBoxes = (minX: number, minZ: number, maxX: number, maxZ: number, out: WorldBox[]): WorldBox[] =>
    this.boxGrid.query(minX, minZ, maxX, maxZ, this.boxes, out);

  /** Trees whose trunk circle bounds overlap the rectangle. `out` is cleared first. */
  queryTrees = (minX: number, minZ: number, maxX: number, maxZ: number, out: TreeDef[]): TreeDef[] =>
    this.treeGrid.query(minX, minZ, maxX, maxZ, this.trees, out);

  /** Rocks whose collision circle bounds overlap the rectangle. `out` is cleared first. */
  queryRocks = (minX: number, minZ: number, maxX: number, maxZ: number, out: RockDef[]): RockDef[] =>
    this.rockGrid.query(minX, minZ, maxX, maxZ, this.rocks, out);
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Append an axis-aligned box (coordinates are normalised and rounded to millimetres). Degenerate
 * boxes (any extent < 2 mm) are skipped. Returns the new box id or -1.
 */
export function pushBox(
  boxes: WorldBox[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  kind: BoxKind, material: SurfaceMaterial, color: number, building: number, blocksBullets = true,
): number {
  const ax = r3(Math.min(x0, x1)), bx = r3(Math.max(x0, x1));
  const ay = r3(Math.min(y0, y1)), by = r3(Math.max(y0, y1));
  const az = r3(Math.min(z0, z1)), bz = r3(Math.max(z0, z1));
  if (bx - ax < 0.002 || by - ay < 0.002 || bz - az < 0.002) return -1;
  const id = boxes.length;
  boxes.push({
    id,
    min: { x: ax, y: ay, z: az },
    max: { x: bx, y: by, z: bz },
    kind, material, color, building, blocksBullets,
  });
  return id;
}
