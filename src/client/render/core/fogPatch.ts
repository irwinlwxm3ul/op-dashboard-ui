// Altitude-aware exponential fog. The haze is tuned so terrain fades out at 700-900 m for players
// on the ground; seen from the plane / during the drop (camera 80-340 m up) that much haze would
// wash the island out, so the fog density eases down with camera height (real haze is densest
// near the ground). Patches three's global fog chunk once so every fogged material (including
// other modules') stays consistent. Idempotent; skipped if the chunk layout changes.

import * as THREE from 'three';

const MARKER = '/* dz-altitude-fog */';
const ORIGINAL = 'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );';
const PATCHED =
  MARKER +
  ' float dzFogDensity = fogDensity * mix( 1.0, 0.55, smoothstep( 80.0, 340.0, cameraPosition.y ) );\n' +
  '\t\tfloat fogFactor = 1.0 - exp( - dzFogDensity * dzFogDensity * vFogDepth * vFogDepth );';

export function installAltitudeFog(): boolean {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks.fog_fragment;
  if (typeof src !== 'string') return false;
  if (src.includes(MARKER)) return true;
  if (!src.includes(ORIGINAL)) return false;
  chunks.fog_fragment = src.replace(ORIGINAL, PATCHED);
  return true;
}
