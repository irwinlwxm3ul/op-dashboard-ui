// Pose representation and blending math for the procedural soldier.
//
// A pose is a flat Float32Array of channels (joint angles, hips placement, hand IK targets, weapon
// placement). Poses blend linearly channel by channel, which is well behaved because every channel
// is either a small Euler angle, a position or a weight. The rig (rig.ts) turns a pose into bone
// matrices (forward kinematics + two-bone arm IK).
//
// Conventions (model space of the character, before the root yaw): feet at the origin, facing -Z,
// right +X, up +Y. Pitch = rotation about X (positive swings a downward limb FORWARD and tilts an
// upward segment BACKWARD), roll = rotation about Z (positive tilts an upward segment to the LEFT),
// yaw = rotation about Y (positive turns left). Knee > 0 bends the shin backward.

export const P = {
  // Hips (pelvis) placement in model space and orientation (Euler YXZ).
  HX: 0, HY: 1, HZ: 2, HPITCH: 3, HROLL: 4, HYAW: 5,
  // Spine (lumbar) and chest (thoracic) local rotations.
  SPITCH: 6, SROLL: 7, SYAW: 8,
  CPITCH: 9, CROLL: 10, CYAW: 11,
  // Head (neck joint).
  NPITCH: 12, NYAW: 13, NROLL: 14,
  // Legs: hip pitch (forward +), hip abduction (outward +), knee bend (+).
  LLP: 15, LLR: 16, LKNEE: 17,
  RLP: 18, RLR: 19, RKNEE: 20,
  // Left arm: hand target in chest space (C), in model space (R, weight RW), elbow pole direction in
  // chest space (P), weapon grip weight (GRIP: 1 = hand on the weapon's support point).
  LCX: 21, LCY: 22, LCZ: 23, LRX: 24, LRY: 25, LRZ: 26, LRW: 27, LPX: 28, LPY: 29, LPZ: 30, LGRIP: 31,
  // Right arm (GRIP: hand on the pistol grip).
  RCX: 32, RCY: 33, RCZ: 34, RRX: 35, RRY: 36, RRZ: 37, RRW: 38, RPX: 39, RPY: 40, RPZ: 41, RGRIP: 42,
  // Weapon: aim pivot (shoulder pocket) in chest space, extra pitch/yaw/roll, aim-follow factor
  // (how much of the aim pitch the weapon takes), holster blend (0 in hands .. 1 slung).
  WPX: 43, WPY: 44, WPZ: 45, WPITCH: 46, WYAW: 47, WROLL: 48, WAIM: 49, WHOLSTER: 50,
  // How much the aim pitch bends the torso / head (0..1).
  AIMBODY: 51,
} as const;

export const POSE_SIZE = 52;

export type Pose = Float32Array;

export function createPose(): Pose {
  return new Float32Array(POSE_SIZE);
}

export function copyPose(out: Pose, a: Pose): Pose {
  out.set(a);
  return out;
}

/** out = a + (b - a) * t */
export function lerpPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  for (let i = 0; i < POSE_SIZE; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** out += src * w */
export function accumulatePose(out: Pose, src: Pose, w: number): Pose {
  for (let i = 0; i < POSE_SIZE; i++) out[i] += src[i] * w;
  return out;
}

export function clearPose(out: Pose): Pose {
  out.fill(0);
  return out;
}

/** Frame-rate independent exponential approach of `cur` toward `target` per channel. */
export function dampPose(cur: Pose, target: Pose, k: number): Pose {
  for (let i = 0; i < POSE_SIZE; i++) cur[i] += (target[i] - cur[i]) * k;
  return cur;
}

/**
 * Normalise blend weights in place (sum = 1). Weights below `eps` are zeroed so callers can skip
 * evaluating those poses. Returns the number of active weights.
 */
export function normalizeWeights(w: Float32Array, eps = 1e-3): number {
  let sum = 0;
  for (let i = 0; i < w.length; i++) {
    if (w[i] < eps) w[i] = 0;
    sum += w[i];
  }
  let active = 0;
  if (sum <= 0) {
    w.fill(0);
    w[0] = 1;
    return 1;
  }
  for (let i = 0; i < w.length; i++) {
    w[i] /= sum;
    if (w[i] > 0) active++;
  }
  return active;
}

// ---------------------------------------------------------------------------
// Locomotion cadence
// ---------------------------------------------------------------------------

export type GaitKind = 'stand' | 'crouch' | 'prone' | 'swim' | 'downed';

/**
 * Stride length (m travelled per full gait cycle = two footfalls) for a gait at a horizontal speed.
 * The animation cycle frequency is speed / stride, so remote footsteps derived from velocity
 * (feel module: one step per half stride) stay in sync with the legs.
 */
export function strideLength(gait: GaitKind, speed: number, sprinting: boolean): number {
  switch (gait) {
    case 'crouch':
      return 1.1 + 0.6 * Math.min(1, speed / 2.7);
    case 'prone':
      return 1.15;
    case 'downed':
      return 1.0;
    case 'swim':
      return 2.2;
    default: {
      // Walk 1.4 m at a stroll, ~2.5 m at the 4.7 m/s run, ~3.2 m sprinting.
      const base = 1.4 + 1.1 * Math.min(1, speed / 4.7);
      return sprinting ? Math.max(base, 2.5 + 0.7 * Math.min(1, Math.max(0, (speed - 4.7) / 1.6))) : base;
    }
  }
}

/** Advance a gait phase (radians) for horizontal speed over dt. */
export function advancePhase(phase: number, speed: number, stride: number, dt: number): number {
  const p = phase + (speed / Math.max(0.2, stride)) * Math.PI * 2 * dt;
  return p > 1e4 ? p % (Math.PI * 2) : p;
}

// ---------------------------------------------------------------------------
// Small easing helpers used by pose generators
// ---------------------------------------------------------------------------

export const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (x: number): number => {
  const t = sat(x);
  return t * t * (3 - 2 * t);
};
export const easeInQuad = (x: number): number => {
  const t = sat(x);
  return t * t;
};
export const easeOutBack = (x: number, s = 1.6): number => {
  const t = sat(x) - 1;
  return 1 + t * t * ((s + 1) * t + s);
};
