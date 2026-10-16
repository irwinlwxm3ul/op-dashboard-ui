// Strict validation of everything a client can send. Used by the Node server (untrusted input)
// and by the local worker (defence in depth). Returns null for anything malformed; callers count
// rejections and kick abusive connections.

import {
  MAX_CHAT_LEN, MAX_LOBBY_NAME_LEN, MAX_NAME_LEN, MAX_PLAYERS, MIN_PLAYERS, PROTOCOL_VERSION,
} from './constants';
import type { ClientMessage, LobbySettings } from './protocol';
import type {
  BotDifficulty, ClientAction, ConsumableId, ItemId, MatchConfig, PlayerInput, TeamSize,
} from './types';
import { BTN } from './types';

const ITEM_IDS: ReadonlySet<string> = new Set<ItemId>([
  'pistol', 'smg', 'ar', 'shotgun', 'dmr', 'sniper',
  'ammo_9mm', 'ammo_556', 'ammo_762', 'ammo_12g', 'ammo_300',
  'bandage', 'firstaid', 'medkit', 'energy', 'fuel',
  'frag',
  'vest1', 'vest2', 'vest3', 'helmet1', 'helmet2', 'helmet3', 'pack1', 'pack2', 'pack3',
]);
const CONSUMABLE_IDS: ReadonlySet<string> = new Set<ConsumableId>(['bandage', 'firstaid', 'medkit', 'energy', 'fuel']);
const ALL_BUTTONS = Object.values(BTN).reduce((a, b) => a | b, 0);
const MAX_ACTIONS_PER_INPUT = 4;
const MAX_INPUTS_PER_MESSAGE = 8;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const int = (x: unknown): x is number => num(x) && Number.isInteger(x);
const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;

/** Strip control characters, collapse whitespace, trim and cap length. Returns '' when unusable. */
export function sanitizeText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function sanitizeName(s: unknown): string | null {
  if (typeof s !== 'string' || s.length > 64) return null;
  const n = sanitizeText(s, MAX_NAME_LEN);
  return n.length >= 1 ? n : null;
}

export function sanitizeAction(raw: unknown): ClientAction | null {
  if (!isObj(raw) || typeof raw.a !== 'string') return null;
  switch (raw.a) {
    case 'pickup':
    case 'revive':
    case 'spectate':
      return int(raw.id) && raw.id >= 0 ? { a: raw.a, id: raw.id } : null;
    case 'enter': {
      if (!int(raw.id) || raw.id < 0) return null;
      if (raw.seat !== undefined && !(int(raw.seat) && raw.seat >= 0 && raw.seat < 8)) return null;
      return raw.seat === undefined ? { a: 'enter', id: raw.id } : { a: 'enter', id: raw.id, seat: raw.seat as number };
    }
    case 'drop': {
      if (typeof raw.item !== 'string' || !ITEM_IDS.has(raw.item)) return null;
      if (raw.count !== undefined && !(int(raw.count) && raw.count > 0 && raw.count <= 1000)) return null;
      return raw.count === undefined
        ? { a: 'drop', item: raw.item as ItemId }
        : { a: 'drop', item: raw.item as ItemId, count: raw.count as number };
    }
    case 'dropWeapon':
      return raw.slot === 0 || raw.slot === 1 || raw.slot === 2 ? { a: 'dropWeapon', slot: raw.slot } : null;
    case 'use':
      return typeof raw.item === 'string' && CONSUMABLE_IDS.has(raw.item) ? { a: 'use', item: raw.item as ConsumableId } : null;
    case 'give':
      return typeof raw.item === 'string' && ITEM_IDS.has(raw.item) ? { a: 'give', item: raw.item as ItemId } : null;
    case 'seat':
      return int(raw.seat) && raw.seat >= 0 && raw.seat < 8 ? { a: 'seat', seat: raw.seat } : null;
    case 'cancel':
    case 'throw':
    case 'exit':
    case 'jump':
    case 'chute':
    case 'respawn':
    case 'swapWeapons':
      return { a: raw.a } as ClientAction;
    default:
      return null;
  }
}

/**
 * Validate and normalise one input. Movement axes are clamped to the unit circle, aim is
 * wrapped/clamped, unknown button bits are stripped. Returns null if malformed.
 */
export function sanitizeInput(raw: unknown): PlayerInput | null {
  if (!isObj(raw)) return null;
  const { seq, mx, mz, yaw, pitch, buttons, stance, slot, rt } = raw;
  if (!int(seq) || seq < 0 || !num(mx) || !num(mz) || !num(yaw) || !num(pitch) || !int(buttons) || !num(rt)) return null;
  if (stance !== 0 && stance !== 1 && stance !== 2) return null;
  if (slot !== -1 && slot !== 0 && slot !== 1 && slot !== 2) return null;
  let x = Math.max(-1, Math.min(1, mx));
  let z = Math.max(-1, Math.min(1, mz));
  const l = Math.hypot(x, z);
  if (l > 1) { x /= l; z /= l; }
  const lim = (89 * Math.PI) / 180;
  const out: PlayerInput = {
    seq,
    mx: x,
    mz: z,
    yaw: ((((yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI,
    pitch: Math.max(-lim, Math.min(lim, pitch)),
    buttons: buttons & ALL_BUTTONS,
    stance,
    slot,
    rt,
  };
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || raw.actions.length > MAX_ACTIONS_PER_INPUT) return null;
    const acts: ClientAction[] = [];
    for (const a of raw.actions) {
      const s = sanitizeAction(a);
      if (!s) return null;
      acts.push(s);
    }
    if (acts.length) out.actions = acts;
  }
  return out;
}

const TEAM_SIZES: readonly number[] = [1, 2, 4];
const DIFFS: readonly string[] = ['easy', 'normal', 'hard'];

export function sanitizeLobbySettings(raw: unknown): LobbySettings | null {
  if (!isObj(raw)) return null;
  const { name, maxPlayers, teamSize, botFill, botDifficulty, zoneSpeed } = raw;
  if (!str(name, 64) || !int(maxPlayers) || !int(teamSize) || typeof botFill !== 'boolean') return null;
  if (typeof botDifficulty !== 'string' || !DIFFS.includes(botDifficulty)) return null;
  if (!num(zoneSpeed)) return null;
  if (!TEAM_SIZES.includes(teamSize)) return null;
  if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) return null;
  // A battle royale needs at least two teams.
  if (maxPlayers <= teamSize) return null;
  const n = sanitizeText(name, MAX_LOBBY_NAME_LEN);
  if (!n) return null;
  return {
    name: n,
    maxPlayers,
    teamSize: teamSize as TeamSize,
    botFill,
    botDifficulty: botDifficulty as BotDifficulty,
    zoneSpeed: Math.max(0.25, Math.min(2, zoneSpeed)),
  };
}

export function sanitizeMatchConfig(raw: unknown): MatchConfig | null {
  if (!isObj(raw)) return null;
  const { mode, seed, maxPlayers, teamSize, botFill, botDifficulty, zoneSpeed, infiniteAmmo } = raw;
  if (mode !== 'br' && mode !== 'training') return null;
  if (!int(seed) || !int(maxPlayers) || !int(teamSize) || !TEAM_SIZES.includes(teamSize)) return null;
  if (typeof botFill !== 'boolean' || typeof infiniteAmmo !== 'boolean' || !num(zoneSpeed)) return null;
  if (typeof botDifficulty !== 'string' || !DIFFS.includes(botDifficulty)) return null;
  // Battle royale needs at least two teams (training is a single player on its own).
  if (mode === 'br' && maxPlayers <= teamSize) return null;
  return {
    mode,
    seed: seed >>> 0,
    maxPlayers: Math.max(1, Math.min(MAX_PLAYERS, maxPlayers)),
    teamSize: teamSize as TeamSize,
    botFill,
    botDifficulty: botDifficulty as BotDifficulty,
    zoneSpeed: Math.max(0.25, Math.min(2, zoneSpeed)),
    infiniteAmmo,
  };
}

/** Validate a decoded JSON client message. */
export function validateClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'hello': {
      const name = sanitizeName(raw.name);
      if (!name || raw.version !== PROTOCOL_VERSION) return null;
      if (raw.codec !== undefined && raw.codec !== 'delta1') return null;
      return raw.codec === 'delta1'
        ? { t: 'hello', name, version: PROTOCOL_VERSION, codec: 'delta1' }
        : { t: 'hello', name, version: PROTOCOL_VERSION };
    }
    case 'listLobbies':
    case 'leaveLobby':
    case 'startMatch':
    case 'leaveMatch':
    case 'loaded':
      return { t: raw.t } as ClientMessage;
    case 'createLobby':
    case 'lobbySettings': {
      const settings = sanitizeLobbySettings(raw.settings);
      return settings ? ({ t: raw.t, settings } as ClientMessage) : null;
    }
    case 'joinLobby':
      return str(raw.id, 32) && raw.id.length > 0 ? { t: 'joinLobby', id: raw.id } : null;
    case 'setTeam':
      return int(raw.team) && raw.team >= 0 && raw.team < MAX_PLAYERS ? { t: 'setTeam', team: raw.team } : null;
    case 'ready':
      return typeof raw.ready === 'boolean' ? { t: 'ready', ready: raw.ready } : null;
    case 'chat': {
      if (!str(raw.text, 1000)) return null;
      const text = sanitizeText(raw.text, MAX_CHAT_LEN);
      return text ? { t: 'chat', text } : null;
    }
    case 'input': {
      if (!Array.isArray(raw.inputs) || raw.inputs.length === 0 || raw.inputs.length > MAX_INPUTS_PER_MESSAGE) return null;
      const inputs: PlayerInput[] = [];
      for (const i of raw.inputs) {
        const s = sanitizeInput(i);
        if (!s) return null;
        inputs.push(s);
      }
      return { t: 'input', inputs };
    }
    case 'ping':
      return num(raw.c) ? { t: 'ping', c: raw.c } : null;
    case 'startLocal': {
      const config = sanitizeMatchConfig(raw.config);
      const name = sanitizeName(raw.name);
      return config && name ? { t: 'startLocal', config, name } : null;
    }
    default:
      return null;
  }
}
