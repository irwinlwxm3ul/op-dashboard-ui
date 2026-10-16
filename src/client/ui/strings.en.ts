// English UI strings owned by the UI module (src/client/ui). Merged into the English dictionary
// by src/client/i18n/locales/en.ts. Keys must be namespaced "ui.*". Translated in the final i18n pass.
// Core keys (menu.*, hud.*, prompt.*, inv.*, ...) are reused wherever they fit; these cover the rest.
export const uiStrings = {
  // Main menu
  'ui.main.fontCredit': 'Title font: Lilita One (SIL Open Font License).',

  // Lobby browser
  'ui.mp.connectHint': 'Enter your name and connect to browse online lobbies.',
  'ui.mp.connectedAs': 'Connected as {name}',
  'ui.mp.disconnect': 'Disconnect',
  'ui.mp.notConnected': 'Connect to see the open lobbies.',
  'ui.mp.defaultLobbyName': "{name}'s lobby",

  // Lobby room
  'ui.lobby.edit': 'Edit',
  'ui.lobby.teams': 'Teams',
  'ui.lobby.readyHint': 'Ready up when you are set to drop.',

  // Loading screen
  'ui.loading.tip': 'Tip',
  'ui.tip.1': 'Marksman and sniper rounds travel and drop: aim above distant targets and lead moving ones.',
  'ui.tip.2': 'The white circle on the map shows where the play area shrinks to next.',
  'ui.tip.3': 'Bandages and first aid kits heal up to 75 health. Medical kits heal you to full.',
  'ui.tip.4': 'Energy drinks fill your boost bar, which heals you over time and makes you run faster.',
  'ui.tip.5': 'In duo and squad matches, hold the interact key next to a knocked teammate to revive them.',
  'ui.tip.6': 'Crouching and going prone reduce recoil and spread.',
  'ui.tip.7': 'Vehicles are fast but loud. Watch the fuel gauge and carry a jerry can.',
  'ui.tip.8': 'Right-click the full map to place a waypoint; your compass and minimap point to it.',
  'ui.tip.9': 'Higher level vests and helmets absorb more damage before they break.',
  'ui.tip.10': 'Visit the Training Ground to learn bullet drop before your next drop.',

  // Results
  'ui.results.yourStats': 'Your stats',
  'ui.results.ofTotal': '/ {n}',
  'ui.results.winners': 'Winners: {names}',
  'ui.results.spectator': 'You watched this match as a spectator.',

  // Settings / controls
  'ui.unit.degrees': '{n}°',
  'ui.controls.groupMouse': 'Mouse',
  'ui.controls.capturing': 'Press the new key for “{action}”. Esc cancels.',
  'ui.controls.rebindAria': '{action}: {key}. Activate to change.',
  'ui.controls.reserved': '{key} is reserved by the browser. Choose another key.',
  'ui.controls.swapped': '“{action}” moved to {key} to avoid a conflict.',
  'ui.controls.resetDone': 'Key bindings were reset to the defaults.',

  // Key caps
  'ui.key.delete': 'Delete',
  'ui.key.insert': 'Insert',
  'ui.key.home': 'Home',
  'ui.key.end': 'End',
  'ui.key.pageUp': 'Page Up',
  'ui.key.pageDown': 'Page Down',
  'ui.key.menu': 'Menu',

  // HUD
  'ui.hud.teamsLabel': 'Teams',
  'ui.hud.eliminatedHint': 'Press {key} to open the menu and leave the match.',
  'ui.hud.respawnKey': 'Respawn',
  'ui.hud.palette': 'Item spawner',
  'ui.hud.swap': 'Swap',
  'ui.hud.magazine': '{mag}/{size}',
  'ui.feed.died': '{victim} died',
} as const;
