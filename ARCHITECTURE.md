# Architecture & module contracts

This is the binding contract between modules. `src/shared/types.ts`, `src/shared/protocol.ts`,
`src/shared/constants.ts`, `src/shared/math.ts`, `src/shared/rng.ts` are the shared foundation.
Each module below is owned by one implementer; other modules import only the public API listed
here (from the module's `index.ts`).

## Conventions

* Units: meters, seconds, radians. Y up. Map spans `[-half, half]` on X and Z.
* Angles (three.js compatible): `yaw = 0` faces **-Z**, positive yaw turns left (CCW from above);
  `pitch > 0` looks up. Use helpers in `src/shared/math.ts` (`forward`, `right`, `dirFromAngles`).
* Input axes: `mx` = strafe right (+), `mz` = forward (+).
* Determinism: anything that must agree between client and server (world gen, spread, recoil
  jitter, loot rolls) uses `src/shared/rng.ts`, never `Math.random()`.
* Shared code (`src/shared/**`) must not touch DOM, `window`, `three` renderer objects or Node APIs.
  It runs in Node (server, tests) and in a browser Web Worker.
* State objects are plain JSON data (see `types.ts`). No classes in state.
* Hot paths avoid per-call allocations where practical (reuse scratch vectors).
* No user-visible strings anywhere except `src/client/i18n/locales/*`. Proper nouns (town names,
  bot names) are allowed in shared code.

## Module ownership

| Module | Path | Stage |
|---|---|---|
| World generation | `src/shared/world/` | A |
| Physics (character, raycast, hitboxes) | `src/shared/physics/` | A |
| Items, combat math, ballistics, inventory, loot tables | `src/shared/items/` | A |
| Vehicles | `src/shared/vehicles/` | A |
| Audio engine | `src/client/audio/` | A |
| i18n | `src/client/i18n/`, `scripts/check-i18n.ts` | A |
| Simulation + match runner | `src/shared/sim/` | B |
| Bot AI | `src/shared/bots/` | B |
| Server (ws, lobbies, validation) | `src/server/` | B |
| Client net & game state (transports, prediction, interpolation, input) | `src/client/net/`, `src/client/game/` | B |
| World rendering | `src/client/render/world/` | C |
| Entity rendering, FX, viewmodel, camera | `src/client/render/entities/`, `src/client/render/fx/`, `src/client/render/view/` | C |
| UI (menus, lobby, HUD, map, results) | `src/client/ui/` | C |
| Game feel glue (feedback, shake, hitmarkers, sound routing) | `src/client/feel/` | C |
| App bootstrap | `src/client/main.ts`, `index.html` | D |

---

## Stage A APIs

### `src/shared/world` — `index.ts`

```ts
export const SURFACE_LIST: SurfaceMaterial[];           // index used by World.surface
export function generateWorld(seed: number, kind: MapKind): World;   // deterministic
export function worldCacheKey(seed: number, kind: MapKind): string;
```
* `island`: 1024 m island, sea beyond the coast (beaches), hills + one mountain, ~10 named towns
  (`TownDef.name` proper nouns) incl. one military base (tier 2), a road network, ~110 enterable
  buildings (door gaps ≥1.3 m wide × 2.2 m tall, window gaps, interior walls, stairs made of step
  boxes ≤0.3 m rise for multi-floor buildings, flat roofs reachable on some), ~4 000 trees,
  ~1 200 rocks, ~2 500 bushes, crates/containers/fences as cover, ~1 800 loot spawns
  (mostly on building floors), ~22 vehicle spawns on roads/garages.
* `training`: compact flat map (`TRAINING_MAP_SIZE`): firing range with lanes and targets at
  25/50/100/200/300/400/500/600 m from `firingLine`, moving targets, weapon racks (`racks`)
  holding every weapon/gear/consumable, a few CQB buildings, a vehicle test track with ramps
  and vehicle spawns of every type, `spawn`.
* Buildings are axis aligned (rotations only in multiples of 90°) so every collider is an AABB.
* Generation must take < 1.5 s in Node. Spatial grids back `queryBoxes/queryTrees/queryRocks`.

### `src/shared/physics` — `index.ts`

```ts
export interface MoveIntent {
  mx: number; mz: number;           // already clamped to unit circle
  yaw: number;                      // body heading used for movement basis
  sprint: boolean; walk: boolean;
  jumpPressed: boolean;             // edge (buffered internally via body.jumpBuffer)
  wantStance: Stance;
  speedMul: number;                 // weapon / ADS / healing / boost multipliers combined
  downed: boolean;                  // crawl only
  dive: number;                     // freefall/parachute: forward lean -1..1 (from mz)
}
export interface MoveEvents {
  jumped: boolean;
  landed: boolean;
  landSpeed: number;                // vertical speed at landing (m/s)
  stanceBlocked: boolean;           // wanted stance not possible (no headroom)
  enteredWater: boolean;
}
// Ground / swim movement (modes 'ground' and 'swim'); switches between them by water depth.
export function stepCharacter(body: CharacterBody, intent: MoveIntent, dt: number, world: World, out?: MoveEvents): MoveEvents;
// Freefall / parachute movement (modes 'freefall' | 'parachute'); sets mode 'ground'/'swim' on landing.
export function stepDrop(body: CharacterBody, intent: MoveIntent, dt: number, world: World, chuteOpen: boolean, out?: MoveEvents): MoveEvents;
export function bodyHeight(stance: Stance): number;
export function eyePosition(body: { pos: Vec3; stance: Stance; mode: MovementMode }, lean: number, yaw: number, out?: Vec3): Vec3;
export function canStand(world: World, pos: Vec3, stance: Stance): boolean;

export function raycastWorld(world: World, origin: Vec3, dir: Vec3, maxDist: number, out?: RayHit): RayHit | null;  // terrain, water surface, boxes (blocksBullets), trees, rocks
export function lineOfSight(world: World, a: Vec3, b: Vec3): boolean;

export interface HitboxPose { pos: Vec3; yaw: number; stance: Stance; life: LifeState; mode: MovementMode; lean: number; }
export function buildHitboxes(pose: HitboxPose, out?: Hitbox[]): Hitbox[];
export function raycastHitboxes(origin: Vec3, dir: Vec3, maxDist: number, boxes: Hitbox[]): { t: number; part: HitPart } | null;
export function rayCapsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: number, maxDist: number): number; // -1 if miss

// Generic collision helpers (also used by vehicles):
export function collideCircleXZ(world: World, pos: Vec3, radius: number, y0: number, y1: number): { pushed: boolean; nx: number; nz: number; depth: number };
```
`stepCharacter` must be **deterministic and side-effect free except for `body`** — the client
runs it for prediction and the server for authority.

### `src/shared/items` — `index.ts`

```ts
export const WEAPONS: Record<WeaponId, WeaponDef>;
export const AMMO: Record<AmmoId, AmmoDef>;
export const CONSUMABLES: Record<ConsumableId, ConsumableDef>;
export const THROWABLES: Record<ThrowableId, ThrowableDef>;
export const GEAR: Record<GearId, GearDef>;
export const ITEMS: Record<ItemId, ItemDef>;
export const ALL_ITEM_IDS: ItemId[];
export function itemCategory(id: ItemId): ItemCategory;
export function isWeaponId(id: string): id is WeaponId;   // + isAmmoId, isConsumableId, isGearId, isItemId

// Combat math
export function fireInterval(w: WeaponDef): number;
export interface SpreadContext { ads: number; speed: number; airborne: boolean; stance: Stance; bloom: number; }
export function spreadCone(w: WeaponDef, ctx: SpreadContext): number;
/** Deterministic pellet/shot directions. seed = hash32(playerId, shotCounter). */
export function shotDirections(w: WeaponDef, yaw: number, pitch: number, cone: number, seed: number, out?: Vec3[]): Vec3[];
/** Recoil to add for this shot (radians). */
export function recoilForShot(w: WeaponDef, sprayIndex: number, seed: number, stance: Stance, ads: number): { pitch: number; yaw: number };
/** Recover accumulated recoil toward 0. */
export function recoverRecoil(w: WeaponDef | null, rp: number, ry: number, dt: number, firing: boolean): { pitch: number; yaw: number };
export interface DamageResult { health: number; vestDmg: number; helmetDmg: number; armorHit: boolean; armorBroke: boolean; }
export function computeDamage(weapon: WeaponId, part: HitPart, distance: number, armor: ArmorState): DamageResult;
export function applyArmorDamage(armor: ArmorState, r: DamageResult): void;

// Ballistics
export function stepBallistic(pos: Vec3, vel: Vec3, w: WeaponDef, dt: number): void;          // mutates
export function simulateTrajectory(w: WeaponDef, range: number): { time: number; drop: number }; // vs straight line, unzeroed
export function zeroAngle(w: WeaponDef, zeroRange: number): number;                            // pitch offset so the sight is zeroed

// Inventory (mutates PlayerState)
export function capacity(p: PlayerState): number;
export function usedCapacity(p: PlayerState): number;
export function roomFor(p: PlayerState, item: ItemId): number;    // how many fit
export interface PickupResult { taken: number; dropped: { item: ItemId; count: number; mag?: number }[]; }
export function pickupItem(p: PlayerState, item: ItemId, count: number, mag?: number): PickupResult;
export function removeItem(p: PlayerState, item: ItemId, count: number): number;
export function applyConsumable(p: PlayerState, item: ConsumableId): void;   // heal/boost effects (not fuel)
export function tickBoost(p: PlayerState, dt: number): void;                  // boost heal-over-time + decay
export function boostSpeedMul(boost: number): number;
export function emptyInventory(): { ammo: Record<AmmoId, number>; items: Record<ConsumableId | ThrowableId, number> };

// Loot
export function rollLoot(rng: Rng, tier: 0 | 1 | 2): { item: ItemId; count: number; mag?: number }[];
```

### `src/shared/vehicles` — `index.ts`

```ts
export interface VehicleDef {
  type: VehicleType; seats: number; maxSpeed: number; reverseSpeed: number; accel: number; brake: number;
  steerMax: number; steerSpeed: number; grip: number; mass: number; health: number;
  fuelMax: number; fuelPerSec: number;                // at full throttle
  halfExtents: Vec3;                                   // collision OBB (x width, y height, z length)/2
  wheelBase: number; groundClearance: number;
  seatOffsets: Vec3[];                                 // local space; -Z is forward
  seatCanShoot: boolean[];
  isBike: boolean;
}
export const VEHICLES: Record<VehicleType, VehicleDef>;
export function createVehicle(id: EntityId, spawn: VehicleSpawn, fuelFraction?: number): VehicleState;
export interface VehicleControls { throttle: number; steer: number; handbrake: boolean; boost: boolean; }
export interface VehicleStepEvents { crash: number; crashPos: Vec3 | null; inWater: boolean; }
export function stepVehicle(v: VehicleState, ctl: VehicleControls | null, dt: number, world: World, others: VehicleState[], out?: VehicleStepEvents): VehicleStepEvents;
export function seatWorldPosition(v: VehicleState, seat: number, out?: Vec3): Vec3;
export function exitPosition(v: VehicleState, seat: number, world: World): Vec3;
export function raycastVehicle(v: VehicleState, origin: Vec3, dir: Vec3, maxDist: number): number; // -1 miss
export function vehicleHitsPoint(v: VehicleState, p: Vec3, radius: number): boolean;
export function crashDamage(impact: number, type: VehicleType): { vehicle: number; occupants: number };
```

### `src/client/audio` — `index.ts`

Singleton `audio` (WebAudio). Must be a no-op (never throw) when AudioContext is unavailable.
Gunshots and most effects are synthesized (pre-rendered once into AudioBuffers); Kenney CC0
samples in `/assets/sounds/` for footsteps, landing, jump, hurt, weapon change, explosion layer.

```ts
export interface AudioSettings { master: number; sfx: number; ui: number; }
export const audio: {
  init(): Promise<void>;                 // call from a user gesture; idempotent
  setSettings(s: AudioSettings): void;
  setListener(pos: Vec3, yaw: number, pitch: number): void;
  gunshot(kind: WeaponSoundKind, pos: Vec3, local: boolean): void;   // distance delay (speed of sound), muffling, tail
  dryFire(): void;
  reload(kind: WeaponSoundKind, phase: 'out' | 'in' | 'bolt' | 'shell'): void;
  weaponSwitch(): void;
  impact(material: string, pos: Vec3): void;
  bulletCrack(pos: Vec3): void;          // near miss supersonic snap
  footstep(material: SurfaceMaterial, pos: Vec3, local: boolean, intensity: number): void;
  jump(local: boolean, pos: Vec3): void;
  land(intensity: number, pos: Vec3, local: boolean): void;
  hitmarker(kind: 'body' | 'head' | 'armor' | 'knock' | 'kill'): void;
  hurt(amount: number): void;
  armorBreak(): void;
  explosion(pos: Vec3): void;
  heal(item: string): void;
  pickup(): void;
  ui(name: 'click' | 'hover' | 'ready' | 'start' | 'countdown' | 'error' | 'zone' | 'win' | 'lose'): void;
  setWind(intensity: number): void;      // freefall/parachute (0..1)
  setZoneProximity(insideBlue: boolean, intensity: number): void;
  engine(id: number): { update(pos: Vec3, rpm: number, throttle: number, local: boolean): void; stop(): void };
  update(dt: number): void;
}
```

### `src/client/i18n` — `index.ts`

```ts
export type Lang = 'en' | 'ru' | 'zh' | 'es' | 'fr' | 'de' | 'pt' | 'ja' | 'ko' | 'ar';
export const LANGUAGES: { code: Lang; native: string; dir: 'ltr' | 'rtl' }[];
export type TKey = keyof typeof en;                     // en.ts is the source of truth
export function t(key: TKey, params?: Record<string, string | number>): string;   // {name} interpolation; plurals via key variants `x_one`, `x_other` selected with Intl.PluralRules when params.count is given
export function initI18n(): Lang;                       // localStorage > navigator.languages > 'en'; applies <html lang dir>
export function setLanguage(lang: Lang): void;          // persists + applies + notifies
export function getLanguage(): Lang;
export function onLanguageChange(cb: (lang: Lang) => void): () => void;
export function isRTL(): boolean;
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string;
export function fmtDuration(seconds: number): string;   // m:ss
export function translateDom(root: ParentNode): void;   // fills [data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria]
export function itemName(id: ItemId): string;           // t(`item.${id}`)
export function errorText(code: LobbyErrorCode): string;
```
Locales live in `src/client/i18n/locales/{en,ru,zh,es,fr,de,pt,ja,ko,ar}.ts`; every non-English
locale is typed `Record<TKey, string>` so a missing key is a compile error.

---

## Stage B APIs

Foundation added for stage B (hand-written, binding): `src/shared/validate.ts`
(`validateClientMessage`, `sanitizeInput`, `sanitizeAction`, `sanitizeLobbySettings`,
`sanitizeMatchConfig`, `sanitizeName`, `sanitizeText`) and `src/shared/sim/view.ts`
(`SimView`, `SimEvent`, `NoiseEvent`, `BotDriver`).

### `src/shared/sim` — `index.ts`

```ts
export class GameSim implements SimView {
  constructor(config: MatchConfig);
  // SimView members (config, world, time, tick, phase, players, vehicles, loot, projectiles, zone, plane, noises, queries...)
  addPlayer(init: { name: string; isBot: boolean; team?: TeamId }): EntityId;  // -1 if rejected
  removePlayer(id: EntityId): void;          // human disconnected: player becomes bot-controlled (isBot = true) so the match stays fair
  fillBots(): void;                          // config.botFill: fill to maxPlayers respecting teamSize
  start(): void;                             // waiting -> plane (br) | playing (training)
  step(): void;                              // one TICK_DT (consumes at most one queued input per player per tick)
  drainEvents(): SimEvent[];
  drainLootDelta(): { added: LootItem[]; removed: EntityId[] };
  isOver(): boolean;
  results(): MatchResults;
  /** Hitbox history for lag compensation. */
  rewindHitboxes(id: EntityId, timeSec: number, out?: Hitbox[]): Hitbox[];
}
export class MatchRunner {
  constructor(opts: {
    config: MatchConfig;
    clients: { id: string; name: string; team: TeamId | null; send(msg: ServerMessage): void }[];
    botDriverFactory?: (sim: SimView) => BotDriver;   // defaults to none (server / worker pass createBotDriver)
    onEnd?: (results: MatchResults) => void;
  });
  readonly sim: GameSim;
  start(nowMs: number): void;              // adds players, fills bots, sends matchInit to each client
  update(nowMs: number): void;             // fixed-step accumulator (max 5 catch-up ticks), snapshots at SNAPSHOT_RATE with interest management
  handleMessage(clientId: string, msg: ClientMessage): void;  // 'input' (token-bucket rate limit, queue), 'ping' -> 'pong', 'leaveMatch'
  removeClient(clientId: string): void;
  isOver(): boolean;
  stats(): { tickMsAvg: number; tickMsMax: number; players: number; bots: number };
}
```

### `src/shared/bots` — `index.ts`

```ts
export function createBotDriver(sim: SimView): BotDriver;   // drives every player with isBot === true via sim.queueInput
export function botName(rng: Rng): string;                  // proper-noun gamer tags
```

### `src/server` — Node entry `src/server/index.ts`

HTTP server (serves `dist/` in production, `/healthz`), `ws` WebSocketServer on path `/ws`,
port `PORT` env or `DEFAULT_SERVER_PORT`. Lobby manager (create/list/join/leave/settings/teams/
ready/start/chat), one `MatchRunner` per lobby in game, ticked by a shared high-resolution loop.
Every inbound message passes `validateClientMessage`; per-connection message-rate limits and
max payload; kicks after repeated invalid messages; heartbeats. `LAG_MS` env adds symmetric
artificial latency (order preserving). After a match: results, then `backToLobby` + fresh
`lobbyState` (ready flags reset). Exports `startServer(opts?: { port?: number; lagMs?: number; log?: boolean }): Promise<{ port: number; close(): Promise<void> }>` for tests.

### `src/client/net` and `src/client/game`

* `Transport` (`send`, `onMessage`, `onClose`, `close`, `kind: 'local' | 'ws'`), `WsTransport.connect(url?)`
  (default `ws(s)://<host>/ws`), `LocalTransport` running `MatchRunner` + bots inside a module Web Worker
  (`localWorker.ts`) speaking the same protocol (`startLocal`).
* `InputController`: keyboard/mouse with pointer lock, rebindable keymap, sensitivity/ADS sensitivity/invert,
  toggle-or-hold crouch/ADS, produces one `PlayerInput` per tick with `seq`, base aim, buttons, stance,
  slot, `rt`, and queued actions.
* `ClientGame`: owns the match on the client: clock sync, snapshot buffer + interpolation of remote players,
  vehicles, projectiles, zone; prediction + reconciliation of the local player (shared `stepCharacter`/`stepDrop`,
  driver-side vehicle prediction with `stepVehicle`), predicted weapon handling (fire cadence, ammo, recoil,
  spread directions via shared items functions) for instant feedback; server-confirmed hits/kills;
  interaction prompt resolution (nearest loot / vehicle / revive target / plane jump / chute); loot map from
  `MatchInit` + deltas; typed event bus for `GameEvent`s and local predicted events. Exposes a per-frame
  `FrameState` (defined in `src/client/game/types.ts`) consumed by rendering, UI, audio and feel.

---

## Parallel build: file ownership (strict)

Every path has exactly one owner. Agents only write inside their own paths.

| Owner | Paths |
|---|---|
| **integrator (main thread)** | `src/shared/{types,protocol,constants,math,rng,validate}.ts`, `src/shared/sim/view.ts`, `src/client/game/types.ts`, `src/client/render/contracts.ts`, `src/client/ui/contracts.ts`, `src/client/main.ts`, `src/client/app/**`, `index.html`, configs, `tests/e2e/**`, `tests/integration/**`, `src/shared/netcodec.ts`, `README.md`, `PLAN.md`, `ARCHITECTURE.md` |
| world | `src/shared/world/**`, `tests/world.test.ts` |
| physics | `src/shared/physics/**`, `tests/physics.test.ts` |
| items | `src/shared/items/**`, `tests/items.test.ts` |
| vehicles | `src/shared/vehicles/**`, `tests/vehicles.test.ts` |
| sim | `src/shared/sim/**` (except `view.ts`), `tests/sim.test.ts`, `tests/runner.test.ts` |
| bots | `src/shared/bots/**`, `tests/bots.test.ts` |
| server | `src/server/**`, `tests/server.test.ts`, `tests/cheats.test.ts` |
| client-net | `src/client/net/**`, `src/client/game/**` (except `types.ts`), `tests/client-net.test.ts` |
| audio | `src/client/audio/**`, `tests/audio.test.ts` |
| i18n | `src/client/i18n/**`, `scripts/check-i18n.ts`, `tests/i18n.test.ts` |
| render-world | `src/client/render/core/**`, `src/client/render/world/**` |
| render-entities | `src/client/render/entities/**` |
| render-view-fx | `src/client/render/view/**`, `src/client/render/fx/**` |
| ui | `src/client/ui/**` (except `contracts.ts`), `src/client/styles/**` |
| feel | `src/client/feel/**` |

i18n string fragments: `src/client/i18n/locales/en.ts` = core keys (i18n owner) merged with
`src/client/ui/strings.en.ts` (`ui.*`, ui owner) and `src/client/feel/strings.en.ts` (`feel.*`, feel owner).
Non-English locales are `Partial` during the parallel build (English fallback); the final i18n pass
completes them and `npm run check:i18n` enforces completeness.

Client module factories (each module `index.ts`): `createRenderCore`, `createWorldRenderer`
(render/core + render/world), `createEntityRenderer` (render/entities), `createViewRig`
(render/view), `createFxRenderer` (render/fx), `createFeel` (feel), `createUI` (ui),
`ClientGame`/`LocalTransport`/`WsTransport`/`settings`/`InputController` (client-net). Signatures in
`src/client/render/contracts.ts`, `src/client/ui/contracts.ts`, `src/client/game/types.ts`.
| assets | `public/assets/models/{characters,animations,weapons,items}/**`, `src/client/assets/**`, `scripts/assets/**`, `docs/ASSETS.md`, `tests/assets.test.ts` |
| world-assets | `public/assets/models/{vehicles,props,nature}/**`, `src/client/assets/manifest-world.ts`, `scripts/assets/world/**`, `docs/ASSETS-world.md`, `tests/assets-world.test.ts` |
