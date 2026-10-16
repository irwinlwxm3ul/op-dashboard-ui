# Common instructions for every module agent

You are building one module of **DROPZONE**, a browser-based 3D battle royale shooter
(PUBG-inspired) in TypeScript: Three.js client, Node + ws server, shared deterministic simulation.
Repository: `/home/user/op-dashboard-ui` (deps installed: three 0.186, ws, vite 8, vitest, typescript 5.9, tsx).

## Read first
`PLAN.md` (product goals, game loop, game-feel requirements, netcode/anti-cheat, performance budget,
visibility, i18n), `ARCHITECTURE.md` (binding contracts, **strict file-ownership map**), the shared
foundation `src/shared/{types,protocol,constants,math,rng,validate}.ts`, `src/shared/sim/view.ts`,
and the client contracts `src/client/game/types.ts`, `src/client/render/contracts.ts`,
`src/client/ui/contracts.ts`. Then your module spec in `docs/specs/<module>.md`.

## Parallel build rules
* ~15 agents are building all modules **at the same time** in the same working tree. You may ONLY
  create/modify files inside your owned paths (see your spec + the ownership table in ARCHITECTURE.md).
  Never edit contracts/foundation files or another module's files. Never run `git` commands
  (the integrator commits). Do not install packages. Never leave servers/processes running.
* Modules you depend on may not exist yet or may be incomplete. Code against the contract
  (ARCHITECTURE.md signatures / contract files). Before finishing, re-check whether your dependencies
  now exist (read their `index.ts`) and make your code compile against the real implementation.
  Your tests must not depend on unfinished modules — use small local fakes where needed, unless your
  spec says otherwise.
* A previous interrupted attempt may have left files in your owned paths — inspect them, keep what is
  good, and continue.
* If you need a contract change or found a bug in someone else's module, do not edit it: work around it
  locally and report it in your final message under **Contract requests / cross-module issues** with
  exact details.

## Quality bar
Production-grade and complete: no TODOs, stubs or placeholder logic. Clean structure, comments where
non-obvious. Respect the PLAN.md performance budget (no per-frame / per-tick allocations in hot paths,
use instancing / spatial grids). Game feel matters: things must feel tight and responsive, not just work.
Shared code (`src/shared/**`) must not use DOM, `window`, three.js, Node APIs or `Math.random`/`Date.now`
for gameplay (use `rng.ts`, sim time). Client code: **no hardcoded user-visible strings** — every UI
string goes through `t()` from `src/client/i18n` (see ARCHITECTURE.md i18n fragments).

## Verification before finishing
1. `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '<your owned path prefixes>'` prints nothing
   (ignore errors in files you don't own).
2. Your tests pass: `npx vitest run <your test files>` (if your module has tests).

## Final message (your return value)
Concise report: files created, the exact public API you export, deviations from the contract,
contract requests / cross-module issues, test results. No code dumps.
