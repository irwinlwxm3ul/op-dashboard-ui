// App controller: the single owner of application flow. Implements the AppActions the UI calls,
// manages connections (local worker or game server), the lobby flow and the match lifecycle.
//
//   main menu ─┬─ Training ─────────────┐
//              ├─ Single player setup ──┤→ loading → game → results → menu / play again
//              └─ Multiplayer → lobby browser → lobby room → loading → game → results → lobby room

import { botName } from '../../shared/bots';
import { PROTOCOL_VERSION } from '../../shared/constants';
import { Rng } from '../../shared/rng';
import type { LobbySettings, LobbyState, MatchInit, ServerMessage } from '../../shared/protocol';
import type { MatchConfig, MatchResults } from '../../shared/types';
import { audio } from '../audio';
import { settings } from '../game';
import { LocalTransport, WsTransport } from '../net';
import type { RenderCore, WorldRenderer } from '../render/contracts';
import { createUI } from '../ui';
import type { AppActions, MatchContext, SinglePlayerOptions, UiApi, UiErrorCode } from '../ui/contracts';
import { MessageHub } from './hub';
import { MatchSession } from './MatchSession';
import { loadRenderModules, safeCreate, type RenderModules } from './modules';
import { fallbackRenderCore } from './fallbacks';

/** Fixed seed so the training ground is always the same place. */
const TRAINING_SEED = 20261016;
const CONNECT_TIMEOUT_MS = 8000;
const MATCH_INIT_TIMEOUT_MS = 30000;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] >>> 0;
}

function isMatchInit(m: ServerMessage): m is Extract<ServerMessage, { t: 'matchInit' }> {
  return m.t === 'matchInit';
}

export class App implements AppActions {
  readonly ui: UiApi;
  private core: RenderCore | null = null;
  private modules: RenderModules | null = null;
  private cachedWorld: { key: string; renderer: WorldRenderer } | null = null;
  private session: MatchSession | null = null;
  private context: MatchContext = 'sp';
  /** Single-player / training connection (worker) */
  private localHub: MessageHub | null = null;
  /** Multiplayer connection */
  private mpHub: MessageHub | null = null;
  private clientId = '';
  private lobby: LobbyState | null = null;
  private lastSp: SinglePlayerOptions | null = null;
  private starting = false;

  constructor(root: HTMLElement) {
    this.ui = createUI(root, this);
    this.ui.show('main');
    // Warm up the render modules in the background so starting a match is quick.
    void loadRenderModules().then((m) => { this.modules = m; });
    // Expose which modules fell back (debugging + e2e assertions).
    (window as unknown as { __dzFallbacks?: () => string[] }).__dzFallbacks = () => this.modules?.fallbacks ?? [];
    const unlockAudio = () => { void audio.init(); };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    const applyAudio = () => {
      const s = settings.get();
      audio.setSettings({ master: s.masterVolume, sfx: s.sfxVolume, ui: s.uiVolume });
    };
    applyAudio();
    let lastQuality = settings.get().quality;
    let lastScale = settings.get().renderScale;
    settings.subscribe(() => {
      applyAudio();
      const s = settings.get();
      if (this.core && (s.quality !== lastQuality || s.renderScale !== lastScale)) {
        this.core.setQuality(s.quality, s.renderScale);
      }
      lastQuality = s.quality;
      lastScale = s.renderScale;
    });
  }

  // ---------------------------------------------------------------------------
  // Local matches
  // ---------------------------------------------------------------------------

  startTraining(): void {
    void this.startLocal({
      mode: 'training', seed: TRAINING_SEED, maxPlayers: 1, teamSize: 1, botFill: false,
      botDifficulty: 'normal', zoneSpeed: 1, infiniteAmmo: true,
    }, 'training');
  }

  startSinglePlayer(opts: SinglePlayerOptions): void {
    this.lastSp = opts;
    void this.startLocal({
      mode: 'br', seed: randomSeed(), maxPlayers: opts.maxPlayers, teamSize: opts.teamSize, botFill: true,
      botDifficulty: opts.botDifficulty, zoneSpeed: opts.zoneSpeed, infiniteAmmo: false,
    }, 'sp');
  }

  private async startLocal(config: MatchConfig, context: MatchContext): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.endSession();
    this.closeLocal();
    this.ui.show('loading');
    this.ui.setLoading(0.05, 'flow.loading.starting');
    try {
      await nextFrame();
      const transport = new LocalTransport();
      const hub = new MessageHub(transport);
      this.localHub = hub;
      const initP = hub.waitFor(isMatchInit, MATCH_INIT_TIMEOUT_MS);
      transport.start(config, this.playerName());
      this.ui.setLoading(0.15, 'flow.loading.waiting');
      const { init } = await initP;
      await this.beginMatch(hub, init, context);
      // The simulation worker dying mid-match must not leave the player in a frozen match.
      hub.onClose(() => {
        if (this.localHub !== hub) return;
        this.endSession();
        this.closeLocal();
        this.ui.showError('net.connectFailed');
        this.ui.show('main');
      });
    } catch (err) {
      console.error('[app] failed to start local match', err);
      this.closeLocal();
      this.ui.showError('net.connectFailed');
      this.ui.show('main');
    } finally {
      this.starting = false;
    }
  }

  /**
   * The player's display name. If none was entered, generate a language-neutral gamer tag once
   * (same generator as the bots) and remember it, instead of a hardcoded English word.
   */
  private playerName(): string {
    const current = settings.get().playerName.trim();
    if (current) return current;
    const tag = botName(new Rng(randomSeed()));
    settings.set({ playerName: tag });
    return tag;
  }

  private closeLocal(): void {
    if (!this.localHub) return;
    this.localHub.dispose();
    this.localHub.transport.close();
    this.localHub = null;
  }

  // ---------------------------------------------------------------------------
  // Match lifecycle (shared by local and online)
  // ---------------------------------------------------------------------------

  private ensureCore(modules: RenderModules): RenderCore {
    if (!this.core) {
      const host = this.ui.canvasHost;
      this.core = safeCreate('render core', () => modules.createRenderCore(host), () => fallbackRenderCore(host));
      const s = settings.get();
      this.core.setQuality(s.quality, s.renderScale);
      if (this.firstRun && modules.recommendQuality) {
        // First launch on this device: benchmark once and pick a preset that holds 60 FPS.
        const core = this.core;
        void modules.recommendQuality(core).then((q) => {
          if (settings.get().quality !== q) settings.set({ quality: q });
        }).catch(() => { /* keep defaults */ });
      }
    }
    return this.core;
  }

  /** True when the player has never saved settings on this device. */
  private readonly firstRun: boolean = (() => {
    try { return localStorage.getItem('dz.settings') === null; } catch { return false; }
  })();

  private async beginMatch(hub: MessageHub, init: MatchInit, context: MatchContext): Promise<void> {
    this.context = context;
    this.ui.show('loading');
    this.ui.setLoading(0.2, 'flow.loading.world');
    // Cached when everything loaded; re-attempted after a degraded (fallback) load.
    const modules = await loadRenderModules();
    this.modules = modules;
    // Download / decode the 3D assets during the loading screen so nothing visibly swaps from the
    // procedural fallbacks at match start. Bounded: a slow network never blocks the match.
    await this.preloadModels();
    await nextFrame();
    const core = this.ensureCore(modules);
    this.ui.setLoading(0.75, 'flow.loading.scene');
    await nextFrame();
    const session = new MatchSession({
      ui: this.ui,
      core,
      modules,
      worldRenderer: this.cachedWorld,
      transport: hub.gameTransport(),
      init,
      context,
      onResults: (r) => this.onResults(r),
    });
    this.cachedWorld = null;
    this.session = session;
    try {
      this.ui.attachGame(session.game, context);
    } catch (err) {
      this.endSession();
      throw err;
    }
    this.ui.setLoading(1, 'flow.loading.ready');
    await nextFrame();
    this.ui.show('game');
    core.resize();
    session.start();
    hub.send({ t: 'loaded' });
  }

  /** Preload every asset category (cached after the first match), reporting loading progress. */
  private async preloadModels(): Promise<void> {
    const ASSET_PRELOAD_TIMEOUT_MS = 20000;
    try {
      const assets = await import('../assets');
      const progress = (done: number, total: number) => {
        this.ui.setLoading(0.2 + 0.5 * (total > 0 ? done / total : 1), 'flow.loading.assets');
      };
      await Promise.race([
        assets.preloadAssets(['characters', 'weapons', 'items', 'vehicles', 'props', 'nature'], progress),
        new Promise<void>((resolve) => setTimeout(resolve, ASSET_PRELOAD_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.warn('[app] asset preload failed; renderers fall back to procedural models', err);
    }
  }

  private onResults(_results: MatchResults): void {
    // Results screen is shown by the session; nothing else to do here. Multiplayer returns to the lobby
    // when the server sends backToLobby (or when the player clicks "back to lobby").
  }

  private endSession(): void {
    if (!this.session) return;
    this.cachedWorld = this.session.dispose();
    this.session = null;
  }

  leaveMatch(): void {
    if (this.context === 'mp') {
      this.mpHub?.send({ t: 'leaveMatch' });
      this.endSession();
      this.ui.show(this.lobby ? 'lobby' : 'multiplayer');
      return;
    }
    this.endSession();
    this.closeLocal();
    this.ui.show(this.context === 'sp' && this.lastSp ? 'singleplayer' : 'main');
  }

  backToMenu(): void {
    this.endSession();
    this.closeLocal();
    this.disconnectMultiplayer();
    this.ui.show('main');
  }

  resumeGame(): void {
    this.session?.setPaused(false);
  }

  // ---------------------------------------------------------------------------
  // Multiplayer
  // ---------------------------------------------------------------------------

  async connectMultiplayer(name: string): Promise<void> {
    if (this.mpHub && !this.mpHub.closed) {
      this.mpHub.send({ t: 'listLobbies' });
      return;
    }
    settings.set({ playerName: name });
    let transport: WsTransport;
    try {
      transport = await WsTransport.connect();
    } catch {
      throw 'net.serverOffline' satisfies UiErrorCode;
    }
    const hub = new MessageHub(transport);
    this.mpHub = hub;
    hub.on((m) => this.onServerMessage(m));
    hub.onClose(() => this.onDisconnected(hub));
    const welcome = hub.waitFor((m): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome', CONNECT_TIMEOUT_MS);
    const failure = hub.waitFor((m): m is Extract<ServerMessage, { t: 'error' }> => m.t === 'error', CONNECT_TIMEOUT_MS)
      .then((e) => { throw e.code; }, () => new Promise<never>(() => {}));
    hub.send({ t: 'hello', name, version: PROTOCOL_VERSION, codec: 'delta1' });
    try {
      const w = await Promise.race([welcome, failure]);
      this.clientId = w.clientId;
    } catch (err) {
      this.disconnectMultiplayer();
      throw typeof err === 'string' ? err : ('net.connectFailed' satisfies UiErrorCode);
    }
    hub.send({ t: 'listLobbies' });
  }

  disconnectMultiplayer(): void {
    const hub = this.mpHub;
    if (!hub) return;
    this.mpHub = null;
    this.lobby = null;
    hub.dispose();
    hub.transport.close();
  }

  private onDisconnected(hub: MessageHub): void {
    if (this.mpHub !== hub) return; // deliberate disconnect
    this.mpHub = null;
    this.lobby = null;
    hub.dispose();
    if (this.context === 'mp') this.endSession();
    this.ui.showError('net.disconnected');
    this.ui.show('multiplayer');
  }

  private onServerMessage(m: ServerMessage): void {
    switch (m.t) {
      case 'lobbyList':
        this.ui.setLobbyList(m.lobbies);
        break;
      case 'lobbyState':
        this.lobby = m.lobby;
        this.ui.setLobbyState(m.lobby, this.clientId);
        if (!this.session && this.ui.screen !== 'loading' && this.ui.screen !== 'results') this.ui.show('lobby');
        break;
      case 'lobbyLeft':
        this.lobby = null;
        this.ui.setLobbyState(null, this.clientId);
        if (!this.session) this.ui.show('multiplayer');
        this.mpHub?.send({ t: 'listLobbies' });
        break;
      case 'error':
        this.ui.showError(m.code);
        break;
      case 'chat':
        this.ui.addChat(m.from, m.text);
        break;
      case 'matchInit':
        if (this.mpHub) {
          this.endSession();
          void this.beginMatch(this.mpHub, m.init, 'mp').catch((err) => {
            console.error('[app] failed to start online match', err);
            // Tell the server we're not in the match, so it stops streaming to us and the lobby
            // can return to waiting (it also lets abandoned-match cleanup run).
            this.mpHub?.send({ t: 'leaveMatch' });
            this.endSession();
            this.ui.showError('net.connectFailed');
            this.ui.show('lobby');
          });
        }
        break;
      case 'matchOver':
        this.session?.handleMatchOver(m.results);
        break;
      case 'backToLobby':
        // Stay on the results screen if the player is reading it; otherwise go back to the room.
        if (this.ui.screen !== 'results') {
          this.endSession();
          this.ui.show('lobby');
        } else {
          this.endSession();
        }
        break;
      default:
        break;
    }
  }

  refreshLobbies(): void { this.mpHub?.send({ t: 'listLobbies' }); }
  createLobby(s: LobbySettings): void { this.mpHub?.send({ t: 'createLobby', settings: s }); }
  joinLobby(id: string): void { this.mpHub?.send({ t: 'joinLobby', id }); }
  leaveLobby(): void { this.mpHub?.send({ t: 'leaveLobby' }); }
  updateLobbySettings(s: LobbySettings): void { this.mpHub?.send({ t: 'lobbySettings', settings: s }); }
  setTeam(team: number): void { this.mpHub?.send({ t: 'setTeam', team }); }
  setReady(ready: boolean): void { this.mpHub?.send({ t: 'ready', ready }); }
  startLobbyMatch(): void { this.mpHub?.send({ t: 'startMatch' }); }
  sendChat(text: string): void { this.mpHub?.send({ t: 'chat', text }); }
}
