// English strings owned by the game-feel module (src/client/feel). Merged into the English dictionary
// by src/client/i18n/locales/en.ts. Keys must be namespaced "feel.*". Translated in the final i18n pass.
// The feel module reuses core keys (banner.*, hud.zone.*, hud.teammate*, training.part.*) wherever
// they exist; only strings without a core equivalent live here.
export const feelStrings = {
  // Kill confirmation extras
  'feel.kill.finished': 'You finished off {name}',
  'feel.kill.distance': '{distance} m',

  // Local death without an attacker, and damage-source names shown under "killed / knocked by"
  'feel.death.vehicle': 'You died in a vehicle crash',
  'feel.source.zone': 'Blue zone',
  'feel.source.vehicle': 'Vehicle',
  'feel.source.explosion': 'Explosion',
  'feel.source.fall': 'Fall damage',
  'feel.source.bleed': 'Bleeding',
  'feel.source.drown': 'Drowning',
  'feel.unknownPlayer': 'Unknown',

  // Training ground hit readout next to the crosshair
  'feel.target.damage': '{damage} dmg',
  'feel.target.distance': '{distance} m',
} as const;
