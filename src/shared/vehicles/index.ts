// Vehicles module public API (see ARCHITECTURE.md).
//
// Frame conventions:
// * VehicleState.pos is the centre of the collision OBB (VehicleDef.halfExtents). Resting on flat
//   ground, pos.y = ground + rideHeight(def) (= groundClearance + halfExtents.y).
// * Orientation R = Ry(yaw) * Rx(pitch) * Rz(roll) — three.js Euler(pitch, yaw, roll, 'YXZ').
//   yaw > 0 turns left, pitch > 0 nose up, roll > 0 right side up (bike leaning left).
// * Local space: +X right, +Y up, -Z forward. Seat offsets give the seated occupant's body origin
//   (feet level; hips SEAT_HIP_HEIGHT above, eyes at the physics SEATED_EYE_HEIGHT above).
// * VehicleControls.steer / VehicleState.steer > 0 = steer right. rpm 0 = engine off.

export type { VehicleDef, VehicleHandling, CircleSet } from './defs';
export { VEHICLES, HANDLING, WHEELS, CIRCLES, SEAT_HIP_HEIGHT, rideHeight } from './defs';
export type { VehicleControls, VehicleStepEvents } from './physics';
export { createVehicle, stepVehicle, BOOST_MUL, IDLE_RPM, MAX_RPM } from './physics';
export type { Basis } from './geometry';
export {
  seatWorldPosition, exitPosition, raycastVehicle, vehicleHitsPoint,
  basisFromAngles, makeBasis, localToWorld, worldToLocal,
} from './geometry';
export { crashDamage } from './damage';
