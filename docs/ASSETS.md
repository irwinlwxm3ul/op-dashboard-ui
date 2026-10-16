# Third-party 3D assets

Everything under `public/assets/models/{characters,animations,weapons,items}/` comes from the free
assets listed here. All of it is **CC0 1.0** except the five ammo boxes (**CC BY 4.0**, credit
required, see [Attribution](#attribution-text-for-credits)). Nothing is Mixamo-derived, NC, ND or SA, and nothing
is ripped from a game. Vehicles, props and nature are documented separately in
[ASSETS-world.md](ASSETS-world.md).

The game reads these files only through `src/client/assets` (`manifest.ts` + `loader.ts`).
`tests/assets.test.ts` checks the files against the manifest, and `scripts/assets/verify.mjs` loads every
file with three.js 0.186 in headless Chromium.

## Licence evidence

| Source | Where the licence is stated | Quote |
|---|---|---|
| Quaternius: Universal Animation Library 1 & 2 | `License.txt` in each pack folder of [tilakpatell/tilakverse-assets@8506439](https://github.com/tilakpatell/tilakverse-assets/tree/85064399bbdacc0e8cc50807179490314bc4ff1c/quaternius) | "License: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication https://creativecommons.org/publicdomain/zero/1.0/" |
| Quaternius: Ultimate Modular Men (Feb 2022) / Women (Apr 2022) | `License.txt` in each pack folder of [agentkaerf/FreeModels@db3df04](https://github.com/agentkaerf/FreeModels/tree/db3df04d1e4714298a09510b26fb6de6645138a2), and the official pack pages `packs/ultimatemodularcharacters.html` and `packs/ultimatemodularwomen.html` in [Quaternius/quaternius.github.io@c219437](https://github.com/Quaternius/quaternius.github.io/tree/c219437bd230a5e66e1b523dbd8ee2bcf0dfb90b/packs) | "Ultimate Modular Males by @Quaternius … License: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication"; pack pages: "License CC0" |
| Quaternius: Ultimate Gun Pack (July 2019) | `quaternius/ultimategun/Ultimate Gun Pack - July 2019/License.txt` in [regnaio/assets@336e580](https://github.com/regnaio/assets/tree/336e580f990c2efd62f640957967e874efab1226/quaternius/ultimategun) and `packs/ultimategun.html` (Quaternius site repo above) | "LowPoly Models by @Quaternius … License: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication"; pack page: "Ultimate Guns Pack … License CC0" |
| Quaternius: Survival Pack (Sept 2020) | `quaternius/survival/Survival Pack - Sept 2020/License.txt` in regnaio/assets@336e580 and `packs/survival.html` (Quaternius site repo) | "LowPoly Models by @Quaternius … License: CC0 1.0 Universal (CC0 1.0)"; pack page: "Survival Pack … License CC0" |
| Quaternius: Toon Shooter Game Kit (Dec 2022) | `packs/toonshootergamekit.html` (Quaternius site repo); the mirror's `README.md` links that page | "Toon Shooter Game Kit … Formats FBX OBJ Blend glTF License CC0" |
| Zsky (@Zsky_01): Low Poly Weapons Pack V.1 | `itch/zsky2000/low-poly-weapons-pack-v1/WeaponsPack_V.1/License.txt` in regnaio/assets@336e580 ([itch page](https://zsky2000.itch.io/low-poly-weapons-pack-v1)) | "Low Poly Models made by @Zsky_01 … License: Attribution 4.0 International (CC BY 4.0) That means you can do anything but you must give me Credits." |

The upstream sites (quaternius.com, itch.io, opengameart.org, poly.pizza) were not reachable from the
build container, so the files come from public GitHub mirrors, pinned to the commits above. The
mirrored files are byte-identical copies of the packs. For example, the Ultimate Gun Pack FBX blobs
in regnaio/assets and in WingNut17/ps1-style@42b446d have the same git hashes. The licences were
checked against Quaternius' own website repository.

## Characters & animations

| File(s) | Source (repo @ commit : path) | Author | Licence | Modifications |
|---|---|---|---|---|
| `characters/male_tactical.glb` | agentkaerf/FreeModels @ db3df04 : `Ultimate Modular Men- Feb 2022/Individual Characters/glTF/Swat.gltf` | Quaternius | CC0 1.0 | Pistol mesh removed; all outfit meshes merged into one skinned mesh `Body` with vertex colours (material `outfit`); added a 24-tri skinned team armband `TeamBand` (material `team`) on the left upper arm; `Root` bone turned 180° (faces -Z) and scaled so the bind pose is 1.80 m; bind pose as rest pose; source animations dropped (shared library below). 7 754 + 24 tris. |
| `characters/male_casual.glb` | same repo : `…/Ultimate Modular Men- Feb 2022/Individual Characters/glTF/Casual_2.gltf` | Quaternius | CC0 1.0 | as above. 5 776 + 24 tris |
| `characters/male_hoodie.glb` | same repo : `…/Ultimate Modular Men- Feb 2022/Individual Characters/glTF/Casual_Hoodie.gltf` | Quaternius | CC0 1.0 | as above. 6 206 + 24 tris |
| `characters/female_tactical.glb` | same repo : `Ultimate Modular Women - April 2022/Individual Characters/glTF/Soldier.gltf` | Quaternius | CC0 1.0 | as above. 7 900 + 24 tris |
| `characters/female_adventurer.glb` | same repo : `…/Ultimate Modular Women - April 2022/Individual Characters/glTF/Adventurer.gltf` | Quaternius | CC0 1.0 | as above. 6 812 + 24 tris |
| `characters/female_casual.glb` | same repo : `…/Ultimate Modular Women - April 2022/Individual Characters/glTF/Casual.gltf` | Quaternius | CC0 1.0 | as above. 6 424 + 24 tris |
| `animations/humanoid-male.glb`, `animations/humanoid-female.glb` | tilakpatell/tilakverse-assets @ 8506439 : `quaternius/universal-animation-library/Unreal-Godot/UAL1.glb`, `quaternius/universal-animation-library-2/Unreal-Godot/UAL2.glb` | Quaternius | CC0 1.0 | 53 clips **retargeted** from the UAL rig to the Ultimate Modular male / female rigs: world-space rotation deltas over a shared T-pose reference, pelvis translation scaled by hip height, and IK feet re-attached. Resampled at 30 fps with lossy key reduction (0.35°, 2 mm), skeleton only, no mesh. Plus **6 clips authored for this project** with two-bone IK: `Rifle_Hold`, `Rifle_Aim`, `Rifle_Shoot`, `Rifle_Reload`, `Rifle_Sprint`, `Parachute_Hang`. |

## Weapons (`weapons/<WeaponId>.glb`)

Source: regnaio/assets @ 336e580 : `quaternius/ultimategun/Ultimate Gun Pack - July 2019/FBX/<file>`
(Quaternius, CC0 1.0).

| File | Source model | Real length | Tris |
|---|---|---|---|
| `weapons/pistol.glb` | `Pistol_1.fbx` | 0.21 m | 1 040 |
| `weapons/smg.glb` | `SubmachineGun_5.fbx` | 0.66 m | 1 440 |
| `weapons/ar.glb` | `AssaultRifle2_1.fbx` | 0.90 m | 1 930 |
| `weapons/shotgun.glb` | `Shotgun_3.fbx` | 1.02 m | 978 |
| `weapons/dmr.glb` | `SniperRifle_2.fbx` | 1.10 m | 1 732 |
| `weapons/sniper.glb` | `SniperRifle_3.fbx` | 1.20 m | 1 722 |

Modifications (all six weapons):
* Converted from FBX to GLB.
* Recoloured with one shared palette (the same one as the procedural guns in `render/entities/weaponModels.ts`).
* Merged into one mesh with vertex colours and a single material, `weapon`.
* Rotated so the barrel points along -Z and scaled to the real length.
* Moved so the pistol-grip fist centre is at the origin.
* Grip, butt, support, muzzle and sight points measured on orthographic grids and exported as empty marker nodes (`Grip`, `Butt`, `Support`, `Muzzle`, `Sight`).

## Items (`items/<ItemId>.glb`)

| File(s) | Source (all regnaio/assets @ 336e580) | Author | Licence | Modifications |
|---|---|---|---|---|
| `items/bandage.glb` | `quaternius/survival/Survival Pack - Sept 2020/FBX/Bandages.fbx` | Quaternius | CC0 1.0 | FBX to GLB, merged to one vertex-coloured mesh, scaled to real size (0.11 m), set on the ground and centred |
| `items/firstaid.glb` | `…/Survival Pack - Sept 2020/FBX/FirstAidKit.fbx` | Quaternius | CC0 1.0 | as above (0.26 m) |
| `items/medkit.glb` | `…/Survival Pack - Sept 2020/FBX/FirstAidKit_Hard.fbx` | Quaternius | CC0 1.0 | as above (0.36 m) |
| `items/energy.glb` | `…/Survival Pack - Sept 2020/FBX/Can_Red.fbx` | Quaternius | CC0 1.0 | as above (0.125 m high) |
| `items/fuel.glb` | `…/Survival Pack - Sept 2020/FBX/GasCan.fbx` | Quaternius | CC0 1.0 | as above (0.47 m high), recoloured olive (jerry can) |
| `items/pack1.glb`, `items/pack2.glb`, `items/pack3.glb` | `…/Survival Pack - Sept 2020/FBX/Backpack.fbx` | Quaternius | CC0 1.0 | as above; three sizes (0.42 / 0.52 / 0.62 m) and colourways (sand / olive / black) |
| `items/frag.glb` | `quaternius/toonshootergamekit/Toon Shooter Game Kit - Dec 2022/Guns/glTF/Grenade.gltf` | Quaternius | CC0 1.0 | as above (0.11 m), recoloured olive |
| `items/helmet1.glb`, `items/helmet2.glb`, `items/helmet3.glb` | `…/Toon Shooter Game Kit - Dec 2022/Characters/glTF/Character_Soldier.gltf`: helmet parts (`Head_1` / `Character_Main`, plus the `Grey` goggles for levels 2 and 3) | Quaternius | CC0 1.0 | Helmet extracted in the bind pose and baked to one mesh; tan / olive / black; per-rig wear transform fitted to the head |
| `items/ammo_9mm.glb` | `itch/zsky2000/low-poly-weapons-pack-v1/WeaponsPack_V.1/FBX/PistolAmmo_Box.fbx` | Zsky (@Zsky_01) | **CC BY 4.0** | FBX to GLB, merged to one vertex-coloured mesh, scaled (0.20 m), set on the ground |
| `items/ammo_556.glb` | `…/WeaponsPack_V.1/FBX/AssaultRifleAmmo_Box.fbx` | Zsky | **CC BY 4.0** | as above (0.26 m) |
| `items/ammo_762.glb` | `…/WeaponsPack_V.1/FBX/SniperAmmo_Box.fbx` | Zsky | **CC BY 4.0** | as above (0.26 m) |
| `items/ammo_300.glb` | `…/WeaponsPack_V.1/FBX/SniperAmmo_Box.fbx` | Zsky | **CC BY 4.0** | as above (0.28 m), box recoloured olive to tell it apart from 7.62 |
| `items/ammo_12g.glb` | `…/WeaponsPack_V.1/FBX/ShotgunAmmo_Box.fbx` | Zsky | **CC BY 4.0** | as above (0.22 m) |
| `items/vest1.glb`, `items/vest2.glb`, `items/vest3.glb` | none: **authored for DROPZONE** from bevelled boxes in `scripts/assets/build-items.mjs` (soft vest / plate carrier with pouches / heavy carrier with collar and groin plate) | DROPZONE | CC0 1.0 (project) | n/a |

## Attribution text for Credits

The integrator owns README Credits. Suggested text:

> **3D models.** Characters, animations (Universal Animation Library 1 & 2), weapons (Ultimate Guns
> Pack), survival items and backpacks (Survival Pack), grenade and helmets (Toon Shooter Game Kit) by
> **Quaternius** (quaternius.com), CC0 1.0. Ammo boxes from "Low Poly Weapons Pack V.1" by **Zsky**
> (@Zsky_01, https://zsky2000.itch.io/low-poly-weapons-pack-v1), licensed under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The ammo box models were rescaled,
> re-coloured and merged into single meshes. Rifle and parachute animations and the body-armour
> models were made for DROPZONE. See docs/ASSETS.md for details.

## Pipeline (reproducible)

All scripts are in `scripts/assets/`. They need only the project's own dependencies: three.js,
Playwright's Chromium and tsx.

```sh
bash scripts/assets/fetch-sources.sh        # blobless git fetches of the pinned commits into $ASSETS_DL
node scripts/assets/build-characters.mjs    # merge outfits, retarget UAL clips, author rifle clips, export
node scripts/assets/build-weapons.mjs       # FBX -> normalised weapon-frame GLBs
node scripts/assets/build-items.mjs         # items + per-rig gear wear transforms
node scripts/assets/sync-manifest.mjs       # copy measured values into manifest.ts generated regions
node scripts/assets/verify.mjs              # load + animate everything in headless three.js, check budgets
node scripts/assets/preview.mjs [outDir]    # review screenshots (characters, poses, weapons, held, items, gear)
npx vitest run tests/assets.test.ts
```

Rebuilding from a fresh fetch reproduces every committed GLB byte for byte.

The conversion runs inside headless Chromium (SwiftShader WebGL) with three.js `GLTFLoader`,
`FBXLoader` and `GLTFExporter`:
* `harness.mjs`: local file server and browser page.
* `retarget.page.js`: retargeting.
* `characters.page.js`: outfit merge, armband, IK rifle clips and the compact animation writer.
* `weapons.page.js`: single-mesh baking and the shared palette.

The build reports with the measured sockets and fits are in `scripts/assets/reports/`.

## Budgets

These are checked by the test and by `verify.mjs`:
* The model tree stays under 30 MB. My folders currently hold 8.7 MB.
* Each character file is under 4 MB. The actual files are 0.7 to 0.95 MB.
* Triangle limits: characters at most 8 000 (+64), weapons at most 3 000, items at most 2 000.
* Textures are at most 1 024 px. These assets have no textures: they are vertex-coloured.

Draw calls:
* Characters: 2 (body + team armband).
* Weapons and items: 1 each, so they can be instanced.

## Not found / limitations

* **Rifle animations:** no CC0 rifle-handling clips exist for these rigs. UAL has only pistol clips,
  and Mixamo is excluded. The six rifle and parachute overlays were therefore authored with IK.
  * They are poses with simple keyframes (hold, aim, recoil kick, a 2.1 s magazine reload, port-arms sprint), not motion capture.
  * The support hand holds the magazine well, not the far end of the handguard, because the Quaternius arms are short.
  * Per-weapon `support` points are in the manifest if a renderer wants to IK the left hand further.
* **Body armour:** no CC0 plate carrier fit a realistic torso. The Toon Shooter vest is chibi-shaped and looked wrong when rescaled, so the vests were authored.
* **Helmets:** these are the toon soldier helmet rescaled to the head. They read well at gameplay distances, but sit on top of the hair.
* **Character style:** the characters are stylised low-poly (Quaternius house style), not photoreal. A realistic CC0 rigged soldier with clothes and a compatible animation set was not available from any reachable source.
* **Poly Haven:** its CC0 photoreal props (jerry can, ammo box) were unreachable from the container and would also clash in style.
