# DROPZONE — browser battle royale (PUBG-inspired)

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Rendering | **Three.js 0.186** (WebGL2) | Mature, instancing/LOD primitives, runs everywhere |
| Language | **TypeScript** end to end | One codebase for client, server and the shared simulation |
| Client build | **Vite 8** | Fast dev server, Web Worker bundling |
| Server | **Node 22 + `ws`** | Lightweight authoritative game server + lobby service |
| Tests | **Vitest** (unit/sim/net), **Playwright** (headless browser smoke) | |
| Assets | **Kenney Starter Kits** (CC0 models/sprites/sounds, MIT code), **Lilita One** (OFL) font; everything else procedural (terrain, buildings, soldiers, vehicles, guns) | Free, licence-clean, small download |

### One simulation, three modes
`src/shared/` holds a deterministic-ish `GameSim` (movement, collision, weapons, ballistics,
vehicles, loot, zone, plane/parachute, downed/revive, bots) wrapped by a `MatchRunner` that
speaks the network protocol.

* **Online multiplayer**: `MatchRunner` runs on the Node server, clients connect over WebSocket.
* **Single-player vs bots** and **Training ground**: the *same* `MatchRunner` runs in a Web Worker
  in the browser behind a `LocalTransport`. Single-player therefore exercises exactly the same
  netcode path (prediction, interpolation, snapshots) as online play, and never blocks rendering.

```
src/shared/   constants, types, protocol, world gen, physics, items/ballistics, vehicles, sim, bots, MatchRunner
src/client/   i18n, ui (menus/lobby/HUD/map/results), net (transports, prediction, interpolation),
              render (terrain, vegetation, buildings, characters, vehicles, FX, viewmodel), audio, feel (shake/recoil/hitmarkers)
src/server/   ws server, lobby manager, rooms, validation & rate limiting
tests/        unit + full-match soak + ws integration + playwright smoke + cheat probes
```

## 2. Game loop (end to end)

1. **Lobby** — SP: choose player count (2–64), team size (solo/duo/squad), bot difficulty. MP: lobby
   browser → create/join → pick team slot → ready → host starts. Bots optionally fill empty slots.
2. **Plane** — random straight flight path across the island at 300 m; map shows path.
3. **Jump** (F) → **freefall** (~50 m/s, steerable, dive/flare with W/S) → **parachute** (manual
   F or auto at 120 m above ground; steerable glide) → **land**. Squad members can follow the leader.
4. **Loot** — weapons, ammo, armor (vest/helmet L1–3), backpacks, heals, boosts, frags, jerry cans
   in buildings and towns. Inventory (Tab), quick-use keys.
5. **Fight** — 6 weapons; hitscan for pistol/SMG/AR/shotgun, **ballistic projectiles with travel
   time and drop for DMR and sniper**. Frag grenades.
6. **Zone** — 8 phases of wait → shrink with escalating damage; zone timer, map preview of next circle.
7. **Vehicles** — buggy (2 seats), UAZ (4 seats), motorbike (2 seats). Enter/exit (F), seat swap (1–4),
   fuel, collisions, crash damage, explosion when destroyed, passengers can shoot.
8. **Downed/revive** — in duo/squad, 0 HP → knocked (crawl, bleed out, finishable); teammate holds F
   for 6 s to revive. Team eliminated when no member is alive-and-standing.
9. **Final circle → winner** — last team standing → "WINNER WINNER" banner → results screen
   (placement, kills, knocks, damage, survival time, per-team breakdown).
10. **Back to lobby** — MP returns everyone to the same lobby room (ready states reset); SP returns
    to the setup menu. Dead players can spectate teammates (or their killer) until the end.

**Training ground** — a separate compact map: weapon racks with every gun + infinite ammo, static
targets at marked ranges 25–600 m (to see drop), moving targets, damage read-out, a vehicle test
track with ramps, instant respawn.

## 3. Game feel (tight, not just functional)

* **Movement** — acceleration/friction curves (no instant velocity snaps), walk 4.7 / sprint 6.3 /
  crouch 2.7 / prone 1.2 m/s, ADS slows. Jump with 100 ms coyote time + input buffering, landing dip
  scaled by fall speed, stride-synced head bob and footsteps, subtle strafe tilt, smooth stance
  transitions, peek lean (Q/E).
* **Weapon handling** — per-weapon draw/holster/ADS times, ADS FOV (red dot 1×, DMR 4×, sniper 8×
  with scope overlay), breathing sway (Shift steadies while scoped), viewmodel inertia lag and bob,
  tactical vs empty reloads, sniper bolt cycle, dry-fire click, low-ammo counter tint.
* **Recoil** — deterministic per-weapon pattern (vertical climb + seeded horizontal jitter) applied
  **server-side** on top of the client's aim, plus a separate cosmetic camera kick spring and
  viewmodel kick; first-shot accuracy, bloom while moving/jumping.
* **Hit feedback** — hitmarkers (white body / red head / X on knock/kill) with distinct sounds,
  optional damage numbers, blood puff / armor spark on the target, victim flinch, directional damage
  indicators, low-HP vignette + desaturation, armor-break sound.
* **Sound** — WebAudio graph: layered gunshots (Kenney samples + synthesized crack/boom per weapon),
  **speed-of-sound delay** and low-pass muffling with distance, supersonic snap for near misses,
  footsteps by surface, engine sound synthesized from RPM, wind during freefall, UI sounds.
* **Camera shake** — trauma-based noise shake: firing (small), explosions/crashes (distance-scaled),
  hard landings.
* **Kill feedback** — kill-confirm sound + centered skull, "You knocked/killed X (n kills)" banner,
  kill feed with weapon icon & headshot marker.

## 4. Netcode, lag compensation & anti-cheat

**Principle: the client sends intent, never results.**

**What the client sends** (30 Hz `input` messages, each covering one fixed 33.3 ms tick):
`seq`, move axes (strafe/forward, −1..1), view yaw/pitch (*without* recoil), button bitmask
(fire, ADS, jump, crouch, prone, sprint, reload, interact, lean), requested weapon slot, discrete
actions (`pickup lootId`, `use item`, `drop`, `enterVehicle id`, `seat n`, `revive id`, `jump from
plane`, `open chute`), and `renderTime` — the server timestamp of the interpolated world the player
was looking at when they pressed the button. No positions, hits, damage, ammo or health ever.

**What the server validates / owns**
* Schema & size check on every message (bad types, NaN/Infinity, oversized → dropped; repeat → kick).
* **Rate limiting**: a token bucket allows ≤ ~1.25 inputs per tick; the server consumes **one input
  per tick per player**, so speed-hacks gain nothing. Missing inputs repeat the last one.
* **Movement is simulated on the server** with the same code the client predicts with →
  no teleport/fly/noclip/speedhack. Move vector clamped to the unit circle, pitch to ±89°.
* **Weapons**: fire-rate cooldowns, ammo, reload/draw/ADS timers, spread RNG (seeded by player + shot
  index) and **recoil are server-authoritative** — a no-recoil cheat changes nothing because the
  server adds the pattern itself.
* **Interactions** (loot, vehicles, revive) checked for distance ≤ 3 m, line of sight and state.
* Damage, health, armor, inventory, kills, zone, vehicle state: server-only.
* **Information hiding**: other players' inventories and enemy health are never sent; entity update
  rates drop with distance (interest management).
* Not fully preventable in a browser: aim-assist/ESP from a modified client. Mitigation: server-side
  heuristics (headshot ratio, angular snap speed) logged as flags.

**Lag compensation**
* Server keeps a 1 s ring buffer of every player's hitboxes (pos, stance, yaw, life) per tick.
* A hitscan shot is traced from the server-authoritative eye position, against hitboxes **rewound to
  the client's `renderTime`**, bounded per player by its server-measured RTT + interpolation delay
  (+ input queue wait) and hard-capped at 500 ms, so a client can never rewind further than it really
  lags (limits the "shot behind a wall" effect for the victim).
* **Ballistic projectiles** (DMR/sniper) are simulated in server time with sub-stepped segments
  (gravity + drag) but carry the shooter's rewind offset; each segment is tested against hitboxes at
  `t − offset`, so leading a moving target works the same at any ping.
* **Client prediction & reconciliation** for the local player (movement, stance, firing visuals);
  snapshots ack the last processed `seq`, the client snaps to the server state and replays unacked
  inputs; small errors are smoothed visually.
* **Entity interpolation**: remote entities render 100 ms in the past between snapshots
  (extrapolate ≤ 150 ms on loss).
* Hit markers/damage are shown only on server confirmation (no fake hits); tracers, muzzle flash,
  sounds and recoil are predicted instantly.
* `LAG_MS=150` server env var injects artificial latency for testing.

## 5. Performance budget

| Item | Budget |
|---|---|
| Client frame rate | **60 FPS** on integrated GPU (Iris Xe class) @1080p "Medium"; 120+ on discrete GPUs |
| CPU per frame | ≤ 2 ms prediction/interp, ≤ 3 ms entity/scene update, ≤ 4 ms render submit |
| GPU | ≤ 250 draw calls, ≤ 1.5 M triangles visible, one 2048² shadow map covering 140 m around the camera |
| Players | ≤ **64** per match (humans + bots) |
| Vehicles / loot / projectiles | ≤ 24 vehicles, ~1 800 loot items, ≤ 200 in-flight projectiles/grenades |
| Static world | ~4 000 trees, ~1 500 rocks/bushes, ~110 buildings, 1 024 × 1 024 m island |
| Server | 30 Hz tick, ≤ 8 ms/tick for 64 players incl. bots on one core |
| Bandwidth | 20 Hz snapshots; quantized JSON; ≤ 15 KB/s per client average |

**LOD / instancing plan (1 km map)**
* **Terrain**: 4 m heightmap split into 8 × 8 chunks of 128 m; each chunk has 3 LOD meshes chosen by
  distance, with skirts to hide cracks; frustum culled.
* **Vegetation & rocks**: one `InstancedMesh` per species per LOD band — near (< 150 m) full low-poly,
  mid (150–450 m) simplified, far (450–900 m) cross-quad impostor; bands re-sorted per chunk a few
  times per second with hysteresis to avoid flicker.
* **Buildings**: merged geometry per building; full interior < 200 m, exterior shell beyond.
* **Loot**: instanced per item type, drawn < 120 m.
* **Players**: 3 LODs with hysteresis — near (< 50 m) articulated soldier, mid (50–250 m) merged
  low-poly body, far (250–1 000 m) team-tinted silhouette impostor. **Player render distance
  1 000 m**; players/vehicles use a reduced-fog material so they stay visible beyond the terrain
  fog fade.
* Interest management on the server: < 150 m full rate, 150–500 m 10 Hz, > 500 m 4 Hz
  (interpolation hides the lower rate; nothing pops because entities are never culled by the
  server inside 1 000 m).

## 6. Player readability at distance

* Strong, readable silhouettes: high-contrast proportions (helmet, backpack, rifle) and a fresnel
  rim-light on characters so they separate from foliage and terrain.
* Team colors: every team gets a hue (armband, backpack, helmet stripe); **your team always renders
  in your own team color with an outline**.
* Nameplates: teammates always (name, health bar, distance, visible through walls; off-screen
  markers on the screen edge); enemies show a nameplate only with line of sight and the crosshair on
  them, within 200 m.
* LOD crossfades with hysteresis bands, far impostors and the 1 000 m player render distance keep
  enemies visible far away without popping in.

## 7. Internationalization

* **Priority languages** (the main markets): **Simplified Chinese (zh-CN)** for Mainland China and
  Singapore, **Traditional Chinese (zh-TW)** for the Taiwan region, **Traditional Chinese (zh-HK)** for
  Hong Kong SAR and Macao SAR, and **Japanese (ja)**. The two Traditional variants are written separately
  with region-appropriate wording (e.g. 軟體/軟件, 網路/網絡, 解析度/解像度, 機車/電單車), not a script
  conversion of each other; the shared terminology is in `docs/i18n/glossary-east-asia.md`.
* Other languages: English, Korean, Russian, Spanish, French, German, Portuguese and Arabic (RTL). They
  are complete today, but from now on new strings may ship untranslated there and fall back to English.
* Every UI string goes through `t(key, params)`; keys are type-checked against the English
  dictionary, plurals via `Intl.PluralRules`, numbers via `Intl.NumberFormat` with the regional locale.
* Detection: a stored manual choice wins; otherwise the browser's `navigator.languages` list is searched
  for a priority language first (so `en-HK, zh-HK` → zh-HK and `en-SG, zh-SG` → zh-CN), then for any
  other supported language, else English. Chinese tags resolve by script, then region: Hans/CN/SG/MY →
  zh-CN, HK/MO → zh-HK, Hant/TW → zh-TW. The manual switch in the main menu and settings lists the
  priority languages first and persists in `localStorage`.
* `<html lang>` is the exact regional code, so Han characters take the region's glyph shapes and font
  stack (PingFang SC/TC/HK, Microsoft YaHei/JhengHei, Noto Sans CJK SC/TC/HK/JP).
* Arabic sets `<html dir="rtl" lang="ar">`; layout uses CSS logical properties so menus and HUD mirror.
* The server never sends display text, only codes (`lobby.full`, `kill`, …) that the client translates.
* `npm run check:i18n` fails if a priority locale misses a key, any locale has unknown/empty keys or
  wrong placeholders, a priority locale mixes scripts (Simplified characters in zh-TW/zh-HK, Traditional
  in zh-CN, Chinese simplified or kyujitai in Japanese) or uses the other region's wording, or UI code
  assigns a raw string literal to `textContent`/`innerHTML`/`placeholder`/`title`.

## 8. Manual acceptance tests

Setup: `npm install`, then `npm run dev` (client on :5173 + game server on :8787).

1. **Languages / RTL** — Main menu → language switcher → Arabic: all text is Arabic and the layout
   mirrors right-to-left. Switch to Japanese and back to English; reload → the choice persists. In a
   browser set to German, a first visit opens in German. A browser listing `en-HK, zh-HK` (or
   `zh-MO`) opens in Traditional Chinese (Hong Kong/Macao wording), `zh-TW` in Traditional Chinese
   (Taiwan wording), `en-SG, zh-SG` in Simplified Chinese, and `ja` in Japanese.
2. **Training ground ballistics** — Training → pick up the sniper → shoot the 300 m and 500 m targets.
   The tracer visibly arcs, impact is delayed (~0.4 s at 300 m), and you must aim above the target.
   The AR hits instantly at 100 m. Damage read-out shows head vs body.
3. **Game feel** — Spray the AR at a wall: recoil climbs in a learnable pattern, the camera kicks
   and recovers, shots sound and tracers render. Hitmarkers differ for head/body; a kill shows the skull
   + sound.
4. **Single-player full loop** — Single Player → 30 players, squads, normal bots → you start with
   3 bot teammates (nameplates). Ride the plane, jump, open the chute, land, loot armor + gun, fight.
   The zone shrinks with a timer. Take a vehicle, drive, refuel. Get knocked → a bot teammate revives
   you (or you revive one). Play to the final circle → winner/elimination banner → results → back
   to setup.
5. **Two-window multiplayer** — Window A: Multiplayer → name "A" → Create lobby (8 players, solo,
   bots off). Window B: Multiplayer → name "B" → the lobby is listed → join. Both Ready → A starts.
   Both drop, find each other (map markers), shoot. Hits register in both windows (hitmarker for the
   shooter, damage indicator for the victim). The kill appears in both kill feeds. The match ends →
   results → both windows are back in the same lobby.
6. **Teammates online** — Same as 5 but duo, both windows on team 1, bots on. The teammate's
   nameplate and map marker are visible; get knocked by a bot → the other window revives you
   (hold F for 6 s).
7. **Lag compensation** — Run the server with `LAG_MS=150 npm run dev`. Shooting a strafing player
   or bot with the AR still registers where you aimed; the sniper still needs only travel-time lead.
8. **Vehicles** — In a match or training: F to enter as driver, 1–4 to switch seats, a second window
   enters as passenger and shoots from the seat. Drive into a wall at speed → the vehicle and
   occupants take damage. Run the fuel down → the engine stops; use a jerry can → it drives again.
   Shoot a vehicle until it burns and explodes.
9. **Distance visibility** — From a hill, look across the map at a bot 400–800 m away: it renders as
   a team-tinted silhouette without popping as you approach. Scope the sniper to confirm.
10. **Anti-cheat probes** — `npm run test:cheats` connects raw sockets that send speed-hack input
    floods, fire-rate spam, far-away loot pickups and NaN aim → the server ignores or rejects each
    one (the test asserts the outcome).
11. **Performance** — Press F3 for the stats overlay (FPS, frame ms, draw calls, triangles,
    entities, ping). Expect ≥ 60 FPS on Medium in a 64-player SP match.

## 9. Automated verification

* Unit tests: world gen determinism, collision, weapons/recoil/spread, ballistics (drop & time of
  flight vs analytic), damage/armor, zone phases, vehicles (fuel, crash damage), downed/revive, i18n
  key completeness.
* **Full-match soak**: 64 bots play a match to completion headless in Node with a single winner,
  and stay within the tick budget.
* **WS integration**: two scripted clients lobby → start → one shoots the other → kill registered → back
  in the lobby.
* **Cheat probes** as in test 10.
* **Playwright smoke**: boot the client in headless Chromium, run the training ground and a short SP match,
  assert no console errors, capture screenshots.
* **Acceptance automation**: the mechanics behind every §8 test also run unattended. Simulation and
  server checks are in `tests/integration/acceptance.test.ts`: ballistics, recoil pattern and prediction
  parity, the SP loop, duo combat and revive, lag compensation at 150 ms, vehicles, distance relevance, and
  a duo lobby through the real server. Browser checks are in `tests/e2e/acceptance.spec.ts`: languages and
  RTL, the F3 overlay, range ballistics, AR spray, the SP loop, two-window MP and distant players. What
  still needs a person at a real GPU is the *feel*: how recoil, hit feedback, sound and the
  no-pop LOD transitions look and sound.

## 10. Build approach

1. Scaffold the project and write the shared contracts (`types.ts`, `protocol.ts`, constants) by hand.
2. Fan out parallel agents per module with strict file ownership: world gen, physics, items &
   ballistics, vehicles, sim + match runner, bots, server, client net, rendering, characters/FX/viewmodel,
   audio & feel, UI + i18n.
3. Integrate, typecheck, run unit/soak/integration tests and headless-browser smoke.
4. Adversarial review passes (correctness, netcode/security, performance, i18n coverage, game
   feel), fix, re-verify.
5. Commit and push to `claude/dreamy-bell-cz3als`.
