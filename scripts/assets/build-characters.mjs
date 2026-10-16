#!/usr/bin/env node
// Builds public/assets/models/characters/*.glb and public/assets/models/animations/*.glb from the
// pinned Quaternius sources (see sources.mjs / fetch-sources.sh). Usage:
//   node scripts/assets/build-characters.mjs
// Prints the measured weapon socket and rig data that src/client/assets/manifest.ts mirrors.
import path from 'node:path';
import fs from 'node:fs';
import { runInPage, MODELS_DIR } from './harness.mjs';
import { DL, UMM, UMW, UAL1, UAL2 } from './sources.mjs';

/** UAL clips retargeted onto both rigs (source clip name -> loop?). */
const UAL_CLIPS = {
  // locomotion
  Idle_Loop: true, Idle_LookAround_Loop: true, Walk_Loop: true, Walk_Bwd_Loop: true, Walk_L_Loop: true, Walk_R_Loop: true,
  Jog_Fwd_Loop: true, Jog_Bwd_Loop: true, Jog_Left_Loop: true, Jog_Right_Loop: true, Sprint_Loop: true,
  Jump_Start: false, Jump_Loop: true, Jump_Land: false,
  Crouch_Idle_Loop: true, Crouch_Fwd_Loop: true, Crouch_Bwd_Loop: true, Crouch_Left_Loop: true, Crouch_Right_Loop: true,
  Crawl_Idle_Loop: true, Crawl_Fwd_Loop: true, Crawl_Bwd_Loop: true, Crawl_Left_Loop: true, Crawl_Right_Loop: true,
  Swim_Idle_Loop: true, Swim_Fwd_Loop: true,
  // seats / actions
  Driving_Loop: true, Sitting_Idle_Loop: true, Fixing_Kneeling: true, Bandage_Loop: true, Drink: false, Consume: false,
  PickUp_Kneeling: false, Interact: false, OverhandThrow: false, Roll: false, SafetyVault: false, ClimbUp_1m: false,
  // pistol
  Pistol_Idle_Loop: true, Pistol_Aim_Neutral: true, Pistol_Aim_Up: true, Pistol_Aim_Down: true, Pistol_Shoot: false, Pistol_Reload: false,
  // reactions
  Hit_Chest: false, Hit_Head: false, Hit_Stomach: false, Hit_Shoulder_L: false, Hit_Shoulder_R: false, Death01: false, Death02: false,
  Celebration: false, Dance_Loop: true,
};

const RIGS = [
  {
    id: 'male', base: `${UMM}/Swat.gltf`,
    variants: [
      { id: 'male_tactical', file: `${UMM}/Swat.gltf`, drop: ['Pistol'] },
      { id: 'male_casual', file: `${UMM}/Casual_2.gltf`, drop: [] },
      { id: 'male_hoodie', file: `${UMM}/Casual_Hoodie.gltf`, drop: [] },
    ],
  },
  {
    id: 'female', base: `${UMW}/Soldier.gltf`,
    variants: [
      { id: 'female_tactical', file: `${UMW}/Soldier.gltf`, drop: [] },
      { id: 'female_adventurer', file: `${UMW}/Adventurer.gltf`, drop: [] },
      { id: 'female_casual', file: `${UMW}/Casual.gltf`, drop: [] },
    ],
  },
];

const outChars = path.join(MODELS_DIR, 'characters');
const outAnims = path.join(MODELS_DIR, 'animations');
fs.mkdirSync(outChars, { recursive: true });
fs.mkdirSync(outAnims, { recursive: true });

const page = `
import * as THREE from 'three';
import { loadGltf, toBase64 } from '/scripts/page-lib.js';
import { createRetargeter, bakeClip, boneMap } from '/scripts/retarget.page.js';
import { mergeOutfit, makeArmband, bindHeight, exportGlb, exportAnimationGlb, measureSocket, authorRifleClips, poseFromClip, CHARACTER_HEIGHT, UPPER_BODY_BONES } from '/scripts/characters.page.js';
const RIGS = ${JSON.stringify(RIGS)};
const UAL_CLIPS = ${JSON.stringify(UAL_CLIPS)};
const OUT_CHARS = ${JSON.stringify(outChars)};
const OUT_ANIMS = ${JSON.stringify(outAnims)};
const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
const ual1 = await loadGltf('/dl/' + enc(${JSON.stringify(UAL1)}));
const ual2 = await loadGltf('/dl/' + enc(${JSON.stringify(UAL2)}));
const srcClips = new Map([...ual1.animations, ...ual2.animations].map((c) => [c.name, c]));
const report = {};
for (const rig of RIGS) {
  const base = await loadGltf('/dl/' + enc(rig.base));
  const rt = createRetargeter(ual1.scene, base.scene);
  const clips = [];
  for (const [name, loop] of Object.entries(UAL_CLIPS)) {
    const c = srcClips.get(name);
    if (!c) throw new Error('missing UAL clip ' + name);
    const baked = bakeClip(rt, ual1.scene, c, name, { loop });
    // Root carries the facing/scale fix of the exported characters: never animate it.
    baked.tracks = baked.tracks.filter((t) => !t.name.startsWith('Root.'));
    clips.push(baked);
  }
  const byName = new Map(clips.map((c) => [c.name, c]));
  const bones = boneMap(base.scene);
  poseFromClip(base.scene, byName.get('Pistol_Aim_Neutral'), 0);
  const socket = measureSocket(base.scene, bones);
  const authored = authorRifleClips(base.scene, bones, socket, { idleClip: byName.get('Idle_Loop'), gripClip: byName.get('Pistol_Aim_Neutral') });
  clips.push(...authored.clips);

  // Animation library: the bare skeleton + clips.
  // Rest pose of the library skeleton = bind pose (what the exported characters rest in).
  let skel = null;
  base.scene.traverse((o) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; });
  skel.pose();
  base.scene.updateMatrixWorld(true);
  const armature = bones.Root.parent;
  const { glb: animBuf, dropped } = exportAnimationGlb(armature, clips);
  await window.__writeFile(OUT_ANIMS + '/humanoid-' + rig.id + '.glb', toBase64(animBuf));

  const rigReport = { droppedRestTracks: dropped, socket: { position: socket.position.toArray(), quaternion: socket.quaternion.toArray() }, misses: authored.misses, eye: authored.eye, clips: clips.map((c) => [c.name, +c.duration.toFixed(3), c.tracks.length]), animBytes: animBuf.byteLength, variants: {} };
  for (const v of rig.variants) {
    const g = await loadGltf('/dl/' + enc(v.file));
    const { mesh, tris } = mergeOutfit(g.scene, { drop: v.drop, name: 'Body' });
    const band = makeArmband(mesh, 'UpperArmL');
    const h = bindHeight(mesh);
    const scale = CHARACTER_HEIGHT / h.height;
    const vb = boneMap(g.scene);
    // Face -Z (three.js forward) and normalise height by transforming the Root bone.
    vb.Root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    vb.Root.scale.multiplyScalar(scale);
    vb.Root.position.multiplyScalar(scale);
    vb.Root.position.y -= h.minY * scale;
    g.scene.updateMatrixWorld(true);
    const buf = await exportGlb(g.scene, []);
    await window.__writeFile(OUT_CHARS + '/' + v.id + '.glb', toBase64(buf));
    rigReport.variants[v.id] = { tris, bandTris: band.geometry.index ? band.geometry.index.count / 3 : 0, height: h.height, scale, bytes: buf.byteLength };
  }
  report[rig.id] = rigReport;
}
window.__done(report);
`;

const { result } = await runInPage(page, { mounts: { '/dl/': DL }, timeoutMs: 900_000 });
fs.mkdirSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'reports'), { recursive: true });
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'reports', 'characters.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 1).slice(0, 6000));
