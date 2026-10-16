// Original gamer tags for bots. Built from generic adjective / noun / number combinations so no
// tag refers to a real person, brand or trademark. Proper nouns are allowed in shared code (they are
// never translated), and every result fits MAX_NAME_LEN.

import { MAX_NAME_LEN } from '../constants';
import type { Rng } from '../rng';

const ADJECTIVES: readonly string[] = [
  'Silent', 'Rusty', 'Crimson', 'Lucky', 'Frosty', 'Hollow', 'Swift', 'Grim', 'Brave', 'Shady',
  'Neon', 'Salty', 'Mellow', 'Rapid', 'Feral', 'Lazy', 'Sneaky', 'Iron', 'Velvet', 'Cosmic',
  'Dusty', 'Stormy', 'Wild', 'Quiet', 'Bold', 'Toxic', 'Atomic', 'Polar', 'Sunny', 'Gloomy',
  'Fuzzy', 'Spicy', 'Clever', 'Mighty', 'Tiny', 'Jolly', 'Rogue', 'Lone', 'Hasty', 'Bitter',
  'Gentle', 'Savage', 'Sleepy', 'Noble', 'Wicked', 'Proud', 'Ashen', 'Amber', 'Cobalt', 'Scarlet',
  'Golden', 'Misty', 'Brisk', 'Grumpy', 'Witty', 'Chunky', 'Nimble', 'Fierce', 'Zesty', 'Murky',
];

const NOUNS: readonly string[] = [
  'Otter', 'Falcon', 'Badger', 'Viper', 'Moose', 'Raven', 'Lynx', 'Panda', 'Walrus', 'Gecko',
  'Hornet', 'Bison', 'Coyote', 'Heron', 'Mantis', 'Puffin', 'Yeti', 'Goblin', 'Wizard', 'Pirate',
  'Nomad', 'Ranger', 'Pickle', 'Waffle', 'Taco', 'Noodle', 'Muffin', 'Comet', 'Rocket', 'Anvil',
  'Cactus', 'Pebble', 'Thistle', 'Lantern', 'Ghost', 'Sparrow', 'Jackal', 'Marmot', 'Squid', 'Kraken',
  'Phantom', 'Drifter', 'Bandit', 'Outlaw', 'Hermit', 'Beetle', 'Turtle', 'Narwhal', 'Wombat', 'Koala',
  'Ferret', 'Weasel', 'Mongoose', 'Pelican', 'Tortoise', 'Gopher', 'Hyena', 'Magpie', 'Llama', 'Toad',
];

const SUFFIXES: readonly string[] = ['TV', 'GG', 'Pro', 'Jr', 'XL', 'HD', 'OG', 'Max'];

/**
 * Deterministic original gamer tag drawn from `rng`, e.g. "SilentOtter42", "salty_pickle",
 * "xXRavenXx", "Walrus_404" or "GrumpyGeckoGG". Always 1..MAX_NAME_LEN characters.
 */
export function botName(rng: Rng): string {
  const adj = rng.pick(ADJECTIVES);
  const noun = rng.pick(NOUNS);
  let name: string;
  const style = rng.int(0, 9);
  switch (style) {
    case 0:
    case 1:
      name = adj + noun;
      break;
    case 2:
    case 3:
      name = adj + noun + rng.int(1, 99);
      break;
    case 4:
      name = noun + '_' + rng.int(100, 999);
      break;
    case 5:
      name = 'xX' + noun + 'Xx';
      break;
    case 6:
      name = adj.toLowerCase() + '_' + noun.toLowerCase();
      break;
    case 7:
      name = adj + noun + rng.pick(SUFFIXES);
      break;
    case 8:
      name = noun + rng.pick(NOUNS);
      break;
    default:
      name = adj.charAt(0) + '.' + noun + rng.int(1, 9);
      break;
  }
  if (name.length > MAX_NAME_LEN) name = noun + rng.int(10, 99);
  return name;
}
