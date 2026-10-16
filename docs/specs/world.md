# Module spec: world

Owned paths: src/shared/world/** and tests/world.test.ts

- MODULE: World generation (src/shared/world). Implement generateWorld(seed, kind), SURFACE_LIST, worldCacheKey per ARCHITECTURE.md, returning an object satisfying the World interface in types.ts (data + methods heightAt/normalAt/surfaceAt/groundAt/inBounds/queryBoxes/queryTrees/queryRocks backed by uniform spatial grids).

- ISLAND map (kind "island", MAP_SIZE 1024 m, TERRAIN_RES 257 heightmap, row-major z rows / x columns covering [-half, half]): an organic island shape (noise-perturbed radial falloff) with coastline roughly 400-470 m from center, sandy beaches, sea floor below WATER_LEVEL beyond the coast (heights down to about -12), rolling hills (0-40 m) and one mountain/ridge (up to ~90 m), a lake or river is optional. Surfaces: grass, dirt patches, rock on steep slopes and peaks, sand near water, road along roads.

- Roads: a network connecting towns (polyline segments, width 6-8 m), terrain flattened/smoothed under roads, surface "road".

- Towns: ~10 named towns (invent original proper nouns, e.g. "Novoreka", "Kestrel Bay"), sizes small/medium/large, one military base (tier 2) with bunkers, containers, towers. Town terrain flattened to plateaus with smooth blending.

- Buildings (~110, axis-aligned, rotations only in 90 degree multiples so every collider is an AABB): styles house, barn, apartment (2-3 floors), warehouse, shed, tower, bunker, shop. Build them out of WorldBox pieces: foundation box from below terrain up to floor level (no floating gaps), floor slabs 0.2 m, outer walls 0.25 m thick with door gaps (>=1.3 m wide, 2.2 m tall) and window gaps (sill 1.0 m, top 2.0 m) implemented by splitting walls into boxes, interior partition walls with doorways, ceiling/roof slabs, stairs made of step boxes (rise <= 0.3 m, run ~0.3 m, width >= 1.1 m) with a stairwell hole in the upper floor slab for multi-floor buildings, some flat roofs reachable via stairs, rooftop parapets. Floor-to-floor height ~3.2 m. Realistic muted palette (beige plaster, brick red, grey concrete, weathered wood, green military, corrugated metal) in WorldBox.color; materials set appropriately (concrete/wood/metal). Fill BuildingDef (footprint, floors, boxIds, wall/roof colours, town). Every building must be enterable by a 0.35 m radius, 1.8 m tall character and its interior must be navigable.

- Props: crates, shipping containers (some open), concrete barriers, wooden fences (low, blocksBullets true), sandbag walls in the military base — as WorldBox with kind.

- Vegetation: ~4000 trees (TreeDef: pine/oak/birch/dead, trunk radius 0.2-0.5, height 6-16 m) clustered into forests via noise, none on roads, in towns, inside building footprints or in water; ~1200 rocks (RockDef) incl. some large cover rocks; ~2500 bushes. Keep 1.5 m clearance from buildings/doors.

- Loot spawns (~1800): mostly on building floor surfaces (y = floor top + 0.05, at least 0.5 m away from walls, distributed across all floors/rooms), some outdoors near props; tier by town tier (military = 2) plus random. Never inside walls/stairs.

- Vehicle spawns (~22): on roads or beside buildings on flat ground, clear 4 m radius of colliders, mix of buggy/uaz/bike, yaw aligned with road.

- TRAINING map (kind "training", TRAINING_MAP_SIZE): mostly flat grass plain with gentle hills at edges, water beyond edges. A firing range: a firingLine position, 6+ lanes, lane markers, static targets (TrainingTarget kind static, each also represented by a WorldBox kind "target" plate ~0.6 x 1.8 m standing on a post) at ranges 25, 50, 100, 200, 300, 400, 500, 600 m measured from firingLine, moving targets (kind moving with a, b, speed) at 50/100/200 m, popup targets at 15-30 m. Racks (kind "rack" boxes) with racks[] entries for EVERY ItemId (all weapons, every ammo type, all consumables incl. fuel, frag, all gear levels) laid out near spawn. A small CQB area with 3-4 buildings (reuse building generator), a vehicle test track: an oval/loop road with ramps (WorldBox kind "ramp" built as stacked step boxes or a few sloped-approximation boxes), and vehicleSpawns with every type (2 each). spawn/spawnYaw facing the range.

- groundAt(x, z, fromY): highest walkable surface (terrain or box top) at or below fromY (default +Infinity); used for spawning/landing on roofs.

- Determinism: identical output for same seed in Node and browser (only rng.ts randomness, no Math.random, no Date). Cache generated worlds in a module-level Map keyed by worldCacheKey.

- Performance: generateWorld for island must run < 1.5 s in Node (measure in a test and assert < 3 s to avoid CI flakiness); queries must be O(cells touched).

- Tests (tests/world.test.ts): determinism (same seed equal hashes of heights/boxes; different seed differs), timing, counts within expected ranges, no building/tree/loot in water, loot spawns are on a box top or terrain and not inside any box, every building has at least one door gap reachable from outside (e.g. check a 1.3 m wide opening exists in exterior walls at ground floor), vehicle spawns clear, training map has racks for all ItemIds and targets at all listed ranges, query functions return the right subsets.
