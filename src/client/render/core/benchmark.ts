// First-run quality recommendation: GPU renderer-string heuristics (WEBGL_debug_renderer_info)
// combined with a short synthetic benchmark (<= ~2 s) that renders a medium-preset-like frame
// (terrain grid, ~1 600 instanced trees, boxes, 1024^2 sun shadows, fog, standard materials) into
// an offscreen target at the canvas resolution and times it with a GPU sync. The recommendation
// is returned only; persisting it is the caller's decision.

import * as THREE from 'three';
import type { Quality } from '../../game/types';
import type { RenderCore } from '../contracts';
import { ENV } from './environment';
import { QUALITY_PROFILES, computePixelRatio } from './quality';

export const QUALITY_ORDER: readonly Quality[] = ['low', 'medium', 'high', 'ultra'];

export interface GpuInfo {
  vendor: string;
  renderer: string;
}

/** Unmasked GPU vendor / renderer strings when the browser exposes them. */
export function readGpuInfo(renderer: THREE.WebGLRenderer): GpuInfo {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
    const vendor = String((dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null) ?? gl.getParameter(gl.VENDOR) ?? '');
    const rend = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null) ?? gl.getParameter(gl.RENDERER) ?? '');
    return { vendor, renderer: rend };
  } catch {
    return { vendor: '', renderer: '' };
  }
}

/**
 * Quality tier (0 low .. 3 ultra) suggested by the GPU name, or null when unknown.
 * Integrated GPUs land on low/medium (PLAN.md: Iris Xe class = medium at 60 FPS), discrete
 * mid-range on high, current discrete on ultra, software rasterisers on low.
 */
export function classifyGpu(rendererString: string): number | null {
  const s = rendererString.toLowerCase();
  if (!s) return null;
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(s)) return 0;
  // Mobile / embedded.
  if (/mali|powervr|videocore|tegra/.test(s)) return 0;
  const adreno = /adreno[^\d]*(\d{3})/.exec(s);
  if (adreno) return Number(adreno[1]) >= 650 ? 1 : 0;
  // Apple silicon (Chrome/ANGLE reports "Apple M1 Pro" etc.; Safari only "Apple GPU").
  const apple = /apple m(\d+)(?:\s*(pro|max|ultra))?/.exec(s);
  if (apple) return apple[2] ? 3 : 2;
  if (/apple gpu/.test(s)) return 1;
  // NVIDIA.
  if (/nvidia|geforce|quadro|rtx|gtx/.test(s)) {
    const rtx = /rtx\s*a?(\d{4})/.exec(s);
    if (rtx) {
      const n = Number(rtx[1]);
      return n % 100 <= 50 ? 2 : 3; // RTX x050 (and workstation x000) cards are mid-range
    }
    const gtx = /gtx\s*(\d{3,4})/.exec(s);
    if (gtx) {
      const n = Number(gtx[1]);
      if (n >= 1600) return 2;
      if (n >= 1060) return 2;
      if (n >= 1000) return 1;
      if (n >= 970) return 2;
      return 1;
    }
    if (/\bmx\s*\d{3}/.test(s)) return 1;
    if (/\bgt\s*\d{3,4}/.test(s)) return 0;
    return 2;
  }
  // AMD.
  if (/radeon|amd/.test(s)) {
    const rx = /rx\s*(\d{3,4})/.exec(s);
    if (rx) {
      const n = Number(rx[1]);
      if (n >= 9000) return n % 100 >= 60 ? 3 : 2;
      if (n >= 6000) return n % 1000 < 600 ? 2 : 3;
      if (n >= 5000) return n % 1000 >= 600 ? 3 : 2;
      if (n >= 470) return 2;
      return 1;
    }
    if (/\b(680m|780m|880m|890m|8060s)\b/.test(s)) return 2;
    if (/vega|radeon\(tm\) graphics|radeon graphics|\d{3}m\b/.test(s)) return 1;
    if (/radeon pro/.test(s)) return 2;
    return 1;
  }
  // Intel.
  if (/intel/.test(s)) {
    if (/\barc\b/.test(s)) return /\ba3\d{2}/.test(s) ? 1 : 2;
    if (/iris|xe/.test(s)) return 1;
    return 0; // HD / UHD graphics
  }
  return null;
}

/** Tier from the synthetic medium-frame cost (ms, GPU-synced). */
export function tierFromFrameMs(ms: number): number {
  if (ms <= 3.5) return 3;
  if (ms <= 6.5) return 2;
  if (ms <= 12.5) return 1;
  return 0;
}

/** Measurement wins (it includes the real screen resolution) but stays within one tier of the GPU heuristic. */
export function combineTiers(heuristic: number | null, measured: number | null): number {
  if (measured === null) return heuristic ?? 1;
  if (heuristic === null) return measured;
  return Math.min(3, Math.max(0, Math.min(heuristic + 1, Math.max(heuristic - 1, measured))));
}

const BENCH_DEADLINE_MS = 1500;
const COMPILE_WAIT_MS = 600;
const BENCH_MAX_FRAMES = 24;
const BENCH_WARMUP = 2;

interface BenchScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dispose(): void;
}

function buildBenchScene(aspect: number): BenchScene {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(ENV.fogColor, ENV.fogDensity);
  scene.background = new THREE.Color(ENV.fogColor);
  const disposables: { dispose(): void }[] = [];

  const hemi = new THREE.HemisphereLight(ENV.hemiSky, ENV.hemiGround, ENV.hemiIntensity);
  const sun = new THREE.DirectionalLight(ENV.sunColor, ENV.sunIntensity);
  sun.position.set(43, 74, 51);
  sun.castShadow = true;
  sun.shadow.mapSize.set(QUALITY_PROFILES.medium.shadowMapSize, QUALITY_PROFILES.medium.shadowMapSize);
  const ext = QUALITY_PROFILES.medium.shadowExtent / 2;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 400 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.radius = 2.5;
  scene.add(hemi, sun, sun.target);

  // Terrain-like ground (rolling grid, ~80k triangles).
  const ground = new THREE.PlaneGeometry(900, 900, 200, 200);
  ground.rotateX(-Math.PI / 2);
  const gp = ground.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i), z = gp.getZ(i);
    gp.setY(i, Math.sin(x * 0.02) * 6 + Math.cos(z * 0.017) * 5 + Math.sin((x + z) * 0.05) * 1.5);
  }
  ground.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x6d8a3a, roughness: 0.95 });
  const groundMesh = new THREE.Mesh(ground, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  disposables.push(ground, groundMat);

  // Instanced "trees" (canopy blob + trunk cone), ~1 600 near-ish instances (~200k triangles).
  const canopy = new THREE.IcosahedronGeometry(2.6, 1);
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 5, 6);
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x4f6e30, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4f3d2d, roughness: 0.9 });
  disposables.push(canopy, trunk, canopyMat, trunkMat);
  const n = 1600;
  const canopies = new THREE.InstancedMesh(canopy, canopyMat, n);
  const trunks = new THREE.InstancedMesh(trunk, trunkMat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    // Deterministic scatter in front of the camera.
    const a = (i * 2.399963) % (Math.PI * 0.9) - Math.PI * 0.45;
    const d = 8 + ((i * 7919) % 1000) / 1000 * 260;
    const x = Math.sin(a) * d, z = -Math.cos(a) * d;
    const y = Math.sin(x * 0.02) * 6 + Math.cos(z * 0.017) * 5;
    m.makeTranslation(x, y + 6.5, z);
    canopies.setMatrixAt(i, m);
    m.makeTranslation(x, y + 2.5, z);
    trunks.setMatrixAt(i, m);
  }
  for (const im of [canopies, trunks]) {
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    scene.add(im);
  }

  // Building-like boxes as individual meshes (draw-call overhead of a town).
  const box = new THREE.BoxGeometry(8, 7, 9);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a6, roughness: 0.9 });
  disposables.push(box, boxMat);
  for (let i = 0; i < 70; i++) {
    const b = new THREE.Mesh(box, boxMat);
    const a = (i * 0.7) % 1.6 - 0.8;
    const d = 20 + (i % 10) * 18;
    b.position.set(Math.sin(a) * d, 4, -Math.cos(a) * d);
    b.castShadow = true;
    b.receiveShadow = true;
    scene.add(b);
  }

  const camera = new THREE.PerspectiveCamera(70, aspect, ENV.near, ENV.far);
  camera.position.set(0, 14, 12);
  camera.lookAt(0, 4, -80);
  sun.target.position.set(0, 0, -45);
  sun.position.set(43, 74, 6);
  return {
    scene,
    camera,
    dispose: () => {
      sun.dispose();
      for (const d of disposables) d.dispose();
      canopies.dispose();
      trunks.dispose();
    },
  };
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });

/**
 * Median GPU-synced cost (ms) of the synthetic medium frame at the canvas resolution with medium
 * pixel ratio, or null if no frame could be measured within the time budget.
 */
export async function benchmarkMediumFrame(core: RenderCore): Promise<number | null> {
  const r = core.renderer;
  const start = performance.now();
  const cssW = core.canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const cssH = core.canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 720);
  const pr = computePixelRatio(QUALITY_PROFILES.medium, typeof window !== 'undefined' ? window.devicePixelRatio : 1, 1);
  const w = Math.max(64, Math.round(cssW * pr)), h = Math.max(64, Math.round(cssH * pr));
  const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true });
  const bench = buildBenchScene(w / h);
  const pixel = new Uint8Array(4);
  const samples: number[] = [];
  try {
    // Compile the benchmark programs for this target without blocking (parallel shader compile
    // where available), so shader compilation is not timed; wait at most COMPILE_WAIT_MS.
    const prev = r.getRenderTarget();
    r.setRenderTarget(target);
    if (r.extensions.has('KHR_parallel_shader_compile')) {
      const compiled = r.compileAsync(bench.scene, bench.camera);
      r.setRenderTarget(prev);
      await Promise.race([compiled, new Promise<void>((res) => setTimeout(res, COMPILE_WAIT_MS))]);
    } else {
      r.compile(bench.scene, bench.camera);
      r.setRenderTarget(prev);
    }
    const measureStart = performance.now();
    for (let frame = 0; frame < BENCH_WARMUP + BENCH_MAX_FRAMES; frame++) {
      if (performance.now() - measureStart > BENCH_DEADLINE_MS - (measureStart - start) * 0.5) break;
      await nextFrame();
      // Run synchronously and restore renderer state so an interleaved app frame is unaffected.
      const prevTarget = r.getRenderTarget();
      const prevShadows = r.shadowMap.enabled;
      const prevAutoClear = r.autoClear;
      const calls = r.info.render.calls, tris = r.info.render.triangles;
      const t0 = performance.now();
      r.shadowMap.enabled = true;
      r.autoClear = true;
      r.setRenderTarget(target);
      r.render(bench.scene, bench.camera);
      r.readRenderTargetPixels(target, w >> 1, h >> 1, 1, 1, pixel); // GPU sync
      const dt = performance.now() - t0;
      r.setRenderTarget(prevTarget);
      r.shadowMap.enabled = prevShadows;
      r.autoClear = prevAutoClear;
      r.info.render.calls = calls;
      r.info.render.triangles = tris;
      if (frame >= BENCH_WARMUP) samples.push(dt);
    }
  } finally {
    bench.dispose();
    target.dispose();
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

/**
 * Recommended quality for this device (first run). Never throws; falls back to the GPU-name
 * heuristic (or medium) when the benchmark cannot run.
 */
export async function recommendQuality(core: RenderCore): Promise<Quality> {
  let heuristic: number | null = null;
  try {
    heuristic = classifyGpu(readGpuInfo(core.renderer).renderer);
  } catch {
    heuristic = null;
  }
  let measured: number | null = null;
  try {
    // Software rasterisers take seconds per frame: skip straight to low.
    const software = /swiftshader|llvmpipe|softpipe|software/i.test(readGpuInfo(core.renderer).renderer);
    if (!software) {
      const ms = await benchmarkMediumFrame(core);
      if (ms !== null) measured = tierFromFrameMs(ms);
    }
  } catch {
    measured = null;
  }
  return QUALITY_ORDER[combineTiers(heuristic, measured)];
}
