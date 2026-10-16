// Browser-side retargeting of Quaternius Universal Animation Library clips (UE-mannequin-style
// skeleton) onto the Quaternius Ultimate Modular Men / Women skeleton. Runs inside the headless
// page created by harness.mjs (see build-characters.mjs). Not shipped with the game.
//
// Method: both skeletons are put into a common reference pose (the UAL bind pose, a T-pose; the
// target skeleton is direction-aligned to it bone by bone). For every sampled frame the world-space
// rotation delta of each source bone from its reference is applied to the matching target bone's
// reference world rotation, and converted back to a local rotation. The pelvis translation is
// transferred as an offset scaled by the hip-height ratio; IK-style feet (children of Root in the
// target rig) are re-attached to the end of the shin.
import * as THREE from 'three';

/** Target (UMM/UMW) bone -> source (UAL) bone. */
export const BONE_MAP = {
  Body: 'pelvis',
  Abdomen: 'spine_01',
  Torso: 'spine_02',
  Chest: 'spine_03',
  Neck: 'neck_01',
  Head: 'Head',
  'Shoulder.L': 'clavicle_l', 'UpperArm.L': 'upperarm_l', 'LowerArm.L': 'lowerarm_l', 'Wrist.L': 'hand_l',
  'Shoulder.R': 'clavicle_r', 'UpperArm.R': 'upperarm_r', 'LowerArm.R': 'lowerarm_r', 'Wrist.R': 'hand_r',
  'UpperLeg.L': 'thigh_l', 'LowerLeg.L': 'calf_l', 'Foot.L': 'foot_l',
  'UpperLeg.R': 'thigh_r', 'LowerLeg.R': 'calf_r', 'Foot.R': 'foot_r',
};
for (const side of ['L', 'R']) {
  const s = side.toLowerCase();
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 3; i++) BONE_MAP[`${f}${i}.${side}`] = `${f.toLowerCase()}_0${i}_${s}`;
  for (let i = 1; i <= 3; i++) BONE_MAP[`Thumb${i}.${side}`] = `thumb_0${i}_${s}`;
}

// three.js strips '.' from node names (PropertyBinding.sanitizeNodeName): 'Foot.L' -> 'FootL'.
const S = (n) => THREE.PropertyBinding.sanitizeNodeName(n);
for (const k of Object.keys(BONE_MAP)) {
  const v = BONE_MAP[k];
  delete BONE_MAP[k];
  BONE_MAP[S(k)] = v;
}

/** Direction-alignment chains: [targetBone, targetChild, sourceBone, sourceChild]. */
const ALIGN = [];
for (const side of ['L', 'R']) {
  const s = side.toLowerCase();
  ALIGN.push(
    [`UpperLeg.${side}`, `LowerLeg.${side}`, `thigh_${s}`, `calf_${s}`],
    [`LowerLeg.${side}`, `Foot.${side}`, `calf_${s}`, `foot_${s}`],
    [`Shoulder.${side}`, `UpperArm.${side}`, `clavicle_${s}`, `upperarm_${s}`],
    [`UpperArm.${side}`, `LowerArm.${side}`, `upperarm_${s}`, `lowerarm_${s}`],
    [`LowerArm.${side}`, `Wrist.${side}`, `lowerarm_${s}`, `hand_${s}`],
    [`Wrist.${side}`, `Middle1.${side}`, `hand_${s}`, `middle_01_${s}`],
  );
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
    const fl = f.toLowerCase();
    ALIGN.push([`${f}1.${side}`, `${f}2.${side}`, `${fl}_01_${s}`, `${fl}_02_${s}`], [`${f}2.${side}`, `${f}3.${side}`, `${fl}_02_${s}`, `${fl}_03_${s}`]);
  }
  ALIGN.push([`Thumb1.${side}`, `Thumb2.${side}`, `thumb_01_${s}`, `thumb_02_${s}`], [`Thumb2.${side}`, `Thumb3.${side}`, `thumb_02_${s}`, `thumb_03_${s}`]);
}
ALIGN.push(['Abdomen', 'Torso', 'spine_01', 'spine_02'], ['Torso', 'Chest', 'spine_02', 'spine_03'], ['Neck', 'Head', 'neck_01', 'Head']);
for (const a of ALIGN) { a[0] = S(a[0]); a[1] = S(a[1]); }

/** Bones whose anatomical parent differs from their scene-graph parent (IK feet). */
const ANATOMICAL_PARENT = { FootL: 'LowerLegL', FootR: 'LowerLegR' };

export function boneMap(root) {
  const m = {};
  root.traverse((o) => { if (o.isBone) m[o.name] = o; });
  return m;
}

export function firstSkeleton(root) {
  let sk = null;
  root.traverse((o) => { if (!sk && o.isSkinnedMesh) sk = o.skeleton; });
  return sk;
}

/** Bones in parent-before-child order. */
function orderedBones(root) {
  const out = [];
  root.traverse((o) => { if (o.isBone) out.push(o); });
  return out;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();

function worldQ(o, out = new THREE.Quaternion()) { return o.getWorldQuaternion(out); }
function worldP(o, out = new THREE.Vector3()) { return o.getWorldPosition(out); }

function setWorldQuaternion(bone, q) {
  const pq = bone.parent ? worldQ(bone.parent, _q2) : _q2.identity();
  bone.quaternion.copy(pq.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

function setWorldPosition(bone, p) {
  bone.parent.updateMatrixWorld(true);
  _m.copy(bone.parent.matrixWorld).invert();
  bone.position.copy(p).applyMatrix4(_m);
  bone.updateMatrixWorld(true);
}

/**
 * Prepares a retargeter. `srcRoot` is the UAL scene (its skeleton will be posed by clips),
 * `dstRoot` the target character scene. Both must face +Z with Y up (true for both packs).
 */
export function createRetargeter(srcRoot, dstRoot) {
  const src = boneMap(srcRoot), dst = boneMap(dstRoot);
  const srcSkel = firstSkeleton(srcRoot), dstSkel = firstSkeleton(dstRoot);
  srcSkel.pose();
  dstSkel.pose();
  srcRoot.updateMatrixWorld(true);
  dstRoot.updateMatrixWorld(true);

  // Feet: remember their offset in the shin frame (bind pose) before aligning.
  const footOffset = {};
  for (const [foot, shin] of Object.entries(ANATOMICAL_PARENT)) {
    footOffset[foot] = worldP(dst[foot]).applyMatrix4(dst[shin].matrixWorld.clone().invert());
  }
  const reattachFeet = () => {
    for (const [foot, shin] of Object.entries(ANATOMICAL_PARENT)) {
      dst[shin].updateMatrixWorld(true);
      setWorldPosition(dst[foot], _v.copy(footOffset[foot]).applyMatrix4(dst[shin].matrixWorld));
    }
  };

  // Align target to the source reference pose (directions), parents first.
  const order = orderedBones(dstRoot).map((b) => b.name);
  const alignSorted = ALIGN.slice().sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  for (const [tb, tc, sb, sc] of alignSorted) {
    if (!dst[tb] || !dst[tc] || !src[sb] || !src[sc]) continue;
    const dDir = worldP(dst[tc], new THREE.Vector3()).sub(worldP(dst[tb])).normalize();
    const sDir = worldP(src[sc], new THREE.Vector3()).sub(worldP(src[sb])).normalize();
    const rot = new THREE.Quaternion().setFromUnitVectors(dDir, sDir);
    setWorldQuaternion(dst[tb], rot.multiply(worldQ(dst[tb])));
    if (tb.startsWith('LowerLeg') || tb.startsWith('UpperLeg')) reattachFeet();
  }
  reattachFeet();
  dstRoot.updateMatrixWorld(true);

  const ref = {};
  for (const name of order) {
    const b = dst[name];
    ref[name] = { localQ: b.quaternion.clone(), localP: b.position.clone(), worldQ: worldQ(b) };
  }
  const srcRef = {};
  for (const [t, s] of Object.entries(BONE_MAP)) if (src[s]) srcRef[s] = worldQ(src[s]);
  const srcPelvisRef = worldP(src.pelvis);
  const dstBodyRef = worldP(dst.Body);
  const hipScale = dstBodyRef.y / srcPelvisRef.y;

  /** Pose the target from the current source pose (source must be updated). */
  function applyFrame() {
    srcRoot.updateMatrixWorld(true);
    for (const name of order) {
      const b = dst[name];
      const s = BONE_MAP[name];
      if (s && src[s]) {
        const delta = worldQ(src[s], _q).multiply(_q2.copy(srcRef[s]).invert());
        const desired = delta.multiply(ref[name].worldQ);
        b.position.copy(ref[name].localP);
        setWorldQuaternion(b, desired);
      } else {
        b.quaternion.copy(ref[name].localQ);
        b.position.copy(ref[name].localP);
        b.updateMatrixWorld(true);
      }
      if (name === 'Body') {
        const p = worldP(src.pelvis, _v2).sub(srcPelvisRef).multiplyScalar(hipScale).add(dstBodyRef);
        setWorldPosition(b, p);
      }
    }
    reattachFeet();
  }

  return { src, dst, order, ref, hipScale, applyFrame, srcSkel, dstSkel };
}

/**
 * Bakes `clip` (bound to srcRoot) into a target clip sampled at `fps`. Every target bone gets a
 * quaternion track (so switching clips never leaves stale bones); Body and the IK feet also get
 * position tracks. Constant tracks are reduced to a single key.
 */
export function bakeClip(rt, srcRoot, clip, name, { fps = 30, loop = true } = {}) {
  const mixer = new THREE.AnimationMixer(srcRoot);
  const action = mixer.clipAction(clip);
  action.play();
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const qs = {}, ps = {};
  const posBones = ['Body', 'FootL', 'FootR'];
  for (const n of rt.order) qs[n] = new Float32Array(frames * 4);
  for (const n of posBones) ps[n] = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    action.time = t;
    mixer.update(0);
    rt.applyFrame();
    for (const n of rt.order) rt.dst[n].quaternion.toArray(qs[n], f * 4);
    for (const n of posBones) rt.dst[n].position.toArray(ps[n], f * 3);
  }
  // Loop seam: make the last frame equal to the first for looping clips.
  if (loop) {
    for (const n of rt.order) qs[n].copyWithin((frames - 1) * 4, 0, 4);
    for (const n of posBones) ps[n].copyWithin((frames - 1) * 3, 0, 3);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(srcRoot);
  const tracks = [];
  for (const n of rt.order) {
    fixQuaternionSigns(qs[n]);
    tracks.push(reduceTrack(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, qs[n]), 4));
  }
  for (const n of posBones) tracks.push(reduceTrack(new THREE.VectorKeyframeTrack(`${n}.position`, times, ps[n]), 3));
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

function fixQuaternionSigns(arr) {
  for (let i = 4; i < arr.length; i += 4) {
    const dot = arr[i] * arr[i - 4] + arr[i + 1] * arr[i - 3] + arr[i + 2] * arr[i - 2] + arr[i + 3] * arr[i - 1];
    if (dot < 0) for (let k = 0; k < 4; k++) arr[i + k] = -arr[i + k];
  }
}

/**
 * Lossy keyframe reduction: collapses (nearly) constant tracks to one key, then greedily removes
 * keys that interpolation between their kept neighbours reproduces within tolerance
 * (quaternions: `angleTol` radians, vectors: `distTol` metres).
 */
export function reduceTrack(track, stride, { eps = 2e-4, angleTol = 0.006, distTol = 0.002 } = {}) {
  const v = track.values, t = track.times;
  const n = t.length;
  let constant = true;
  for (let i = stride; i < v.length && constant; i++) if (Math.abs(v[i] - v[i % stride]) > eps) constant = false;
  const T = track.constructor;
  if (constant) return new T(track.name, [0], Array.from(v.slice(0, stride)));
  if (n <= 2) return track;
  const isQuat = stride === 4;
  const a = new THREE.Quaternion(), b = new THREE.Quaternion(), c = new THREE.Quaternion(), x = new THREE.Quaternion();
  const errAt = (i0, i1, k) => {
    const alpha = (t[k] - t[i0]) / (t[i1] - t[i0]);
    if (isQuat) {
      a.fromArray(v, i0 * 4); b.fromArray(v, i1 * 4); c.fromArray(v, k * 4);
      x.slerpQuaternions(a, b, alpha);
      return x.angleTo(c);
    }
    let d = 0;
    for (let j = 0; j < stride; j++) {
      const e = v[i0 * stride + j] + (v[i1 * stride + j] - v[i0 * stride + j]) * alpha - v[k * stride + j];
      d += e * e;
    }
    return Math.sqrt(d);
  };
  const tol = isQuat ? angleTol : distTol;
  const keep = [0];
  let last = 0;
  for (let i = 2; i < n; i++) {
    // Can we span last -> i without the keys in between?
    let ok = true;
    for (let k = last + 1; k < i && ok; k++) if (errAt(last, i, k) > tol) ok = false;
    if (!ok) { keep.push(i - 1); last = i - 1; }
  }
  keep.push(n - 1);
  const times = keep.map((i) => t[i]);
  const values = [];
  for (const i of keep) for (let j = 0; j < stride; j++) values.push(v[i * stride + j]);
  return new T(track.name, times, values);
}
