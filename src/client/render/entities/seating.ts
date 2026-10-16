// Shared layout of the driver controls (steering wheel / handlebars) relative to the driver seat
// origin, used both to build the vehicle models and to put the driver's hands on them, so the two
// always agree.

import type { VehicleType } from '../../../shared/types';

export interface DriverControls {
  /** Steering wheel centre (cars) or handlebar steering axis top (bike), relative to seat 0 origin. */
  center: readonly [number, number, number];
  /** Wheel radius (cars) / half handlebar width (bike). */
  radius: number;
  /** Wheel plane tilt toward the driver (rad). */
  tilt: number;
  /** Steering wheel turns per unit of normalised steer (rad). */
  wheelTurn: number;
  bike: boolean;
}

export const DRIVER_CONTROLS: Record<VehicleType, DriverControls> = {
  buggy: { center: [0, 0.84, -0.46], radius: 0.16, tilt: 0.5, wheelTurn: 1.7, bike: false },
  uaz: { center: [0, 0.86, -0.43], radius: 0.18, tilt: 0.42, wheelTurn: 1.6, bike: false },
  bike: { center: [0, 0.74, -0.56], radius: 0.33, tilt: 0, wheelTurn: 0.5, bike: true },
};

/**
 * Driver hand targets relative to the seat origin (vehicle-local orientation), written into
 * out[0..2] (left) and out[3..5] (right). `steer` is the normalised steering (-1..1, + right).
 */
export function driverHandTargets(type: VehicleType, steer: number, out: Float32Array | number[]): void {
  const c = DRIVER_CONTROLS[type];
  if (c.bike) {
    // Handlebar rotates about the (vertical-ish) steering axis: right turn moves the left grip forward.
    const a = -steer * c.wheelTurn;
    const ca = Math.cos(a), sa = Math.sin(a);
    // Grip at local (x, 0, 0) around the axis -> (x cos a, 0, -x sin a)
    const lx = -c.radius, rx = c.radius;
    out[0] = c.center[0] + lx * ca; out[1] = c.center[1]; out[2] = c.center[2] - lx * sa;
    out[3] = c.center[0] + rx * ca; out[4] = c.center[1]; out[5] = c.center[2] - rx * sa;
    return;
  }
  // Clockwise from the driver's view for a right turn.
  ringGrips(c.center[0], c.center[1], c.center[2], c.radius, Math.cos(c.tilt), Math.sin(c.tilt), steer * c.wheelTurn, out);
}

/** Hand positions on a steering wheel ring (~10 and ~2 o'clock, rotated by the steering). */
export function ringGrips(
  cx: number, cy: number, cz: number, radius: number, upY: number, upZ: number, turn: number,
  out: Float32Array | number[], at = 0,
): void {
  const thL = Math.PI - 0.45 - turn;
  const thR = 0.45 - turn;
  out[at] = cx + radius * Math.cos(thL);
  out[at + 1] = cy + radius * Math.sin(thL) * upY;
  out[at + 2] = cz + radius * Math.sin(thL) * upZ;
  out[at + 3] = cx + radius * Math.cos(thR);
  out[at + 4] = cy + radius * Math.sin(thR) * upY;
  out[at + 5] = cz + radius * Math.sin(thR) * upZ;
}

// ---------------------------------------------------------------------------------------------
// Rider contact points on the real (glTF) vehicle models, vehicle-local (OBB centre origin, -Z
// forward). The models carry no steering-wheel / grip / peg nodes, so these were measured on the
// meshes (markers rendered over the models from the driver's eye and from the side).
// ---------------------------------------------------------------------------------------------

/** UAZ steering wheel: rim centre, radius and in-plane "up" (the top of the rim leans forward). */
export const UAZ_MODEL_WHEEL = { center: [-0.41, 0.245, -0.63], radius: 0.175, upY: 0.905, upZ: -0.426 } as const;
/** Bike: right handlebar grip centre in Fork-node space (the left grip mirrors x). */
export const BIKE_MODEL_GRIP = [0.385, 0.952, 0.054] as const;
/** Bike footpeg tops (right side, the left mirrors x): [driver, passenger]. */
export const BIKE_MODEL_PEGS = [[0.2, -0.345, 0.1], [0.19, -0.27, 0.52]] as const;
/** Procedural bike footpeg tops (same layout; see vehicles.ts buildBike). */
export const BIKE_PROC_PEGS = [[0.2, -0.235, 0.05], [0.19, -0.205, 0.5]] as const;
