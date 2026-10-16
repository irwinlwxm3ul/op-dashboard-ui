// Vehicle pipeline (browser side). Each source model is re-oriented (front -Z, up +Y, right +X),
// uniformly scaled to the gameplay collision box length, and re-centred so the model origin is the
// physics OBB centre (VehicleState.pos): wheels touch the ground at y = -rideHeight. Wheels become
// separate nodes pivoting at their centres (spin = rotation.x); the bike fork pivots on its
// steering axis (steer = rotation.y with the loaded rotation.x rake kept).
import {
  THREE, load, dl, parts, merge, simplify, bboxOf, bbox, tris, applyMatrix, retex, standard, mesh,
  paintTex, setUv, only, exportGlb, sceneTris,
} from './world.page.js';

function horizontalYaw(dir) {
  // Rotation about +Y that maps horizontal `dir` onto -Z.
  return Math.atan2(dir.x, dir.z) + Math.PI;
}

/** Root-space centre (bbox) of a list of geometries. */
function centerOf(geos) {
  return bboxOf(geos).getCenter(new THREE.Vector3());
}

/**
 * Common placement: rotate so front wheels are at -Z, scale to `length`, centre X/Z and put the
 * wheel bottoms at y = -rideHeight. Returns the 4x4 matrix to bake.
 */
function placement(allGeos, frontGeos, rearGeos, wheelGeos, length, rideHeight) {
  const dir = centerOf(frontGeos).sub(centerOf(rearGeos));
  dir.y = 0;
  dir.normalize();
  const rot = new THREE.Matrix4().makeRotationY(horizontalYaw(dir));
  const tmp = allGeos.map((g) => g.clone().applyMatrix4(rot));
  const b = bboxOf(tmp);
  const s = length / (b.max.z - b.min.z);
  const scale = new THREE.Matrix4().makeScale(s, s, s);
  const rs = new THREE.Matrix4().multiplyMatrices(scale, rot);
  const all2 = allGeos.map((g) => g.clone().applyMatrix4(rs));
  const wheels2 = wheelGeos.map((g) => g.clone().applyMatrix4(rs));
  const b2 = bboxOf(all2), bw = bboxOf(wheels2);
  const c = b2.getCenter(new THREE.Vector3());
  const t = new THREE.Matrix4().makeTranslation(-c.x, -rideHeight - bw.min.y, -c.z);
  return { matrix: new THREE.Matrix4().multiplyMatrices(t, rs), scale: s };
}

/** Moves geometry so its bbox centre is the origin; returns that centre. */
function recenter(g) {
  const c = bbox(g).getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  return c;
}

function wheelInfo(g) {
  const b = bbox(g);
  const size = b.getSize(new THREE.Vector3());
  return { radius: +(Math.max(size.y, size.z) / 2).toFixed(3), width: +size.x.toFixed(3) };
}

const r3 = (v) => v.toArray().map((x) => +x.toFixed(3));

// ------------------------------------------------------------------------------------------------
// LuAZ-969 -> 'uaz'
// ------------------------------------------------------------------------------------------------

export async function buildLuaz({ src, out, length, rideHeight }) {
  const g = await load(dl(src));
  const all = parts(g.scene);
  const isWheel = (p) => /^wheel_(FR|FL|RL|RR)/.test(p.name);
  const wheelOf = (p) => p.name.match(/^wheel_(FR|FL|RL|RR)/)[1];
  const front = all.filter((p) => isWheel(p) && wheelOf(p)[0] === 'F').map((p) => p.geometry);
  const rear = all.filter((p) => isWheel(p) && wheelOf(p)[0] === 'R').map((p) => p.geometry);
  const { matrix, scale } = placement(all.map((p) => p.geometry), front, rear, [...front, ...rear], length, rideHeight);
  for (const p of all) applyMatrix(p.geometry, matrix);

  const srcPaint = all.find((p) => p.material.name === 'luaz_diffuse').material;
  const paint = standard('uaz_body', {
    map: retex(srcPaint.map, 1024, { mime: 'image/jpeg' }),
    roughness: 0.42,
    metalness: 0.15,
  });
  const glass = standard('uaz_glass', { color: 0x1d2730, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.55 });

  const root = new THREE.Group();
  root.name = 'uaz';
  const bodyGeo = merge(all.filter((p) => !isWheel(p) && p.material.name === 'luaz_diffuse').map((p) => only(p.geometry, ['position', 'normal', 'uv'])));
  const glassGeo = merge(all.filter((p) => p.material.name === 'luaz_transparent').map((p) => only(p.geometry, ['position', 'normal'])));
  root.add(mesh('Body', bodyGeo, paint));
  root.add(mesh('Glass', glassGeo, glass));
  const wheels = {};
  // Name wheels by their final position (front = -Z, left = -X), not by the source labels.
  for (const p of all.filter(isWheel)) {
    const geo = only(p.geometry, ['position', 'normal', 'uv']);
    const c = recenter(geo);
    const name = `Wheel_${c.z < 0 ? 'F' : 'R'}${c.x < 0 ? 'L' : 'R'}`;
    if (wheels[name]) throw new Error(`duplicate wheel ${name}`);
    const node = new THREE.Group();
    node.name = name;
    node.position.copy(c);
    node.add(mesh(`${name}_mesh`, geo, paint));
    root.add(node);
    wheels[name] = { center: r3(c), ...wheelInfo(geo) };
  }
  const bytes = await exportGlb(root, out);
  return { file: out, bytes, tris: sceneTris(root), scale: +scale.toFixed(4), wheels, bbox: bboxReport(root) };
}

// ------------------------------------------------------------------------------------------------
// Dirt bike -> 'bike'
// ------------------------------------------------------------------------------------------------

/** Palette material: one tiny base-colour + metallic-roughness texture, one cell per source material. */
function paletteMaterial(name, entries) {
  const cells = Math.ceil(Math.sqrt(entries.length));
  const px = 4; // pixels per cell (keeps cells apart under linear filtering)
  const size = cells * px;
  const cellUv = (i) => [((i % cells) + 0.5) / cells, (Math.floor(i / cells) + 0.5) / cells];
  const base = paintTex(size, size, (ctx) => {
    entries.forEach((e, i) => {
      const c = e.color.clone().convertLinearToSRGB();
      ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      ctx.fillRect((i % cells) * px, Math.floor(i / cells) * px, px, px);
    });
  });
  const mr = paintTex(size, size, (ctx) => {
    entries.forEach((e, i) => {
      ctx.fillStyle = `rgb(0,${Math.round(e.roughness * 255)},${Math.round(e.metalness * 255)})`;
      ctx.fillRect((i % cells) * px, Math.floor(i / cells) * px, px, px);
    });
  }, { srgb: false });
  const m = standard(name, { map: base, ormMap: mr, roughness: 1, metalness: 1 });
  return { material: m, cellUv };
}

export async function buildBike({ src, out, length, rideHeight, targets }) {
  const g = await load(dl(src));
  const nodes = {};
  g.scene.traverse((o) => { nodes[o.name] = o; });
  const sub = (name) => {
    if (!nodes[name]) throw new Error(`no node ${name}`);
    return parts(g.scene, { under: nodes[name] });
  };
  // GLTFLoader sanitises node names ('Cylinder.001' -> 'Cylinder001').
  const body = sub('Cube');
  const fork = sub('Cylinder001');
  const wA = sub('Cylinder005'), wB = sub('Cylinder003');
  const geos = (ps) => ps.map((p) => p.geometry);
  // The wheel closest to the fork is the front wheel.
  const forkC = centerOf(geos(fork));
  const dA = centerOf(geos(wA)).distanceTo(forkC), dB = centerOf(geos(wB)).distanceTo(forkC);
  const [wF, wR] = dA < dB ? [wA, wB] : [wB, wA];
  const allParts = [...body, ...fork, ...wF, ...wR];
  const { matrix, scale } = placement(geos(allParts), geos(wF), geos(wR), [...geos(wF), ...geos(wR)], length, rideHeight);
  for (const p of allParts) applyMatrix(p.geometry, matrix);

  // Palette (one material for the whole bike).
  const mats = [...new Set(allParts.map((p) => p.material))];
  const entries = mats.map((m) => ({ color: m.color.clone(), roughness: Math.max(0.25, m.roughness), metalness: m.metalness }));
  const pal = paletteMaterial('bike', entries);
  for (const p of allParts) {
    const [u, v] = pal.cellUv(mats.indexOf(p.material));
    only(p.geometry, ['position', 'normal']);
    setUv(p.geometry, u, v);
  }
  const bodyGeo = await simplify(merge(geos(body)), targets.body, { uvWeight: 10, weld: true, crease: 35 });
  const forkGeo = await simplify(merge(geos(fork)), targets.fork, { uvWeight: 10, weld: true, crease: 35 });
  const wheelF = await simplify(merge(geos(wF)), targets.wheel, { uvWeight: 10, weld: true, crease: 35 });
  const wheelR = await simplify(merge(geos(wR)), targets.wheel, { uvWeight: 10, weld: true, crease: 35 });

  const root = new THREE.Group();
  root.name = 'bike';
  root.add(mesh('Body', bodyGeo, pal.material));
  // Steering axis: front axle -> centre of the handlebar (top 8 % of the fork geometry).
  const axle = recenter(wheelF);
  const fp = forkGeo.getAttribute('position');
  const fb = bbox(forkGeo);
  const top = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < fp.count; i++) {
    if (fp.getY(i) < fb.max.y - (fb.max.y - fb.min.y) * 0.08) continue;
    top.x += fp.getX(i); top.y += fp.getY(i); top.z += fp.getZ(i); n++;
  }
  top.divideScalar(n);
  top.x = 0;
  const axis = top.clone().sub(axle).normalize();
  const rake = Math.atan2(axis.z, axis.y);
  const forkNode = new THREE.Group();
  forkNode.name = 'Fork';
  forkNode.position.copy(axle);
  forkNode.rotation.set(rake, 0, 0);
  forkNode.updateMatrix();
  const inv = forkNode.matrix.clone().invert();
  applyMatrix(forkGeo, inv);
  forkNode.add(mesh('Fork_mesh', forkGeo, pal.material));
  const wf = new THREE.Group();
  wf.name = 'Wheel_F';
  // Wheel geometry is already centred on the axle (= fork origin); express it in the fork frame.
  applyMatrix(wheelF, new THREE.Matrix4().makeRotationX(-rake));
  wf.add(mesh('Wheel_F_mesh', wheelF, pal.material));
  forkNode.add(wf);
  root.add(forkNode);
  const rearC = recenter(wheelR);
  const wr = new THREE.Group();
  wr.name = 'Wheel_R';
  wr.position.copy(rearC);
  wr.add(mesh('Wheel_R_mesh', wheelR, pal.material));
  root.add(wr);
  const bytes = await exportGlb(root, out);
  return {
    file: out, bytes, tris: sceneTris(root), scale: +scale.toFixed(4),
    parts: { body: tris(bodyGeo), fork: tris(forkGeo), wheelF: tris(wheelF), wheelR: tris(wheelR) },
    wheels: { Wheel_F: { center: r3(axle), ...wheelInfo(wheelF) }, Wheel_R: { center: r3(rearC), ...wheelInfo(wheelR) } },
    fork: { pivot: r3(axle), axis: r3(axis), rake: +rake.toFixed(4) },
    bbox: bboxReport(root),
  };
}

function bboxReport(root) {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root, true);
  return { min: r3(b.min), max: r3(b.max) };
}
