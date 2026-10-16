// Vehicle pipeline (browser side). Each source model is re-oriented (front -Z, up +Y, right +X),
// uniformly scaled to the gameplay collision box length, and re-centred so the model origin is the
// physics OBB centre (VehicleState.pos): wheels touch the ground at y = -rideHeight. Wheels become
// separate nodes pivoting at their centres (spin = rotation.x); the bike fork pivots on its
// steering axis (steer = rotation.y with the loaded rotation.x rake kept).
import {
  THREE, load, dl, parts, merge, simplify, bboxOf, bbox, tris, applyMatrix, retex, standard, mesh,
  paintTex, setUv, only, exportGlb, sceneTris, compact,
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

export async function buildLuaz({ src, out, length, rideHeight, seats, hipHeight }) {
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
  return { file: out, bytes, tris: sceneTris(root), scale: +scale.toFixed(4), wheels, bbox: bboxReport(root), seatSurfaces: seatSurfaces(root, seats, hipHeight) };
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

/** Splits `g` by a per-triangle predicate on the triangle centroid -> [matching, rest]. */
function splitBy(g, pred) {
  const idx = g.index.array, pos = g.getAttribute('position').array;
  const a = [], b = [];
  const c = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) { const v = idx[i + k]; c.x += pos[v * 3]; c.y += pos[v * 3 + 1]; c.z += pos[v * 3 + 2]; }
    c.divideScalar(3);
    (pred(c) ? a : b).push(idx[i], idx[i + 1], idx[i + 2]);
  }
  return [a.length ? compact(g, Uint32Array.from(a)) : null, b.length ? compact(g, Uint32Array.from(b)) : null];
}

/**
 * Steering assembly of the dirt bike in its SOURCE frame (Sketchfab root: +Y up, front +Z, metres):
 * the triple clamps sit around HEAD and the fork tubes run along AXIS. Everything in front of the
 * head tube (fork lowers, front fender, number plate), the handlebar block and a slim cylinder
 * around the steering axis (fork tubes, clamps, stem) steers; the rest is the static body.
 */
const BIKE_HEAD = new THREE.Vector3(0, 0.42, 0.81);
const BIKE_AXIS = new THREE.Vector3(0, 0.58, -0.31).normalize();
function bikeSteers(c) {
  if (c.z > 0.88) return true;
  if (c.y > 0.365 && c.z > 0.6) return true;
  const d = c.clone().sub(BIKE_HEAD);
  const along = d.dot(BIKE_AXIS);
  const radial = d.addScaledVector(BIKE_AXIS, -along).length();
  return radial < 0.15 && along > -0.75 && along < 0.25;
}

export async function buildBike({ src, out, length, rideHeight, targets, seats, hipHeight }) {
  const g = await load(dl(src));
  const nodes = {};
  g.scene.traverse((o) => { nodes[o.name] = o; });
  const sub = (name) => {
    if (!nodes[name]) throw new Error(`no node ${name}`);
    return parts(g.scene, { under: nodes[name] });
  };
  // GLTFLoader sanitises node names ('Cylinder.001' -> 'Cylinder001'). Cube = frame, engine,
  // plastics, fork and handlebar; Cylinder001 = swing arm; Cylinder003 / 005 = front / rear wheel.
  const body = [...sub('Cube'), ...sub('Cylinder001')];
  const wF = sub('Cylinder003'), wR = sub('Cylinder005');
  const geos = (ps) => ps.map((p) => p.geometry);
  if (centerOf(geos(wF)).z < centerOf(geos(wR)).z) throw new Error('bike source orientation changed (front wheel must be at +Z)');

  // Palette (one material for the whole bike), assigned before any merging.
  const allParts = [...body, ...wF, ...wR];
  const mats = [...new Set(allParts.map((p) => p.material))];
  // Pure black (tyres) reads as a hole under the game's lighting: floor colours at rubber albedo.
  const entries = mats.map((m) => {
    const c = m.color.clone();
    const dark = Math.max(c.r, c.g, c.b) < 0.03;
    if (dark) c.setRGB(Math.max(c.r, 0.028), Math.max(c.g, 0.028), Math.max(c.b, 0.03));
    return { color: c, roughness: dark ? Math.max(0.8, m.roughness) : Math.max(0.25, m.roughness), metalness: m.metalness };
  });
  const pal = paletteMaterial('bike', entries);
  for (const p of allParts) {
    const [u, v] = pal.cellUv(mats.indexOf(p.material));
    only(p.geometry, ['position', 'normal']);
    setUv(p.geometry, u, v);
  }
  // Split the steering assembly off in the source frame, then place everything.
  const [forkSrc, bodySrc] = splitBy(merge(geos(body)), bikeSteers);
  const wheelFSrc = merge(geos(wF)), wheelRSrc = merge(geos(wR));
  const { matrix, scale } = placement([forkSrc, bodySrc, wheelFSrc, wheelRSrc], [wheelFSrc], [wheelRSrc], [wheelFSrc, wheelRSrc], length, rideHeight);
  for (const x of [forkSrc, bodySrc, wheelFSrc, wheelRSrc]) applyMatrix(x, matrix);
  const head = BIKE_HEAD.clone().applyMatrix4(matrix);
  const axis = BIKE_AXIS.clone().transformDirection(matrix);

  const opts = { uvWeight: 10, weld: true, crease: 35 };
  const bodyGeo = await simplify(bodySrc, targets.body, opts);
  const forkGeo = await simplify(forkSrc, targets.fork, opts);
  const wheelF = await simplify(wheelFSrc, targets.wheel, opts);
  const wheelR = await simplify(wheelRSrc, targets.wheel, opts);

  const root = new THREE.Group();
  root.name = 'bike';
  root.add(mesh('Body', bodyGeo, pal.material));
  // Fork node: origin on the steering axis level with the front axle, local +Y along the axis.
  const axle = recenter(wheelF);
  const t = (axle.y - head.y) / axis.y;
  const pivot = head.clone().addScaledVector(axis, t);
  const rake = Math.atan2(axis.z, axis.y);
  const forkNode = new THREE.Group();
  forkNode.name = 'Fork';
  forkNode.position.copy(pivot);
  forkNode.rotation.set(rake, 0, 0);
  forkNode.updateMatrix();
  const inv = forkNode.matrix.clone().invert();
  applyMatrix(forkGeo, inv);
  forkNode.add(mesh('Fork_mesh', forkGeo, pal.material));
  const wf = new THREE.Group();
  wf.name = 'Wheel_F';
  wf.position.copy(axle).applyMatrix4(inv);
  // Wheel geometry is centred on the axle; express its orientation in the (raked) fork frame.
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
    wheels: { Wheel_F: { center: r3(axle), local: r3(wf.position), ...wheelInfo(wheelF) }, Wheel_R: { center: r3(rearC), ...wheelInfo(wheelR) } },
    fork: { pivot: r3(pivot), axis: r3(axis), rake: +rake.toFixed(4) },
    bbox: bboxReport(root),
    seatSurfaces: seatSurfaces(root, seats, hipHeight),
  };
}

/**
 * Seat surface height under each physics seat (VehicleDef.seatOffsets: feet-level origin, hips
 * SEAT_HIP_HEIGHT above): ray cast down from 0.45 m above the hips (below roofs) onto the model.
 */
function seatSurfaces(root, seats, hipHeight) {
  root.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  return seats.map((s) => {
    rc.set(new THREE.Vector3(s.x, s.y + hipHeight + 0.45, s.z), new THREE.Vector3(0, -1, 0));
    rc.far = 1.2;
    const hit = rc.intersectObject(root, true)[0];
    return hit ? +hit.point.y.toFixed(3) : null;
  });
}

function bboxReport(root) {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root, true);
  return { min: r3(b.min), max: r3(b.max) };
}
