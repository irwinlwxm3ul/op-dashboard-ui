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
  const turn = steer * c.wheelTurn; // clockwise from the driver's view for a right turn
  const upY = Math.cos(c.tilt), upZ = Math.sin(c.tilt);
  const thL = Math.PI - 0.45 - turn; // ~10 o'clock
  const thR = 0.45 - turn; // ~2 o'clock
  out[0] = c.center[0] + c.radius * Math.cos(thL);
  out[1] = c.center[1] + c.radius * Math.sin(thL) * upY;
  out[2] = c.center[2] + c.radius * Math.sin(thL) * upZ;
  out[3] = c.center[0] + c.radius * Math.cos(thR);
  out[4] = c.center[1] + c.radius * Math.sin(thR) * upY;
  out[5] = c.center[2] + c.radius * Math.sin(thR) * upZ;
}
