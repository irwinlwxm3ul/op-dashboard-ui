// Item selection for build-items.mjs (see its header for the sources).
const C = { olive: 0x4f5a3a, oliveDark: 0x3c4530, tan: 0x9a8762, black: 0x232527, grey: 0x55595e, khaki: 0x7d7a52, navy: 0x2b3442, sand: 0xa89670 };

/**
 * size: target extent (m) of the item's largest dimension (or its height with fit: 'height').
 * parts: optional filter on "<node>/<material>" for multi-part sources. recolor: material
 * name -> hex (applied before baking). rotate: Euler (deg) applied to the source first.
 */
export const ITEMS = {
  bandage: { src: 'surv_Bandages.fbx', size: 0.11 },
  firstaid: { src: 'surv_FirstAidKit.fbx', size: 0.26 },
  medkit: { src: 'surv_FirstAidKit_Hard.fbx', size: 0.36 },
  energy: { src: 'surv_Can_Red.fbx', size: 0.125, fit: 'height' },
  fuel: { src: 'surv_GasCan.fbx', size: 0.47, fit: 'height', recolor: { Red: 0x4f5a3a, DarkRed: 0x3c4530 } },
  frag: { src: 'toon_Grenade.gltf', size: 0.11, fit: 'height', recolor: { Green: 0x4f5a3a } },
  ammo_9mm: { src: 'zsky_PistolAmmo_Box.fbx', size: 0.2 },
  ammo_556: { src: 'zsky_AssaultRifleAmmo_Box.fbx', size: 0.26 },
  ammo_762: { src: 'zsky_SniperAmmo_Box.fbx', size: 0.26 },
  ammo_12g: { src: 'zsky_ShotgunAmmo_Box.fbx', size: 0.22 },
  ammo_300: { src: 'zsky_SniperAmmo_Box.fbx', size: 0.28, recolor: { BlueSniper_AmmoBox: 0x4f5a3a, BlueScreenSniper_AmmoBox: 0x6b7650 } },
  helmet1: { src: 'toon_Character_Soldier.gltf', parts: '^Head_1/Character_Main$', size: 0.27, gear: 'helmet', recolor: { Character_Main: C.tan } },
  helmet2: { src: 'toon_Character_Soldier.gltf', parts: '^Head_1/(Character_Main|Grey)$', size: 0.28, gear: 'helmet', recolor: { Character_Main: C.olive, Grey: C.black } },
  helmet3: { src: 'toon_Character_Soldier.gltf', parts: '^Head_1/(Character_Main|Grey)$', size: 0.29, gear: 'helmet', recolor: { Character_Main: C.black, Grey: C.grey } },
  // No CC0 plate carrier fitting a realistic torso was found: vests are authored here from
  // primitives (procedural: level 1 soft police vest, 2 plate carrier with pouches, 3 heavy
  // carrier with collar and groin plate), CC0 as part of this project.
  vest1: { procedural: 'vest', level: 1, size: 0.42, fit: 'height', gear: 'vest', colors: [C.navy, C.black] },
  vest2: { procedural: 'vest', level: 2, size: 0.44, fit: 'height', gear: 'vest', colors: [C.olive, C.oliveDark] },
  vest3: { procedural: 'vest', level: 3, size: 0.48, fit: 'height', gear: 'vest', colors: [C.black, C.grey] },
  pack1: { src: 'surv_Backpack.fbx', size: 0.42, fit: 'height', gear: 'pack', recolor: { Brown: C.sand, LightGreen: C.khaki, Gold: C.grey, Green: C.oliveDark } },
  pack2: { src: 'surv_Backpack.fbx', size: 0.52, fit: 'height', gear: 'pack', recolor: { Brown: C.olive, LightGreen: C.oliveDark, Gold: C.grey, Green: C.black } },
  pack3: { src: 'surv_Backpack.fbx', size: 0.62, fit: 'height', gear: 'pack', recolor: { Brown: C.black, LightGreen: C.grey, Gold: C.olive, Green: C.oliveDark } },
};


/** Manifest category + human-readable source label per item. */
export const ITEM_SOURCES = {
  bandage: { category: 'consumable', label: 'Survival Pack: Bandages' },
  firstaid: { category: 'consumable', label: 'Survival Pack: FirstAidKit' },
  medkit: { category: 'consumable', label: 'Survival Pack: FirstAidKit_Hard' },
  energy: { category: 'consumable', label: 'Survival Pack: Can_Red' },
  fuel: { category: 'consumable', label: 'Survival Pack: GasCan (recoloured olive)' },
  frag: { category: 'throwable', label: 'Toon Shooter Game Kit: Grenade (recoloured olive)' },
  ammo_9mm: { category: 'ammo', label: 'Zsky Weapons Pack V.1: PistolAmmo_Box' },
  ammo_556: { category: 'ammo', label: 'Zsky Weapons Pack V.1: AssaultRifleAmmo_Box' },
  ammo_762: { category: 'ammo', label: 'Zsky Weapons Pack V.1: SniperAmmo_Box' },
  ammo_12g: { category: 'ammo', label: 'Zsky Weapons Pack V.1: ShotgunAmmo_Box' },
  ammo_300: { category: 'ammo', label: 'Zsky Weapons Pack V.1: SniperAmmo_Box (recoloured olive)' },
  helmet1: { category: 'gear', label: 'Toon Shooter Game Kit: Character_Soldier helmet (tan)' },
  helmet2: { category: 'gear', label: 'Toon Shooter Game Kit: Character_Soldier helmet + goggles (olive)' },
  helmet3: { category: 'gear', label: 'Toon Shooter Game Kit: Character_Soldier helmet + goggles (black)' },
  vest1: { category: 'gear', label: 'authored: soft vest (procedural)' },
  vest2: { category: 'gear', label: 'authored: plate carrier (procedural)' },
  vest3: { category: 'gear', label: 'authored: heavy carrier (procedural)' },
  pack1: { category: 'gear', label: 'Survival Pack: Backpack (sand)' },
  pack2: { category: 'gear', label: 'Survival Pack: Backpack (olive)' },
  pack3: { category: 'gear', label: 'Survival Pack: Backpack (black)' },
};

