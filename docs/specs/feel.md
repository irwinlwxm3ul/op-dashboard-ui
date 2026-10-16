# Module spec: feel (game feel + audio routing)

Owned paths: `src/client/feel/**` (strings in `src/client/feel/strings.en.ts`, keys `feel.*`, merged into English by i18n;
prefer existing core keys from `src/client/i18n/locales/en.core.ts` such as banner.* / feed.* when they exist).
Export `createFeel: CreateFeel` from `src/client/feel/index.ts` implementing `Feel` (`src/client/render/contracts.ts`).
This module turns events into *feel*: camera shake/kick values (consumed by the view rig), all transient hit/kill feedback
overlays (DOM in the `overlay` element = `UiApi.feelLayer`), and **all sound routing** through the `audio` singleton
(`src/client/audio`, API in ARCHITECTURE.md). Read PLAN.md §3 carefully. Tight, punchy, readable — tune values with care.

## FeelState outputs (`feel.state`, updated in `update(frame, cam, dt)`)
- **Trauma shake**: trauma 0..1 decays (~1.4/s); shake = trauma² × smooth noise (e.g. layered sines / value noise) on
  pitch/yaw/roll. Sources: local shots (small, per weapon `kick.shake`), nearby explosions (distance-scaled),
  vehicle crashes (local vehicle), hard landings, taking damage (small), near-miss cracks (tiny).
- **Cosmetic recoil kick** (separate from server recoil): on `localShot` add the weapon's `KickDef` camPitch/camYaw
  (random sign for yaw)/camRoll, recover with a critically damped spring (~12–18 Hz) so it snaps back; `fovPunch`
  small widening on big guns; viewmodel kick values `vm.back/up/rot/side` with spring recovery.
- **Landing dip** proportional to `localLand` speed with spring recovery; **head bob** phase advancing with horizontal
  speed of the local player (stride ~1.9 m walking, longer sprinting), amount by speed (0 in air / vehicle / prone).
- `lowHealth` 0..1 when health < 35.

## Overlays (DOM in `overlay`, pooled, CSS animations, pointer-events none)
- **Hitmarkers** (server `hit` events where attacker = local player): X-shaped marker at screen center; white for body,
  red for head, blue-ish for armor-absorbed, bigger red X with a skull for kill, orange for knock; short pop animation;
  stacking hits refresh. Sounds via `audio.hitmarker(kind)`. Training `targetHit` events also produce hitmarkers
  plus a floating readout (damage, part, distance m) near center-right.
- **Damage numbers** (if `settings.get().damageNumbers`): floating numbers projected at the hit position (need camera:
  use the `cam` param + world→screen projection math with fov/aspect; keep it self-contained), color by part.
- **Damage direction indicators** when the local player is hit: red arcs around the screen center pointing toward the
  source (`from`), fading over 1.5 s; screen-edge red flash scaled by damage; `audio.hurt(dmg)`; armor break → shatter
  icon + `audio.armorBreak()`.
- **Low HP**: vignette (red, pulsing with heartbeat rhythm) and desaturation (CSS `filter` on the canvas host is not
  yours — instead render a full-screen overlay with `backdrop-filter: saturate()` or a radial gradient), intensifies with lower health;
  downed state → grey screen tint + heartbeat.
- **Kill feedback**: on `kill`/`knock` where attacker = local: center-bottom banner ("You killed {name}" / "You knocked
  {name}", with kill count "{n} kills"), skull icon pop, `audio.hitmarker('kill'|'knock')` (layered confirm),
  headshot tag. When the local player is knocked/killed: "Knocked by {name}" / "Killed by {name}" with weapon.
- **Match moments**: zone phase warnings (`zonePhase` → banner + `audio.ui('zone')`), "Winner" celebration banner on
  matchEnd if the local team placed 1 (`audio.ui('win')`), elimination sting otherwise (`audio.ui('lose')`), teammate
  knocked/killed notices, revive done notice.

## Sound routing (all through `audio`)
- `audio.setListener(cam.pos, cam.yaw, cam.pitch)` every frame (fall back to self eye when cam is null).
- Gunshots: `localShot` → `audio.gunshot(kind, origin, true)`; server `shot` events from other shooters →
  `audio.gunshot(kind, origin, false)` (the engine applies distance delay/muffling). Weapon sound kind from
  `WEAPONS[weapon].sound` (`src/shared/items`). Near misses: for remote shots whose ray (origin→ends) passes within
  `SUPPRESSION_RADIUS` of the listener → `audio.bulletCrack(closest point)` + tiny shake.
- `impact` → `audio.impact(material, pos)` (limit rate); `explosion`/`vehicleDestroyed` → `audio.explosion` + shake.
- Footsteps: local from `localFootstep`; remote players: derive from interpolated `frame.players` horizontal speed
  & stance (stride accumulator per player, only within 40 m, surface via `world.surfaceAt`) →
  `audio.footstep(material, pos, false, intensity)`.
- `localReload`/`reload` events → reload phase sounds timed over the reload duration (mag out at 20 %, mag in at 70 %,
  bolt at end for empty reloads; shells per shell for shotgun; sniper bolt after each shot); `localDryFire` →
  `audio.dryFire()`; `localWeaponSwitch` → `audio.weaponSwitch()`; `localJump`/`localLand` → jump/land;
  `useDone`/`useStart` (local) → `audio.heal(item)`; `pickup` (local) → `audio.pickup()`.
- Vehicles: maintain an `audio.engine(id)` handle for every vehicle within 250 m (create/stop as they enter/leave),
  `update(pos, rpm, throttle≈|speed| based, local = local player inside)`; `vehicleCrash` → impact thud + shake if local.
- Freefall/parachute wind: `audio.setWind(speed-based intensity)`; zone: `audio.setZoneProximity(outside, intensity)`.
- Call `audio.update(dt)` each frame.

No unit tests required (keep spring/trauma math pure and small). Type-check clean.
