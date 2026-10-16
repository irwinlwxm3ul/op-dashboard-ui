// Small numeric helpers for generation. Only IEEE-exact operations (+ - * / sqrt) are used in
// anything that drives placement decisions, so Node and every browser engine generate the same
// world bit for bit (Math.hypot and transcendental functions are not correctly rounded everywhere).

/** Euclidean length of (dx, dz). */
export function len2(dx: number, dz: number): number {
  return Math.sqrt(dx * dx + dz * dz);
}
