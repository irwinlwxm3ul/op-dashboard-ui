# Module spec: ui

Owned paths: `src/client/ui/**` (except `contracts.ts`), `src/client/styles/**`. The English strings you need live in
`src/client/ui/strings.en.ts` (`export const uiStrings = { 'ui.xxx': '...' } as const;` — keys MUST start with `ui.`),
merged into the English dictionary by the i18n module. Prefer existing core keys from `src/client/i18n/locales/en.core.ts`
(written concurrently by the i18n agent — check it near the end and reuse keys instead of duplicating). Every visible
string goes through `t()` (`src/client/i18n`), including `title`/`placeholder`/`aria-label` attributes (or `data-i18n*`
attributes + `translateDom`). Re-render text on `onLanguageChange`. `npx tsx scripts/check-i18n.ts --scan-only` (when it
exists) must report nothing for your files.

Export `createUI: CreateUI` from `src/client/ui/index.ts` implementing `UiApi` (`src/client/ui/contracts.ts`). Plain
DOM + CSS (no framework), modular files per screen/widget. Styles in `src/client/styles/*.css` imported from TS (Vite).

## Visual design
Clean tactical/military look: dark translucent panels with blur, off-white text, accent amber/yellow (#f2a900-ish) for
primary actions, team cyan for friendly info, red for damage/danger. Headings may use the Lilita One font at
`/assets/fonts/lilita_one_regular.ttf` (@font-face) for the DROPZONE logo only; body text uses `system-ui` with a
fallback stack covering CJK and Arabic (e.g. "Noto Sans", "Noto Sans CJK SC", "Noto Sans Arabic", "Segoe UI", sans-serif).
**RTL**: use CSS logical properties (margin-inline, inset-inline-start, text-align: start) everywhere so Arabic mirrors
correctly; HUD elements that are spatial (compass, minimap) don't mirror their content. Responsive down to 1024×600.
Keyboard accessible menus (focus styles, Enter/Esc). UI clicks/hover call `audio.ui('click'|'hover')` from
`src/client/audio`.

## Screens (UiApi.show)
- **main**: animated title DROPZONE, buttons: Single Player, Training Ground, Multiplayer, Settings, Controls;
  language switcher (dropdown of `LANGUAGES` native names, calls `setLanguage`), player name field (stored via
  `settings` from `src/client/game` — `settings.get().playerName` / `settings.set`).
- **singleplayer** setup: player count slider (2–64), team size (solo/duo/squad), bot difficulty, zone speed; start →
  `actions.startSinglePlayer`. Training button on main calls `actions.startTraining()` directly.
- **multiplayer** (lobby browser): requires a name; connect (`actions.connectMultiplayer(name)` → errors shown with
  `showError`), list of lobbies (name, host, players/max, team size, status) with Join, Refresh, Create lobby form
  (name, max players, team size, bot fill, bot difficulty, zone speed) → `actions.createLobby`.
- **lobby** room: lobby name, settings summary (host can edit → `updateLobbySettings`), team grid with
  `teamCount` teams × `teamSize` slots showing members (host crown, ready check, ping), click a team to join it
  (`setTeam`), Ready toggle, Start (host only, enabled when everyone else is ready), Leave, chat panel.
- **loading**: progress bar + translated step label (`setLoading(progress, stepKey)` — stepKey is an i18n key).
- **game**: the HUD (below). **results**: placement (big "#n / total"), winner celebration when 1st, personal stats
  (kills, knocks, damage, headshots, revives, longest kill, survival time, accuracy), team breakdown table, buttons:
  Back to lobby (mp) / Play again + Main menu (sp/training).
- **Settings** modal (from main menu and pause menu): graphics quality, render scale, FOV, mouse/ADS/scope sensitivity,
  invert Y, volumes (also call `audio.setSettings`), show FPS, damage numbers, toggle crouch/ADS, default camera
  mode, language. **Controls** modal: list of all `KeyAction`s with current binding, click-to-rebind (captures next
  key), reset defaults; mouse buttons shown as fixed rows.
- **Pause menu** (`setPaused(true)`; Esc): Resume, Settings, Controls, Leave match.

## In-game HUD (`attachGame`, `updateHud` every frame — update DOM only when values change; cache last values)
- Bottom center: health bar (white → red when low, damage "ghost" trail animation), boost bar segments above it,
  downed bleed-out bar when downed. Armor icons (helmet/vest level + durability ring), backpack level.
- Bottom right: weapon slots (1–3 + frag count) with active highlight, ammo `mag / reserve` big, fire mode, reload
  progress, low-ammo tint; item quick-use counts (bandage/firstaid/medkit/energy) with keys.
- Top center: compass strip (heading degrees and N/E/S/W letters — use i18n keys for cardinal letters), with markers
  for teammates and map waypoint.
- Top right: alive count, kills, teams alive (solo hides), zone timer/state text ("restricting play area in m:ss",
  "play area shrinking") + progress bar, ping when > 0.
- Left: teammates list (name, health bar, downed/dead state, distance), kill feed (top-left or top-right, max 5 entries,
  fade after 6 s, weapon name via `itemName`, headshot icon, knocked vs killed text from feed.* keys; highlight your own
  kills/knocks).
- Minimap (bottom-left canvas): pre-render a map texture once from `world.heights`/`world.surface`/roads/buildings/water
  (offscreen canvas; shading by slope), north-up 250 m view centered on the player, zone circle (blue) + next circle
  (white), teammates, self arrow, plane path line + plane icon during plane phase, waypoint. Full map (M toggle via
  input events `toggleMap`): zoomable/pannable, town labels (proper nouns from world.towns), grid lettering,
  right-click places a waypoint (shared to HUD compass/minimap; local only).
- Center: dynamic crosshair whose gap reflects `self.spread` (projected to pixels using the camera FOV), hidden while
  ADS with scopes; scope overlay (black vignette circle + reticle for x4/x8, red dot for reddot) when `cam.scope` is set;
  hit feedback is NOT here (feel module owns hitmarkers in `feelLayer`).
- Interaction prompt (center-bottom): from `frame.interaction` with the key from settings keybinds (e.g. "[F] Pick up
  AR-5 Rifle", "Hold [F] Revive Alex" with hold progress), progress bars for healing / reviving / being revived.
- Phase specific: plane ("press F to jump", time until auto-eject), freefall/parachute altitude + speed meter,
  vehicle HUD (speed km/h, fuel bar, vehicle health, seat indicator), spectating banner (`spectating {name}`, keys to switch),
  training ground panel (infinite ammo indicator, keys: respawn; a "give item" palette: grid of all items by category that
  queues `{a:'give', item}` via `game.queueAction` when clicked while the inventory is open).
- Inventory (Tab via `toggleInventory`): left = nearby ground loot (within 3 m, click → pickup action), center = backpack
  items with counts and capacity bar (click consumable → use; right-click → drop action with count prompt-free
  default all), right = equipment (vest/helmet/pack, weapons with mags; drop buttons). While open: `input.enabled = false`,
  pointer unlocked; closing re-locks.
- F3 stats overlay (`toggleStats`) using `setRenderStats` data: fps, frame ms, draw calls, triangles, entities, ping.
- Scoreboard (Tab is inventory; use `toggleScoreboard` event): players alive per team, your team stats.
- `isOverlayOpen()` true when pause, inventory, map, settings or controls are open; the app uses it to manage pointer lock.

## Layers
`createUI` builds the root structure: `canvasHost` (bottom, the app mounts the WebGL canvas here), `nameplateLayer`
(entity renderer draws DOM nameplates here; pointer-events none), `feelLayer` (game feel overlays; pointer-events none),
then HUD, then menus/modals on top.

No unit tests required, but keep formatting helpers pure. Type-check clean.
