// Bot difficulty profiles. Everything that makes a bot better or worse lives here so tuning is
// one table. Bots must stay beatable and fun: even "hard" bots react in a human-like quarter
// second, need time to settle their aim and only partially control recoil.

import type { BotDifficulty } from '../types';

const DEG = Math.PI / 180;

export interface BotSkill {
  /** Seconds between first seeing an enemy and the first shot (randomised +-20 %). */
  reaction: number;
  /** Aim error (radians, 1 sigma) right after acquiring a target. */
  aimErrorStart: number;
  /** Floor of the aim error while tracking a target for a long time (radians). */
  aimErrorMin: number;
  /** Exponential convergence rate of the aim error while tracking (1/s). */
  aimConverge: number;
  /** Extra error per rad/s of target angular velocity (tracking lag). */
  trackingLag: number;
  /** Max turn rate of the view (rad/s). */
  turnRate: number;
  /** Proportional gain of the view controller (1/s): higher snaps faster within the turn rate. */
  aimGain: number;
  /** Maximum vision range (m). */
  visionRange: number;
  /** Half angle of the view cone (radians). */
  fovHalf: number;
  /** Fraction of hearing radius actually noticed. */
  hearing: number;
  /** Fraction of the server-side recoil that the bot pulls against. */
  recoilComp: number;
  /** Fraction of target velocity used when leading (1 = perfect lead). */
  leadAccuracy: number;
  /** Probability of aiming at the head instead of the chest when a new aim point is chosen. */
  headshotBias: number;
  /** Full-auto burst length range at mid range (shots). */
  burstMin: number;
  burstMax: number;
  /** Pause between bursts (s). */
  burstPause: number;
  /** Minimum interval between semi-auto taps at range (s). */
  tapInterval: number;
  /** 0..1: how much the bot strafes / crouch-peeks while fighting. */
  strafe: number;
  /** 0..1: chance to look for cover when hurt. */
  useCover: number;
  /** Health below which the bot disengages to find cover (if it uses cover). */
  coverHealth: number;
  /** 0..1: healing intelligence (item choice, healing before fights, energy drinks). */
  healSmart: number;
  /** Chance per think (while an enemy hides behind cover) to throw a frag. */
  fragChance: number;
  /** 0..1: aggressiveness (pushes last known positions / investigates noises). */
  aggression: number;
}

export const BOT_SKILLS: Record<BotDifficulty, BotSkill> = {
  easy: {
    reaction: 0.8,
    aimErrorStart: 6.5 * DEG,
    aimErrorMin: 1.6 * DEG,
    aimConverge: 0.9,
    trackingLag: 0.55,
    turnRate: 3.2,
    aimGain: 7,
    visionRange: 150,
    fovHalf: 65 * DEG,
    hearing: 0.6,
    recoilComp: 0.3,
    leadAccuracy: 0.45,
    headshotBias: 0.03,
    burstMin: 4,
    burstMax: 9,
    burstPause: 0.55,
    tapInterval: 0.42,
    strafe: 0.2,
    useCover: 0.2,
    coverHealth: 25,
    healSmart: 0.25,
    fragChance: 0.02,
    aggression: 0.35,
  },
  normal: {
    reaction: 0.45,
    aimErrorStart: 4.2 * DEG,
    aimErrorMin: 0.9 * DEG,
    aimConverge: 1.5,
    trackingLag: 0.35,
    turnRate: 5.5,
    aimGain: 10,
    visionRange: 250,
    fovHalf: 70 * DEG,
    hearing: 0.8,
    recoilComp: 0.6,
    leadAccuracy: 0.75,
    headshotBias: 0.1,
    burstMin: 3,
    burstMax: 7,
    burstPause: 0.4,
    tapInterval: 0.3,
    strafe: 0.55,
    useCover: 0.6,
    coverHealth: 35,
    healSmart: 0.6,
    fragChance: 0.05,
    aggression: 0.5,
  },
  hard: {
    reaction: 0.25,
    aimErrorStart: 2.8 * DEG,
    aimErrorMin: 0.45 * DEG,
    aimConverge: 2.3,
    trackingLag: 0.2,
    turnRate: 8,
    aimGain: 14,
    visionRange: 400,
    fovHalf: 72 * DEG,
    hearing: 1,
    recoilComp: 0.85,
    leadAccuracy: 0.92,
    headshotBias: 0.22,
    burstMin: 3,
    burstMax: 5,
    burstPause: 0.28,
    tapInterval: 0.2,
    strafe: 0.85,
    useCover: 0.9,
    coverHealth: 45,
    healSmart: 0.95,
    fragChance: 0.09,
    aggression: 0.65,
  },
};

export function skillFor(d: BotDifficulty): BotSkill {
  return BOT_SKILLS[d] ?? BOT_SKILLS.normal;
}
