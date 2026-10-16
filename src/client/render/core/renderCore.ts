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
import { FrameTimer } from './frameTimer';
import { OutputPass } from './post';
import { computePixelRatio, qualityProfile, type QualityProfile } from './quality';
import { installShadowEdgeFade } from './shadowFade';
import { createSkyDome, type SkyDome } from './sky';

/** Distance from the shadow focus point back toward the sun where the shadow camera sits (m). */
const SHADOW_LIGHT_DISTANCE = 400;

export const createRenderCore: CreateRenderCore = (container: HTMLElement): RenderCore => new RenderCoreImpl(container);

class RenderCoreImpl implements RenderCore {
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
  private readonly statsOut: RenderStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0 };
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

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.target.texture.name = 'dz-scene-hdr';

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
    this.applyQuality(false);
  }

  private applyQuality(initial: boolean): void {
    const p = qualityProfile(this._quality);
    const prev = this.profile;
    this.profile = p;

    if (this.target.samples !== p.msaaSamples) {
      this.target.dispose();
      this.target.samples = p.msaaSamples;
    }
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
    if (w === this.lastWidth && h === this.lastHeight && pr === this.lastPixelRatio) return;
    this.lastWidth = w;
    this.lastHeight = h;
    this.lastPixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const size = this.renderer.getDrawingBufferSize(this.tmpSize);
    this.target.setSize(size.x, size.y);
    this.output.setResolution(size.x, size.y);
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
    if (this.lastFrameMs >= 0) this.skyTime += Math.min(0.25, (now - this.lastFrameMs) / 1000);
    this.lastFrameMs = now;

    const r = this.renderer;
    r.info.reset();

    this.camera.updateMatrixWorld();
    const camPos = this.tmpCam.setFromMatrixPosition(this.camera.matrixWorld);
    this.sky.update(camPos, this.skyTime);
    this.updateShadowCamera(camPos);

    const autoClear = r.autoClear;
    r.setRenderTarget(this.target);
    r.clear(true, true, false);
    r.autoClear = false;
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    this.output.render(r, this.target.texture);
    r.autoClear = autoClear;
  }

  stats(): RenderStats {
    const info = this.renderer.info;
    const s = this.statsOut;
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
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
