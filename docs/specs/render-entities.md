# Module spec: render-entities

Owned paths: `src/client/render/entities/**`. Export `createEntityRenderer: CreateEntityRenderer` from
`src/client/render/entities/index.ts` (signature in `src/client/render/contracts.ts`). Consumes `FrameState`
(`src/client/game/types.ts`) every frame. Uses three.js. Read PLAN.md §3 (game feel) and §6 (player readability).

## Players (the most important part — readability at distance)
- Procedural low-poly **soldier** built from simple meshes (no external model): helmet (levels 0–3 change shape:
  none = cap/hair, 1 = soft cap-like, 2 = rounded helmet, 3 = full combat helmet with visor), head, torso with vest
  (level shows plates/pouches), backpack (level 0–3 sizes), arms, legs, boots, and the held weapon (simple procedural
  gun meshes per WeaponId: pistol, smg, ar, shotgun, dmr, sniper — recognisable silhouettes).
  Strong, readable silhouette; muted military clothing with per-team accent colour (armband + backpack stripe +
  helmet band). Team hue palette: generate distinct hues per team id; **the local player's team always uses a fixed
  bright cyan/blue** for teammates' accents.
- **Rim light**: character materials get a fresnel rim term (onBeforeCompile) so silhouettes pop against foliage;
  slightly stronger at distance. Characters use `fog: false` or reduced fog factor so they stay visible beyond
  terrain haze (PLAN.md: player render distance 1000 m).
- **Procedural animation** driven by velocity/stance/mode/flags/life: idle breathing, walk/run cycles with stride
  length from speed, crouch walk, prone crawl, downed crawl (lying, one arm forward), swim, freefall (spread
  skydive pose, dive pose when fast), parachute (hanging pose, legs dangling), seated in vehicle (driver hands on
  wheel / handlebars, passenger holding weapon), death (ragdoll-like fall: blend to lying with a tumble over ~0.6 s,
  then fade out/sink after ~5 s), aim pitch rotates upper body/arms, lean (PF.LEAN_L/R) tilts upper body, ADS pose,
  reload gesture (PF.RELOADING), healing gesture (PF.HEALING), reviving kneel (PF.REVIVING), sprint pose (PF.SPRINT).
  Smooth blending between poses. Footfall timing should be consistent with stride (the feel module derives remote
  footsteps from velocity; keep cycle frequency = speed / stride length).
- **LOD with hysteresis** (`LOD_NEAR`, `LOD_MID`, `LOD_HYSTERESIS` from constants): near (< 50 m) full articulated
  soldier (~2 k tris); mid (50–250 m) simplified merged body with coarse animation (~300 tris); far (250–1000 m) a
  solid team-tinted silhouette impostor (capsule + head sphere) that is always rendered (no fog, constant minimum
  screen size so it never shrinks below ~2 px tall). Crossfade (dither/opacity) during transitions so nothing pops.
  Use instancing for mid/far LOD if it helps draw calls.
- Local player body: hidden in FPP (`cam.hideLocalBody`), visible in TPP; shadows on near LOD only.
- **Nameplates** (DOM elements in the `overlay` element passed to the factory, positioned via projection each frame,
  pooled, CSS transforms only): teammates always (name, health bar incl. downed red bar from `downedHp`, distance in m,
  visible through walls, team colour); off-screen teammates get an edge-of-screen arrow marker; enemies only when the
  local player aims within ~2° of them with line of sight (use `lineOfSight` from `src/shared/physics`) and within
  `ENEMY_NAMEPLATE_RANGE` — name only, no health. Distance text uses numerals + "m" via `t('hud.distanceMeters', {n})`
  (if the key does not exist yet in i18n core, report it; do not hardcode). Downed teammates show a pulsing icon.
- Training targets (`frame.trainingTargets`): render moving/popup targets as target dummies (static `target` boxes
  are rendered by the world renderer; render dummies only for kind moving/popup).

## Vehicles
- Procedural models: buggy (open frame, roll cage, big wheels), UAZ-like 4x4 (boxy body, windows dark), motorbike.
  Wheels rotate with speed and front wheels steer (`steer`); body uses yaw/pitch/roll; bike leans with roll.
  Headlights off by day. Damage states: smoke when hp < 40 %, fire + heavy smoke while `burning`, burnt dark wreck when
  `destroyed`. Interpolated values come from FrameState. Riders are placed by the player renderer at seat positions
  (use `seatWorldPosition` from `src/shared/vehicles` with the VehicleView pose).
- Team-independent colours (army green, rust, sand) chosen by vehicle id.

## Loot, plane, parachutes, frags
- Loot items (`frame.loot`): small recognisable meshes per item category (weapon silhouettes, ammo boxes colour-coded by
  ammo type, med items white/red boxes, energy can, jerry can red, frag, vest/helmet/backpack shapes), instanced per item
  kind, drawn within 120 m, gentle bob + rotate and a subtle glow ring so they read on grass; hidden when picked.
- Plane: procedural cargo plane (fuselage, wings, tail, 4 props spinning) at `frame.planePos` heading along the plane path,
  with engine contrail/haze. Parachute canopy above players in `parachute` mode (team-coloured stripes), with lines.
- Frag projectiles are drawn by the fx module, not here.

## Performance
Pool and reuse everything; no allocations per frame; ≤ 60 draw calls for 64 players on medium (instanced far/mid LOD).
No tests required; pure helpers (LOD selection with hysteresis, team colour palette, pose blending math) in separate
functions. Type-check must be clean.
