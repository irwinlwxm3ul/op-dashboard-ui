// 1 m resolution occupancy raster used only during generation to keep features apart
// (roads, buildings, door aprons, props, towns, vegetation spacing).

export const M_ROAD = 1;
/** Building footprint + 1 m. */
export const M_BUILDING = 2;
/** Space in front of doors. */
export const M_APRON = 4;
/** Prop footprint + margin. */
export const M_PROP = 8;
/** Inside a town radius. */
export const M_TOWN = 16;
/** Tree spacing. */
export const M_TREE = 32;
/** Rock footprint. */
export const M_ROCK = 64;
/** Vegetation exclusion around buildings / props / doors. */
export const M_NOVEG = 128;

export class OccupancyMask {
  readonly n: number;
  readonly half: number;
  readonly bits: Uint8Array;

  constructor(size: number) {
    this.n = Math.ceil(size);
    this.half = size / 2;
    this.bits = new Uint8Array(this.n * this.n);
  }

  private c(v: number): number {
    const i = Math.floor(v + this.half);
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }

  get(x: number, z: number): number {
    return this.bits[this.c(z) * this.n + this.c(x)];
  }

  markRect(x0: number, z0: number, x1: number, z1: number, bit: number): void {
    const ia = this.c(x0), ib = this.c(x1), ja = this.c(z0), jb = this.c(z1);
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) this.bits[j * this.n + i] |= bit;
  }

  /** True if any cell overlapping the rectangle has one of `bits`. */
  anyRect(x0: number, z0: number, x1: number, z1: number, bits: number): boolean {
    const ia = this.c(x0), ib = this.c(x1), ja = this.c(z0), jb = this.c(z1);
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) if (this.bits[j * this.n + i] & bits) return true;
    return false;
  }

  markCircle(x: number, z: number, r: number, bit: number): void {
    const ia = this.c(x - r), ib = this.c(x + r), ja = this.c(z - r), jb = this.c(z + r);
    const r2 = (r + 0.71) * (r + 0.71);
    for (let j = ja; j <= jb; j++) {
      const cz = j - this.half + 0.5 - z;
      for (let i = ia; i <= ib; i++) {
        const cx = i - this.half + 0.5 - x;
        if (cx * cx + cz * cz <= r2) this.bits[j * this.n + i] |= bit;
      }
    }
  }

  anyCircle(x: number, z: number, r: number, bits: number): boolean {
    const ia = this.c(x - r), ib = this.c(x + r), ja = this.c(z - r), jb = this.c(z + r);
    const r2 = (r + 0.71) * (r + 0.71);
    for (let j = ja; j <= jb; j++) {
      const cz = j - this.half + 0.5 - z;
      for (let i = ia; i <= ib; i++) {
        const cx = i - this.half + 0.5 - x;
        if (cx * cx + cz * cz <= r2 && this.bits[j * this.n + i] & bits) return true;
      }
    }
    return false;
  }
}
