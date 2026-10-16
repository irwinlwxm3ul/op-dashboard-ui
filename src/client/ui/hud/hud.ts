// In-game HUD orchestrator: builds every widget, binds them to an attached match, routes per-frame
// updates, owns the mouse-taking overlays (inventory, full map) and HUD key handling.

import { settings } from '../../game';
import type { EntityId } from '../../../shared/types';
import type { ClientGameApi, FrameState, InputUiEvent, KeyAction, Settings } from '../../game/types';
import type { CameraState, RenderStats } from '../../render/contracts';
import type { MatchContext } from '../contracts';
import type { UiCtx } from '../context';
import { h, isTyping } from '../dom';
import { onKeyboardLayout } from '../keys';
import { Compass } from './compass';
import { Crosshair, ScopeOverlay } from './crosshair';
import { FullMap } from './fullMap';
import { Inventory } from './inventory';
import { KillFeed } from './killFeed';
import { MatchInfo, ZoneWarning } from './matchInfo';
import { Minimap } from './minimap';
import { RESPAWN_CODE, StatsOverlay, TrainingPanel } from './panels';
import { DropMeter, PlanePanel, StatusBanner, VehiclePanel } from './phase';
import { ActionProgress, Prompt } from './prompt';
import { Scoreboard } from './scoreboard';
import { MEMBER_COLORS, Waypoint, type HudEnv, type Widget } from './shared';
import { Teammates } from './teammates';
import { Vitals } from './vitals';
import { WeaponPanel } from './weapons';

/** Ignore a toggle event from the input module right after the HUD handled the same key itself. */
const TOGGLE_DEBOUNCE_MS = 200;
const MAP_PAN_PX = 80;
const MAP_ZOOM_STEP = 1.4;

class Env implements HudEnv {
  readonly world;
  readonly waypoint = new Waypoint();
  keys: Record<KeyAction, string>;
  team: EntityId[] = [];
  private index = new Map<EntityId, number>();
  private rosterSize = -1;

  constructor(readonly game: ClientGameApi, readonly context: MatchContext) {
    this.world = game.world;
    this.keys = settings.get().keybinds;
    const init = game.init;
    this.setTeam(init.roster.filter((r) => r.team === init.team).map((r) => r.id), init.roster.length);
  }

  /** Recompute the local team when the roster changed (late joins / bot fill). */
  sync(frame: FrameState): void {
    if (frame.roster.size === this.rosterSize) return;
    const ids: EntityId[] = [];
    for (const r of frame.roster.values()) if (r.team === frame.localTeam) ids.push(r.id);
    this.setTeam(ids, frame.roster.size);
  }

  private setTeam(ids: EntityId[], rosterSize: number): void {
    ids.sort((a, b) => a - b);
    this.team = ids;
    this.rosterSize = rosterSize;
    this.index.clear();
    ids.forEach((id, i) => this.index.set(id, i));
  }

  memberColor(id: EntityId): string | null {
    const i = this.index.get(id);
    return i === undefined ? null : MEMBER_COLORS[i % MEMBER_COLORS.length];
  }

  memberNumber(id: EntityId): number {
    const i = this.index.get(id);
    return i === undefined ? 0 : i + 1;
  }
}

export class Hud {
  readonly el: HTMLDivElement;
  private env: Env | null = null;
  private visible = false;
  private readonly widgets: Widget[];
  private readonly scope = new ScopeOverlay();
  private readonly crosshair = new Crosshair();
  private readonly compass = new Compass();
  private readonly zoneWarning = new ZoneWarning();
  private readonly plane = new PlanePanel();
  private readonly status = new StatusBanner();
  private readonly matchInfo = new MatchInfo();
  private readonly feed = new KillFeed();
  private readonly stats = new StatsOverlay();
  private readonly training = new TrainingPanel();
  private readonly mates = new Teammates();
  private readonly minimap = new Minimap();
  private readonly prompt = new Prompt();
  private readonly action = new ActionProgress();
  private readonly vehicle = new VehiclePanel();
  private readonly vitals = new Vitals();
  private readonly weapons = new WeaponPanel();
  private readonly drop = new DropMeter();
  private readonly scoreboard = new Scoreboard();
  private readonly inventory: Inventory;
  private readonly fullMap: FullMap;
  private unbind: Array<() => void> = [];
  private lastFrame: FrameState | null = null;
  /** When the HUD itself last toggled each overlay from a key press (input-event debounce). */
  private readonly lastOwnToggle = { inventory: 0, map: 0 };

  constructor(ctx: UiCtx) {
    this.el = h('div', 'dz-hud dz-hidden');
    this.el.dataset.testid = 'hud';
    this.inventory = new Inventory(() => this.setInventory(false));
    this.fullMap = new FullMap(() => this.setMap(false));

    this.el.appendChild(this.scope.el);
    const center = h('div', 'dz-hud-center', this.el);
    center.append(this.crosshair.el, this.action.el);
    const top = h('div', 'dz-hud-top', this.el);
    top.append(this.compass.el, this.zoneWarning.el, this.plane.el, this.status.el);
    const topRight = h('div', 'dz-hud-top-right', this.el);
    topRight.append(this.matchInfo.el, this.feed.el);
    const topLeft = h('div', 'dz-hud-top-left', this.el);
    topLeft.append(this.stats.el, this.training.el);
    const left = h('div', 'dz-hud-left', this.el);
    left.append(this.mates.el);
    const bottomLeft = h('div', 'dz-hud-bottom-left', this.el);
    bottomLeft.append(this.minimap.el);
    const bottom = h('div', 'dz-hud-bottom', this.el);
    bottom.append(this.prompt.el, this.vehicle.el, this.vitals.el);
    const bottomRight = h('div', 'dz-hud-bottom-right', this.el);
    bottomRight.append(this.weapons.el);
    const right = h('div', 'dz-hud-right', this.el);
    right.append(this.drop.el);
    this.el.append(this.scoreboard.el, this.inventory.el, this.fullMap.el);

    this.widgets = [
      this.scope, this.crosshair, this.compass, this.zoneWarning, this.plane, this.status, this.matchInfo, this.feed,
      this.stats, this.training, this.mates, this.minimap, this.prompt, this.action, this.vehicle, this.vitals,
      this.weapons, this.drop,
    ];

    settings.subscribe((s) => this.onSettings(s));
    onKeyboardLayout(() => this.relabel());
    ctx.onLanguage(() => this.relabel());
  }

  get overlayOpen(): boolean {
    return this.inventory.isOpen || this.fullMap.isOpen;
  }

  attach(game: ClientGameApi, context: MatchContext): void {
    this.detach();
    const env = new Env(game, context);
    this.env = env;
    for (const w of this.widgets) w.reset();
    this.minimap.attach(env);
    this.fullMap.attach(env);
    this.inventory.attach(env);
    this.unbind.push(this.feed.bind(env));
    this.unbind.push(this.scoreboard.bind(env));
    const on = (ev: InputUiEvent, cb: () => void) => this.unbind.push(game.input.on(ev, cb));
    on('toggleInventory', () => this.fromInput('inventory', () => this.setInventory(!this.inventory.isOpen)));
    on('toggleMap', () => this.fromInput('map', () => this.setMap(!this.fullMap.isOpen)));
    on('toggleStats', () => this.stats.toggle());
    on('toggleScoreboard', () => this.scoreboard.toggle());
  }

  detach(): void {
    for (const u of this.unbind.splice(0)) u();
    this.inventory.detach();
    this.fullMap.detach();
    this.scoreboard.reset();
    for (const w of this.widgets) w.reset();
    this.env = null;
    this.lastFrame = null;
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('dz-hidden', !v);
  }

  update(frame: FrameState, cam: CameraState, dt: number): void {
    const env = this.env;
    if (!env || !this.visible) return;
    this.lastFrame = frame;
    env.sync(frame);
    this.minimap.suppressed = this.fullMap.isOpen;
    for (const w of this.widgets) w.update(frame, cam, env, dt);
    this.scoreboard.update(frame);
    this.inventory.update(frame);
    this.fullMap.update(frame, cam);
    // A dead player has nothing to manage in the inventory.
    if (this.inventory.isOpen && frame.self && frame.self.life === 'dead') this.setInventory(false);
  }

  setRenderStats(stats: RenderStats, ping: number, entities: number): void {
    this.stats.set(stats, ping, entities);
  }

  /** Close inventory / map / scoreboard. `relock` re-captures the pointer for gameplay. */
  closeOverlays(relock: boolean): void {
    const had = this.overlayOpen;
    this.inventory.setOpen(false);
    this.fullMap.setOpen(false);
    this.scoreboard.setOpen(false);
    if (had && relock) this.relock();
  }

  /** Keyboard handling while the game screen is active (window capture phase). True = consumed. */
  handleKey(ev: KeyboardEvent): boolean {
    const env = this.env;
    if (!env || !this.visible || isTyping()) return false;
    const code = ev.code;
    const keys = env.keys;
    if (this.inventory.isOpen) {
      if (code === 'Escape' || code === keys.inventory) {
        if (!ev.repeat) {
          this.lastOwnToggle.inventory = performance.now();
          this.setInventory(false);
        }
        return true;
      }
      if (code === keys.map && !ev.repeat) {
        this.lastOwnToggle.map = performance.now();
        this.setMap(true);
        return true;
      }
      // Keep Tab from walking focus out of the overlay.
      return code === 'Tab';
    }
    if (this.fullMap.isOpen) {
      if (code === 'Escape' || code === keys.map) {
        if (!ev.repeat) {
          this.lastOwnToggle.map = performance.now();
          this.setMap(false);
        }
        return true;
      }
      if (code === keys.inventory && !ev.repeat) {
        this.lastOwnToggle.inventory = performance.now();
        this.setInventory(true);
        return true;
      }
      switch (ev.key) {
        case '+': case '=': this.fullMap.zoomBy(MAP_ZOOM_STEP); return true;
        case '-': case '_': this.fullMap.zoomBy(1 / MAP_ZOOM_STEP); return true;
        default: break;
      }
      switch (code) {
        case 'NumpadAdd': this.fullMap.zoomBy(MAP_ZOOM_STEP); return true;
        case 'NumpadSubtract': this.fullMap.zoomBy(1 / MAP_ZOOM_STEP); return true;
        case 'ArrowLeft': this.fullMap.pan(-MAP_PAN_PX, 0); return true;
        case 'ArrowRight': this.fullMap.pan(MAP_PAN_PX, 0); return true;
        case 'ArrowUp': this.fullMap.pan(0, -MAP_PAN_PX); return true;
        case 'ArrowDown': this.fullMap.pan(0, MAP_PAN_PX); return true;
        case 'Delete': case 'Backspace': env.waypoint.clear(); return true;
        default: return code === 'Tab';
      }
    }
    if (ev.repeat) return false;
    const frame = this.lastFrame;
    const self = frame?.self;
    if (!frame || !self) return false;
    // Training ground: instant respawn (only when the key is not bound to a game action).
    if (env.context === 'training' && code === RESPAWN_CODE && !Object.values(keys).includes(code)) {
      env.game.queueAction({ a: 'respawn' });
      return true;
    }
    // Spectating: cycle through valid targets.
    if (self.life === 'dead' && frame.phase === 'playing' && (code === 'ArrowLeft' || code === 'ArrowRight')) {
      this.cycleSpectate(frame, code === 'ArrowRight' ? 1 : -1);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  private fromInput(kind: 'inventory' | 'map', fn: () => void): void {
    if (performance.now() - this.lastOwnToggle[kind] < TOGGLE_DEBOUNCE_MS) return;
    fn();
  }

  private setInventory(open: boolean): void {
    const env = this.env;
    if (!env || open === this.inventory.isOpen) return;
    if (open) {
      const self = this.lastFrame?.self;
      if (!self || self.life === 'dead') return;
      this.fullMap.setOpen(false);
      // Mark the overlay open before releasing the pointer so the app does not treat the
      // pointer-lock loss as "pause".
      this.inventory.setOpen(true);
      this.releasePointer();
    } else {
      this.inventory.setOpen(false);
      if (!this.overlayOpen) this.relock();
    }
  }

  private setMap(open: boolean): void {
    const env = this.env;
    if (!env || open === this.fullMap.isOpen) return;
    if (open) {
      this.inventory.setOpen(false);
      this.fullMap.setOpen(true);
      this.releasePointer();
    } else {
      this.fullMap.setOpen(false);
      if (!this.overlayOpen) this.relock();
    }
  }

  private releasePointer(): void {
    const input = this.env?.game.input;
    if (!input) return;
    input.enabled = false;
    input.exitLock();
  }

  private relock(): void {
    const input = this.env?.game.input;
    if (!input) return;
    input.enabled = true;
    input.requestLock();
  }

  private cycleSpectate(frame: FrameState, dir: 1 | -1): void {
    const env = this.env;
    const self = frame.self;
    if (!env || !self) return;
    const candidates: EntityId[] = [];
    for (const p of frame.players.values()) {
      if (!p.isSelf && p.isTeammate && p.life !== 'dead') candidates.push(p.id);
    }
    if (!candidates.length && self.killerId !== null) {
      const k = frame.players.get(self.killerId);
      if (k && k.life !== 'dead') candidates.push(k.id);
    }
    if (!candidates.length) {
      for (const p of frame.players.values()) if (!p.isSelf && p.life !== 'dead') candidates.push(p.id);
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => a - b);
    const current = frame.viewTargetId ?? self.spectating;
    const i = current === null ? -1 : candidates.indexOf(current);
    const next = candidates[(i + dir + candidates.length) % candidates.length];
    if (next !== current) env.game.queueAction({ a: 'spectate', id: next });
  }

  private onSettings(s: Settings): void {
    if (this.env && this.env.keys !== s.keybinds) {
      this.env.keys = s.keybinds;
      this.relabel();
    }
  }

  private relabel(): void {
    for (const w of this.widgets) w.relabel();
    this.inventory.relabel();
    this.fullMap.relabel();
    this.scoreboard.relabel();
  }
}
