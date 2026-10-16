// One running match on the client: owns the ClientGame and the per-match render stack, runs the
// frame loop in the order defined in render/contracts.ts, and reports the end of the match.

import type { MatchInit } from '../../shared/protocol';
import type { MatchResults } from '../../shared/types';
import { ClientGame, settings } from '../game';
import type { FrameState } from '../game/types';
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
const MAX_FRAME_DT = 0.1;

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
  readonly worldRenderer: WorldRenderer;
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
      this.worldRenderer = opts.worldRenderer.renderer;
    } else {
      opts.worldRenderer?.renderer.dispose();
      this.worldRenderer = safeCreate('world renderer', () => modules.createWorldRenderer(core, world), () => fallbackWorldRenderer(core, world));
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
    const dt = Math.min(MAX_FRAME_DT, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const { ui, core } = this.opts;
    try {
      this.game.input.enabled = !this.paused && !this.resultsShown && !ui.isOverlayOpen();
      this.game.update(dt);
      const frame = this.game.getFrame();
      this.lastFrame = frame;
      this.feel.update(frame, this.lastCam, dt);
      const cam = this.view.update(frame, this.feel.state, dt);
      this.lastCam = cam;
      this.worldRenderer.update(frame, cam, dt);
      this.entities.update(frame, cam, dt);
      this.fx.update(frame, cam, dt);
      core.render();
      ui.updateHud(frame, cam, dt);
      if (now - this.lastStats > STATS_INTERVAL_MS) {
        this.lastStats = now;
        const entities = frame.players.size + frame.vehicles.size + frame.projectiles.size + frame.loot.size;
        ui.setRenderStats(core.stats(), frame.ping, entities);
      }
      if (frame.results && !this.resultsTimer) this.scheduleResults(frame.results);
    } catch (err) {
      // Never let one bad frame kill the loop; log once per second at most.
      if (now - this.lastErrorLog > 1000) {
        this.lastErrorLog = now;
        console.error('[app] frame error', err);
      }
    }
  };
  private lastErrorLog = 0;

  /** Dispose everything except the (cacheable) world renderer, which is returned to the caller. */
  dispose(): { key: string; renderer: WorldRenderer } {
    this.running = false;
    cancelAnimationFrame(this.raf);
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
