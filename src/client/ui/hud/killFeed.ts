// Kill feed (top-right): knocks / kills / own-team revives, max 5 entries, fading after 6 s.
// Lines are built from translated templates; {killer} / {victim} / {weapon} become styled spans so
// word order stays correct in every language.

import { fmtNumber, itemName, t, type TKey } from '../../i18n';
import type { DamageSource, EntityId, WeaponId } from '../../../shared/types';
import type { ClientEventOf, FrameState } from '../../game/types';
import { h, svgIcon } from '../dom';
import { ICONS, weaponIcon } from '../icons';
import type { HudEnv, Widget } from './shared';

const MAX_ENTRIES = 5;
const LIFETIME_MS = 6000;
const FADE_MS = 500;
const SHOW_DISTANCE_FROM = 50;

const MARK = '\u0001';
const TOKENS = { killer: `${MARK}k${MARK}`, victim: `${MARK}v${MARK}`, weapon: `${MARK}w${MARK}`, reviver: `${MARK}k${MARK}`, target: `${MARK}v${MARK}` };

const WEAPON_IDS: ReadonlySet<string> = new Set<WeaponId>(['pistol', 'smg', 'ar', 'shotgun', 'dmr', 'sniper']);

interface Entry {
  el: HTMLElement;
  born: number;
}

export class KillFeed implements Widget {
  readonly el: HTMLDivElement;
  private entries: Entry[] = [];
  private frame: FrameState | null = null;
  private env: HudEnv | null = null;

  constructor() {
    this.el = h('div', 'dz-feed');
    this.el.setAttribute('aria-live', 'polite');
  }

  /** Subscribe to the match events. Returns the unsubscribe function. */
  bind(env: HudEnv): () => void {
    this.env = env;
    const ev = env.game.events;
    const offs = [
      ev.on('kill', (e) => this.onKill(e)),
      ev.on('knock', (e) => this.onKnock(e)),
      ev.on('revived', (e) => this.onRevived(e)),
    ];
    return () => {
      for (const off of offs) off();
      this.env = null;
    };
  }

  update(frame: FrameState): void {
    this.frame = frame;
    if (!this.entries.length) return;
    const now = performance.now();
    while (this.entries.length && now - this.entries[0].born > LIFETIME_MS + FADE_MS) {
      this.entries.shift()!.el.remove();
    }
  }

  relabel(): void {
    // Existing lines keep their language; new lines use the new one.
  }

  reset(): void {
    for (const e of this.entries) e.el.remove();
    this.entries = [];
    this.frame = null;
  }

  private name(id: EntityId | null): string {
    if (id === null) return '';
    const f = this.frame;
    return f?.roster.get(id)?.name ?? f?.players.get(id)?.name ?? t('common.unknown');
  }

  private role(id: EntityId | null): 'me' | 'mate' | 'other' {
    if (id === null || !this.env) return 'other';
    const local = this.frame?.localId ?? this.env.game.init.you;
    if (id === local) return 'me';
    return this.env.team.includes(id) ? 'mate' : 'other';
  }

  private onKill(e: ClientEventOf<'kill'>): void {
    const self = e.attacker !== null && e.attacker === e.victim;
    const attacker = self ? null : e.attacker;
    let key: TKey;
    let weapon: DamageSource | null = null;
    if (e.finished && attacker !== null) key = 'feed.finished';
    else switch (e.source) {
      case 'zone': key = 'feed.zone'; break;
      case 'fall': key = 'feed.fall'; break;
      case 'bleed': key = 'feed.bledOut'; break;
      case 'drown': key = 'feed.drowned'; break;
      case 'vehicle': key = attacker !== null ? 'feed.vehicle' : 'feed.vehicleCrash'; break;
      case 'frag': key = attacker !== null ? 'feed.frag' : 'feed.explosionEnv'; break;
      case 'explosion': key = attacker !== null ? 'feed.explosion' : 'feed.explosionEnv'; break;
      default:
        key = attacker !== null ? 'feed.killed' : 'ui.feed.died';
        weapon = e.source;
    }
    this.push(key, attacker, e.victim, weapon, e.headshot, e.distance, 'kill');
  }

  private onKnock(e: ClientEventOf<'knock'>): void {
    const attacker = e.attacker !== null && e.attacker !== e.victim ? e.attacker : null;
    let key: TKey;
    let weapon: DamageSource | null = null;
    if (attacker === null) key = 'feed.knockedEnv';
    else switch (e.source) {
      case 'vehicle': key = 'feed.knockedVehicle'; break;
      case 'frag': key = 'feed.knockedFrag'; break;
      case 'explosion': key = 'feed.knockedExplosion'; break;
      default:
        if (WEAPON_IDS.has(e.source)) {
          key = 'feed.knocked';
          weapon = e.source;
        } else key = 'feed.knockedEnv';
    }
    this.push(key, attacker, e.victim, weapon, e.headshot, e.distance, 'knock');
  }

  private onRevived(e: ClientEventOf<'revived'>): void {
    // Only our own team's revives are interesting.
    if (this.role(e.target) === 'other' && this.role(e.reviver) === 'other') return;
    const text = t('feed.revived', { reviver: TOKENS.reviver, target: TOKENS.target });
    this.build(text, e.reviver, e.target, null, false, 0, 'revive');
  }

  private push(key: TKey, killer: EntityId | null, victim: EntityId, weapon: DamageSource | null, headshot: boolean, distance: number, kind: 'kill' | 'knock'): void {
    const text = t(key, { killer: TOKENS.killer, victim: TOKENS.victim, weapon: TOKENS.weapon });
    this.build(text, killer, victim, weapon, headshot, distance, kind);
  }

  private build(text: string, killer: EntityId | null, victim: EntityId, weapon: DamageSource | null, headshot: boolean, distance: number, kind: 'kill' | 'knock' | 'revive'): void {
    const line = h('div', `dz-feed-line dz-feed-${kind}`);
    const killerRole = this.role(killer);
    const victimRole = this.role(victim);
    if (killerRole === 'me') line.classList.add('dz-feed-mine');
    else if (victimRole === 'me') line.classList.add('dz-feed-victim');
    else if (killerRole === 'mate' || victimRole === 'mate') line.classList.add('dz-feed-team');
    const parts = text.split(MARK);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i % 2 === 1) {
        if (p === 'k') this.nameSpan(line, killer, killerRole);
        else if (p === 'v') this.nameSpan(line, victim, victimRole);
        else if (p === 'w' && weapon) {
          const w = h('span', 'dz-feed-weapon', line);
          if (WEAPON_IDS.has(weapon)) {
            w.appendChild(svgIcon(weaponIcon(weapon as WeaponId), 'dz-feed-weapon-icon'));
            h('span', 'dz-feed-weapon-name', w).textContent = itemName(weapon as WeaponId);
          }
        }
      } else if (p) {
        h('span', 'dz-feed-text', line).textContent = p;
      }
    }
    if (headshot) {
      const hs = svgIcon(ICONS.headshot, 'dz-icon dz-feed-hs');
      hs.title = t('feed.headshot');
      line.appendChild(hs);
    }
    if (distance >= SHOW_DISTANCE_FROM && kind !== 'revive') {
      h('span', 'dz-feed-dist', line).textContent = t('unit.meters', { n: fmtNumber(Math.round(distance)) });
    }
    this.el.prepend(line);
    this.entries.push({ el: line, born: performance.now() });
    while (this.entries.length > MAX_ENTRIES) this.entries.shift()!.el.remove();
  }

  private nameSpan(parent: HTMLElement, id: EntityId | null, role: 'me' | 'mate' | 'other'): void {
    const s = h('span', `dz-feed-name dz-feed-name-${role}`, parent);
    s.textContent = this.name(id);
    if (role === 'mate' && this.env && id !== null) {
      const c = this.env.memberColor(id);
      if (c) s.style.setProperty('--c', c);
    }
  }
}
