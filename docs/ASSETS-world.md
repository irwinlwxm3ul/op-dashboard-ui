# World assets: vehicles, props, nature

Real third-party 3D models that replace the procedural vehicles, cover props and vegetation.
Everything is **CC0 1.0** or **CC BY 4.0**, downloaded from pinned GitHub mirrors (the only
reachable host from the build sandbox), converted in headless Chromium with three.js 0.186 and
committed as plain binary glTF (no Draco / meshopt compression, textures embedded, <= 1024 px).

* Manifest: `src/client/assets/manifest-world.ts` (generated, typed: `VEHICLE_MODELS`,
  `PROP_MODELS`, `NATURE_MODELS`, `WORLD_ASSET_CREDITS`, `WORLD_ASSET_BUDGETS`,
  `worldAssetFilesFor()`, `propModelsForBox()`), resolve paths with `modelUrl()` from
  `./manifest`, load with `loadModel()` / `instantiate()` from `./loader`.
* Files: `public/assets/models/{vehicles,props,nature}/` - 21 GLBs + `nature/impostors.png`,
  7.6 MB in total (budget 15 MB).
* Pipeline: `scripts/assets/world/` (see [Rebuilding](#rebuilding)).
* Checks: `npx vitest run tests/assets-world.test.ts` (static GLB checks) and
  `node scripts/assets/world/verify.mjs [outDir]` (three.js load + QA screenshots).

## What is in it

| Category | File | Model | Tris (LOD0 / LOD1) | Size |
|---|---|---|---|---|
| vehicle `uaz` | `vehicles/uaz.glb` | LuAZ-969 4x4 with canvas top (Body, Glass, 4 wheels) | 4 108 | 375 KB |
| vehicle `bike` | `vehicles/bike.glb` | off-road dirt bike (Body, Fork, 2 wheels) | 4 442 | 281 KB |
| vehicle `buggy` | - | **not found** (see below): keeps the procedural buggy | - | - |
| prop | `props/crate_wood.glb` | plank crate with X brace, 1 m cube | 230 | 159 KB |
| prop | `props/crate_military.glb` | banded crate, olive-drab tinted, 1 m | 1 576 | 315 KB |
| prop | `props/ammo_crate.glb` | stencilled military ammo crate (0.8 m) | 1 531 | 220 KB |
| prop | `props/barrel_oil.glb` | blue ribbed steel oil drum | 1 100 | 165 KB |
| prop | `props/barrel_red.glb` | red "flammable" fuel drum | 1 100 | 200 KB |
| prop | `props/jerrycan.glb` | red steel jerry can | 895 | 194 KB |
| prop | `props/barrier_concrete.glb` | 2 concrete jersey barriers, 3.1 m run | 1 400 | 203 KB |
| prop | `props/sandbag_wall.glb` | 2 m sandbag wall, 6 courses, 42 bags | 1 848 | 79 KB |
| prop | `props/container_green.glb`, `container_red.glb` | ISO 20 ft shipping containers | 1 336 / 1 032 | 102 / 80 KB |
| prop | `props/fence_wood.glb` | rural two-rail wooden fence, 2.06 m | 40 | 145 KB |
| prop | `props/fence_chainlink.glb` | 2.4 m chain-link panel + post (alpha-tested wire) | 1 470 | 563 KB |
| nature | `nature/tree_pine.glb` | 5 pines (+ LOD1 each) | <= 2 000 / ~650-800 | 993 KB |
| nature | `nature/tree_oak.glb` | 5 broadleaf trees (+ LOD1) | <= 2 000 / ~640 | 1.15 MB |
| nature | `nature/tree_birch.glb` | 5 birches, leaves re-tinted summer green (+ LOD1) | <= 2 000 / ~640 | 1.06 MB |
| nature | `nature/tree_dead.glb` | 5 dead trees / snags (+ LOD1) | <= 2 000 / ~590 | 862 KB |
| nature | `nature/rocks.glb` | 6 scanned mossy rocks (+ LOD1) | 700 / 180 | 315 KB |
| nature | `nature/bushes.glb` | 3 bushes (+ LOD1) | 900 / 400 / 276 (LOD1 300 / 300 / 276) | 281 KB |
| nature | `nature/grass.glb` | 3 grass tufts | 58 / 108 / 120 | 87 KB |
| nature | `nature/impostors.png` | far-band atlas: pine, oak, birch, dead, bush (1280 x 512) | - | 455 KB |

Lineup screenshots of all of the above are produced by `verify.mjs` (vehicles posed with steering
and their physics collision boxes, props, every tree variant at LOD0 and LOD1, rocks / bushes /
grass).

## Frames and how to use them

All files are already scaled and oriented (manifest `scale: 1`, identity `rotation`): metres,
+Y up, +X right, forward -Z.

**Vehicles.** Origin = physics OBB centre (`VehicleState.pos`), length = `2 * halfExtents.z`,
wheel bottoms at `y = -(groundClearance + halfExtents.y)` at rest - so the model is placed with
exactly the transform the procedural vehicles use. Every wheel is a Group pivoting at its centre:
spin with `rotation.x`, steer front wheels with `rotation.y` (`rotation.order = 'YXZ'`), apply
suspension as a y offset from the manifest `center`. The bike's front wheel is a child of
`Fork`, whose origin lies on the steering axis level with the axle and whose local +Y is the
steering axis (`rake` 0.49 rad): steer with `Fork.rotation.y` keeping the loaded `rotation.x`.
Measured wheel radii: UAZ 0.386 m (physics 0.40), bike 0.34 m (physics 0.33). `seatSurfaceY`
gives the model's seat height under each physics seat: UAZ front seats -0.24 (physics hips at
-0.25, i.e. a perfect fit); the bike seat is ~0.11 m above the physics hips, so lift the rider by
that much. The UAZ body uses one textured material (`uaz_body`, the original teal paint) plus a
transparent `uaz_glass`; the bike uses one palette material (`bike`). Neither is designed for
per-vehicle paint tinting (`paintTinted: false`); darken the material colour for wrecks.

**Props.** Resting on y = 0, centred on X/Z, long axis along X. `PROP_MODELS[id].boxes` /
`propModelsForBox(kind, material)` map the world generator's boxes to models: `crate`+`wood` ->
crate_wood / crate_military (military crate palette), `barrier`+`concrete` -> barrier_concrete,
`barrier`+`sand` -> sandbag_wall, `fence`+`wood` -> fence_wood, `fence`+`metal` ->
fence_chainlink, `container`+`metal` -> container_green / container_red (closed containers only;
open, enterable containers keep their box walls). `fit` says how to scale each one to its box.
`ammo_crate`, the barrels and the jerry can are free dressing props (native size).

**Trees.** Unit height (ground y = 0, crown top y = 1, roots slightly below 0), trunk base centred
on the origin: instance scale `(h, h, h)` with `h = TreeDef.h`, exactly like
`vegetationModels.ts`. Each variant is a Group `<kind>_<n>` with `<kind>_<n>_bark` and
`<kind>_<n>_leaves` meshes, plus `<kind>_<n>_lod1` for the mid band. All variants of a kind share
one bark and one leaves material (alpha-tested, double sided). Vertex attributes `_sway`
(0 at the base -> 1 at the top) and `_trunk` (1 on the trunk core, fading to 0 on branches and
leaves) mirror the procedural `sway` / `trunk` attributes, so the existing wind and
trunk-radius shader code works after renaming (`geometry.setAttribute('sway', geometry.getAttribute('_sway'))`).
`trunkRadius` is each variant's trunk base radius in unit space (the procedural trees use
`UNIT_TRUNK_RADIUS = 0.03`): per instance, `aTrunk = TreeDef.r / (trunkRadius * h)`.
Draw calls: 2 per variant per band (bark + leaves); using 2-3 variants per kind keeps the near
and mid bands within ~50 draw calls.

**Rocks.** Base y = 0, top y = 1, horizontal radius 1, ~20 % buried (y down to -0.2): instance
scale `(r, h, r)` reproduces the physics cylinder of `RockDef` (`y .. y + h`, radius `r`).

**Bushes / grass.** Bushes are ~1.6 m wide at scale 1 with `_sway = max(0, y) * 2.2` (like the
procedural bush); grass tufts are unit height with `_sway = y`.

**Impostors.** `nature/impostors.png` uses the same cell order as the procedural atlas (pine,
oak, birch, dead, bush), base at the bottom of each cell, unlit albedo. Size far quads with
`NATURE_MODELS.impostors.widthRatio` (crown width / height of variant 1: pine 0.71, oak 0.68,
birch 0.53, dead 0.68; bush 1.7 x 1.1 m at scale 1).

## Sources, licences and modifications

Every file was downloaded from a GitHub mirror at a pinned commit (`scripts/assets/world/sources.mjs`);
the original page, author and licence of each model are listed with it. **CC BY 4.0 models must be
credited** wherever the game lists credits - use `WORLD_ASSET_CREDITS` (the credit lines below are
the ones the authors ask for).

### CC BY 4.0 (attribution required)

**LUAZ** by aaadragon - `vehicles/uaz.glb`
* Original: https://sketchfab.com/3d-models/luaz-172d9676de3541808f422eee16f47e72
* Mirror: https://github.com/profojak/Brumm-Brumm-Bau/tree/473da224db5e2155de9d18de29e35542215523f4/assets/models/vehicle
  (commit `473da224db5e2155de9d18de29e35542215523f4`, Sketchfab glTF export with `license.txt`)
* Licence (from the shipped `license.txt`): "license type: CC-BY-4.0
  (http://creativecommons.org/licenses/by/4.0/) - requirements: Author must be credited.
  Commercial use is allowed."
* Credit: This work is based on "LUAZ"
  (https://sketchfab.com/3d-models/luaz-172d9676de3541808f422eee16f47e72) by aaadragon
  (https://sketchfab.com/aaadragon) licensed under CC-BY-4.0
  (http://creativecommons.org/licenses/by/4.0/)
* Modifications: re-oriented (front -Z), uniformly scaled x1.168 to the 4 m collision box,
  re-centred on the OBB centre; doors merged into the body; wheels split into pivoting nodes
  named by position; body texture 2048 -> 1024 px JPEG; roughness / metalness retuned; the
  transmission glass material replaced by a plain transparent material.

**DIRT BIKE OFF ROAD BIKE LOW POLY** by nabeelashrafphotography - `vehicles/bike.glb`
* Original: https://sketchfab.com/3d-models/dirt-bike-off-road-bike-low-poly-dbcca404b21348c69938207d265b6035
* Mirror: https://github.com/warathepj/Tentspace/tree/4c755e03fd0fdfb08052662246a7324bf60e5e5a/public/models/dirt_bike_off_road_bike_low_poly
  (commit `4c755e03fd0fdfb08052662246a7324bf60e5e5a`)
* Licence (from the shipped `license.txt`): "license type: CC-BY-4.0
  (http://creativecommons.org/licenses/by/4.0/) - requirements: Author must be credited.
  Commercial use is allowed."
* Credit: This work is based on "DIRT BIKE OFF ROAD BIKE LOW POLY"
  (https://sketchfab.com/3d-models/dirt-bike-off-road-bike-low-poly-dbcca404b21348c69938207d265b6035)
  by nabeelashrafphotography (https://sketchfab.com/nabeelashrafphotography) licensed under
  CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
* Modifications: re-oriented, scaled x1.013 to the 2.1 m collision box, re-centred; steering
  assembly (fork, handlebar, front fender, number plate) split off into a raked `Fork` node;
  decimated 17 101 -> 4 442 triangles; the 9 flat materials baked into one 4x4 palette texture
  (base colour + metallic-roughness), black tyres lifted to rubber albedo.

**Sandbag** by Jenna (jennakay) - `props/sandbag_wall.glb`
* Original: https://sketchfab.com/3d-models/sandbag-2efc2a324abc4d0087f1d7c3cbba665a
* Mirror: https://github.com/greentis/comp4451-game/tree/dfc99fec9898c06e54bb105afcd7b185f13e6b45/assets/sandbag
  (commit `dfc99fec9898c06e54bb105afcd7b185f13e6b45`)
* Licence (from the shipped `license.txt`): "license type: CC-BY-4.0
  (http://creativecommons.org/licenses/by/4.0/) - requirements: Author must be credited.
  Commercial use is allowed."
* Credit: This work is based on "Sandbag"
  (https://sketchfab.com/3d-models/sandbag-2efc2a324abc4d0087f1d7c3cbba665a) by Jenna
  (https://sketchfab.com/jennakay) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
* Modifications: decimated 3 904 -> 44 triangles, laid flat, 42 jittered copies stacked into a
  2 m running-bond wall; texture 1024 -> 512 px.

### CC0 1.0 (public domain)

**Quaternius** packs (all models by Quaternius, https://quaternius.com), mirrored at
https://github.com/agentkaerf/FreeModels (commit `db3df04d1e4714298a09510b26fb6de6645138a2`).
Each pack's licence file reads: "License: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication
https://creativecommons.org/publicdomain/zero/1.0/".
* Stylized Nature MegaKit (Standard) - https://github.com/agentkaerf/FreeModels/tree/db3df04d1e4714298a09510b26fb6de6645138a2/Stylized Nature MegaKit[Standard]
  -> `tree_pine` (Pine_1..5), `tree_oak` (CommonTree_1..5), `tree_dead` (DeadTree_1..5),
  `bushes` bush_1 (Bush_Common), `grass` grass_3 (Grass_Common_Short).
* Ultimate Stylized Nature - https://github.com/agentkaerf/FreeModels/tree/db3df04d1e4714298a09510b26fb6de6645138a2/Ultimate Stylized Nature - May 2022
  -> `tree_birch` (BirchTree_1..5), `bushes` bush_2 / bush_3 (Bush, Bush_Large), `grass`
  grass_1 / grass_2 (Grass_Small, Grass_Large).
* Medieval Village MegaKit (Standard) - https://github.com/agentkaerf/FreeModels/tree/db3df04d1e4714298a09510b26fb6de6645138a2/Medieval Village MegaKit[Standard]
  -> `crate_wood` (Prop_Crate), `fence_wood` (Prop_WoodenFence_Single).
* Fantasy Props MegaKit (Standard) - https://github.com/agentkaerf/FreeModels/tree/db3df04d1e4714298a09510b26fb6de6645138a2/Fantasy Props MegaKit[Standard]
  -> `crate_military` (Crate_Wooden).
* Zombie Apocalypse Kit - https://github.com/agentkaerf/FreeModels/tree/db3df04d1e4714298a09510b26fb6de6645138a2/Zombie Apocalypse Kit - March 2024
  -> `container_green`, `container_red`.
* Modifications: trees / bushes / grass normalised (unit height or 1.6 m width, trunk base at the
  origin), decimated to <= 2 000 triangles (bark: attribute-aware meshoptimizer decimation;
  leaves: whole alpha cards dropped and the survivors enlarged), LOD1 meshes generated the same
  way, `_sway` / `_trunk` vertex attributes added, variants of a kind merged into one file with
  shared materials; bark textures desaturated toward grey-brown (pine / oak) or brightened (dead);
  birch leaves (autumn yellow) and Bush_Common leaves (red) re-tinted green, Ultimate bushes
  toned down; leaf textures colour-bled under the alpha mask; textures resized to <= 512 px.
  Crates scaled to 1 m, crate_military wood tinted olive drab; containers scaled to ISO 20 ft
  (6.06 x 2.59 x 2.44 m).

**Poly Haven** models (https://polyhaven.com/license: all Poly Haven assets are CC0 1.0), 1k
glTF exports mirrored on GitHub:
* Barrel 03 by Serhii Khromov - https://polyhaven.com/a/barrel_03 -> `barrel_oil`
* Barrel 01 by Jorge Camacho - https://polyhaven.com/a/Barrel_01 -> `barrel_red`
* Metal Jerrycan by Sean Buckley - https://polyhaven.com/a/metal_jerrycan -> `jerrycan`
* Concrete Road Barrier by Amal Kumar - https://polyhaven.com/a/concrete_road_barrier -> `barrier_concrete`
* Modular Chainlink Fence by James Ray Cock (fence wire material: Amal Kumar) -
  https://polyhaven.com/a/modular_chainlink_fence -> `fence_chainlink`

  Mirror for the five above: https://github.com/EliteGamer007/6dof-drone-sim (commit
  `3b97077101bedb1326cf6483e04dc51ccf130fa3`, `assets/polyhaven/models/`; its
  `assets/CREDITS.md` reads "Poly Haven (CC0 1.0 - public domain, attribution not required)").
  Per-asset mirror folders:
  https://github.com/EliteGamer007/6dof-drone-sim/tree/3b97077101bedb1326cf6483e04dc51ccf130fa3/assets/polyhaven/models/barrel_03,
  https://github.com/EliteGamer007/6dof-drone-sim/tree/3b97077101bedb1326cf6483e04dc51ccf130fa3/assets/polyhaven/models/Barrel_01,
  https://github.com/EliteGamer007/6dof-drone-sim/tree/3b97077101bedb1326cf6483e04dc51ccf130fa3/assets/polyhaven/models/metal_jerrycan,
  https://github.com/EliteGamer007/6dof-drone-sim/tree/3b97077101bedb1326cf6483e04dc51ccf130fa3/assets/polyhaven/models/concrete_road_barrier,
  https://github.com/EliteGamer007/6dof-drone-sim/tree/3b97077101bedb1326cf6483e04dc51ccf130fa3/assets/polyhaven/models/modular_chainlink_fence
* Rock Moss Set 01 by Kless Gyzen - https://polyhaven.com/a/rock_moss_set_01 -> `rocks`
  (mirror: https://github.com/ayoub5550/inside-copy-/tree/e93e405569477bd9e5e304f1a0763116888fb66f/assets/ph/models/rock_moss_set_01,
  commit `e93e405569477bd9e5e304f1a0763116888fb66f`; its `CREDITS.md`: "Poly Haven -
  https://polyhaven.com (CC0)")
* Old Military Crate by Jack Mava - https://polyhaven.com/a/old_military_crate -> `ammo_crate`
  (mirror: https://github.com/AetherRadar/operation-steel-tide/tree/d6a33b932e00fb9016dea407eca3f909aeaf2dcb/assets/models/old_military_crate,
  commit `d6a33b932e00fb9016dea407eca3f909aeaf2dcb`; its `assets/models/LICENSE.md`: "Exact
  license: CC0 1.0 Universal, https://creativecommons.org/publicdomain/zero/1.0/")
* Authors were taken from the mirrors' credit files and a Poly Haven API dump
  (https://github.com/Akshay25798/VFX-Houdini-Asset_Browser, `downloads/json/models.json`).
* Modifications: decimated with attribute-aware meshoptimizer (jerry can 20 022 -> 895,
  barrier 60 928 -> 700 per barrier, barrels -> 1 100, rocks 5-16 k -> 700 / 180, ammo crate
  10 476 -> 1 531, chain-link frame + post ~4 150 -> 1 440 plus the 30-triangle wire); two barriers placed end to end; fence
  post moved to the panel end; chain-link wire alpha rebuilt from luminance (the mirror ships the
  diffuse as JPEG without the opacity channel), thickened by one texel and given a flat colour;
  rocks normalised to the unit physics cylinder (non-uniform scale); textures resized (diffuse /
  normal 512 px JPEG, ORM / roughness 256 px, chain-link wire 1024 px PNG).

### Rejected candidates (licence not CC0 / CC BY, or unverifiable)

RUN Voxel Packs in series-ai/jam-ready-assets (RUN-only licence until 2028), Synty POLYGON
packs, Sketchfab models under CC BY-NC / CC BY-NC-SA / "Sketchfab Standard", DuneBuggyAR (no
licence file), the glTF sample "Buggy" (no licence statement), poly.pizza mirrors without
per-model licence data, and the "HCR2 Buggy" fan model (CC BY, but a copy of a commercial game's
vehicle design).

## Not found: buggy

No CC0 / CC BY open-frame buggy (dune buggy, sand rail, UTV) was reachable: the obvious sources
(Quaternius, Kenney, Poly Pizza, Sketchfab, itch.io, OpenGameArt) are blocked from the sandbox,
and the GitHub mirrors searched (code search for `buggy` / `dune buggy` / `kart` / `atv` /
`utv` glTF files and Sketchfab `license.txt` files) only turned up NC-licensed, sci-fi or
fan-made game models. `VEHICLE_MODELS.buggy` is therefore absent and the procedural buggy stays.

## Rebuilding

```bash
node scripts/assets/world/fetch-sources.mjs          # sparse, blobless clones at the pinned commits -> $ASSETS_DL
node scripts/assets/world/build.mjs                  # vehicles, props, nature (or name categories)
node scripts/assets/world/gen-manifest.mjs           # src/client/assets/manifest-world.ts from reports/*.json
node scripts/assets/world/verify.mjs /tmp/world-qa   # three.js load checks + lineup screenshots
npx vitest run tests/assets-world.test.ts
```

`$ASSETS_DL` defaults to `/tmp/claude-0/assets-dl`. Downloads are data only - nothing from them
is executed; all processing runs in our own scripts (`world.page.js`, `vehicles.page.js`,
`props.page.js`, `nature.page.js`) inside headless Chromium (Playwright, SwiftShader WebGL),
using three.js (GLTFLoader / GLTFExporter) and meshoptimizer from `node_modules`. The build is
deterministic (fixed seeds for card thinning and sandbag jitter). `preview.mjs` renders a lineup
of arbitrary glTF files (`label=path[#node]`) for candidate review.

## Quality notes

* UAZ: a faithful Soviet 4x4 (LuAZ-969) with textured body, soft top, interior seats and spare
  wheel - the most "Erangel" of the set. Seats line up with the physics seat offsets.
* Bike: realistic KTM-style enduro; the decimation keeps spokes and the chain; tyres are
  slightly faceted at very close range.
* Props: the Poly Haven scans (barrels, jerry can, ammo crate, jersey barriers, chain-link
  fence, rocks) are photo-real; the Quaternius crates / wooden fence / containers are stylised
  but textured and sit well next to them. The containers' 512 px atlas is the softest texture
  of the set.
* Trees are stylised (hand-painted bark, alpha-card foliage) rather than photo-real: realistic
  CC0 scans (Poly Haven trees) are 100 k+ triangles and unusable for ~4 000 instanced trees.
  LOD1 at ~640 triangles is visually close to LOD0 thanks to card thinning; impostors are
  rendered from the real models.
