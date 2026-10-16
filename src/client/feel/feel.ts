// Feel controller: subscribes to the client event bus, routes every event to camera feel, sound
// and overlays, and runs the per-frame updates. Events are queued by the bus callbacks and handled
// at the start of update() so every handler sees the current FrameState and camera.

import { DOWNED_HEALTH } from '../../shared/constants';
import { clamp, distSq } from '../../shared/math';
import { WEAPONS } from '../../shared/items';
import type {
  DamageSource, EntityId, GameEvent, MatchResults, Vec3, WeaponId,
} from '../../shared/types';
import { audio } from '../audio';
import { settings } from '../game';
import type { ClientEvent, ClientEventBus, FrameState, LocalPlayerView } from '../game/types';
import { fmtDuration, itemName, t } from '../i18n';
import type { CameraState, Feel, FeelState } from '../render/contracts';
import { CameraFeel, createFeelState } from './camera';
import { KillBanner, MomentBanner, Notices } from './overlay/banners';
import { DamageIndicators } from './overlay/damage';
import { div } from './overlay/dom';
import { HIT_PRIORITY, Hitmarker, type HitKind } from './overlay/hitmarker';
import { DamageNumbers } from './overlay/numbers';
import { TrainingReadout } from './overlay/readout';
import { ensureFeelStyles } from './overlay/styles';
import { Vitals } from './overlay/vitals';
import { SoundRouter } from './sound';

type EventOf<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;

/** Zone phases in a match (PLAN.md: 8 phases); the last one is announced as the final circle. */
const ZONE_PHASE_COUNT = 8;
/** Safety cap for events queued between two updates. */
const MAX_QUEUED_EVENTS = 2048;
/** Minimum spacing of hurt sounds (s) for combat damage and for damage over time (zone, bleeding). */
const HURT_INTERVAL = 0.08;
const HURT_INTERVAL_DOT = 0.9;

/** Damage sources without a meaningful attacker direction. */
function isEnvironmental(s: DamageSource): boolean {
  return s === 'zone' || s === 'bleed' || s === 'drown' || s === 'fall';
}

export class FeelController implements Feel {
  readonly state: FeelState = createFeelState();

  private readonly camera = new CameraFeel();
  private readonly sound: SoundRouter;
  private readonly root: HTMLDivElement;
  private readonly vitals: Vitals;
  private readonly damage: DamageIndicators;
  private readonly numbers: DamageNumbers;
  private readonly hitmarker: Hitmarker;
  private readonly readout: TrainingReadout;
  private readonly killBanner: KillBanner;
  private readonly moment: MomentBanner;
  private readonly notices: Notices;

  private readonly queue: ClientEvent[] = [];
  private readonly unsubscribe: () => void;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = (): void => this.measure();
  private width = 0;
  private height = 0;
  private now = 0;
  private disposed = false;

  // Per-frame coalesced hit feedback (shotgun pellets / multi-hits play one sound, one pop).
  private frameMarker: HitKind | null = null;
  private frameShatter = false;
  private frameTick: HitKind | null = null;
  private frameConfirm: 'kill' | 'knock' | null = null;
  private frameArmorBreak = false;
  private frameHurt = 0;
  private frameHurtDot = false;
  private lastHurt = -10;

  private routeErrors = 0;
  private kills = 0;
  private endAnnounced = false;
  private readonly targetPos: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(events: ClientEventBus, overlay: HTMLElement) {
    const doc = overlay.ownerDocument;
    ensureFeelStyles(doc);
    this.root = div(overlay, 'dzf-root');
    // Layer order (bottom -> top): vitals tint, damage flash/arcs, numbers, readout, hitmarker, kill banner,
    // notices, match-moment banner (a winner celebration covers routine notices).
    this.vitals = new Vitals(this.root);
    this.damage = new DamageIndicators(this.root);
    this.numbers = new DamageNumbers(this.root);
    this.readout = new TrainingReadout(this.root);
    this.hitmarker = new Hitmarker(this.root);
    this.killBanner = new KillBanner(this.root);
    this.notices = new Notices(this.root);
    this.moment = new MomentBanner(this.root);

    this.sound = new SoundRouter(() => this.camera.addTrauma(0.09, 0.3));

    this.unsubscribe = events.onAny((ev) => {
      if (this.queue.length < MAX_QUEUED_EVENTS) this.queue.push(ev);
    });

    const view = doc.defaultView;
    if (view && typeof view.ResizeObserver === 'function') {
      this.resizeObserver = new view.ResizeObserver(() => this.measure());
      this.resizeObserver.observe(this.root);
    } else if (view) {
      view.addEventListener('resize', this.onWindowResize);
    }
    this.measure();
  }

  private measure(): void {
    this.width = this.root.clientWidth;
    this.height = this.root.clientHeight;
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  update(frame: FrameState, cam: CameraState | null, dt: number): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    this.now += step;

    this.sound.begin(frame, cam, step);
    for (let i = 0; i < this.queue.length; i++) {
      try {
        this.route(this.queue[i], frame);
      } catch (err) {
        // A malformed event must not take the whole feel pipeline (and later events) down with it.
        if (this.routeErrors++ < 5) console.error('[feel] failed to handle event', this.queue[i].type, err);
      }
    }
    this.queue.length = 0;
    this.flushHitFeedback();

    this.camera.update(frame.self, step, this.state);
    this.sound.end(frame, step);
    this.updateOverlays(frame, cam, step);
  }

  private updateOverlays(frame: FrameState, cam: CameraState | null, dt: number): void {
    const now = this.now;
    const self = frame.self;
    this.hitmarker.update(now);
    if (this.width === 0 && this.resizeObserver === null) this.measure();
    this.numbers.update(cam, this.width, this.height, now);
    const origin = self && self.life !== 'dead' ? self.pos : null;
    const viewYaw = cam ? cam.yaw : self ? self.aimYaw : 0;
    this.damage.update(origin, viewYaw, now, dt);
    const bleed = self && self.life === 'downed' ? 1 - clamp(self.downedHp / DOWNED_HEALTH, 0, 1) : 0;
    this.vitals.update(this.state.lowHealth, self ? self.life : null, bleed, dt);
    this.readout.update(now);
    this.killBanner.update(now);
    this.moment.update(now);
    this.notices.update(now);
  }

  // ---------------------------------------------------------------------------
  // Event routing
  // ---------------------------------------------------------------------------

  private route(ev: ClientEvent, f: FrameState): void {
    const self = f.self;
    const me = f.localId;
    switch (ev.type) {
      // ---- Local predicted events ----
      case 'localShot':
        this.camera.shot(WEAPONS[ev.weapon], self?.ads ?? 0, self?.stance ?? 'stand');
        this.sound.localShot(ev.weapon, ev.origin);
        break;
      case 'localReload':
        this.sound.reload(ev.weapon, ev.empty, currentMag(self, ev.weapon), reserveFor(self, ev.weapon, f), true);
        break;
      case 'localReloadDone':
        this.sound.reloadDone();
        break;
      case 'localDryFire':
        audio.dryFire();
        break;
      case 'localJump':
        if (self) audio.jump(true, self.pos);
        break;
      case 'localLand':
        this.camera.land(ev.speed);
        if (self) audio.land(clamp(ev.speed / 15, 0.15, 1), self.pos, true);
        break;
      case 'localFootstep':
        this.camera.footstep();
        if (self) audio.footstep(ev.material, self.pos, true, ev.intensity);
        break;
      case 'localWeaponSwitch':
        this.sound.cancel(true, 'all');
        audio.weaponSwitch();
        break;
      case 'localStance':
      case 'localAds':
      case 'localSnapshot':
        break;

      // ---- Server events ----
      case 'shot':
        if (ev.shooter !== me) this.sound.remoteShot(ev.weapon, ev.origin, ev.ends, this.isSpectated(f, ev.shooter));
        break;
      case 'impact':
        this.sound.impact(ev.material, ev.pos);
        break;
      case 'hit':
        this.onHit(ev, f);
        break;
      case 'knock':
        this.onKnock(ev, f);
        break;
      case 'kill':
        this.onKill(ev, f);
        break;
      case 'revived':
        this.onRevived(ev, f);
        break;
      case 'teamEliminated':
        if (me !== null && ev.team === f.localTeam && f.config.mode !== 'training') this.announceElimination(ev.placement, f);
        break;
      case 'pickup':
        if (ev.player === me) audio.pickup();
        break;
      case 'reload':
        // Only the spectated player's reload is audible (reload sounds are not spatialised).
        if (ev.player !== me && this.isSpectated(f, ev.player)) {
          const def = WEAPONS[ev.weapon];
          this.sound.reload(ev.weapon, ev.empty, ev.empty ? 0 : Math.floor(def.magSize / 2), Infinity, false);
        }
        break;
      case 'draw':
        if (ev.player !== me && this.isSpectated(f, ev.player)) {
          this.sound.cancel(false, 'all');
          audio.weaponSwitch();
        }
        break;
      case 'dryfire':
        if (ev.player !== me && this.isSpectated(f, ev.player)) audio.dryFire();
        break;
      case 'useStart':
      case 'useDone':
        if (ev.player === me || this.isSpectated(f, ev.player)) audio.heal(ev.item);
        break;
      case 'jumpPlane':
        if (ev.player === me && self) audio.jump(true, self.pos);
        break;
      case 'chuteOpen':
        if (ev.player === me) {
          // Canopy catching: a short tug and the rustle of fabric.
          this.camera.addTrauma(0.28, 0.4);
          this.camera.jolt(-0.07);
          audio.pickup();
        }
        break;
      case 'land':
        if (ev.player !== me) {
          const p = f.players.get(ev.player);
          if (p) audio.land(clamp(ev.speed / 15, 0.15, 1), p.pos, false);
        }
        break;
      case 'jump':
        if (ev.player !== me) {
          const p = f.players.get(ev.player);
          if (p) audio.jump(false, p.pos);
        }
        break;
      case 'vehicleCrash':
        this.onVehicleCrash(ev, f);
        break;
      case 'vehicleDestroyed':
        this.onExplosion(ev.pos, 6);
        break;
      case 'explosion':
        this.onExplosion(ev.pos, ev.radius);
        break;
      case 'zonePhase':
        this.onZonePhase(ev, f);
        break;
      case 'matchEnd':
        this.onMatchEnd(ev.results, f);
        break;
      case 'spawned':
        if (ev.player === me) this.resetLocalOverlays();
        break;
      case 'targetHit':
        this.onTargetHit(ev, f);
        break;
      // Remote footsteps are derived from interpolated movement in SoundRouter (no doubles);
      // the remaining events have no feel response of their own.
      case 'footstep':
      case 'vehicleEnter':
      case 'vehicleExit':
      case 'throw':
      case 'planeStart':
      case 'matchStart':
        break;
      default:
        break;
    }
  }

  private onHit(ev: EventOf<'hit'>, f: FrameState): void {
    const me = f.localId;
    if (me === null) return;
    if (ev.attacker === me && ev.victim !== me) {
      const marker: HitKind =
        ev.result === 'kill' ? 'kill' : ev.result === 'knock' ? 'knock' : ev.part === 'head' ? 'head' : ev.armor ? 'armor' : 'body';
      this.queueMarker(marker, ev.armorBroke);
      // The hit itself plays the part tick; knock / kill confirms layer on top from their own events.
      this.queueTick(ev.part === 'head' ? 'head' : ev.armor ? 'armor' : 'body');
      if (ev.armorBroke) this.frameArmorBreak = true;
      if (settings.get().damageNumbers) {
        this.numbers.spawn(ev.victim, ev.pos, ev.damage, DamageNumbers.styleFor(ev.part, ev.armor), ev.result !== 'damage', this.now);
      }
    }
    if (ev.victim === me) {
      if (isEnvironmental(ev.source)) {
        this.damage.flashOnly(Math.min(0.5, 0.18 + ev.damage / 60));
        this.frameHurtDot = true;
      } else {
        const hasDir = distSq(ev.from, ev.pos) > 0.25;
        this.damage.hit(ev.attacker === me ? -1 : ev.attacker, hasDir ? ev.from : null, ev.damage, this.now);
        this.camera.addTrauma(0.1 + (Math.min(ev.damage, 60) / 60) * 0.25, 0.6);
      }
      this.frameHurt += ev.damage;
      if (ev.armorBroke) {
        this.damage.armorBroken(ev.part === 'head', this.now);
        this.frameArmorBreak = true;
      }
    }
  }

  private onKnock(ev: EventOf<'knock'>, f: FrameState): void {
    const me = f.localId;
    if (me === null) return;
    if (ev.victim === me) {
      this.showLocalDown(false, ev.attacker, ev.source, f);
    } else if (ev.attacker === me) {
      this.queueMarker('knock', false);
      this.queueConfirm('knock');
      const count = this.killCount(f);
      this.killBanner.show(
        'knock', t('banner.youKnocked', { name: this.nameOf(ev.victim, f) }),
        ev.headshot ? t('banner.headshot') : null,
        [count > 0 ? t('banner.killCount', { count }) : '', distanceText(ev.distance)], this.now,
      );
    } else if (this.isTeammate(f, ev.victim)) {
      this.notices.push(t('hud.teammateDown', { name: this.nameOf(ev.victim, f) }), 'bad', this.now);
      audio.ui('countdown');
    }
  }

  private onKill(ev: EventOf<'kill'>, f: FrameState): void {
    const me = f.localId;
    if (me === null) return;
    if (ev.victim === me) {
      this.showLocalDown(true, ev.attacker, ev.source, f);
    } else if (ev.attacker === me) {
      this.kills++;
      this.queueMarker('kill', false);
      this.queueConfirm('kill');
      const count = this.killCount(f);
      const name = this.nameOf(ev.victim, f);
      this.killBanner.show(
        'kill', t(ev.finished ? 'feel.kill.finished' : 'banner.youKilled', { name }),
        ev.headshot ? t('banner.headshot') : null,
        [t('banner.killCount', { count }), distanceText(ev.distance)], this.now,
      );
    } else if (this.isTeammate(f, ev.victim)) {
      this.notices.push(t('hud.teammateKilled', { name: this.nameOf(ev.victim, f) }), 'bad', this.now);
    }
  }

  /** "Knocked by X" / "Killed by X" (with weapon) or the environmental cause. */
  private showLocalDown(killed: boolean, attacker: EntityId | null, source: DamageSource, f: FrameState): void {
    const byOther = attacker !== null && attacker !== f.localId;
    let main: string;
    const details: string[] = [];
    if (byOther) {
      main = t(killed ? 'banner.killedBy' : 'banner.knockedBy', { name: this.nameOf(attacker, f) });
      details.push(sourceLabel(source));
    } else if (killed) {
      main = deathText(source);
    } else {
      main = t('hud.downed');
    }
    this.killBanner.show(killed ? 'death' : 'downed', main, null, details, this.now);
  }

  private onRevived(ev: EventOf<'revived'>, f: FrameState): void {
    const me = f.localId;
    if (me === null) return;
    if (ev.target === me) {
      this.notices.push(t('banner.revivedBy', { name: this.nameOf(ev.reviver, f) }), 'good', this.now);
      audio.ui('ready');
    } else if (ev.reviver === me) {
      this.notices.push(t('banner.youRevived', { name: this.nameOf(ev.target, f) }), 'good', this.now);
      audio.ui('ready');
    } else if (this.isTeammate(f, ev.target)) {
      this.notices.push(t('hud.teammateRevived', { name: this.nameOf(ev.target, f) }), 'good', this.now);
    }
  }

  private announceElimination(placement: number, f: FrameState): void {
    if (this.endAnnounced) return;
    this.endAnnounced = true;
    audio.ui('lose');
    const sub = placement > 0
      ? t(f.config.teamSize > 1 ? 'banner.teamPlaced' : 'banner.youPlaced', { n: placement })
      : t('banner.betterLuck');
    this.moment.show('lose', t('banner.eliminated'), sub, 4.5, this.now);
  }

  private onMatchEnd(results: MatchResults, f: FrameState): void {
    const me = f.localId;
    if (me === null || f.config.mode === 'training') return;
    let mine = null;
    for (const p of results.players) if (p.id === me) mine = p;
    const won = (results.winnerTeam !== null && results.winnerTeam === f.localTeam) || mine?.placement === 1;
    if (won) {
      this.endAnnounced = true;
      audio.ui('win');
      this.moment.show(
        'win', t(f.config.teamSize > 1 ? 'banner.winnerTeam' : 'banner.winner'),
        t('banner.killCount', { count: this.killCount(f) }), 6.5, this.now,
      );
    } else {
      this.announceElimination(mine?.placement ?? 0, f);
    }
  }

  private onZonePhase(ev: EventOf<'zonePhase'>, f: FrameState): void {
    if (f.config.mode === 'training') return;
    let title: string;
    let sub = '';
    if (ev.stage === 'waiting') {
      title = t('hud.zone.waiting', { time: fmtDuration(Math.ceil(ev.timer)) });
      sub = ev.phase >= ZONE_PHASE_COUNT ? t('banner.zone.final') : t('hud.zone.phase', { n: ev.phase });
    } else if (ev.stage === 'shrinking') {
      title = t('banner.zone.restricting');
      sub = ev.phase >= ZONE_PHASE_COUNT ? t('banner.zone.final') : t('hud.zone.phase', { n: ev.phase });
    } else {
      return; // 'pre' (match start) and 'final' (zone fully closed) need no announcement
    }
    this.moment.show('zone', title, sub, 3.6, this.now);
    audio.ui('zone');
  }

  private onVehicleCrash(ev: EventOf<'vehicleCrash'>, f: FrameState): void {
    const local = f.self !== null && f.self.vehicleId === ev.vehicle;
    if (!local && this.sound.distanceToHead(ev.pos) > 150) return;
    audio.impact('metal', ev.pos);
    if (local) {
      this.camera.addTrauma(clamp(ev.impact / 22, 0.15, 0.85));
      if (ev.impact > 6) audio.land(clamp(ev.impact / 25, 0.2, 1), ev.pos, true);
    }
  }

  private onExplosion(pos: Vec3, radius: number): void {
    if (!this.sound.explosion(pos)) return;
    const d = this.sound.distanceToHead(pos);
    const reach = Math.max(45, radius * 7);
    if (d >= reach) return;
    const k = d <= radius ? 1 : 1 - (d - radius) / (reach - radius);
    this.camera.addTrauma(0.05 + 0.95 * k * k);
  }

  private onTargetHit(ev: EventOf<'targetHit'>, f: FrameState): void {
    const kind: HitKind = ev.part === 'head' ? 'head' : 'body';
    this.queueMarker(kind, false);
    this.queueTick(kind);
    this.readout.push(ev.damage, ev.part, ev.distance, this.now);
    if (!settings.get().damageNumbers) return;
    for (const target of f.trainingTargets) {
      if (target.id !== ev.target) continue;
      this.targetPos.x = target.pos.x;
      this.targetPos.y = target.pos.y + (ev.part === 'head' ? 0.35 : 0);
      this.targetPos.z = target.pos.z;
      this.numbers.spawn(-1 - ev.target, this.targetPos, ev.damage, DamageNumbers.styleFor(ev.part, false), false, this.now);
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // Coalesced hit feedback
  // ---------------------------------------------------------------------------

  private queueMarker(kind: HitKind, shatter: boolean): void {
    if (this.frameMarker === null || HIT_PRIORITY[kind] > HIT_PRIORITY[this.frameMarker]) this.frameMarker = kind;
    this.frameShatter = this.frameShatter || shatter;
  }

  private queueTick(kind: HitKind): void {
    if (this.frameTick === null || HIT_PRIORITY[kind] > HIT_PRIORITY[this.frameTick]) this.frameTick = kind;
  }

  private queueConfirm(kind: 'kill' | 'knock'): void {
    if (this.frameConfirm !== 'kill') this.frameConfirm = kind;
  }

  private flushHitFeedback(): void {
    if (this.frameMarker !== null) this.hitmarker.show(this.frameMarker, this.now, this.frameShatter);
    if (this.frameTick !== null) audio.hitmarker(this.frameTick);
    if (this.frameConfirm !== null) audio.hitmarker(this.frameConfirm);
    if (this.frameArmorBreak) audio.armorBreak();
    if (this.frameHurt > 0) {
      const interval = this.frameHurtDot ? HURT_INTERVAL_DOT : HURT_INTERVAL;
      if (this.now - this.lastHurt >= interval) {
        audio.hurt(this.frameHurt);
        this.lastHurt = this.now;
      }
    }
    this.frameMarker = null;
    this.frameShatter = false;
    this.frameTick = null;
    this.frameConfirm = null;
    this.frameArmorBreak = false;
    this.frameHurt = 0;
    this.frameHurtDot = false;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private killCount(f: FrameState): number {
    return Math.max(this.kills, f.self?.stats.kills ?? 0);
  }

  private isSpectated(f: FrameState, id: EntityId): boolean {
    return id !== f.localId && id === f.viewTargetId;
  }

  private isTeammate(f: FrameState, id: EntityId): boolean {
    if (f.localId === null || id === f.localId) return false;
    const p = f.players.get(id);
    if (p) return p.isTeammate;
    const r = f.roster.get(id);
    return r !== undefined && r.team === f.localTeam;
  }

  private nameOf(id: EntityId, f: FrameState): string {
    return f.roster.get(id)?.name ?? f.players.get(id)?.name ?? t('feel.unknownPlayer');
  }

  private resetLocalOverlays(): void {
    this.damage.clear();
    this.vitals.clear();
    this.sound.cancel(true, 'all');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.queue.length = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root.ownerDocument.defaultView?.removeEventListener('resize', this.onWindowResize);
    this.sound.dispose();
    this.numbers.clear();
    this.readout.clear();
    this.hitmarker.clear();
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function currentMag(self: LocalPlayerView | null, weapon: WeaponId): number {
  if (!self) return 0;
  for (const w of self.weapons) if (w && w.id === weapon) return w.mag;
  return 0;
}

/** Reserve rounds for a weapon's ammo type (Infinity in training with infinite ammo). */
function reserveFor(self: LocalPlayerView | null, weapon: WeaponId, f: FrameState): number {
  if (!self || f.config.infiniteAmmo) return Infinity;
  return self.ammo[WEAPONS[weapon].ammo] ?? Infinity;
}

function distanceText(distance: number): string {
  return distance >= 1 ? t('feel.kill.distance', { distance: Math.round(distance) }) : '';
}

/** Weapon / cause name shown under "killed / knocked by {name}". */
function sourceLabel(s: DamageSource): string {
  switch (s) {
    case 'zone': return t('feel.source.zone');
    case 'vehicle': return t('feel.source.vehicle');
    case 'explosion': return t('feel.source.explosion');
    case 'fall': return t('feel.source.fall');
    case 'bleed': return t('feel.source.bleed');
    case 'drown': return t('feel.source.drown');
    case 'frag': return itemName('frag');
    default: return itemName(s);
  }
}

/** Death message without an attacker (environment or self-inflicted). */
function deathText(s: DamageSource): string {
  switch (s) {
    case 'zone': return t('banner.diedZone');
    case 'fall': return t('banner.diedFall');
    case 'bleed': return t('banner.diedBleed');
    case 'drown': return t('banner.diedDrown');
    case 'vehicle': return t('feel.death.vehicle');
    case 'frag':
    case 'explosion': return t('banner.diedExplosion');
    default: return t('banner.died');
  }
}
