# Module spec: render-view-fx

Owned paths: `src/client/render/view/**`, `src/client/render/fx/**`.
Exports: `src/client/render/view/index.ts` → `createViewRig: CreateViewRig`;
`src/client/render/fx/index.ts` → `createFxRenderer: CreateFxRenderer` (signatures in `src/client/render/contracts.ts`).
Read PLAN.md §3 Game feel carefully: this module is where shooting *feels* tight.

## ViewRig (camera + first-person viewmodel)
- Camera modes (CameraState.mode): **TPP** (default from settings) over-the-shoulder (right shoulder, ~2.6 m behind,
  0.55 m right, slight up), camera collision against world (raycast with `raycastWorld` from `src/shared/physics`,
  pull in smoothly, never inside walls); **FPP** at `self.eye`; toggled by `frame.camera.mode`. ADS in TPP switches to
  first-person sight view (like PUBG). **Scope** mode when ADS with x4/x8 scopes at full blend (`CameraState.scope` set
  so the UI draws the scope overlay; viewmodel hidden). FOV from settings (horizontal-ish feel; vertical FOV computed
  from setting) × weapon `adsZoom` blended by `self.ads`, plus `feel.fovPunch`. Free look (`frame.camera.freeLook`) rotates
  only the camera. Plane: chase cam behind/above the plane looking forward, mouse orbits. Freefall/parachute: third
  person behind the player, wider FOV in freefall with slight speed shake. Vehicle: chase cam behind vehicle with
  smoothing and look-around (driver) / seat-relative (passenger, can aim when seat can shoot → normal TPP/FPP from seat).
  Spectate: follows `frame.viewTargetId` player in TPP using their interpolated aim. Death: short slow orbit around
  the body before switching to spectate.
- Apply feel: `feel.shake`, `feel.kick` (pitch/yaw/roll added to camera), `feel.landDip`, head bob (`feel.bob`) in FPP
  only and subtle; strafe tilt (small roll from lateral velocity); stance transitions smoothed (camera height eases).
  The aim direction (bullets) is `self.aimYaw/aimPitch` (base + server recoil). The camera looks along aim + cosmetic
  kick + shake, so the crosshair stays truthful (kick returns quickly).
- **Viewmodel** (FPP and TPP-ADS when not scoped): separate scene/camera layer rendered after the world with its own
  narrow FOV (render with `renderer.autoClear = false` + clearDepth via an `onAfterRender` hook or by adding the
  viewmodel to the main scene on a dedicated layer with depthTest tricks — choose a robust approach and document it).
  Procedural arms (sleeves + gloves) and procedural guns per WeaponId with recognisable shapes (pistol, SMG with
  stubby barrel, AR with red-dot sight, pump shotgun, DMR with 4x scope, bolt sniper with 8x scope), materials
  consistent with the third-person guns. Animations: idle sway (breathing), mouse-movement inertia lag, walk/run
  bob synced to stride, sprint pose (gun lowered/rotated), ADS transition aligning the sight with screen center over
  `adsTime`, recoil kick from `feel.vm` (back/up/rot/side) with fast recovery, muzzle flash (sprite + brief point light,
  randomised rotation/scale), shell casing ejection (pooled small meshes with gravity, despawn), reload animation
  (mag out/in motion; empty reload includes bolt/charging handle; shotgun shell insert per shell; sniper bolt cycle
  after each shot), weapon draw/holster (raise/lower over drawTime), dry-fire click motion, healing animation
  (item in hand), fists when unarmed. Triggered from client events: `localShot`, `localReload`, `localReloadDone`,
  `localDryFire`, `localWeaponSwitch`, `localAds`, `localJump`, `localLand`.
- Applies the result to `core.camera` (position, rotation order 'YXZ', fov, updateProjectionMatrix only when changed).

## FxRenderer
- Driven by `events` (`ClientEventBus`) and FrameState: **tracers** for every `shot` event (remote) and `localShot`
  (local predicted; skip the server `shot` echo for the local shooter to avoid doubles) — bright stretched
  billboards/lines that travel at weapon muzzle velocity (fast streak, fading), every shot for remote players,
  hitscan tracer end points from `ends`; ballistic weapons: projectile visuals follow `frame.projectiles` (sniper/DMR bullets
  as glowing streaks so drop is visible), local predicted ballistic shots simulate the arc locally with
  `stepBallistic`/`launchVelocity` from `src/shared/items` until the server projectile appears.
- Third-person **muzzle flashes** for remote shooters (at their weapon muzzle approximated from player pos/aim),
  brief light on high quality.
- **Impacts** (`impact` events): per material — dirt/grass dust puff + debris, rock/concrete sparks + dust,
  metal sparks, wood splinters, water splash column; bullet decals (pooled, max ~200, fade). **Blood**: flesh impacts
  produce a red mist puff (hit events with `pos`), armor hits blue-white sparks.
- **Explosions** (`explosion`, `vehicleDestroyed`): fireball (additive sprites), smoke column, debris, shockwave ring,
  flash light, scorch decal. Vehicle burning smoke is handled by entities; here only the blast.
- **Frags** in flight (projectiles with kind frag): small grenade mesh spinning; thrower's arc. **Landing dust** on `land`
  events with speed; **parachute open** puff; water splash when entering water.
- All particle systems pooled (instanced sprites / Points with custom shader), soft-capped counts per quality, no
  allocations per frame; fx far away (> 400 m) culled except tracers/explosions.
- No tests required; keep pure helpers testable. Type-check clean.
