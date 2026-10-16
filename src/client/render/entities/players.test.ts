// Near-body pool pressure: more players in the near band than near bodies must never leave anyone
// partly drawn (the fade state machine has to settle on the mid LOD at full visibility), and the
// near bodies go to the players that matter most on screen.
//
// Lives next to the module it tests (src/client/render/entities is this module's only owned
// path); run with a vitest config whose include covers it.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PF } from '../../../shared/protocol';
import type { FrameState, PlayerView } from '../../game/types';
import type { CameraState } from '../contracts';
import { lodThresholds } from './lod';
import { PlayersRenderer, type PlayersUpdateContext } from './players';

function makePlayer(id: number, x: number, z: number, team = 2): PlayerView {
  return {
    id, name: 'P' + id, team, isBot: true, isSelf: false, isTeammate: false,
    pos: { x, y: 0, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
    stance: 'stand', mode: 'ground', life: 'alive', weapon: 'ar',
    flags: PF.ON_GROUND, vehicleId: null, seat: 0, hp: 100, downedHp: 0,
    gear: [1, 1, 1], age: 0, deadFor: -1,
  } as PlayerView;
}

interface Rig {
  renderer: PlayersRenderer;
  frame: FrameState;
  ctx: PlayersUpdateContext;
  camera: THREE.PerspectiveCamera;
  players: Map<number, PlayerView>;
}

function makeRig(capacity: number, fov = 65): Rig {
  const parent = new THREE.Group();
  const renderer = new PlayersRenderer(parent, capacity);
  const players = new Map<number, PlayerView>();
  const frame = { players, vehicles: new Map(), localTeam: 1 } as unknown as FrameState;
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 2000);
  camera.position.set(0, 1.7, 0); // looking down -Z
  camera.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const cam: CameraState = {
    pos: { x: 0, y: 1.7, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov, mode: 'tpp', scope: null, ads: 0, hideLocalBody: false,
  };
  const ctx: PlayersUpdateContext = {
    camPos: camera.position.clone(), cam, lod: lodThresholds('medium'),
    focalPx: 540 / Math.tan((fov * Math.PI) / 360), shadows: false, time: 0, frustum,
    seatLift: () => 0, riderContacts: () => undefined,
  };
  return { renderer, frame, ctx, camera, players };
}

function run(r: Rig, frames: number): void {
  for (let i = 0; i < frames; i++) {
    r.ctx.time += 1 / 60;
    r.renderer.update(r.frame, r.ctx, 1 / 60);
  }
}

function nearHolders(r: Rig): number[] {
  const ids: number[] = [];
  r.renderer.entries.forEach((e) => {
    if (e.near) ids.push(e.id);
  });
  return ids.sort((a, b) => a - b);
}

describe('near body pool pressure', () => {
  it('keeps every player fully visible when the near band holds more players than near bodies', () => {
    const r = makeRig(3);
    for (let i = 0; i < 20; i++) r.players.set(i + 1, makePlayer(i + 1, (i % 5) - 2, -5 - i * 1.5));
    run(r, 120);
    expect(nearHolders(r)).toHaveLength(3);
    r.renderer.entries.forEach((e) => expect(e.coverage).toBeCloseTo(1, 5));
    // Still settled a while later (no fade restarting every frame).
    run(r, 30);
    r.renderer.entries.forEach((e) => expect(e.coverage).toBeCloseTo(1, 5));
  });

  it('keeps scoped (zoomed) targets fully visible and gives the near bodies to on-screen players', () => {
    const r = makeRig(4, 8);
    // Far players in front (inside the narrow scope frustum)...
    for (let i = 0; i < 10; i++) r.players.set(100 + i, makePlayer(100 + i, 0.5 * i - 2, -220 - 30 * i));
    // ...and closer ones behind the camera (off screen).
    for (let i = 0; i < 6; i++) r.players.set(200 + i, makePlayer(200 + i, i - 3, 15 + 2 * i));
    run(r, 150);
    const holders = nearHolders(r);
    expect(holders).toHaveLength(4);
    // The four closest on-screen players hold them, not the closer off-screen ones.
    expect(holders).toEqual([100, 101, 102, 103]);
    r.renderer.entries.forEach((e) => expect(e.coverage).toBeCloseTo(1, 5));
  });

  it('hands bodies back when the capacity shrinks and stays fully visible', () => {
    const r = makeRig(6);
    for (let i = 0; i < 10; i++) r.players.set(i + 1, makePlayer(i + 1, 0, -4 - 2 * i));
    run(r, 90);
    expect(nearHolders(r)).toEqual([1, 2, 3, 4, 5, 6]);
    r.renderer.setNearCapacity(2);
    run(r, 90);
    expect(nearHolders(r)).toEqual([1, 2]);
    r.renderer.entries.forEach((e) => expect(e.coverage).toBeCloseTo(1, 5));
  });
});
