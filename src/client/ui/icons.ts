// Static inline SVG icons (no text content). All use currentColor so CSS controls the tint.

import type { ConsumableId, GearId, ItemCategory, ItemId, ThrowableId, VehicleType, WeaponId } from '../../shared/types';

const svg = (vb: string, body: string): string =>
  `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" fill="currentColor" focusable="false">${body}</svg>`;

const DARK = 'fill="#000" fill-opacity=".38"';

export const ICONS = {
  helmet: svg('0 0 24 24', `<path d="M3 15.5C3 10.3 7 6 12 6s9 4.3 9 9.5V16H3z"/><path d="M2 17h20v2.2H2z"/><path ${DARK} d="M12 7.2v8.3h-1.2V7.4z"/>`),
  vest: svg('0 0 24 24', `<path d="M7 2.5h3.2L12 4.6l1.8-2.1H17l3 4.2V20a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 20V6.7z"/><path ${DARK} d="M6.5 11h4v4h-4zM13.5 11h4v4h-4z"/>`),
  pack: svg('0 0 24 24', `<path d="M9 2h6v3h.8A4.2 4.2 0 0 1 20 9.2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9.2A4.2 4.2 0 0 1 8.2 5H9zm2 1.6V5h2V3.6z"/><path ${DARK} d="M8 13h8v5.5H8z"/>`),
  bandage: svg('0 0 24 24', `<g transform="rotate(-35 12 12)"><rect x="2.5" y="8" width="19" height="8" rx="4"/><path ${DARK} d="M9 8h1.6v8H9zm4.4 0H15v8h-1.6z"/></g>`),
  firstaid: svg('0 0 24 24', `<rect x="3" y="5" width="18" height="15" rx="2.2"/><path ${DARK} d="M10.2 8h3.6v3.2H17v3.6h-3.2V18h-3.6v-3.2H7v-3.6h3.2z"/>`),
  medkit: svg('0 0 24 24', `<path d="M8.5 3h7v3H20a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 4 6h4.5zm2 1.6V6h3V4.6z"/><path ${DARK} d="M10.6 8.6h2.8v2.6H16v2.8h-2.6v2.6h-2.8V14H8v-2.8h2.6z"/>`),
  energy: svg('0 0 24 24', `<rect x="6.5" y="2.5" width="11" height="19" rx="2.4"/><path ${DARK} d="M13.2 5.5 8.8 12.6h3l-1.2 5.9 4.6-7.4h-3z"/>`),
  fuel: svg('0 0 24 24', `<path d="M6 4h5l2 2h4.5A1.5 1.5 0 0 1 19 7.5V20.5A1.5 1.5 0 0 1 17.5 22h-11A1.5 1.5 0 0 1 5 20.5V5a1 1 0 0 1 1-1z"/><path ${DARK} d="M8 10l8 8m0-8-8 8" stroke="#000" stroke-opacity=".38" stroke-width="1.6"/>`),
  frag: svg('0 0 24 24', `<circle cx="11" cy="14.5" r="7"/><path d="M9 5.5h5V8H9z"/><path d="M14 5.2 18.5 3l.7 1.4-4.2 2.4z"/><path ${DARK} d="M7 12h8v1.4H7zm0 3h8v1.4H7z"/>`),
  ammo: svg('0 0 24 24', `<path d="M5 9.5 6.5 5 8 9.5V20H5zM10.5 9.5 12 5l1.5 4.5V20h-3zM16 9.5 17.5 5 19 9.5V20h-3z"/><path ${DARK} d="M5 17h3v1.2H5zm5.5 0h3v1.2h-3zm5.5 0h3v1.2h-3z"/>`),
  skull: svg('0 0 24 24', `<path d="M12 2.5c-4.7 0-8 3.2-8 7.6 0 2.5 1.1 4.3 2.6 5.4V19a1.5 1.5 0 0 0 1.5 1.5h7.8A1.5 1.5 0 0 0 17.4 19v-3.5c1.5-1.1 2.6-2.9 2.6-5.4 0-4.4-3.3-7.6-8-7.6z"/><circle ${DARK} cx="8.8" cy="11" r="2.1"/><circle ${DARK} cx="15.2" cy="11" r="2.1"/><path ${DARK} d="M11 14.5h2l-1 2z"/>`),
  headshot: svg('0 0 24 24', `<circle cx="12" cy="9" r="5.5"/><path d="M4 21c.6-4.2 3.8-6.5 8-6.5s7.4 2.3 8 6.5z"/><circle cx="12" cy="9" r="2.2" fill="#ff3b30"/><path d="M12 1.5v3M12 13.5v3M4.5 9h3M16.5 9h3" stroke="#ff3b30" stroke-width="1.6"/>`),
  knock: svg('0 0 24 24', `<circle cx="7" cy="7" r="3.2"/><path d="M3 20.5 7.5 12l5 2.5 6.5-1V16l-6.2.9L9 15.3 6 20.5z"/>`),
  crown: svg('0 0 24 24', `<path d="M3 8l4.5 3.5L12 4.5l4.5 7L21 8l-1.8 10.5H4.8z"/><path d="M4.8 19.6h14.4V21H4.8z"/>`),
  check: svg('0 0 24 24', `<path d="M9.2 16.6 4.6 12l-1.8 1.8 6.4 6.4L21.2 8.2l-1.8-1.8z"/>`),
  close: svg('0 0 24 24', `<path d="M6.4 4.6 12 10.2l5.6-5.6 1.8 1.8-5.6 5.6 5.6 5.6-1.8 1.8-5.6-5.6-5.6 5.6-1.8-1.8 5.6-5.6-5.6-5.6z"/>`),
  gear: svg('0 0 24 24', `<path d="M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>`),
  keyboard: svg('0 0 24 24', `<path d="M2.5 6h19A1.5 1.5 0 0 1 23 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-19A1.5 1.5 0 0 1 1 16.5v-9A1.5 1.5 0 0 1 2.5 6z"/><path ${DARK} d="M4 9h2v2H4zm3.5 0h2v2h-2zm3.5 0h2v2h-2zm3.5 0h2v2h-2zM18 9h2v2h-2zM4 12.5h2v2H4zm14 0h2v2h-2zM7.5 12.5h9v2h-9z"/>`),
  play: svg('0 0 24 24', `<path d="M7 4.5v15l12-7.5z"/>`),
  target: svg('0 0 24 24', `<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6zm0 3a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6zm0 2.6a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z"/>`),
  globe: svg('0 0 24 24', `<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1.4 2.2A8 8 0 0 0 4.1 11h3.4c.2-2.6.9-5 2-6.8zm2.8 0c1.2 1.8 1.9 4.2 2.1 6.8h3.4a8 8 0 0 0-5.5-6.8zM9.5 11h5c-.2-2.6-1-4.8-2.5-6.5-1.5 1.7-2.3 3.9-2.5 6.5zm-5.4 2a8 8 0 0 0 6.5 6.8c-1.1-1.8-1.8-4.2-2-6.8zm5.4 0c.2 2.6 1 4.8 2.5 6.5 1.5-1.7 2.3-3.9 2.5-6.5zm6.9 0c-.2 2.6-.9 5-2.1 6.8a8 8 0 0 0 5.5-6.8z"/>`),
  users: svg('0 0 24 24', `<circle cx="8.5" cy="8" r="3.6"/><path d="M1.5 20c.4-4 3.3-6.6 7-6.6s6.6 2.6 7 6.6z"/><circle cx="17" cy="9" r="2.9"/><path d="M16.8 13.6c3 0 5.3 2.2 5.7 5.4h-5.2c-.3-2.2-1.2-4-2.6-5.2.6-.1 1.4-.2 2.1-.2z"/>`),
  refresh: svg('0 0 24 24', `<path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.6A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8zm8 8a8 8 0 0 1-15.4 3H7v-2H1v6h2v-2.6A10 10 0 0 0 22 12z"/>`),
  plane: svg('0 0 24 24', `<path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V18.5l-2 1.5V21.5l3.5-1 3.5 1V20l-2-1.5V13z"/>`),
  parachute: svg('0 0 24 24', `<path d="M12 2C6.5 2 2.2 5.8 2 10.5h20C21.8 5.8 17.5 2 12 2z"/><path d="M2.6 11.2 11 18.5V20h2v-1.5l8.4-7.3h-2l-6.4 5.6v-5.6h-2v5.6l-6.4-5.6z"/>`),
  car: svg('0 0 24 24', `<path d="M5.5 6h13l2.5 6v6.5a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1V17H6.5v1.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V12zm1.3 1.8L5.3 11.5h13.4l-1.5-3.7z"/><circle ${DARK} cx="7" cy="14" r="1.5"/><circle ${DARK} cx="17" cy="14" r="1.5"/>`),
  bike: svg('0 0 24 24', `<circle cx="5.5" cy="16" r="4"/><circle cx="18.5" cy="16" r="4"/><path d="M9 6h4l2 4h3l-3 6h-2l2-4h-3.5L10 16H8l3-6-1-2H9z"/><circle ${DARK} cx="5.5" cy="16" r="1.6"/><circle ${DARK} cx="18.5" cy="16" r="1.6"/>`),
  zone: svg('0 0 24 24', `<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/>`),
  run: svg('0 0 24 24', `<circle cx="14.5" cy="4" r="2.2"/><path d="M9 8.5l4-1.8 3.5 2.5 1.5 3 2.6.8-.6 1.8-3.4-1-1.2-2-1.8 3.6 2.4 2.6V22h-2v-4l-2.6-2.4L9.6 22H7.4l3.5-9-1.1.5-1.6 3H6l2.2-5z"/>`),
  wifi: svg('0 0 24 24', `<path d="M4 18h3v3H4zm5-4h3v7H9zm5-4h3v11h-3zm5-5h3v16h-3z"/>`),
  infinity: svg('0 0 24 24', `<path d="M7 7.5c2.2 0 3.6 1.5 5 3.1 1.4-1.6 2.8-3.1 5-3.1a4.5 4.5 0 0 1 0 9c-2.2 0-3.6-1.5-5-3.1-1.4 1.6-2.8 3.1-5 3.1a4.5 4.5 0 0 1 0-9zm0 2.2a2.3 2.3 0 0 0 0 4.6c1.3 0 2.2-.9 3.6-2.3-1.4-1.4-2.3-2.3-3.6-2.3zm10 0c-1.3 0-2.2.9-3.6 2.3 1.4 1.4 2.3 2.3 3.6 2.3a2.3 2.3 0 0 0 0-4.6z"/>`),
  swap: svg('0 0 24 24', `<path d="M7 3 2.5 7.5 7 12V9h11V6H7zm10 9v3H6v3h11v3l4.5-4.5z"/>`),
  drop: svg('0 0 24 24', `<path d="M11 3h2v11.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6zM4 19h16v2H4z"/>`),
  chat: svg('0 0 24 24', `<path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>`),
  send: svg('0 0 24 24', `<path d="M2.5 20.5 22 12 2.5 3.5 2.5 10l13 2-13 2z"/>`),
  waypoint: svg('0 0 24 24', `<path d="M12 1.5a7 7 0 0 1 7 7c0 5-7 14-7 14s-7-9-7-14a7 7 0 0 1 7-7zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>`),
  trophy: svg('0 0 24 24', `<path d="M6 2h12v2h3v3a5 5 0 0 1-4.6 5A6 6 0 0 1 13 15.8V18h3v3H8v-3h3v-2.2A6 6 0 0 1 7.6 12 5 5 0 0 1 3 7V4h3zm0 4H5v1a3 3 0 0 0 1.4 2.5A6 6 0 0 1 6 8zm12 0v2c0 .5 0 1-.1 1.5A3 3 0 0 0 19 7V6z"/>`),
};

const WEAPON_ICONS: Record<WeaponId, string> = {
  pistol: svg('0 0 64 20', `<path d="M14 3h26v6H29l-1.6 2.2h-4L22.4 18h-7.2l1.6-9H14z"/><path ${DARK} d="M17 5h20v1.2H17z"/>`),
  smg: svg('0 0 64 20', `<path d="M2 7h7V6h29V4h4v2h8v3h-8v3H31l-1 7h-5l1-7h-4l-1 5h-5l1.2-5H9v-2H2z"/><path ${DARK} d="M12 7h22v1.2H12z"/>`),
  ar: svg('0 0 64 20', `<path d="M1 6h9l3 1h8V3h9v4h12V6h18v3H42v3h-6l-.8 2 1.8 5h-5.5l-1.5-5H26l-1.4 5H19l1.6-5H13l-3 2H1z"/><path ${DARK} d="M21 4h8v1.4h-8z"/>`),
  shotgun: svg('0 0 64 20', `<path d="M1 8h12l3-1.5h18V5h28v3H34v1h16v3H34v-1h-9l-2 6h-5.5l1.6-6H14l-3 3.5H1z"/><path ${DARK} d="M37 9h12v1.5H37z"/>`),
  dmr: svg('0 0 64 20', `<path d="M1 7h10l2 1h9l1-4h12l1 4h6V7h21v2.6H42V12h-7l1.5 6h-5.5l-1.3-6H23l-1.6 6H16l1.4-6H11l-2 3H1z"/><path d="M21 1.5h16V4H21z"/><path ${DARK} d="M25 2h8v1.2h-8z"/>`),
  sniper: svg('0 0 64 20', `<path d="M1 9h11l2-1h7l1-3h3v3h10V7h29v1.8H35V12h-8l-1 2.5h-3.5l.8-2.5h-6L15 15H8l-2 2H1z"/><path d="M19 1h16v3.4H19z"/><path d="M24 4.4h2.4V7H24zm5 0h2.4V7H29z"/><path ${DARK} d="M22 2h10v1.2H22z"/>`),
};

const CONSUMABLE_ICONS: Record<ConsumableId | ThrowableId, string> = {
  bandage: ICONS.bandage,
  firstaid: ICONS.firstaid,
  medkit: ICONS.medkit,
  energy: ICONS.energy,
  fuel: ICONS.fuel,
  frag: ICONS.frag,
};

export function weaponIcon(id: WeaponId): string {
  return WEAPON_ICONS[id];
}

export function gearIcon(id: GearId): string {
  if (id.startsWith('vest')) return ICONS.vest;
  if (id.startsWith('helmet')) return ICONS.helmet;
  return ICONS.pack;
}

/** Icon for any item id given its category. */
export function itemIcon(id: ItemId, category: ItemCategory): string {
  switch (category) {
    case 'weapon': return WEAPON_ICONS[id as WeaponId];
    case 'ammo': return ICONS.ammo;
    case 'consumable':
    case 'throwable': return CONSUMABLE_ICONS[id as ConsumableId | ThrowableId];
    case 'gear': return gearIcon(id as GearId);
    default: return ICONS.ammo;
  }
}

export function vehicleIcon(type: VehicleType): string {
  return type === 'bike' ? ICONS.bike : ICONS.car;
}
