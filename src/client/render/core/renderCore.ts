// RenderCore: WebGL renderer, scene, camera, sky, sun + hemisphere lighting, fog, camera-following
// sun shadows, quality presets and the HDR -> ACES/sRGB output pipeline.
//
// Pipeline (every quality): scene -> linear HDR half-float target (MSAA on high/ultra) -> output pass
// (ACES tone mapping + sRGB, FXAA on medium) -> canvas. Rendering through one HDR target on every
// preset keeps the look (fog / horizon / tone curve) identical across quality levels and lets AA be
// switched at runtime without recreating the WebGL context that other modules hold on to.

import * as THREE from 'three';
import type { CreateRenderCore, RenderCore, RenderStats } from '../contracts';
import type { Quality } from '../../game/types';
import { ENV, computeSunDirection } from './environment';
import { DynamicResolution, type DynamicResolutionOptions, type TimingSignal } from './dynamicResolution';
import { installAltitudeFog } from './fogPatch';
import { FrameTimer } from './frameTimer';
import { GpuTimer } from './gpuTimer';
import { OutputPass } from './post';
import { computePixelRatio, qualityProfile, type QualityProfile } from './quality';
import { installShadowEdgeFade } from './shadowFade';
import { createSkyDome, type SkyDome } from './sky';

/** Distance from the shadow focus point back toward the sun where the shadow camera sits (m). */
const SHADOW_LIGHT_DISTANCE = 400;
/** Without a GPU timer result for this long, fall back to frame-time driven scaling (ms). */
const GPU_SAMPLE_TIMEOUT_MS = 3000;

/** RenderStats plus dynamic-resolution diagnostics (extra fields are additive to the contract). */
export interface RenderStatsEx extends RenderStats {
  /** Dynamic resolution multiplier applied to the scene target (0.6..1). */
  resolutionScale: number;
  /** Effective pixel ratio of the scene render (canvas pixel ratio x resolutionScale). */
  pixelRatio: number;
  /** Smoothed GPU frame time in ms when timer queries are available, else -1. */
  gpuMs: number;
  /** Which signal drives dynamic resolution. */
  timing: TimingSignal;
}

export interface DynamicResolutionSettings extends Partial<DynamicResolutionOptions> {
  enabled?: boolean;
}

export const createRenderCore: CreateRenderCore = (container: HTMLElement): RenderCore => new RenderCoreImpl(container);

/** Enable/disable/tune dynamic resolution on a core created by createRenderCore (no-op otherwise). */
export function configureDynamicResolution(core: RenderCore, settings: DynamicResolutionSettings): void {
  if (core instanceof RenderCoreImpl) core.configureDynamicResolution(settings);
}

export class RenderCoreImpl implements RenderCore {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly sunDir: THREE.Vector3;

  private _quality: Quality = 'medium';
  private profile: QualityProfile = qualityProfile('medium');
  private renderScale = 1;

  private readonly container: HTMLElement;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sky: SkyDome;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly output = new OutputPass();
  private readonly timer = new FrameTimer();
  private readonly statsOut: RenderStatsEx = {
    fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0,
    resolutionScale: 1, pixelRatio: 1, gpuMs: -1, timing: 'frame',
  };
  private readonly drs = new DynamicResolution();
  private readonly gpuTimer: GpuTimer | null;
  private timing: TimingSignal = 'frame';
  private lastGpuSampleAt = -1;
  private gpuMsEma = -1;
  private targetW = 0;
  private targetH = 0;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = (): void => this.resize();
  private disposed = false;
  private skyTime = 0;
  private lastFrameMs = -1;

  // Light-space basis for shadow texel snapping (constant because the sun does not move).
  private readonly lsX = new THREE.Vector3();
  private readonly lsY = new THREE.Vector3();
  private readonly lsZ = new THREE.Vector3();
  private readonly tmpCam = new THREE.Vector3();
  private readonly tmpFocus = new THREE.Vector3();
  private readonly tmpSize = new THREE.Vector2();
  private lastWidth = 0;
  private lastHeight = 0;
  private lastPixelRatio = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    installShadowEdgeFade();
    installAltitudeFog();

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = ENV.exposure;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;
    r.debug.checkShaderErrors = import.meta.env?.DEV ?? true;
    r.setClearColor(ENV.fogColor, 1);

    this.canvas = r.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(ENV.fogColor, ENV.fogDensity);

    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, ENV.near, ENV.far);
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(0, 60, 0);
    // In the graph so camera-attached children (e.g. viewmodels) are rendered.
    this.scene.add(this.camera);

    this.sunDir = computeSunDirection();
    // Orthonormal light basis (z toward the sun), identical to what lookAt() gives the shadow camera.
    this.lsZ.copy(this.sunDir);
    this.lsX.set(0, 1, 0).cross(this.lsZ).normalize();
    this.lsY.copy(this.lsZ).cross(this.lsX).normalize();

    this.hemi = new THREE.HemisphereLight(ENV.hemiSky, ENV.hemiGround, ENV.hemiIntensity);
    this.hemi.position.set(0, 1, 0);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(ENV.sunColor, ENV.sunIntensity);
    this.sun.name = 'sun';
    this.sun.position.copy(this.sunDir).multiplyScalar(SHADOW_LIGHT_DISTANCE);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = SHADOW_LIGHT_DISTANCE * 2;
    this.sun.shadow.radius = 2.5;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.sky = createSkyDome(this.sunDir);
    this.scene.add(this.sky.mesh);

    // Half-float HDR target when float colour buffers are renderable (virtually all WebGL2
    // devices); otherwise an 8-bit target (tone mapping still happens in the output pass).
    const hdr = r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.target.texture.name = 'dz-scene-hdr';
    this.gpuTimer = GpuTimer.create(r.getContext());
    this.timing = this.gpuTimer ? 'gpu' : 'frame';

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    window.addEventListener('resize', this.onWindowResize);

    this.applyQuality(true);
  }

  get quality(): Quality {
    return this._quality;
  }

  setQuality(q: Quality, renderScale: number): void {
    const scale = Number.isFinite(renderScale) && renderScale > 0 ? renderScale : 1;
    if (q === this._quality && scale === this.renderScale) return;
    this._quality = q;
    this.renderScale = scale;
    // Different workload: forget timing history and start again from full resolution.
    this.drs.setEnabled(this.drs.enabled);
    this.applyQuality(false);
  }

  configureDynamicResolution(settings: DynamicResolutionSettings): void {
    const { enabled, ...opts } = settings;
    this.drs.configure(opts);
    if (enabled !== undefined && enabled !== this.drs.enabled) this.drs.setEnabled(enabled);
    this.applyTargetSize();
  }

  /** Scene target = drawing buffer x dynamic resolution scale; the output pass upsamples. */
  private applyTargetSize(): void {
    const size = this.renderer.getDrawingBufferSize(this.tmpSize);
    const k = this.drs.scale;
    const w = Math.max(1, Math.round(size.x * k));
    const h = Math.max(1, Math.round(size.y * k));
    if (w === this.targetW && h === this.targetH) return;
    this.targetW = w;
    this.targetH = h;
    this.target.setSize(w, h);
    this.output.setResolution(w, h);
  }

  private applyQuality(initial: boolean): void {
    const p = qualityProfile(this._quality);
    const prev = this.profile;
    this.profile = p;

    if (this.target.samples !== p.msaaSamples) {
      this.target.dispose();
      this.target.samples = p.msaaSamples;
    }
    // Force the target size to be re-applied (resize() may early-out when the canvas is unchanged).
    this.targetW = 0;
    this.targetH = 0;
    this.output.setFxaa(p.fxaa);

    const shadowsChanged = initial || prev.shadows !== p.shadows;
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    if (p.shadows) {
      const shadow = this.sun.shadow;
      if (shadow.mapSize.x !== p.shadowMapSize) {
        shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
        if (shadow.map) {
          shadow.map.dispose();
          shadow.map = null;
        }
      }
      const half = p.shadowExtent / 2;
      const cam = shadow.camera;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
      const texel = p.shadowExtent / p.shadowMapSize;
      shadow.bias = -0.0004;
      shadow.normalBias = texel * 0.9;
    }
    if (shadowsChanged && !initial) {
      // Shadow defines are baked into programs: force every material to rebuild once.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
        else m.needsUpdate = true;
      });
    }
    this.resize();
  }

  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(this.container.clientWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight));
    const pr = computePixelRatio(this.profile, typeof window !== 'undefined' ? window.devicePixelRatio : 1, this.renderScale);
    if (w === this.lastWidth && h === this.lastHeight && pr === this.lastPixelRatio) {
      this.applyTargetSize();
      return;
    }
    this.lastWidth = w;
    this.lastHeight = h;
    this.lastPixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applyTargetSize();
  }

  /** Centre the shadow box slightly ahead of the camera and snap it to shadow-map texels (no shimmer). */
  private updateShadowCamera(camPos: THREE.Vector3): void {
    const p = this.profile;
    if (!p.shadows) return;
    const e = this.camera.matrixWorld.elements;
    let fx = -e[8];
    let fz = -e[10];
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-4) {
      fx /= fl;
      fz /= fl;
    } else {
      fx = 0;
      fz = 0;
    }
    const ahead = p.shadowExtent * 0.28;
    const focus = this.tmpFocus.set(camPos.x + fx * ahead, camPos.y, camPos.z + fz * ahead);
    const texel = p.shadowExtent / p.shadowMapSize;
    const u = Math.round(focus.dot(this.lsX) / texel) * texel;
    const v = Math.round(focus.dot(this.lsY) / texel) * texel;
    const w = focus.dot(this.lsZ);
    focus.set(0, 0, 0).addScaledVector(this.lsX, u).addScaledVector(this.lsY, v).addScaledVector(this.lsZ, w);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, SHADOW_LIGHT_DISTANCE);
  }

  render(): void {
    if (this.disposed) return;
    const now = performance.now();
    this.timer.tick(now);
    const frameInterval = this.lastFrameMs >= 0 ? now - this.lastFrameMs : -1;
    if (frameInterval >= 0) this.skyTime += Math.min(0.25, frameInterval / 1000);
    this.lastFrameMs = now;
    this.updateDynamicResolution(now, frameInterval);

    const r = this.renderer;
    r.info.reset();

    this.camera.updateMatrixWorld();
    const camPos = this.tmpCam.setFromMatrixPosition(this.camera.matrixWorld);
    this.sky.update(camPos, this.skyTime);
    this.updateShadowCamera(camPos);

    const autoClear = r.autoClear;
    this.gpuTimer?.begin();
    r.setRenderTarget(this.target);
    r.clear(true, true, false);
    r.autoClear = false;
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    this.output.render(r, this.target.texture);
    r.autoClear = autoClear;
    this.gpuTimer?.end();
  }

  /** Feed the dynamic resolution controller (GPU time when measurable, else frame interval). */
  private updateDynamicResolution(now: number, frameInterval: number): void {
    let changed = false;
    if (this.gpuTimer) {
      const gpuMs = this.gpuTimer.poll();
      if (gpuMs > 0) {
        this.lastGpuSampleAt = now;
        // Stats EMA ignores hitches (shader compiles, uploads) like the controller does.
        if (gpuMs < 1000) this.gpuMsEma = this.gpuMsEma < 0 ? gpuMs : this.gpuMsEma + (gpuMs - this.gpuMsEma) * 0.1;
        if (this.timing !== 'gpu') {
          this.timing = 'gpu';
          this.drs.reset();
        }
        changed = this.drs.update(gpuMs, now, 'gpu');
      } else if (this.lastGpuSampleAt >= 0 && now - this.lastGpuSampleAt > GPU_SAMPLE_TIMEOUT_MS && this.timing === 'gpu') {
        // Timer results stopped arriving (disjoint storms, driver quirks): use frame timing.
        this.timing = 'frame';
        this.drs.reset();
      }
      if (this.lastGpuSampleAt < 0 && frameInterval > 0) this.lastGpuSampleAt = now;
    }
    if (this.timing === 'frame' && frameInterval > 0) changed = this.drs.update(frameInterval, now, 'frame');
    if (changed) this.applyTargetSize();
  }

  stats(): RenderStatsEx {
    const info = this.renderer.info;
    const s = this.statsOut;
    s.resolutionScale = this.drs.scale;
    s.pixelRatio = this.renderer.getPixelRatio() * this.drs.scale;
    s.gpuMs = this.gpuMsEma;
    s.timing = this.timing;
    s.fps = this.timer.fps;
    s.frameMs = this.timer.frameMs;
    s.drawCalls = info.render.calls;
    s.triangles = info.render.triangles;
    s.geometries = info.memory.geometries;
    s.textures = info.memory.textures;
    return s;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.scene.remove(this.sky.mesh);
    this.sky.dispose();
    this.output.dispose();
    this.target.dispose();
    this.gpuTimer?.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
