// Camera rig + first-person viewmodel (render-view-fx module).
// Interim implementation: positions the camera (FPP/TPP) so the app can be wired while the full rig lands.
import type { CameraState, CreateViewRig, FeelState, ViewRig } from '../contracts';
import type { FrameState } from '../../game/types';
import { DEG, dirFromAngles, right } from '../../../shared/math';

export const createViewRig: CreateViewRig = (core) => {
  const cam: CameraState = {
    pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, fov: 60, mode: 'menu', scope: null, ads: 0, hideLocalBody: false,
  };
  const d = { x: 0, y: 0, z: 0 };
  const r = { x: 0, y: 0, z: 0 };
  core.camera.rotation.order = 'YXZ';
  const rig: ViewRig = {
    update(frame: FrameState, feel: FeelState): CameraState {
      const self = frame.self;
      if (self) {
        const fpp = frame.camera.mode === 'fpp' || self.ads > 0.5;
        cam.yaw = frame.camera.freeLook ? frame.camera.yaw : self.aimYaw;
        cam.pitch = frame.camera.freeLook ? frame.camera.pitch : self.aimPitch;
        cam.pos.x = self.eye.x; cam.pos.y = self.eye.y; cam.pos.z = self.eye.z;
        if (!fpp) {
          dirFromAngles(cam.yaw, cam.pitch, d);
          right(cam.yaw, r);
          cam.pos.x += -d.x * 2.6 + r.x * 0.55;
          cam.pos.y += -d.y * 2.6 + 0.2;
          cam.pos.z += -d.z * 2.6 + r.z * 0.55;
        }
        cam.mode = fpp ? 'fpp' : 'tpp';
        cam.hideLocalBody = fpp;
        cam.ads = self.ads;
      }
      cam.fov = 2 * Math.atan(Math.tan((85 * DEG) / 2) / (16 / 9)) / DEG + feel.fovPunch;
      core.camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
      core.camera.rotation.set(cam.pitch + feel.kick.pitch + feel.shake.pitch, cam.yaw + feel.kick.yaw + feel.shake.yaw, cam.roll + feel.kick.roll + feel.shake.roll);
      if (Math.abs(core.camera.fov - cam.fov) > 1e-3) { core.camera.fov = cam.fov; core.camera.updateProjectionMatrix(); }
      return cam;
    },
    dispose() { /* nothing allocated */ },
  };
  return rig;
};
