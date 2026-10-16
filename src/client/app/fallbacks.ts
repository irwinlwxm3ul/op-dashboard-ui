// Minimal stand-ins for render / feel modules. The app loads each module optionally (see modules.ts);
// if one fails to load or throws during construction, the match still runs with these simple
// implementations instead of crashing. They are deliberately plain.

import * as THREE from 'three';
import type { World } from '../../shared/types';
import type { FrameState } from '../game/types';
import type {
  CameraState, EntityRenderer, Feel, FeelState, FxRenderer, RenderCore, RenderStats, ViewRig, WorldRenderer,
} from '../render/contracts';
import type { Quality } from '../game/types';

export function zeroFeelState(): FeelState {
  return {
    shake: { pitch: 0, yaw: 0, roll: 0 },
    kick: { pitch: 0, yaw: 0, roll: 0 },
    fovPunch: 0,
    vm: { back: 0, up: 0, rot: 0, side: 0 },
    landDip: 0,
    bob: { phase: 0, amount: 0 },
    lowHealth: 0,
  };
}

export function fallbackRenderCore(container: HTMLElement): RenderCore {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4e8);
  scene.fog = new THREE.Fog(0x9fc4e8, 300, 1400);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 2500);
  camera.rotation.order = 'YXZ';
  const sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.copy(sunDir).multiplyScalar(500);
  scene.add(sun, new THREE.HemisphereLight(0xcfe3ff, 0x4a5a3a, 1.1));
  let quality: Quality = 'medium';
  let last = performance.now();
  let fps = 60;
  const resize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();
  return {
    renderer, scene, camera, canvas: renderer.domElement, sunDir,
    get quality() { return quality; },
    setQuality(q, scale) { quality = q; renderer.setPixelRatio(Math.min(2, window.devicePixelRatio * scale)); resize(); },
    resize,
    render() {
      renderer.info.reset();
      renderer.render(scene, camera);
      const now = performance.now();
      fps = fps * 0.95 + (1000 / Math.max(1, now - last)) * 0.05;
      last = now;
    },
    stats(): RenderStats {
      return {
        fps, frameMs: 1000 / Math.max(1, fps), drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };
    },
    dispose() { window.removeEventListener('resize', resize); renderer.dispose(); renderer.domElement.remove(); },
  };
}

export function fallbackWorldRenderer(core: RenderCore, world: World): WorldRenderer {
  const res = world.res;
  const geo = new THREE.PlaneGeometry(world.size, world.size, res - 1, res - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const h = world.heights[i] ?? 0;
    pos.setY(i, h);
    const c = h < world.waterLevel + 1.5 ? [0.76, 0.7, 0.5] : h > 45 ? [0.5, 0.5, 0.48] : [0.33, 0.47, 0.24];
    colors.set(c, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x2f6d8c, transparent: true, opacity: 0.85 }),
  );
  water.position.y = world.waterLevel;
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), world.boxes.length || 1);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  world.boxes.forEach((b, i) => {
    m.makeScale(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    m.setPosition((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    boxes.setMatrixAt(i, m);
    boxes.setColorAt(i, col.setHex(b.color));
  });
  boxes.count = world.boxes.length;
  const zone = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 600, 96, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x2a6cff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  const group = new THREE.Group();
  group.add(terrain, water, boxes, zone);
  core.scene.add(group);
  return {
    update(frame: FrameState) {
      const z = frame.zone;
      zone.visible = z.r < 2000;
      zone.position.set(z.cx, 200, z.cz);
      zone.scale.set(Math.max(0.1, z.r), 1, Math.max(0.1, z.r));
    },
    dispose() { core.scene.remove(group); geo.dispose(); boxes.dispose(); },
  };
}

export function fallbackEntityRenderer(core: RenderCore): EntityRenderer {
  const group = new THREE.Group();
  core.scene.add(group);
  const geo = new THREE.CapsuleGeometry(0.35, 1.1, 4, 8);
  const meshes = new Map<number, THREE.Mesh>();
  const mats = new Map<number, THREE.MeshLambertMaterial>();
  const mat = (team: number, mate: boolean) => {
    const key = mate ? -1 : team;
    let m = mats.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: mate ? 0x33ccff : new THREE.Color().setHSL((team * 0.137) % 1, 0.6, 0.5) });
      mats.set(key, m);
    }
    return m;
  };
  return {
    update(frame: FrameState, cam: CameraState) {
      const seen = new Set<number>();
      for (const p of frame.players.values()) {
        if (p.life === 'dead' || p.mode === 'plane' || (p.isSelf && cam.hideLocalBody)) continue;
        seen.add(p.id);
        let mesh = meshes.get(p.id);
        if (!mesh) { mesh = new THREE.Mesh(geo, mat(p.team, p.isTeammate)); group.add(mesh); meshes.set(p.id, mesh); }
        const h = p.stance === 'prone' || p.life === 'downed' ? 0.4 : p.stance === 'crouch' ? 0.65 : 0.9;
        mesh.position.set(p.pos.x, p.pos.y + h, p.pos.z);
        mesh.rotation.set(p.stance === 'prone' || p.life === 'downed' ? Math.PI / 2 : 0, p.yaw, 0, 'YXZ');
      }
      for (const [id, mesh] of meshes) if (!seen.has(id)) { group.remove(mesh); meshes.delete(id); }
    },
    dispose() { core.scene.remove(group); geo.dispose(); },
  };
}

export function fallbackViewRig(core: RenderCore): ViewRig {
  const state: CameraState = {
    pos: { x: 0, y: 50, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov: 75, mode: 'tpp', scope: null, ads: 0, hideLocalBody: false,
  };
  return {
    update(frame: FrameState) {
      const s = frame.self;
      const yaw = frame.camera.yaw, pitch = frame.camera.pitch;
      if (s && frame.planePos && s.mode === 'plane') {
        state.pos = { x: frame.planePos.x - Math.sin(yaw) * -30, y: frame.planePos.y + 8, z: frame.planePos.z - Math.cos(yaw) * -30 };
      } else if (s) {
        const back = frame.camera.mode === 'tpp' ? 2.8 : 0;
        state.pos = {
          x: s.eye.x + Math.sin(yaw) * Math.cos(pitch) * back,
          y: s.eye.y + 0.3 * (back > 0 ? 1 : 0) - Math.sin(pitch) * back,
          z: s.eye.z + Math.cos(yaw) * Math.cos(pitch) * back,
        };
      }
      state.yaw = yaw; state.pitch = pitch;
      state.hideLocalBody = frame.camera.mode === 'fpp';
      core.camera.position.set(state.pos.x, state.pos.y, state.pos.z);
      core.camera.rotation.set(pitch, yaw, 0, 'YXZ');
      if (core.camera.fov !== state.fov) { core.camera.fov = state.fov; core.camera.updateProjectionMatrix(); }
      return state;
    },
    dispose() {},
  };
}

export const noopFx: FxRenderer = { update() {}, dispose() {} };

export function noopFeel(): Feel {
  const state = zeroFeelState();
  return { state, update() {}, dispose() {} };
}
