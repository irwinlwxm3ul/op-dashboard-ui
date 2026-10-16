// Pure LOD helpers (no three.js): band selection with hysteresis and AABB distances.

/**
 * Selects a distance band with hysteresis. `edges` are ascending band boundaries; band i covers
 * [edges[i-1], edges[i]) and band edges.length is "beyond the last edge". An object only moves to a
 * farther band once it is `hysteresis` meters past the boundary and only moves back once it is
 * `hysteresis` meters inside it, so objects sitting on a boundary never flicker.
 * `current < 0` means "no band yet" (plain selection).
 */
export function selectBand(dist: number, current: number, edges: ArrayLike<number>, hysteresis: number): number {
  const n = edges.length;
  if (current < 0) {
    let b = 0;
    while (b < n && dist >= edges[b]) b++;
    return b;
  }
  let outward = 0;
  while (outward < n && dist >= edges[outward] + hysteresis) outward++;
  if (outward > current) return outward;
  let inward = 0;
  while (inward < n && dist >= edges[inward] - hysteresis) inward++;
  if (inward < current) return inward;
  return current;
}

/** Euclidean distance from a point to an axis-aligned box (0 inside). */
export function distanceToAabb(
  px: number, py: number, pz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Distance from a point to the farthest corner of an axis-aligned box. */
export function maxDistanceToAabb(
  px: number, py: number, pz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  const dx = Math.max(Math.abs(px - minX), Math.abs(px - maxX));
  const dy = Math.max(Math.abs(py - minY), Math.abs(py - maxY));
  const dz = Math.max(Math.abs(pz - minZ), Math.abs(pz - maxZ));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Reference vertical FOV (degrees) for LOD distances; narrower FOVs (scopes) scale distances down. */
export const LOD_REFERENCE_FOV = 70;

/**
 * LOD distance multiplier for a vertical FOV: zooming in by k makes objects look k times closer,
 * so effective LOD distance = distance * lodScale. Clamped so an 8x scope still culls sensibly.
 */
export function lodScaleForFov(fovDeg: number): number {
  if (!(fovDeg > 0)) return 1;
  const ref = Math.tan((LOD_REFERENCE_FOV * Math.PI) / 360);
  const cur = Math.tan((Math.min(fovDeg, 120) * Math.PI) / 360);
  return Math.min(1, Math.max(0.12, cur / ref));
}
