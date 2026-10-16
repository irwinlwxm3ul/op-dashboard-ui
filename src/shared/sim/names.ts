// Original gamer tags for bots (the bots module has its own generator; the sim does not depend
// on it). Deterministic from a seeded Rng; names are kept unique within a match.

import { MAX_NAME_LEN } from '../constants';
import type { Rng } from '../rng';

const PREFIXES = [
  'Quiet', 'Rusty', 'Lucky', 'Feral', 'Hollow', 'Brisk', 'Grim', 'Sly', 'Crimson', 'Frosty', 'Dusty',
  'Wired', 'Lone', 'Swift', 'Rogue', 'Silent', 'Bold', 'Salty', 'Neon', 'Static', 'Velvet', 'Murky',
  'Gritty', 'Sunny', 'Stormy', 'Turbo', 'Lazy', 'Mighty', 'Shady', 'Tiny',
];
const NOUNS = [
  'Falcon', 'Badger', 'Otter', 'Comet', 'Pike', 'Raven', 'Moose', 'Gecko', 'Viper', 'Puma', 'Kettle',
  'Anvil', 'Ranger', 'Nomad', 'Pilot', 'Sprout', 'Lynx', 'Bison', 'Walrus', 'Heron', 'Mantis',
  'Cobra', 'Marmot', 'Yeti', 'Pebble', 'Rocket', 'Wombat', 'Tundra', 'Ember', 'Gopher',
];

/** Generate a gamer tag not present in `taken` (falls back to numbered variants). */
export function generateBotName(rng: Rng, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 24; attempt++) {
    const base = rng.pick(PREFIXES) + rng.pick(NOUNS);
    const name = rng.chance(0.45) ? `${base}${rng.int(1, 99)}` : base;
    if (name.length <= MAX_NAME_LEN && !taken.has(name)) return name;
  }
  for (let i = 100; ; i++) {
    const name = `${rng.pick(NOUNS)}${i}`.slice(0, MAX_NAME_LEN);
    if (!taken.has(name)) return name;
  }
}
