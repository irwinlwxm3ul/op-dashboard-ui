// One running match on the client: owns the ClientGame and the per-match render stack, runs the
// frame loop in the order defined in render/contracts.ts, and reports the end of the match.

import type { MatchInit } from '../../shared/protocol';
import type { MatchResults } from '../../shared/types';
import { ClientGame, settings } from '../game';
import { t } from '../i18n';
import type { ClientGameApi, FrameState } from '../game/types';
import type { Transport } from '../net';
import type {
  CameraState, EntityRenderer, Feel, FxRenderer, RenderCore, ViewRig, WorldRenderer,
} from '../render/contracts';
import type { MatchContext, UiApi } from '../ui/contracts';
import {
  fallbackEntityRenderer, fallbackViewRig, fallbackWorldRenderer, noopFeel, noopFx,
} from './fallbacks';
import { safeCreate, type RenderModules } from './modules';

/** Delay before the results screen so the winner/elimination banners can play. */
const RESULTS_DELAY_MS = 4500;
const STATS_INTERVAL_MS = 500;
/** Render / feel delta clamp (avoids huge jumps after a stall). */
const MAX_FRAME_DT = 0.1;
/**
 * The game itself gets a larger delta so its fixed 30 Hz input stream keeps up at low frame rates
 * (ClientGame additionally caps the ticks it produces per frame).
 */
const MAX_GAME_DT = 0.25;
/** A module that throws this many frames in a row is replaced by its fallback for the rest of the match. */
const MAX_CONSECUTIVE_FAILURES = 30;

export interface MatchSessionOptions {
  ui: UiApi;
  core: RenderCore;
  modules: RenderModules;
  /** Cached world renderer reused across matches on the same world, or null to create one. */
  worldRenderer: { key: string; renderer: WorldRenderer } | null;
  transport: Transport;
  init: MatchInit;
  context: MatchContext;
  onResults(results: MatchResults): void;
}

export class MatchSession {
  readonly game: ClientGame;
  readonly worldKey: string;
  private worldRendererRef: WorldRenderer;
  get worldRenderer(): WorldRenderer {
    return this.worldRendererRef;
  }
  private entities: EntityRenderer;
  private view: ViewRig;
  private fx: FxRenderer;
  private feel: Feel;
  private raf = 0;
  private running = false;
  private last = 0;
  private lastStats = 0;
  private lastCam: CameraState | null = null;
  private resultsTimer: ReturnType<typeof setTimeout> | null = null;
  private resultsShown = false;
  private paused = false;
  private unsubs: Array<() => void> = [];
  private lastFrame: FrameState | null = null;

  constructor(private readonly opts: MatchSessionOptions) {
    const { ui, core, modules, init } = opts;
    this.game = new ClientGame(opts.transport, init, settings);
    const world = this.game.world;
    this.worldKey = `${init.config.seed}:${world.kind}`;

    if (opts.worldRenderer && opts.worldRenderer.key === this.worldKey) {
      this.worldRendererRef = opts.worldRenderer.renderer;
    } else {
      opts.worldRenderer?.renderer.dispose();
      this.worldRendererRef = safeCreate('world renderer', () => modules.createWorldRenderer(core, world), () => fallbackWorldRenderer(core, world));
    }
    const events = this.game.events;
    this.entities = safeCreate('entity renderer', () => modules.createEntityRenderer(core, world, ui.nameplateLayer, events), () => fallbackEntityRenderer(core));
    this.view = safeCreate('view rig', () => modules.createViewRig(core, world, events), () => fallbackViewRig(core));
    this.fx = safeCreate('fx renderer', () => modules.createFxRenderer(core, world, events), () => noopFx);
    this.feel = safeCreate('feel', () => modules.createFeel(events, ui.feelLayer), () => noopFeel());

    const input = this.game.input;
    input.attach(core.canvas);
    this.unsubs.push(input.on('menu', () => this.setPaused(!this.paused)));
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.unsubs.push(() => document.removeEventListener('pointerlockchange', this.onPointerLockChange));
    this.unsubs.push(events.on('matchEnd', (ev) => this.scheduleResults(ev.results)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.startedAt = this.last;
    this.raf = requestAnimationFrame(this.tick);
    this.game.input.requestLock();
  }

  /** Server-side match-over message (multiplayer) — same handling as the matchEnd event. */
  handleMatchOver(results: MatchResults): void {
    this.scheduleResults(results);
  }

  setPaused(open: boolean): void {
    if (this.resultsShown) return;
    this.paused = open;
    this.opts.ui.setPaused(open);
    if (open) this.game.input.exitLock();
    else this.game.input.requestLock();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private onPointerLockChange = (): void => {
    // Browsers release pointer lock on Esc without delivering the key; treat that as "open the pause menu"
    // unless a UI overlay (inventory/map) deliberately released it.
    if (!this.running || this.resultsShown) return;
    if (!document.pointerLockElement && !this.opts.ui.isOverlayOpen()) this.setPaused(true);
  };

  private scheduleResults(results: MatchResults): void {
    if (this.resultsTimer || this.resultsShown || this.opts.context === 'training') return;
    this.resultsTimer = setTimeout(() => {
      this.resultsShown = true;
      this.game.input.exitLock();
      this.opts.ui.showResults(results, this.lastFrame, this.opts.context);
      this.opts.onResults(results);
    }, RESULTS_DELAY_MS);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const rawDt = Math.max(0, (now - this.last) / 1000);
    const dt = Math.min(MAX_FRAME_DT, rawDt);
    this.last = now;
    const { ui, core } = this.opts;
    // Each stage is guarded on its own so one failing module can't freeze the view or the HUD;
    // a module that keeps failing is swapped for its minimal fallback.
    this.guard('game', () => {
      this.game.input.enabled = !this.paused && !this.resultsShown && !ui.isOverlayOpen();
      this.game.update(Math.min(MAX_GAME_DT, rawDt));
    });
    const frame = this.game.getFrame();
    this.lastFrame = frame;
    this.guard('feel', () => this.feel.update(frame, this.lastCam, dt));
    let cam = this.lastCam;
    this.guard('view', () => { cam = this.view.update(frame, this.feel.state, dt); });
    this.lastCam = cam;
    // One-shot aim handoff from the camera rig (e.g. leaving a vehicle chase cam).
    const handoff = (cam as CameraState | null)?.aimHandoff;
    if (handoff) (this.game as ClientGameApi).setAim?.(handoff.yaw, handoff.pitch);
    if (cam) {
      const c = cam;
      this.guard('world', () => this.worldRenderer.update(frame, c, dt));
      this.guard('entities', () => this.entities.update(frame, c, dt));
      this.guard('fx', () => this.fx.update(frame, c, dt));
      this.guard('render', () => core.render());
      this.guard('hud', () => ui.updateHud(frame, c, dt));
    }
    if (now - this.lastStats > STATS_INTERVAL_MS) {
      this.lastStats = now;
      const entities = frame.players.size + frame.vehicles.size + frame.projectiles.size + frame.loot.size;
      this.guard('stats', () => ui.setRenderStats(core.stats(), frame.ping, entities));
    }
    if (frame.results && !this.resultsTimer) this.scheduleResults(frame.results);
    this.updateClickToPlay(now);
  };

  // ---------------------------------------------------------------------------
  // "Click to play": shown while playing without pointer lock (lock denied / not yet granted),
  // so mouse look is never silently dead.
  // ---------------------------------------------------------------------------
  private clickOverlay: HTMLElement | null = null;
  private startedAt = 0;

  private updateClickToPlay(now: number): void {
    const want = this.running && !this.paused && !this.resultsShown && !this.opts.ui.isOverlayOpen()
      && !document.pointerLockElement && now - this.startedAt > 800;
    if (want && !this.clickOverlay) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'dz-click-to-play';
      el.textContent = t('flow.clickToPlay');
      Object.assign(el.style, {
        position: 'absolute', inset: '0', margin: 'auto', width: 'max-content', height: 'max-content',
        padding: '0.9rem 1.6rem', font: '600 1.1rem system-ui, sans-serif', color: '#fff',
        background: 'rgba(10,12,16,0.72)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: '10px',
        cursor: 'pointer', zIndex: '5', pointerEvents: 'auto',
      } satisfies Partial<CSSStyleDeclaration>);
      el.addEventListener('click', () => this.game.input.requestLock());
      this.opts.ui.canvasHost.appendChild(el);
      this.clickOverlay = el;
    } else if (!want && this.clickOverlay) {
      this.clickOverlay.remove();
      this.clickOverlay = null;
    }
  }

  private failures = new Map<string, number>();

  private guard(stage: string, fn: () => void): void {
    try {
      fn();
      if (this.failures.get(stage)) this.failures.set(stage, 0);
    } catch (err) {
      const n = (this.failures.get(stage) ?? 0) + 1;
      this.failures.set(stage, n);
      const now = performance.now();
      if (now - this.lastErrorLog > 1000) {
        this.lastErrorLog = now;
        console.error(`[app] ${stage} failed`, err);
      }
      if (n === MAX_CONSECUTIVE_FAILURES) this.replaceWithFallback(stage);
    }
  }

  /** Swap a persistently failing module for its minimal fallback (keeps the match playable). */
  private replaceWithFallback(stage: string): void {
    const { core } = this.opts;
    const dispose = (d: { dispose(): void }) => { try { d.dispose(); } catch { /* ignore */ } };
    console.error(`[app] ${stage} keeps failing; switching to the fallback implementation`);
    switch (stage) {
      case 'feel': dispose(this.feel); this.feel = noopFeel(); break;
      case 'view': dispose(this.view); this.view = fallbackViewRig(core); break;
      case 'entities': dispose(this.entities); this.entities = fallbackEntityRenderer(core); break;
      case 'fx': dispose(this.fx); this.fx = noopFx; break;
      case 'world': dispose(this.worldRenderer); this.worldRendererRef = fallbackWorldRenderer(core, this.game.world); break;
      default: break;
    }
    this.failures.set(stage, 0);
  }

  private lastErrorLog = 0;

  /** Dispose everything except the (cacheable) world renderer, which is returned to the caller. */
  dispose(): { key: string; renderer: WorldRenderer } {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.clickOverlay?.remove();
    this.clickOverlay = null;
    if (this.resultsTimer) clearTimeout(this.resultsTimer);
    for (const u of this.unsubs.splice(0)) u();
    this.game.input.exitLock();
    this.game.input.detach();
    for (const d of [this.entities, this.view, this.fx, this.feel]) {
      try { d.dispose(); } catch (err) { console.error('[app] dispose failed', err); }
    }
    this.game.dispose();
    this.opts.ui.detachGame();
    return { key: this.worldKey, renderer: this.worldRenderer };
  }
}
