// Browser-side character pipeline (run by build-characters.mjs inside headless Chromium):
//  * merges each Quaternius Ultimate Modular Men/Women outfit into ONE skinned mesh with vertex
//    colours (1 draw call) plus a small skinned team armband primitive (2nd draw call, tintable),
//  * bakes the "Root" bone so the character faces -Z and is exactly CHARACTER_HEIGHT tall,
//  * retargets Universal Animation Library clips onto the rig (retarget.page.js),
//  * authors rifle upper-body clips (hold / aim / shoot / reload / sprint) and a parachute hang
//    with analytic two-bone IK, and computes the right-hand weapon socket.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRetargeter, bakeClip, boneMap, reduceTrack } from './retarget.page.js';

export const CHARACTER_HEIGHT = 1.8;

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const worldP = (o, out = new THREE.Vector3()) => o.getWorldPosition(out);
const worldQ = (o, out = new THREE.Quaternion()) => o.getWorldQuaternion(out);

export function setWorldQuaternion(bone, q) {
  const pq = bone.parent ? worldQ(bone.parent) : new THREE.Quaternion();
  bone.quaternion.copy(pq.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

function rotateToward(bone, childWorld, desiredWorld) {
  const p = worldP(bone);
  const from = childWorld.clone().sub(p).normalize();
  const to = desiredWorld.clone().sub(p).normalize();
  if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
  const r = new THREE.Quaternion().setFromUnitVectors(from, to);
  setWorldQuaternion(bone, r.multiply(worldQ(bone)));
}

/** Analytic two-bone IK: moves `hand`'s origin to `target`, elbow bent toward `pole` (world). */
export function solveArm(upper, lower, hand, target, pole) {
  const S = worldP(upper), E = worldP(lower), W = worldP(hand);
  const a = S.distanceTo(E), b = E.distanceTo(W);
  const dir = target.clone().sub(S);
  let d = dir.length();
  dir.normalize();
  d = Math.min(Math.max(d, Math.abs(a - b) + 1e-3), (a + b) * 0.999);
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const pv = pole.clone().sub(S);
  const perp = pv.sub(dir.clone().multiplyScalar(pv.dot(dir))).normalize();
  const elbow = S.clone().addScaledVector(dir, x).addScaledVector(perp, h);
  rotateToward(upper, worldP(lower), elbow);
  rotateToward(lower, worldP(hand), S.clone().addScaledVector(dir, d));
  return d < S.distanceTo(target) - 1e-3 ? S.distanceTo(target) - d : 0; // unreachable distance
}

/**
 * Samples `clip` at time t straight into the nodes of `root` (no AnimationMixer: a mixer restores
 * the original state when its actions stop, which would undo the pose).
 */
export function poseFromClip(root, clip, t = 0) {
  const nodes = {};
  root.traverse((o) => { nodes[o.name] = o; });
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const node = nodes[track.name.slice(0, dot)];
    const prop = track.name.slice(dot + 1);
    if (!node || !node[prop]) continue;
    const v = track.createInterpolant().evaluate(Math.min(t, clip.duration));
    node[prop].fromArray(v);
  }
  root.updateMatrixWorld(true);
}

/** Converts every skinned mesh of an outfit into one vertex-coloured skinned mesh. */
export function mergeOutfit(root, { drop = [], name = 'Body' } = {}) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  const keep = meshes.filter((m) => !drop.some((d) => m.name.startsWith(d) || m.parent.name.startsWith(d)));
  const skeleton = keep[0].skeleton;
  const geoms = [];
  for (const m of keep) {
    if (m.skeleton.bones.length !== skeleton.bones.length || m.skeleton.bones.some((b, i) => b !== skeleton.bones[i])) throw new Error('outfit meshes use different skeletons');
    let g = m.geometry.clone();
    if (!m.bindMatrix.equals(new THREE.Matrix4())) g.applyMatrix4(m.bindMatrix);
    g = g.index ? g : g;
    const col = (Array.isArray(m.material) ? m.material[0] : m.material).color;
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.morphAttributes = {};
    geoms.push(g.index ? g : g.toNonIndexed());
  }
  const allIndexed = geoms.every((g) => g.index);
  const merged = mergeGeometries(allIndexed ? geoms : geoms.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  const material = new THREE.MeshStandardMaterial({ name: 'outfit', vertexColors: true, roughness: 0.85, metalness: 0 });
  const mesh = new THREE.SkinnedMesh(merged, material);
  mesh.name = name;
  const parent = keep[0].parent.isSkinnedMesh || keep[0].parent.type === 'Group' && keep[0].parent !== root ? keep[0].parent.parent : keep[0].parent;
  for (const m of meshes) {
    const holder = m.parent !== parent && m.parent.type === 'Group' ? m.parent : m;
    holder.removeFromParent();
  }
  parent.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());
  return { mesh, skeleton, tris: merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3 };
}

/** Builds a skinned band around `boneName` (bind pose) as the team-colour armband primitive. */
export function makeArmband(skinned, boneName, { along = 0.45, width = 0.055, segments = 12 } = {}) {
  const skel = skinned.skeleton;
  const bi = skel.bones.findIndex((b) => b.name === boneName);
  const bone = skel.bones[bi];
  const child = bone.children.find((c) => c.isBone);
  const bindWorld = skel.boneInverses[bi].clone().invert();
  const childIdx = skel.bones.indexOf(child);
  const childBind = skel.boneInverses[childIdx].clone().invert();
  const a = new THREE.Vector3().setFromMatrixPosition(bindWorld);
  const b = new THREE.Vector3().setFromMatrixPosition(childBind);
  const axis = b.clone().sub(a);
  const len = axis.length();
  axis.normalize();
  const center = a.clone().addScaledVector(axis, len * along);
  // radius from vertices weighted to this bone near the band position
  const g = skinned.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  let r = 0;
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
    if (w < 0.5) continue;
    _v.fromBufferAttribute(pos, i).sub(center);
    const t = _v.dot(axis);
    if (Math.abs(t) > width) continue;
    r = Math.max(r, _v.addScaledVector(axis, -t).length());
  }
  r = (r || 0.05) * 1.06;
  const geo = new THREE.CylinderGeometry(r, r, width, segments, 1, true);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis));
  geo.translate(center.x, center.y, center.z);
  const n = geo.attributes.position.count;
  const idx = new Uint16Array(n * 4), wts = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { idx[i * 4] = bi; wts[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  geo.deleteAttribute('uv');
  const mat = new THREE.MeshStandardMaterial({ name: 'team', color: 0xffffff, roughness: 0.7, side: THREE.DoubleSide });
  const band = new THREE.SkinnedMesh(geo, mat);
  band.name = 'TeamBand';
  skinned.parent.add(band);
  band.bind(skel, new THREE.Matrix4());
  return band;
}

export function bindHeight(skinned) {
  skinned.skeleton.pose();
  skinned.parent.updateMatrixWorld(true);
  const pos = skinned.geometry.attributes.position;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minY, maxY, height: maxY - minY };
}

export async function exportGlb(object, animations = []) {
  const exporter = new GLTFExporter();
  return exporter.parseAsync(object, { binary: true, animations, onlyVisible: false, includeCustomExtensions: false });
}

// ---------------------------------------------------------------------------------------------
// Weapon socket + authored rifle clips
// ---------------------------------------------------------------------------------------------

const FIST = ['Middle1R', 'Middle2R', 'Middle3R', 'Ring1R', 'Ring2R', 'Ring3R'];

/**
 * Socket frame relative to the right wrist, measured on the retargeted two-handed pistol aim pose:
 * origin = centre of the closed fist (where a pistol grip sits), weapon -Z = character forward,
 * weapon +Y = up. Returns { position, quaternion } in WristR-local space.
 */
export function measureSocket(root, bones) {
  root.updateMatrixWorld(true);
  const c = new THREE.Vector3();
  for (const n of FIST) c.add(worldP(bones[n]));
  c.add(worldP(bones.WristR).lerp(worldP(bones.Middle1R), 0.5));
  c.multiplyScalar(1 / (FIST.length + 1));
  // Character faces +Z during authoring: weapon -Z -> +Z means a half turn about Y.
  const socketWorld = new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), new THREE.Vector3(1, 1, 1));
  bones.WristR.updateMatrixWorld(true);
  const local = bones.WristR.matrixWorld.clone().invert().multiply(socketWorld);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  local.decompose(p, q, s);
  return { position: p, quaternion: q, scale: s };
}

const UPPER = ['Abdomen', 'Torso', 'Chest', 'Neck', 'Head', 'ShoulderL', 'UpperArmL', 'LowerArmL', 'WristL', 'ShoulderR', 'UpperArmR', 'LowerArmR', 'WristR'];
const FINGERS = [];
for (const side of ['L', 'R']) {
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 4; i++) FINGERS.push(`${f}${i}${side}`);
  for (let i = 1; i <= 3; i++) FINGERS.push(`Thumb${i}${side}`);
}
export const UPPER_BODY_BONES = [...UPPER, ...FINGERS];

/**
 * Reference long-gun geometry in weapon-local space (metres, grip at origin, barrel -Z, up +Y):
 * the authored poses place these points; build-weapons normalises every long gun to the same
 * grip convention and the manifest carries per-weapon support-hand offsets.
 */
export const REF_RIFLE = {
  butt: new THREE.Vector3(0, 0.045, 0.24),
  support: new THREE.Vector3(0, 0.02, -0.16),
  sight: new THREE.Vector3(0, 0.115, -0.02),
};

/**
 * Places the right hand so the weapon socket sits at `gripWorld` with orientation `weaponQ`
 * (weapon->world), and the left hand on `supportWorld`.
 */
function placeHands(bones, socket, gripWorld, weaponQ, supportWorld, leftHandQ, poles, palmLocal) {
  // Right hand: wrist world = socketWorld * inverse(socketLocal)
  const socketWorld = new THREE.Matrix4().compose(gripWorld, weaponQ, new THREE.Vector3(1, 1, 1));
  const socketLocal = new THREE.Matrix4().compose(socket.position, socket.quaternion, new THREE.Vector3(1, 1, 1));
  const wrist = socketWorld.clone().multiply(socketLocal.clone().invert());
  const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
  wrist.decompose(wp, wq, ws);
  const missR = solveArm(bones.UpperArmR, bones.LowerArmR, bones.WristR, wp, poles.right);
  setWorldQuaternion(bones.WristR, wq);
  let missL = 0;
  if (supportWorld) {
    // Left wrist sits behind the support point along the hand's long axis.
    const lq = leftHandQ;
    const offset = palmLocal.clone().applyQuaternion(lq);
    missL = solveArm(bones.UpperArmL, bones.LowerArmL, bones.WristL, supportWorld.clone().sub(offset), poles.left);
    setWorldQuaternion(bones.WristL, lq);
    curlFingers(bones, 'L', 0.55);
  }
  return { missR, missL };
}

/** Curls the four fingers of one hand toward the palm by `angle` radians per joint (world space). */
function curlFingers(bones, side, angle) {
  const w = worldP(bones['Wrist' + side]), m = worldP(bones['Middle1' + side]);
  const i = worldP(bones['Index1' + side]), p = worldP(bones['Pinky1' + side]);
  const long = m.clone().sub(w).normalize();
  const across = i.clone().sub(p).normalize();
  const palm = side === 'L' ? new THREE.Vector3().crossVectors(long, across) : new THREE.Vector3().crossVectors(across, long);
  const axis = new THREE.Vector3().crossVectors(long, palm.normalize()).normalize();
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
    for (let j = 1; j <= 3; j++) {
      const bone = bones[`${f}${j}${side}`];
      if (!bone) continue;
      const r = new THREE.Quaternion().setFromAxisAngle(axis, angle * (j === 1 ? 0.8 : 1));
      setWorldQuaternion(bone, r.multiply(worldQ(bone)));
    }
  }
}

/** Builds a world rotation for the left (support) hand from desired long axis / palm normal. */
function handFrame(refLong, refPalm, refQ, long, palm) {
  // rotation R such that R*refLong = long and R*refPalm ~ palm (Gram-Schmidt)
  const a1 = refLong.clone().normalize(), b1 = refPalm.clone().sub(a1.clone().multiplyScalar(refPalm.dot(a1))).normalize();
  const c1 = new THREE.Vector3().crossVectors(a1, b1);
  const a2 = long.clone().normalize(), b2 = palm.clone().sub(a2.clone().multiplyScalar(palm.dot(a2))).normalize();
  const c2 = new THREE.Vector3().crossVectors(a2, b2);
  const m1 = new THREE.Matrix4().makeBasis(a1, b1, c1), m2 = new THREE.Matrix4().makeBasis(a2, b2, c2);
  const r = new THREE.Quaternion().setFromRotationMatrix(m2.multiply(m1.invert()));
  return r.multiply(refQ);
}

function snapshot(names, bones) {
  const out = {};
  for (const n of names) if (bones[n]) out[n] = bones[n].quaternion.clone();
  return out;
}

function clipFromKeys(name, keys, names, { loop = false } = {}) {
  // keys: [{ t, pose }]
  const times = keys.map((k) => k.t);
  const tracks = [];
  for (const n of names) {
    if (!keys[0].pose[n]) continue;
    const vals = [];
    let prev = null;
    for (const k of keys) {
      const q = k.pose[n].clone();
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      vals.push(q.x, q.y, q.z, q.w);
      prev = q;
    }
    tracks.push(reduceTrack(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, vals), 4));
  }
  const clip = new THREE.AnimationClip(name, times[times.length - 1], tracks);
  if (loop) clip.userData = { loop: true };
  return clip;
}

/**
 * Authors the long-gun upper-body clips on a rig posed from `baseClip` (a retargeted idle) with
 * fingers from `gripClip` (retargeted two-handed pistol aim).
 */
export function authorRifleClips(root, bones, socket, { idleClip, gripClip }) {
  const fingerPose = (() => { poseFromClip(root, gripClip, 0); return snapshot(FINGERS, bones); })();
  const reset = () => {
    poseFromClip(root, idleClip, 0);
    for (const [n, q] of Object.entries(fingerPose)) bones[n].quaternion.copy(q);
    root.updateMatrixWorld(true);
  };
  reset();
  const fwd = new THREE.Vector3(0, 0, 1), up = new THREE.Vector3(0, 1, 0);
  // Reference points (character faces +Z).
  const headP = worldP(bones.Head);
  const shoulderR = worldP(bones.UpperArmR), shoulderL = worldP(bones.UpperArmL);
  const neckP = worldP(bones.Neck);
  const headLen = headP.y - neckP.y;
  const eye = new THREE.Vector3(headP.x - 0.032, headP.y + headLen * 1.05 + 0.03, headP.z + 0.085);

  // Left hand reference frame (idle pose): long axis wrist->middle knuckle, palm normal from knuckle spread.
  const leftFrame = () => {
    const w = worldP(bones.WristL), m = worldP(bones.Middle1L), i = worldP(bones.Index1L), p = worldP(bones.Pinky1L);
    const long = m.clone().sub(w).normalize();
    const across = i.clone().sub(p).normalize(); // toward thumb side
    const palm = new THREE.Vector3().crossVectors(long, across).normalize(); // left hand: long x across = palm normal
    return { long, palm, q: worldQ(bones.WristL) };
  };
  const lf = leftFrame();

  const twist = (deg) => {
    // Rotate the spine so the left shoulder comes forward; head counter-rotates to keep looking ahead.
    const per = THREE.MathUtils.degToRad(deg) / 3;
    for (const n of ['Abdomen', 'Torso', 'Chest']) {
      const q = new THREE.Quaternion().setFromAxisAngle(up, per).multiply(worldQ(bones[n]));
      setWorldQuaternion(bones[n], q);
    }
  };
  const lookAhead = (pitchDeg, rollDeg = 0) => {
    // Head (and half on neck) back to facing +Z, pitched down by pitchDeg.
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), 0, THREE.MathUtils.degToRad(rollDeg), 'YXZ'));
    const headRef = headRefQ.clone();
    setWorldQuaternion(bones.Neck, new THREE.Quaternion().slerpQuaternions(worldQ(bones.Neck), target.clone().multiply(neckRefQ), 0.5));
    setWorldQuaternion(bones.Head, target.multiply(headRef));
  };
  const headRefQ = worldQ(bones.Head), neckRefQ = worldQ(bones.Neck);

  // Support hand orientation for a handguard grip, defined in weapon space (barrel -Z, up +Y,
  // +X = the character's right): fingers point forward and across the handguard, palm up/inward.
  const supportQ = (q) => handFrame(lf.long, lf.palm, lf.q,
    new THREE.Vector3(0.45, 0.15, -1).normalize().applyQuaternion(q),
    new THREE.Vector3(0.5, 1, 0).normalize().applyQuaternion(q));
  // Palm centre relative to the left wrist, in wrist-local space (measured on the idle pose).
  const palmLocal = (() => {
    const w = worldP(bones.WristL), m = worldP(bones.Middle1L);
    const pc = w.clone().lerp(m, 0.55).addScaledVector(lf.palm, 0.025);
    return pc.sub(w).applyQuaternion(lf.q.clone().invert());
  })();

  const poles = { right: new THREE.Vector3(shoulderR.x - 0.5, shoulderR.y - 0.6, shoulderR.z - 0.1), left: new THREE.Vector3(shoulderL.x + 0.35, shoulderL.y - 0.7, shoulderL.z + 0.2) };
  const misses = {};

  /** Pose with the weapon defined by its butt position (shoulder pocket) and pitch/yaw/roll. */
  const rifle = ({ pitch = 0, yaw = 0, roll = 0, buttWorld, twistDeg = -18, head = [6, 4], support = REF_RIFLE.support, label }) => {
    reset();
    twist(twistDeg);
    lookAhead(head[0], head[1]);
    // weapon->world: barrel (-Z local) to +Z world, then pitch (positive = muzzle down), yaw, roll.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), THREE.MathUtils.degToRad(roll), 'YXZ'))
      .multiply(new THREE.Quaternion().setFromAxisAngle(up, Math.PI));
    const grip = buttWorld.clone().sub(REF_RIFLE.butt.clone().applyQuaternion(q));
    const sup = support ? grip.clone().add(support.clone().applyQuaternion(q)) : null;
    const m = placeHands(bones, socket, grip, q, sup, supportQ(q), poles, palmLocal);
    if (label) misses[label] = m;
    return snapshot(UPPER_BODY_BONES, bones);
  };

  // Shoulder pocket: in front of the right shoulder joint, slightly inward.
  const pocketAim = new THREE.Vector3(THREE.MathUtils.lerp(eye.x, shoulderR.x, 0.25), eye.y - REF_RIFLE.sight.y + REF_RIFLE.butt.y, shoulderR.z + 0.03);
  const aimSightY = eye.y;
  const aim = rifle({ buttWorld: pocketAim, twistDeg: -34, head: [8, 8], label: 'aim' });
  const hold = rifle({ buttWorld: new THREE.Vector3(shoulderR.x + 0.08, shoulderR.y - 0.07, shoulderR.z + 0.06), pitch: 30, yaw: 10, twistDeg: -26, head: [4, 0], label: 'hold' });
  // Sprint / port arms: butt low at the right hip, muzzle up and across the chest to the left.
  const sprint = rifle({ buttWorld: new THREE.Vector3(shoulderR.x + 0.1, shoulderR.y - 0.34, shoulderR.z + 0.14), pitch: -32, yaw: 50, roll: -20, twistDeg: -10, head: [0, 0], label: 'sprint' });
  // Recoil: butt pushed back, muzzle rises.
  const kick = rifle({ buttWorld: pocketAim.clone().add(new THREE.Vector3(0, 0.012, -0.035)), pitch: -5, twistDeg: -34, head: [8, 8], label: 'kick' });
  // Reload keys: rifle canted and lowered, support hand travels to the magazine and the vest.
  const reloadGun = { buttWorld: new THREE.Vector3(shoulderR.x + 0.08, shoulderR.y - 0.08, shoulderR.z + 0.06), pitch: 20, yaw: 12, roll: -25, twistDeg: -24, head: [16, 0] };
  const magOut = rifle({ ...reloadGun, support: new THREE.Vector3(0, -0.11, -0.1), label: 'magOut' });
  const magPull = rifle({ ...reloadGun, support: new THREE.Vector3(0.05, -0.3, -0.02), label: 'magPull' });
  const pouch = rifle({ ...reloadGun, support: new THREE.Vector3(0.18, -0.36, 0.12), head: [22, 0], label: 'pouch' });
  const magIn = rifle({ ...reloadGun, support: new THREE.Vector3(0, -0.13, -0.1), label: 'magIn' });
  const magSeat = rifle({ ...reloadGun, support: new THREE.Vector3(0, -0.09, -0.1), label: 'magSeat' });
  const reloadSupport = rifle({ ...reloadGun, label: 'reloadSupport' });

  // Parachute hang: both hands up on the risers, elbows out.
  reset();
  const riserL = new THREE.Vector3(shoulderL.x + 0.12, headP.y + 0.32, shoulderL.z + 0.05);
  const riserR = new THREE.Vector3(shoulderR.x - 0.12, headP.y + 0.32, shoulderR.z + 0.05);
  solveArm(bones.UpperArmL, bones.LowerArmL, bones.WristL, riserL, new THREE.Vector3(shoulderL.x + 1, shoulderL.y, shoulderL.z - 0.2));
  solveArm(bones.UpperArmR, bones.LowerArmR, bones.WristR, riserR, new THREE.Vector3(shoulderR.x - 1, shoulderR.y, shoulderR.z - 0.2));
  const hang = snapshot(UPPER_BODY_BONES, bones);

  const N = UPPER_BODY_BONES;
  const clips = [
    clipFromKeys('Rifle_Hold', [{ t: 0, pose: hold }, { t: 1, pose: hold }], N, { loop: true }),
    clipFromKeys('Rifle_Aim', [{ t: 0, pose: aim }, { t: 1, pose: aim }], N, { loop: true }),
    clipFromKeys('Rifle_Shoot', [{ t: 0, pose: aim }, { t: 0.04, pose: kick }, { t: 0.16, pose: aim }], N),
    clipFromKeys('Rifle_Sprint', [{ t: 0, pose: sprint }, { t: 1, pose: sprint }], N, { loop: true }),
    clipFromKeys('Rifle_Reload', [
      { t: 0, pose: hold }, { t: 0.25, pose: reloadSupport }, { t: 0.45, pose: magOut }, { t: 0.7, pose: magPull },
      { t: 1.05, pose: pouch }, { t: 1.35, pose: magIn }, { t: 1.55, pose: magSeat }, { t: 1.8, pose: reloadSupport }, { t: 2.1, pose: hold },
    ], N),
    clipFromKeys('Parachute_Hang', [{ t: 0, pose: hang }, { t: 1, pose: hang }], N, { loop: true }),
  ];
  return { clips, misses, eye: eye.toArray(), aimSightY };
}

/**
 * Compact animation-library writer (skeleton nodes + clips, no meshes). Unlike GLTFExporter it
 * shares identical keyframe-time accessors and packs everything into a single bufferView, which
 * keeps the JSON chunk small for ~60 clips x ~60 channels. Tracks equal to the node's rest value
 * (single key) are dropped: three.js' AnimationMixer falls back to the rest pose for untracked
 * properties, so they carry no information.
 */
export function exportAnimationGlb(root, clips) {
  const nodes = [], index = new Map();
  const visit = (o) => {
    const i = nodes.length;
    index.set(o, i);
    const n = { name: o.name };
    if (!o.position.equals(new THREE.Vector3())) n.translation = o.position.toArray();
    if (!(o.quaternion.x === 0 && o.quaternion.y === 0 && o.quaternion.z === 0 && o.quaternion.w === 1)) n.rotation = o.quaternion.toArray();
    if (!o.scale.equals(new THREE.Vector3(1, 1, 1))) n.scale = o.scale.toArray();
    nodes.push(n);
    const kids = o.children.filter((c) => !c.isMesh && !c.isLight && !c.isCamera);
    if (kids.length) n.children = kids.map(visit);
    return i;
  };
  const rootIdx = visit(root);
  const byName = new Map();
  root.traverse((o) => { if (index.has(o)) byName.set(o.name, o); });
  const chunks = [];
  let offset = 0;
  const accessors = [];
  const pushFloats = (arr, type, minmax) => {
    const f32 = Float32Array.from(arr);
    const acc = { bufferView: 0, byteOffset: offset, componentType: 5126, count: f32.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4 }[type]), type };
    if (minmax) { acc.min = [f32[0]]; acc.max = [f32[f32.length - 1]]; }
    chunks.push(f32);
    offset += f32.byteLength;
    accessors.push(acc);
    return accessors.length - 1;
  };
  const timeCache = new Map();
  const animations = [];
  const PATH = { quaternion: 'rotation', position: 'translation', scale: 'scale' };
  let dropped = 0;
  for (const clip of clips) {
    const channels = [], samplers = [];
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const node = byName.get(track.name.slice(0, dot));
      const prop = track.name.slice(dot + 1);
      if (!node || !PATH[prop]) continue;
      if (track.times.length === 1) {
        const rest = node[prop].toArray();
        if (rest.every((v, i) => Math.abs(v - track.values[i]) < 2e-4)) { dropped++; continue; }
      }
      const key = Array.from(track.times, (t) => t.toFixed(5)).join(',');
      let input = timeCache.get(key);
      if (input === undefined) { input = pushFloats(track.times, 'SCALAR', true); timeCache.set(key, input); }
      const output = pushFloats(track.values, prop === 'quaternion' ? 'VEC4' : 'VEC3');
      samplers.push({ input, output, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: index.get(node), path: PATH[prop] } });
    }
    animations.push({ name: clip.name, channels, samplers });
  }
  const bin = new Uint8Array(offset);
  let o2 = 0;
  for (const c of chunks) { bin.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), o2); o2 += c.byteLength; }
  const json = {
    asset: { version: '2.0', generator: 'DROPZONE scripts/assets (characters.page.js)' },
    scene: 0, scenes: [{ nodes: [rootIdx] }], nodes, animations, accessors,
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: offset }], buffers: [{ byteLength: offset }],
  };
  return { glb: packGlb(json, bin), dropped };
}

export function packGlb(json, bin) {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true); dv.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20;
  const b0 = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(b0, bin.length + binPad, true); dv.setUint32(b0 + 4, 0x004e4942, true);
  u8.set(bin, b0 + 8);
  return out;
}
