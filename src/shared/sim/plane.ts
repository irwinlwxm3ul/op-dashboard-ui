// Plane flight path: a straight line through a point near the island centre with a random
// heading, starting and ending beyond the map edges. Deterministic from the match seed.

import { PLANE_ALTITUDE, PLANE_SPEED } from '../constants';
import type { Rng } from '../rng';
import type { PlaneState, Vec3, World } from '../types';
import { PLANE_CENTER_SPREAD, PLANE_EDGE_MARGIN } from './tuning';

export function createPlane(world: World, rng: Rng, startTime: number): PlaneState {
  const heading = rng.next() * Math.PI * 2;
  const ca = rng.next() * Math.PI * 2;
  const cr = Math.sqrt(rng.next()) * PLANE_CENTER_SPREAD;
  const px = Math.cos(ca) * cr, pz = Math.sin(ca) * cr;
  const dx = Math.cos(heading), dz = Math.sin(heading);
  // Distance from P along +/-d to the square |x|,|z| = half + margin (slab intersection).
  const lim = world.half + PLANE_EDGE_MARGIN;
  const tFwd = exitDistance(px, pz, dx, dz, lim);
  const tBack = exitDistance(px, pz, -dx, -dz, lim);
  const start = { x: px - dx * tBack, z: pz - dz * tBack };
  const end = { x: px + dx * tFwd, z: pz + dz * tFwd };
  return {
    start,
    end,
    altitude: PLANE_ALTITUDE,
    speed: PLANE_SPEED,
    startTime,
    traveled: 0,
    length: Math.hypot(end.x - start.x, end.z - start.z),
    active: true,
  };
}

function exitDistance(px: number, pz: number, dx: number, dz: number, lim: number): number {
  let t = Infinity;
  if (Math.abs(dx) > 1e-9) t = Math.min(t, ((dx > 0 ? lim : -lim) - px) / dx);
  if (Math.abs(dz) > 1e-9) t = Math.min(t, ((dz > 0 ? lim : -lim) - pz) / dz);
  return Number.isFinite(t) ? Math.max(0, t) : lim;
}

/** Plane position after `traveled` metres (writes into out). */
export function planePosition(plane: PlaneState, out: Vec3): Vec3 {
  const f = plane.length > 0 ? Math.min(1, plane.traveled / plane.length) : 0;
  out.x = plane.start.x + (plane.end.x - plane.start.x) * f;
  out.y = plane.altitude;
  out.z = plane.start.z + (plane.end.z - plane.start.z) * f;
  return out;
}

/** Unit flight direction on XZ. */
export function planeDirection(plane: PlaneState, out: { x: number; z: number }): { x: number; z: number } {
  const l = plane.length > 0 ? plane.length : 1;
  out.x = (plane.end.x - plane.start.x) / l;
  out.z = (plane.end.z - plane.start.z) / l;
  return out;
}
