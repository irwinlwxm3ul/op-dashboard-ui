# DROPZONE

A browser-based 3D battle royale shooter inspired by PUBG: single-player against AI bots, a training
ground, and online multiplayer with lobbies, selectable player counts and team sizes, and teammates.
Three.js client, Node.js WebSocket server, and one shared TypeScript simulation that runs on the server
for online play and in a Web Worker for offline play.

See [PLAN.md](PLAN.md) for the full design: game loop, game-feel goals, netcode, lag compensation and
anti-cheat, performance budget, LOD plan and acceptance tests. Module contracts and file ownership are in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Quick start

```bash
npm install
npm run dev          # game server on :8787 + Vite client on :5173 (proxying /ws)
# open http://localhost:5173
```

Production build:

```bash
npm run build        # client → dist/
npm start            # serves dist/ and the game server on PORT (default 8787)
```

Artificial latency for testing lag compensation: `LAG_MS=150 npm run dev`.

## Modes

* **Training ground**: every weapon and item on racks, infinite ammo, range targets from 25 to 600 m
  (bullet drop and travel time for the DMR and sniper), moving targets, a vehicle test track and
  instant respawn.
* **Single player**: 2–64 players, solo, duo or squad, bot difficulty and zone speed. Bots fill every
  slot, including your teammates.
* **Multiplayer**: lobby browser, create or join lobbies, pick a team slot, ready up; the host
  starts. Bots can optionally fill empty slots.

Each match runs: plane → jump → freefall → parachute → land → loot → fight → zone shrinks →
vehicles → downed/revive → final circle → winner → results → back to the lobby.

## Controls (default, rebindable in Settings → Controls)

| Action | Key | Action | Key |
|---|---|---|---|
| Move | W A S D | Fire / Aim | Left / Right mouse |
| Sprint / Walk | Shift / X | Reload | R |
| Jump | Space | Interact (pick up, enter, revive, jump, chute) | F |
| Crouch / Prone | C / Z | Lean | Q / E |
| Weapons | 1 2 3, wheel | Frag (select / throw) | 4 / G |
| Holster | H | Swap primaries | B |
| Inventory | Tab | Map | M |
| Camera FPP/TPP | V | Free look | Alt |
| Quick heal | 7 bandage, 8 first aid, 9 medkit, 0 energy | Refuel | T |
| Vehicle | W/S throttle, A/D steer, Space handbrake, Shift boost, 1–4 seats, F exit | Stats overlay | F3 |
| Scoreboard | P | Spectate next / previous | ← / → |
| Training: respawn | K | Pause menu | Esc |

## Languages

English, Русский, 中文, Español, Français, Deutsch, Português, 日本語, 한국어, العربية (right-to-left).
The game detects the browser language and has a switcher in the main menu and settings.
`npm run check:i18n` verifies every locale is complete and that no UI code hardcodes text.

## Tests

```bash
npm test             # unit + simulation + bot soak + server/WebSocket integration + cheat probes
npm run test:cheats  # anti-cheat probes only
npm run test:e2e     # Playwright smoke tests in headless Chromium (menu/RTL, training, SP, two-window MP)
npm run typecheck
```

The manual acceptance tests are in [PLAN.md §8](PLAN.md#8-manual-acceptance-tests).

## Project layout

```
src/shared/     constants, types, protocol, validation, world gen, physics, items & ballistics,
                vehicles, simulation + match runner, bot AI   (runs in Node and in the browser)
src/server/     WebSocket game server, lobbies, rate limiting, static hosting
src/client/     app flow, i18n, UI/HUD, netcode (prediction/interpolation), rendering, audio, game feel
tests/          vitest suites, integration soak tests, Playwright e2e
```

## Credits

* **3D models.** Characters, animations (Universal Animation Library 1 & 2), weapons (Ultimate Guns
  Pack), survival items and backpacks (Survival Pack), grenade and helmets (Toon Shooter Game Kit) by
  **Quaternius** (quaternius.com), CC0 1.0. Ammo boxes from "Low Poly Weapons Pack V.1" by **Zsky**
  (@Zsky_01, https://zsky2000.itch.io/low-poly-weapons-pack-v1), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the ammo box models were rescaled,
  re-coloured and merged into single meshes. Rifle and parachute animations and the body-armour models
  were made for DROPZONE. Vehicles, props and nature: LuAZ-969 4x4 by **aaadragon** (CC BY 4.0), dirt bike
  by **nabeelashrafphotography** (CC BY 4.0), "Sandbag" by **Jenna** (CC BY 4.0), props and photo-scanned
  rocks from **Poly Haven** (CC0; authors listed in docs/ASSETS-world.md), trees, bushes, crates, fences
  and containers by **Quaternius** (CC0). Per-asset sources, commits, licences and modifications:
  [docs/ASSETS.md](docs/ASSETS.md) (and [docs/ASSETS-world.md](docs/ASSETS-world.md) for vehicles,
  props and nature).
* Sound effects and sprites: [Kenney](https://kenney.nl) Starter Kit FPS. The assets are CC0 and the kit's
  code is MIT; see `public/assets/LICENSE-Kenney-StarterKitFPS.md`.
* Font: Lilita One by Juan Montoreano (SIL Open Font License); see `public/assets/fonts/`.
* Terrain, buildings and gunshot sounds are generated in code.
