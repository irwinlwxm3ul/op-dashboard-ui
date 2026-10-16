// Tiny math helpers for hot paths (Math.hypot is markedly slower than sqrt in V8).

/** Length of the 2D vector (x, z). */
export function hyp(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}
