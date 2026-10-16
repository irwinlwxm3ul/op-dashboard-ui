# Module spec: render-world

Owned paths: `src/client/render/core/**`, `src/client/render/world/**`.
Exports: `src/client/render/core/index.ts` → `createRenderCore: CreateRenderCore`;
`src/client/render/world/index.ts` → `createWorldRenderer: CreateWorldRenderer` (signatures in `src/client/render/contracts.ts`).
The World data comes from `src/shared/world` (`generateWorld`, being built concurrently — code against the `World`
interface in `src/shared/types.ts`; read `docs/specs/world.md` to know what the generator produces).

Look & feel target: a believable, sunny Eastern-European island in the spirit of PUBG Erangel, stylised low-poly
but not cartoony; readable at distance; consistent lighting. 60 FPS on integrated GPUs at "medium" (PLAN.md budget).

## RenderCore (render/core)
- `THREE.WebGLRenderer` (antialias on high/ultra, `powerPreference: 'high-performance'`), sRGB output,
  ACES filmic tone mapping, soft PCF shadows. Canvas appended into the given container, resizes with it
  (ResizeObserver), devicePixelRatio × `renderScale` (capped at 2).
- Scene with sky: three's `Sky` shader (`three/examples/jsm/objects/Sky.js`) or an equivalent gradient sky dome,
  late-morning sun; `sunDir`; hemisphere light + directional sun light whose shadow camera follows the active camera
  (one 2048² map covering ~140 m on high, 1024² ~100 m on medium, off on low). Fog (`FogExp2` or custom) tuned so terrain
  fades into haze around 700–900 m; fog colour matched to the horizon.
- Quality presets (low/medium/high/ultra) change: shadow map size/distance, pixel ratio, vegetation density & LOD
  distances, grass on/off, terrain LOD distances, antialias (FXAA pass optional), max anisotropy.
- `stats()` from `renderer.info` (draw calls, triangles per frame — call `renderer.info.reset()` per frame with
  `autoReset=false`) plus an fps/frame-ms moving average.
- Camera: `PerspectiveCamera` near 0.05, far 2500.

## WorldRenderer (render/world)
- **Terrain**: heightmap from `world.heights` (res × res over [-half, half]), split into 8×8 chunks with 3 LODs each
  (full, half, quarter resolution) selected by distance with hysteresis, skirts to hide cracks, frustum culled.
  Vertex colours / splat from `world.surface` (grass with noise variation, dirt, rock on slopes, sand, road
  colour for roads, snow if present) with a custom `MeshStandardMaterial` `onBeforeCompile` adding subtle
  procedural detail noise (triplanar-ish or world-space noise) so close terrain is not flat-coloured. Normals smooth.
- **Water**: large plane at `world.waterLevel` extending beyond the map to the horizon; animated normal-perturbed
  shader (fresnel, sun specular, depth-ish tint near shore using the heightmap as a texture), cheap.
- **Roads**: already in the surface colouring; optionally a slightly raised decal strip mesh along `world.roads`
  with center line markings (polygon offset to avoid z-fighting).
- **Buildings & props**: build geometry from `world.boxes` (each WorldBox is an AABB with colour + material + kind).
  Merge per building (`world.buildings[*].boxIds`) into one mesh with vertex colours (MeshStandardMaterial,
  roughness by material) + a cheap exterior LOD (shell box per building with wall/roof colours) beyond ~220 m.
  Free-standing props (building === -1) merged per spatial chunk (128 m). Window gaps already exist as geometry gaps;
  add dark "glass-less" frames/trim where cheap. Roof boxes slightly different tone. Shipping containers ribbed look via
  colour stripes is fine. Shadows cast/receive on near buildings only.
- **Vegetation**: trees (`world.trees`, kinds pine/oak/birch/dead), rocks (`world.rocks`), bushes (`world.bushes`) via
  `InstancedMesh` per kind per LOD band: near (< 150 m) low-poly full model (trunk + layered cone/blob canopy, ~150–400 tris),
  mid (150–450 m) simplified (~40 tris), far (450–900 m) crossed-quad impostor (canvas-generated texture with alpha test).
  Recompute band membership per terrain chunk a few times per second (not every frame) with hysteresis; subtle wind sway
  in the vertex shader for canopies/bushes. Rocks: deformed icosahedron per seed variation (a handful of variants instanced,
  scaled per instance). Grass: instanced tufts only within ~45 m of the camera (high/ultra), wind-animated, recycled
  around the camera (ring buffer of patches), none on roads/sand/water.
- **Zone**: the blue zone wall — a tall open cylinder at `frame.zone` (cx, cz, r) from below terrain to ~400 m, rendered
  with an additive/translucent animated shader (vertical scan lines + noise, brighter where it intersects terrain, fades
  with height), double-sided so it is visible from inside. The next ("white") circle as a thin bright ring projected at
  ground (only while `stage === 'waiting'` or `'shrinking'`). Smoothly follows the interpolated zone values.
- **Training map** (`world.kind === 'training'`): render range lane markers and distance signs as geometry/canvas textures
  — distance numbers are numerals only (no words) so no i18n needed; target boxes (`kind: 'target'`) get a target face
  texture (rings) via canvas texture.
- Distant terrain/buildings never pop: LOD transitions with hysteresis; draw distance ≥ 1000 m for terrain/buildings.
- Draw calls budget ≤ 150 for the world on medium. Avoid per-frame allocations.
- No tests required (browser module); keep logic that can be pure (LOD selection, chunk building) in separate functions.
  Type-check must be clean.
