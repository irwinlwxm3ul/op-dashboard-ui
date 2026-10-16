// ViewRig: camera rig + first-person viewmodel. Applies the camera pose to core.camera (rotation
// order 'YXZ', projection updated only when the FOV changes) and drives the viewmodel, which
// renders itself after the world through a scene hook (see viewmodel/viewmodel.ts).

import { damp } from '../../../shared/math';
import { raycastWorld } from '../../../shared/physics';
import type { RayHit, Vec3, World } from '../../../shared/types';
import { settings } from '../../game';
import type { ClientEventBus, FrameState } from '../../game/types';
import type { CameraState, FeelState, RenderCore, ViewRig } from '../contracts';
import { localMuzzle } from '../fx/muzzle';
import { CameraRig } from './cameraRig';
import { Viewmodel, type VmInput } from './viewmodel/viewmodel';

/** Frames between "am I indoors?" probes (lighting of the viewmodel). */
const INDOOR_PROBE_EVERY = 6;

export class ViewRigImpl implements ViewRig {
  private readonly core: RenderCore;
  private readonly world: World;
  private readonly rig: CameraRig;
  private readonly vm: Viewmodel;
  private readonly unsubSettings: () => void;
  private readonly vmIn: VmInput;
  private frameNo = 0;
  private indoor = 0;
  private indoorTarget = 0;
  private disposed = false;
  private readonly up: Vec3 = { x: 0, y: 1, z: 0 };
  private readonly hit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, kind: 'terrain', material: 'grass' };

  constructor(core: RenderCore, world: World, events: ClientEventBus) {
    this.core = core;
    this.world = world;
    this.rig = new CameraRig(world);
    this.rig.setFovSetting(settings.get().fov);
    this.unsubSettings = settings.subscribe((s) => this.rig.setFovSetting(s.fov));
    this.vm = new Viewmodel(core, world, events);
    core.camera.rotation.order = 'YXZ';
    this.vmIn = {
      self: null as never,
      visible: false,
      camYaw: 0, camPitch: 0, aimYaw: 0, aimPitch: 0,
      strafe: 0, speed: 0,
      feel: null as never,
      indoor: 0,
      mainCamera: core.camera,
      sunDir: core.sunDir,
    };
  }

  update(frame: FrameState, feel: FeelState, dt: number): CameraState {
    const cam = this.rig.update(frame, feel, dt);
    this.frameNo++;

    // Apply to the render camera.
    const c = this.core.camera;
    if (c.rotation.order !== 'YXZ') c.rotation.order = 'YXZ';
    c.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    c.rotation.set(cam.pitch, cam.yaw, cam.roll);
    if (Math.abs(c.fov - cam.fov) > 1e-3) {
      c.fov = cam.fov;
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld();

    // Viewmodel
    const self = frame.self;
    if (self) {
      const info = this.rig.info;
      const onFootOrSeat = self.mode === 'ground' || (self.mode === 'vehicle' && cam.mode !== 'vehicle');
      const visible = !this.disposed && info.firstPerson && self.life === 'alive' && onFootOrSeat && cam.scope === null;
      if (this.frameNo % INDOOR_PROBE_EVERY === 0) this.probeIndoor(self.eye);
      this.indoor += (this.indoorTarget - this.indoor) * damp(3, dt);
      const inp = this.vmIn;
      inp.self = self;
      inp.visible = visible;
      inp.camYaw = info.lookYaw;
      inp.camPitch = info.lookPitch;
      inp.aimYaw = self.aimYaw;
      inp.aimPitch = self.aimPitch;
      inp.strafe = info.strafe;
      inp.speed = info.speed;
      inp.feel = feel;
      inp.indoor = this.indoor;
      inp.mainCamera = c;
      inp.sunDir = this.core.sunDir;
      this.vm.playerVel.set(self.vel.x, self.vel.y, self.vel.z);
      this.vm.update(inp, dt);
    } else {
      localMuzzle.viewmodelVisible = false;
    }
    return cam;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubSettings();
    this.vm.dispose();
  }

  private probeIndoor(eye: Vec3): void {
    const h = raycastWorld(this.world, eye, this.up, 30, this.hit);
    this.indoorTarget = h && h.kind === 'box' ? 1 : 0;
  }
}

export function createRig(core: RenderCore, world: World, events: ClientEventBus): ViewRig {
  return new ViewRigImpl(core, world, events);
}
