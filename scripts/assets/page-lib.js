// Browser-side helpers shared by the asset scripts (loaded from /scripts/page-lib.js
// inside the headless page created by harness.mjs). Not shipped with the game.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export { THREE, SkeletonUtils };

const loader = new GLTFLoader();
export function loadGltf(url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

export function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

/** Triangle / mesh / skin statistics for a loaded glTF scene (unique geometries). */
export function sceneStats(root) {
  const geoms = new Set();
  let meshes = 0, skinned = 0, tris = 0, bones = 0;
  const materials = new Set();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isBone) bones++;
    if (!o.isMesh) return;
    meshes++;
    if (o.isSkinnedMesh) skinned++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => materials.add(m));
    if (geoms.has(o.geometry)) return;
    geoms.add(o.geometry);
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  const box = new THREE.Box3();
  // Skinned meshes: compute bounds in bind pose via the skeleton-aware helper.
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isSkinnedMesh) {
      o.computeBoundingBox();
      const b = o.boundingBox.clone().applyMatrix4(o.matrixWorld);
      box.union(b);
    } else {
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  const size = box.getSize(new THREE.Vector3());
  return {
    meshes, skinned, bones, materials: materials.size, tris: Math.round(tris),
    bbox: { min: box.min.toArray().map((v) => +v.toFixed(3)), max: box.max.toArray().map((v) => +v.toFixed(3)), size: size.toArray().map((v) => +v.toFixed(3)) },
  };
}

/** Creates a renderer + scene with a neutral outdoor-ish light rig. */
export function makeStage({ width = 1280, height = 720, background = 0x9aa7b0, ground = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a5040, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sun.position.set(6, 10, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -12; sc.right = sc.top = 12; sc.near = 0.5; sc.far = 50;
  scene.add(sun);
  if (ground) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x6b7a5a, roughness: 1 }));
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    scene.add(g);
  }
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.05, 500);
  return { renderer, scene, camera, sun };
}

export function enableShadows(root) {
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
}

/** Places objects in a row (each scaled by `scales[i]`) and frames the camera. */
export function lineup(stage, objects, { gap = 0.4, elevation = 0.25, labelsTo } = {}) {
  let x = 0;
  const boxes = [];
  for (const o of objects) {
    stage.scene.add(o);
    o.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(o, true);
    const w = b.max.x - b.min.x;
    o.position.x += x - b.min.x;
    o.position.y -= b.min.y;
    o.updateMatrixWorld(true);
    boxes.push(new THREE.Box3().setFromObject(o, true));
    x += w + gap;
  }
  const all = new THREE.Box3();
  boxes.forEach((b) => all.union(b));
  const c = all.getCenter(new THREE.Vector3());
  const s = all.getSize(new THREE.Vector3());
  const fov = (stage.camera.fov * Math.PI) / 180;
  const fit = Math.max(s.y / (2 * Math.tan(fov / 2)), s.x / (2 * Math.tan(fov / 2) * stage.camera.aspect)) * 1.15 + s.z;
  stage.camera.position.set(c.x, c.y + fit * Math.sin(elevation), c.z + fit * Math.cos(elevation));
  stage.camera.lookAt(c);
  const sh = stage.sun.shadow.camera;
  const r = Math.max(s.x, s.z, s.y) * 0.75 + 2;
  sh.left = sh.bottom = -r; sh.right = sh.top = r; sh.updateProjectionMatrix();
  stage.sun.position.set(c.x + 6, 12, c.z + 8);
  stage.sun.target.position.copy(c);
  stage.scene.add(stage.sun.target);
  if (labelsTo) labelsTo.push(...boxes.map((b) => b.getCenter(new THREE.Vector3()).project(stage.camera)));
  return boxes;
}

export function addLabels(names, projected, width = 1280, height = 720) {
  const old = document.querySelectorAll('.lbl');
  old.forEach((e) => e.remove());
  names.forEach((n, i) => {
    const p = projected[i];
    const d = document.createElement('div');
    d.className = 'lbl';
    d.textContent = n;
    d.style.cssText = `position:absolute;left:${((p.x + 1) / 2) * width}px;top:${height - 22}px;transform:translateX(-50%);font:12px sans-serif;color:#111;background:rgba(255,255,255,.7);padding:1px 4px;white-space:nowrap`;
    document.body.appendChild(d);
  });
}
