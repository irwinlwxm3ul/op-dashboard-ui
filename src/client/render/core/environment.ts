// Lighting / atmosphere constants: a sunny late-morning Eastern-European island.
// All colours are sRGB hex values (three.js converts them to the linear working space).
// Calibrated for ACES filmic tone mapping at exposure 1: lit grass reads olive green,
// shadow sides keep detail, the haze is a pale blue-grey that the sky fades into.

import * as THREE from 'three';

/** Sun elevation above the horizon (degrees). */
export const SUN_ELEVATION_DEG = 48;
/** Sun azimuth, clockwise from north (-Z) toward east (+X) (degrees): south-east, late morning. */
export const SUN_AZIMUTH_DEG = 140;

export const ENV = {
  exposure: 1.0,
  sunColor: 0xfff0d8,
  sunIntensity: 2.8,
  hemiSky: 0xbcd6f0,
  hemiGround: 0x6f6b52,
  hemiIntensity: 2.35,
  /** Horizon haze. Distant terrain fades into exactly this colour and so does the sky at the horizon. */
  fogColor: 0xb9c9d6,
  /** FogExp2 density: ~83 % fogged at 700 m, ~92 % at 800 m, ~95 % at 900 m. */
  fogDensity: 0.0019,
  skyZenith: 0x3f7fc8,
  skyHorizon: 0xb2c6d9,
  /** Water body colours (sRGB). */
  waterDeep: 0x1d4a5e,
  waterShallow: 0x3d8a86,
  /** Camera clip planes (spec). */
  near: 0.05,
  far: 2500,
} as const;

/** Normalised direction toward the sun. */
export function computeSunDirection(out = new THREE.Vector3()): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
  const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
