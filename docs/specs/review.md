# Consolidated review pass (post-integration)

One pass, several independent reviewers in parallel, each with a distinct lens. Reviewers READ and RUN
the code (tests, headless browser via the scripts below) and report verified findings; they do not edit
files. The integrator triages and dispatches fixes.

Common context: PLAN.md (requirements and acceptance tests), ARCHITECTURE.md (contracts, ownership),
docs/specs/*.md (module specs). The game builds with `npx vite build` and runs in production mode with
`NODE_ENV=production PORT=<port> npx tsx src/server/index.ts` (serves dist/ + /ws). Headless Chromium:
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` with args `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader --ignore-gpu-blocklist` (software WebGL: ~1–3 FPS, use quality low /
renderScale 0.5 via localStorage `dz.settings`). `window.__dz` is the App (`.session.game.getFrame()`,
`.core.stats()`, `.startSinglePlayer(opts)`, `.startTraining()`). Use ports other than 5173/8787/8790 and
stop every process you start.

Each finding must include: file:line, a concrete failure scenario (inputs/state → wrong behaviour), how
you verified it (test, script, trace), severity (blocker / major / minor), and a suggested fix. Only report
what you verified or traced end to end; mark anything else "unverified".

## Lenses

1. **Netcode, lag compensation & anti-cheat** — server trusts nothing (validate.ts, Connection, LobbyManager,
   MatchRunner), rate limits, information hiding in snapshots, lag-comp rewind correctness and clamps,
   ballistic projectile rewind, prediction/reconciliation parity, clock sync, delta codec correctness
   (netcodec.ts), plane hold, reconnect/disconnect edge cases, DoS vectors (unbounded maps/queues).
2. **Simulation & full game loop** — plane → jump → chute → land → loot → fight → zone → vehicles →
   downed/revive → final circle → winner → results → back to lobby; team elimination/placement;
   training mode; vehicles (enter/exit/seats/fuel/crash damage/explosions); inventory rules; bots behaving
   sensibly (do they loot, fight, revive, rotate, use vehicles, avoid getting stuck?).
3. **Rendering, performance & visibility** — draw calls/triangles vs PLAN budget, per-frame allocations,
   LOD hysteresis/popping, players visible at 400–1000 m (silhouettes, fog), nameplates, shadows, memory
   leaks across matches (dispose paths), quality presets, resize.
4. **Game feel & UX flow** — weapon handling, recoil (server vs cosmetic), hit feedback, sounds routing (no
   double sounds/tracers for local player), camera modes (TPP collision, FPP, scope, vehicle, spectate),
   viewmodel, HUD correctness (ammo, health, zone timer, prompts), menus/lobby/results/pause flows,
   pointer lock handling, inventory/map overlays.
5. **i18n, accessibility & RTL** — no hardcoded strings (`npx tsx scripts/check-i18n.ts`), all 10 locales
   complete, plurals, Arabic RTL layout (screenshots), language detection/persistence, server sends codes only.
6. **Integration & code quality** — contract mismatches between modules, dead code/duplicated logic,
   error handling (module fallbacks in src/client/app), tests that are weak or flaky, build warnings,
   README/PLAN accuracy vs what was built.
