// Pure prop planning: which WorldBoxes are dressed with a 3D prop model (PROP_MODELS /
// propModelsForBox) and with which instance transforms. Collision boxes are never changed - the
// models only replace the boxes' visuals near the camera (see props.ts). Models rest on y = 0,
// centred on X/Z, long side along X; each placement fits the model into its box (rotated 90
// degrees when the box runs along Z), long walls/fences are tiled into native-length segments.

import type { WorldBox } from '../../../shared/types';
import { hash32 } from '../../../shared/rng';
import { PROP_MODELS, propModelsForBox, type WorldPropId } from '../../assets/manifest-world';

export interface PropPlacement {
  model: WorldPropId;
  /** Column-major instance matrix. */
  m: number[];
}

export interface PropPlan {
  boxId: number;
  placements: PropPlacement[];
  /** Linear-ish instance tint (multiplies the model's texture). */
  tint: [number, number, number];
  /** Bounding sphere for distance banding. */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  /** The far fallback box is not drawn either (thin see-through fences vanish with distance). */
  hideFar: boolean;
  /** Model casts sun shadows. */
  shadows: boolean;
}

function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Column-major T(x, y, z) * Ry(yaw) * S(sx, sy, sz). */
function trs(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): number[] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1];
}

/**
 * Model placements filling `box` along its long horizontal axis with `n` segments; each segment
 * is scaled to (segment length, height, depth) unless `keepDepth` keeps the native depth.
 */
function fitSegments(box: WorldBox, model: WorldPropId, n: number, flip: boolean, keepDepth = false): PropPlacement[] {
  const size = PROP_MODELS[model].size;
  const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z;
  const alongX = dx >= dz;
  const len = alongX ? dx : dz;
  const depth = alongX ? dz : dx;
  const seg = len / n;
  const sx = seg / size[0];
  const sy = dy / size[1];
  const sz = keepDepth ? 1 : depth / size[2];
  // Long model axis X -> world X (yaw 0 / pi) or world Z (yaw +-pi/2).
  const yaw = (alongX ? 0 : Math.PI / 2) + (flip ? Math.PI : 0);
  const out: PropPlacement[] = [];
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  for (let i = 0; i < n; i++) {
    const off = -len / 2 + seg * (i + 0.5);
    const x = alongX ? box.min.x + len / 2 + off : cx;
    const z = alongX ? cz : box.min.z + len / 2 + off;
    out.push({ model, m: trs(x, box.min.y, z, yaw, sx, sy, sz) });
  }
  return out;
}

const CRATE_REF_LUMA = 0.42;

/** Plans for every dressable box (order = plan index; boxes without a model are skipped). */
export function planProps(boxes: readonly WorldBox[]): PropPlan[] {
  const plans: PropPlan[] = [];
  for (const b of boxes) {
    const candidates = propModelsForBox(b.kind, b.material);
    if (candidates.length === 0) continue;
    const dx = b.max.x - b.min.x, dy = b.max.y - b.min.y, dz = b.max.z - b.min.z;
    const [r, g, bl] = rgb(b.color);
    const luma = 0.299 * r + 0.587 * g + 0.114 * bl;
    const h = hash32(b.id, 0x9e0b);
    const flip = (h & 1) === 1;
    let placements: PropPlacement[] = [];
    let tint: [number, number, number] = [1, 1, 1];
    let hideFar = false;
    let shadows = true;
    switch (b.kind) {
      case 'crate': {
        // Pale straw-coloured "crates" are hay bales: keep the box.
        if (luma > 0.6) continue;
        const military = g > r;
        const model: WorldPropId = military && candidates.includes('crate_military') ? 'crate_military' : 'crate_wood';
        if (!candidates.includes(model)) continue;
        // Square-ish crates: random quarter turn, fit to the box.
        const size = PROP_MODELS[model].size;
        const quarter = (h >>> 1) & 3;
        const odd = (quarter & 1) === 1;
        const sx = (odd ? dz : dx) / size[0], sz = (odd ? dx : dz) / size[2];
        placements = [{ model, m: trs((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2, (quarter * Math.PI) / 2, sx, dy / size[1], sz) }];
        const k = military ? 1 : Math.min(1.2, Math.max(0.85, luma / CRATE_REF_LUMA));
        tint = [k, k, k];
        break;
      }
      case 'container': {
        // Open containers are built from thin wall boxes and stay procedural.
        if (dx < 2 || dy < 2 || dz < 2) continue;
        const redish = r > g * 1.35 && r > bl * 1.35;
        const model: WorldPropId = redish && candidates.includes('container_red') ? 'container_red' : 'container_green';
        if (!candidates.includes(model)) continue;
        placements = fitSegments(b, model, 1, flip);
        break;
      }
      case 'barrier': {
        if (b.material === 'sand') {
          if (!candidates.includes('sandbag_wall')) continue;
          const len = Math.max(dx, dz);
          placements = fitSegments(b, 'sandbag_wall', Math.max(1, Math.round(len / 2)), flip);
        } else {
          if (!candidates.includes('barrier_concrete')) continue;
          placements = fitSegments(b, 'barrier_concrete', 1, flip);
        }
        break;
      }
      case 'fence': {
        const len = Math.max(dx, dz);
        if (b.material === 'metal') {
          if (!candidates.includes('fence_chainlink')) continue;
          placements = fitSegments(b, 'fence_chainlink', Math.max(1, Math.round(len / PROP_MODELS.fence_chainlink.size[0])), false, true);
          hideFar = true;
        } else {
          if (!candidates.includes('fence_wood')) continue;
          placements = fitSegments(b, 'fence_wood', Math.max(1, Math.round(len / PROP_MODELS.fence_wood.size[0])), flip);
        }
        shadows = false;
        break;
      }
      default:
        continue;
    }
    if (placements.length === 0) continue;
    const j = 0.95 + ((h >>> 8) & 255) / 255 * 0.1;
    plans.push({
      boxId: b.id,
      placements,
      tint: [tint[0] * j, tint[1] * j, tint[2] * j],
      cx: (b.min.x + b.max.x) / 2,
      cy: (b.min.y + b.max.y) / 2,
      cz: (b.min.z + b.max.z) / 2,
      radius: Math.hypot(dx, dy, dz) / 2,
      hideFar,
      shadows,
    });
  }
  return plans;
}
