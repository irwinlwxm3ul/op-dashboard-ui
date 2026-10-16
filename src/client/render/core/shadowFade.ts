// The sun shadow map only covers a box around the camera. Without a fade the shadow edge is a hard
// visible line on the ground. This patches three's PCF shadow lookup (global shader chunk, affects
// every lit material, which is exactly what we want) so shadows fade out over the outer ~8 % of the
// shadow map. Idempotent; if the chunk layout ever changes the patch is skipped (shadows still work).

import * as THREE from 'three';

const MARKER = '/* dz-shadow-edge-fade */';
const PCF_SIGNATURE = 'float getShadow( sampler2DShadow shadowMap';
const RETURN_LINE = 'return mix( 1.0, shadow, shadowIntensity );';
const PATCHED_RETURN =
  MARKER +
  ' float dzEdge = clamp( min( min( shadowCoord.x, 1.0 - shadowCoord.x ), min( shadowCoord.y, 1.0 - shadowCoord.y ) ) * 12.0, 0.0, 1.0 );\n' +
  '\t\t\treturn mix( 1.0, shadow, shadowIntensity * dzEdge );';

export function installShadowEdgeFade(): boolean {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks.shadowmap_pars_fragment;
  if (typeof src !== 'string') return false;
  if (src.includes(MARKER)) return true;
  const fnStart = src.indexOf(PCF_SIGNATURE);
  if (fnStart < 0) return false;
  const ret = src.indexOf(RETURN_LINE, fnStart);
  if (ret < 0) return false;
  chunks.shadowmap_pars_fragment = src.slice(0, ret) + PATCHED_RETURN + src.slice(ret + RETURN_LINE.length);
  return true;
}
