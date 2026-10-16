// Crash damage model. `impact` is the closing speed along the contact normal (m/s) as reported by
// stepVehicle (wall / tree / rock / vehicle hits and hard landings).

import type { VehicleType } from '../types';

interface CrashTuning {
  /** Impacts below this do not damage the vehicle (m/s). */
  vehicleStart: number;
  vehicleScale: number;
  /** Impacts below this do not hurt occupants (m/s). */
  occupantStart: number;
  occupantScale: number;
}

/** Superlinear growth exponents (shared by all vehicle types). */
const VEHICLE_EXP = 1.7;
const OCCUPANT_EXP = 1.5;

const CRASH: Record<VehicleType, CrashTuning> = {
  // 30 m/s into a wall: ~600 of 1000 hp; 12 m/s: ~55 hp.
  buggy: { vehicleStart: 6, vehicleScale: 2.7, occupantStart: 10, occupantScale: 1.0 },
  // Sturdy: same absolute damage scale but more health; occupants slightly protected by the cab.
  uaz: { vehicleStart: 6.5, vehicleScale: 2.6, occupantStart: 10.5, occupantScale: 0.92 },
  // Fragile: starts earlier and grows faster; the rider is fully exposed.
  bike: { vehicleStart: 4.5, vehicleScale: 2.9, occupantStart: 9.5, occupantScale: 1.05 },
};

/**
 * Damage for one crash. Vehicle damage grows superlinearly above ~6 m/s (bike earlier); occupant
 * damage (health points, before armour) starts above ~10 m/s: a 12 m/s bump costs a few hp, a
 * 30 m/s head-on wall crash nearly kills an unarmoured occupant. Monotonic in `impact`.
 */
export function crashDamage(impact: number, type: VehicleType): { vehicle: number; occupants: number } {
  const c = CRASH[type] ?? CRASH.buggy;
  const s = Number.isFinite(impact) ? Math.abs(impact) : 0;
  const ve = s - c.vehicleStart;
  const oe = s - c.occupantStart;
  return {
    vehicle: ve > 0 ? c.vehicleScale * Math.pow(ve, VEHICLE_EXP) : 0,
    occupants: oe > 0 ? c.occupantScale * Math.pow(oe, OCCUPANT_EXP) : 0,
  };
}
