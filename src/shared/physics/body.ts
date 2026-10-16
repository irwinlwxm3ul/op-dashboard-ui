// Body dimensions and eye placement.

import { EYE_HEIGHT, STANCE_HEIGHT } from '../constants';
import type { MovementMode, Stance, Vec3 } from '../types';
import { LEAN_DROP, LEAN_OFFSET, PRONE_EYE_FORWARD, SEATED_EYE_HEIGHT } from './tuning';

/** Collision cylinder height for a stance. */
export function bodyHeight(stance: Stance): number {
  return STANCE_HEIGHT[stance] ?? STANCE_HEIGHT.stand;
}

/**
 * Eye (camera / muzzle origin) position for a body whose `pos` is the feet (or the seat for
 * mode 'vehicle'). Standing / crouching use EYE_HEIGHT; prone puts the eye at the face, slightly
 * ahead of the body centre but still inside the collision radius; seated eyes are
 * SEATED_EYE_HEIGHT above the seat; drop modes and swimming use the standing eye.
 * Lean (-1..1) shifts the eye LEAN_OFFSET * lean along right(yaw) and lowers it LEAN_DROP * |lean|;
 * lean is ignored while lying down and in the plane.
 */
export function eyePosition(
  body: { pos: Vec3; stance: Stance; mode: MovementMode },
  lean: number,
  yaw: number,
  out: Vec3 = { x: 0, y: 0, z: 0 },
): Vec3 {
  const p = body.pos;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  let x = p.x, y = p.y, z = p.z;
  let canLean = true;
  if (body.mode === 'vehicle') {
    y += SEATED_EYE_HEIGHT;
  } else if (body.mode === 'ground' && body.stance === 'prone') {
    y += EYE_HEIGHT.prone;
    // forward(yaw) = (-sin, 0, -cos)
    x -= sy * PRONE_EYE_FORWARD;
    z -= cy * PRONE_EYE_FORWARD;
    canLean = false;
  } else if (body.mode === 'ground' && body.stance === 'crouch') {
    y += EYE_HEIGHT.crouch;
  } else {
    if (body.mode === 'plane') canLean = false;
    y += EYE_HEIGHT.stand;
  }
  if (canLean && lean !== 0 && Number.isFinite(lean)) {
    const l = lean < -1 ? -1 : lean > 1 ? 1 : lean;
    // right(yaw) = (cos, 0, -sin)
    x += cy * LEAN_OFFSET * l;
    z -= sy * LEAN_OFFSET * l;
    y -= LEAN_DROP * (l < 0 ? -l : l);
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
