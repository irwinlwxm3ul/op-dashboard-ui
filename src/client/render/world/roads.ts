// Road decal strips along World.roads: slightly raised, terrain-following strips (polygon offset
// against z-fighting) with procedural asphalt grain, worn wheel tracks, dashed centre line and edge
// lines on wide roads; narrow roads become packed dirt tracks. Round caps fill segment joints.
// All roads are merged into a single mesh (one draw call).

import * as THREE from 'three';
import type { RoadSegment, World } from '../../../shared/types';
import { GeoBuilder, linearRgb } from './geoBuilder';
import { NOISE_GLSL, patchShader } from './shaders';

const LIFT = 0.07;
const CAP_LIFT = 0.055;
const STEP = 2.5;
const CAP_SEGMENTS = 14;
/** Roads at least this wide are asphalt with markings; narrower (village streets) are gravel tracks. */
const ASPHALT_MIN_WIDTH = 6.5;

const ASPHALT = linearRgb(0x5a5752);
const DIRT = linearRgb(0x7c6a4f);

function createRoadMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'dz-road',
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute vec2 ruv;\nattribute vec3 rinfo;\nvarying vec2 vDzUv;\nvarying vec3 vDzInfo;\nvarying vec3 vDzWorld;\n' +
      patchShader(
        shader.vertexShader,
        'begin_vertex',
        '#include <begin_vertex>\nvDzUv = ruv;\nvDzInfo = rinfo;\nvDzWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader =
      'varying vec2 vDzUv;\nvarying vec3 vDzInfo;\nvarying vec3 vDzWorld;\n' +
      NOISE_GLSL +
      patchShader(
        shader.fragmentShader,
        'color_fragment',
        /* glsl */ `#include <color_fragment>
{
  float u = vDzUv.x;
  float v = vDzUv.y;
  float camDist = length(vDzWorld - cameraPosition);
  float fade = 1.0 - smoothstep(30.0, 160.0, camDist);
  float grain = dzNoise(vDzWorld.xz * 1.9) * 0.5 + dzNoise(vDzWorld.xz * 7.0) * 0.5;
  float patches = dzNoise(vDzWorld.xz * 0.18);
  diffuseColor.rgb *= (0.9 + 0.2 * grain * fade) * (0.93 + 0.14 * patches);
  if (u >= 0.0) {
    float tracks = 1.0 - smoothstep(0.0, 0.07, abs(abs(u - 0.5) - 0.24));
    diffuseColor.rgb *= 1.0 - 0.1 * tracks;
    float edge = smoothstep(0.0, 0.06, min(u, 1.0 - u));
    diffuseColor.rgb *= mix(0.86, 1.0, edge);
    if (vDzInfo.x > 0.5) {
      float w = vDzInfo.y;
      float len = vDzInfo.z;
      float aa = fwidth(u) * 1.2 + 1e-4;
      float hw = 0.065 / w;
      float centre = 1.0 - smoothstep(hw, hw + aa, abs(u - 0.5));
      float dash = step(0.42, fract(v / 9.0));
      float ends = smoothstep(3.0, 4.0, v) * smoothstep(3.0, 4.0, len - v);
      float side = (1.0 - smoothstep(hw, hw + aa, abs(u - 0.07))) + (1.0 - smoothstep(hw, hw + aa, abs(u - 0.93)));
      float paint = max(centre * dash * ends, min(side, 1.0)) * (0.65 + 0.35 * grain);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.72, 0.66), paint * 0.85);
    }
  }
}`,
      );
  };
  mat.customProgramCacheKey = () => 'dz-road-v1';
  return mat;
}

function addSegment(gb: GeoBuilder, world: World, r: RoadSegment, normal: { x: number; y: number; z: number }): void {
  const dx = r.b.x - r.a.x, dz = r.b.z - r.a.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.05 || !(r.width > 0)) return;
  const fx = dx / len, fz = dz / len;
  // Left of travel direction (seen from above, -Z north): (-fz, fx) -> u = 0 at left edge.
  const px = fz, pz = -fx;
  const hw = r.width / 2;
  const asphalt = r.width >= ASPHALT_MIN_WIDTH;
  const col = asphalt ? ASPHALT : DIRT;
  const steps = Math.max(1, Math.ceil(len / STEP));
  let prev: number[] | null = null;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = r.a.x + dx * t, cz = r.a.z + dz * t;
    world.normalAt(cx, cz, normal);
    const row: number[] = [];
    for (let k = 0; k < 3; k++) {
      const o = (k - 1) * hw; // -hw, 0, +hw
      const x = cx - px * o, z = cz - pz * o;
      const y = world.heightAt(x, z) + LIFT;
      row.push(gb.vertex(x, y, z, normal.x, normal.y, normal.z, col[0], col[1], col[2]));
      gb.extra('ruv', k / 2, len * t);
      gb.extra('rinfo', asphalt ? 1 : 0, r.width, len);
    }
    if (prev) {
      for (let k = 0; k < 2; k++) {
        const a = prev[k], b = prev[k + 1], c = row[k], d = row[k + 1];
        // Orient upward: (c - a) x (b - a) must point +Y.
        const ax = gb.pos[a * 3], az = gb.pos[a * 3 + 2];
        const ux = gb.pos[c * 3] - ax, uz = gb.pos[c * 3 + 2] - az;
        const vx = gb.pos[b * 3] - ax, vz = gb.pos[b * 3 + 2] - az;
        if (uz * vx - ux * vz > 0) {
          gb.tri(a, c, b);
          gb.tri(b, c, d);
        } else {
          gb.tri(a, b, c);
          gb.tri(b, d, c);
        }
      }
    }
    prev = row;
  }
}

function addCap(gb: GeoBuilder, world: World, x: number, z: number, radius: number, width: number, normal: { x: number; y: number; z: number }): void {
  const col = width >= ASPHALT_MIN_WIDTH ? ASPHALT : DIRT;
  world.normalAt(x, z, normal);
  const centre = gb.vertex(x, world.heightAt(x, z) + CAP_LIFT, z, normal.x, normal.y, normal.z, col[0], col[1], col[2]);
  gb.extra('ruv', -1, 0);
  gb.extra('rinfo', 0, width, 0);
  const ring: number[] = [];
  for (let i = 0; i < CAP_SEGMENTS; i++) {
    const a = (i / CAP_SEGMENTS) * Math.PI * 2;
    const vx = x + Math.cos(a) * radius, vz = z + Math.sin(a) * radius;
    ring.push(gb.vertex(vx, world.heightAt(vx, vz) + CAP_LIFT, vz, normal.x, normal.y, normal.z, col[0], col[1], col[2]));
    gb.extra('ruv', -1, 0);
    gb.extra('rinfo', 0, width, 0);
  }
  for (let i = 0; i < CAP_SEGMENTS; i++) {
    // Angles increase from +X toward +Z: (centre, next, current) faces up.
    gb.tri(centre, ring[(i + 1) % CAP_SEGMENTS], ring[i]);
  }
}

export class RoadRenderer {
  readonly mesh: THREE.Mesh | null = null;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly geometry: THREE.BufferGeometry | null = null;

  constructor(world: World) {
    this.material = createRoadMaterial();
    if (world.roads.length === 0) return;
    const gb = new GeoBuilder().addAttribute('ruv', 2).addAttribute('rinfo', 3);
    const n = { x: 0, y: 1, z: 0 };
    const caps = new Map<string, { x: number; z: number; w: number }>();
    const capKey = (x: number, z: number): string => `${Math.round(x * 4)}:${Math.round(z * 4)}`;
    for (const r of world.roads) {
      addSegment(gb, world, r, n);
      for (const p of [r.a, r.b]) {
        const key = capKey(p.x, p.z);
        const prev = caps.get(key);
        if (!prev || prev.w < r.width) caps.set(key, { x: p.x, z: p.z, w: r.width });
      }
    }
    for (const c of caps.values()) addCap(gb, world, c.x, c.z, c.w / 2, c.w, n);
    if (gb.isEmpty) return;
    this.geometry = gb.build();
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.name = 'roads';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    this.mesh = mesh;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material.dispose();
    this.mesh?.removeFromParent();
  }
}
