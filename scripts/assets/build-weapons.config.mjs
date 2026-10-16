// Weapon selection + hand-measured hold points for build-weapons.mjs (see its header).
/**
 * length: overall length (m). grip/support/sight/butt: [d, y] measured points; muzzleD: d of the
 * muzzle (its height is taken from the geometry). pistol: one-handed class.
 */
export const WEAPONS = {
  pistol: { src: 'Pistol_1', length: 0.21, pistol: true, optic: 'iron', grip: [0.04, 0.05], sight: [0.03, 0.135], support: null, butt: null },
  smg: { src: 'SubmachineGun_5', length: 0.66, optic: 'iron', grip: [0.235, 0.105], support: [0.45, 0.14], sight: [0.23, 0.215], butt: [0, 0.13] },
  ar: { src: 'AssaultRifle2_1', length: 0.9, optic: 'iron', grip: [0.27, 0.16], support: [0.57, 0.205], sight: [0.3, 0.29], butt: [0, 0.2] },
  shotgun: { src: 'Shotgun_3', length: 1.02, optic: 'iron', grip: [0.27, 0.115], support: [0.63, 0.1], sight: [0.33, 0.158], butt: [0, 0.075] },
  dmr: { src: 'SniperRifle_2', length: 1.1, optic: 'scope', grip: [0.29, 0.1], support: [0.62, 0.125], sight: [0.28, 0.205], butt: [0, 0.1] },
  sniper: { src: 'SniperRifle_3', length: 1.2, optic: 'scope', grip: [0.325, 0.07], support: [0.7, 0.095], sight: [0.34, 0.19], butt: [0, 0.08] },
};

