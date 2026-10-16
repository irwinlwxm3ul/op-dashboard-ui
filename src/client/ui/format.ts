// Pure formatting / HUD math helpers (no DOM, no i18n state) so they stay trivially testable.

const RAD2DEG = 180 / Math.PI;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Positive modulo. */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * Compass bearing in degrees [0, 360) for a camera yaw. yaw 0 faces -Z (north), positive yaw turns
 * left (counter-clockwise from above), compass bearings increase clockwise (east = 90).
 */
export function bearingFromYaw(yaw: number): number {
  return mod(-yaw * RAD2DEG, 360);
}

/** Compass bearing from (ax, az) toward (bx, bz). North = -Z, east = +X. */
export function bearingTo(ax: number, az: number, bx: number, bz: number): number {
  return mod(Math.atan2(bx - ax, -(bz - az)) * RAD2DEG, 360);
}

/** Signed smallest difference target - heading in degrees, in (-180, 180]. */
export function relBearing(heading: number, target: number): number {
  const d = mod(target - heading + 180, 360) - 180;
  return d === -180 ? 180 : d;
}

/** m/s → km/h (rounded, absolute). */
export const kmh = (mps: number): number => Math.round(Math.abs(mps) * 3.6);

/**
 * Pixel half-gap of a crosshair representing a cone half-angle `spread` (radians) for a vertical
 * FOV `fovDeg` on a viewport `viewportH` CSS pixels tall.
 */
export function spreadToPixels(spread: number, fovDeg: number, viewportH: number): number {
  const half = (Math.max(1, fovDeg) * Math.PI) / 360;
  return (Math.tan(Math.max(0, spread)) / Math.tan(half)) * (viewportH / 2);
}

/** Distance (m) from a point to the edge of a circle; <= 0 inside. */
export function distOutsideCircle(x: number, z: number, cx: number, cz: number, r: number): number {
  return Math.hypot(x - cx, z - cz) - r;
}

/** Health colour: white when healthy, through amber to red when critical. Returns "r,g,b". */
export function healthRgb(health: number): string {
  // 60+ → white, 15- → red.
  const k = clamp01((health - 15) / 45);
  const r = 255;
  const g = Math.round(64 + (246 - 64) * k);
  const b = Math.round(52 + (238 - 52) * k);
  return `${r},${g},${b}`;
}

/** PUBG-style boost bar segments (sum 100). */
export const BOOST_SEGMENTS: readonly number[] = [20, 40, 30, 10];

/** Fill fraction of boost segment `i` for a boost value 0..100. */
export function boostSegmentFill(boost: number, i: number): number {
  let start = 0;
  for (let k = 0; k < i; k++) start += BOOST_SEGMENTS[k];
  return clamp01((boost - start) / BOOST_SEGMENTS[i]);
}

/** Map grid label: column letter (A..) for index. */
export function gridColumnLabel(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

/** Remaining seconds rounded up (for countdowns). */
export const ceilSeconds = (s: number): number => Math.max(0, Math.ceil(s - 1e-6));

/** Accuracy in percent from hits / shots. */
export const percent = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

/** Exponential approach factor (frame-rate independent). */
export const approach = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);
