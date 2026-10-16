// UI module entry: builds the layer stack (canvas host, nameplates, feel overlays, HUD, menus,
// modals, toasts) and implements UiApi for the app controller. Plain DOM + CSS.

import '../styles/base.css';
import '../styles/menus.css';
import '../styles/hud.css';
import '../styles/map.css';

import { onLanguageChange } from '../i18n';
import { audio } from '../audio';
import type { LobbyState, LobbySummary } from '../../shared/protocol';
import type { MatchResults } from '../../shared/types';
import type { ClientGameApi, FrameState } from '../game/types';
import type { CameraState, RenderStats } from '../render/contracts';
import type { AppActions, CreateUI, MatchContext, Screen, UiApi, UiErrorCode } from './contracts';
import type { ScreenView, UiCtx } from './context';
import { h, isTyping, retranslate } from './dom';
import { isConnectionLoss, uiErrorText } from './errors';
import { Hud } from './hud/hud';
import { initKeyboardLayout } from './keys';
import { ModalManager } from './modal';
import { ControlsModal } from './modals/controlsModal';
import { PauseMenu } from './modals/pauseMenu';
import { SettingsModal } from './modals/settingsModal';
import { LoadingScreen } from './screens/loading';
import { LobbyRoomScreen } from './screens/lobbyRoom';
import { MainMenu } from './screens/mainMenu';
import { MultiplayerScreen } from './screens/multiplayer';
import { ResultsScreen } from './screens/results';
import { SinglePlayerScreen } from './screens/singlePlayer';
import { Toasts } from './toast';

type MenuScreen = Exclude<Screen, 'game'>;

const HOVER_SOUND_GAP_MS = 45;

class Ui implements UiApi, UiCtx {
  readonly root: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly nameplateLayer: HTMLElement;
  readonly feelLayer: HTMLElement;
  readonly modals: ModalManager;

  private current: Screen = 'main';
  private readonly screensEl: HTMLElement;
  private readonly views: Record<MenuScreen, ScreenView>;
  private readonly mainMenu: MainMenu;
  private readonly sp: SinglePlayerScreen;
  private readonly mp: MultiplayerScreen;
  private readonly lobby: LobbyRoomScreen;
  private readonly loading: LoadingScreen;
  private readonly results: ResultsScreen;
  private readonly hud: Hud;
  private readonly toasts: Toasts;
  private readonly langCallbacks: Array<() => void> = [];
  private settingsModal: SettingsModal | null = null;
  private controlsModal: ControlsModal | null = null;
  private readonly pauseMenu: PauseMenu;
  private lastHover: Element | null = null;
  private lastHoverAt = 0;

  constructor(host: HTMLElement, readonly actions: AppActions) {
    this.root = h('div', 'dz-root', host);
    this.root.dataset.screen = this.current;

    this.canvasHost = h('div', 'dz-canvas-host', this.root);
    this.nameplateLayer = h('div', 'dz-nameplates', this.root);
    this.nameplateLayer.setAttribute('aria-hidden', 'true');
    this.feelLayer = h('div', 'dz-feel', this.root);
    this.feelLayer.setAttribute('aria-hidden', 'true');

    this.modals = new ModalManager(h('div', 'dz-modals'));
    this.hud = new Hud(this);
    this.root.appendChild(this.hud.el);
    this.screensEl = h('div', 'dz-screens', this.root);
    this.root.appendChild(this.modals.layer);
    this.toasts = new Toasts(this.root);

    this.mainMenu = new MainMenu(this);
    this.sp = new SinglePlayerScreen(this);
    this.mp = new MultiplayerScreen(this);
    this.lobby = new LobbyRoomScreen(this);
    this.loading = new LoadingScreen(this);
    this.results = new ResultsScreen(this);
    this.views = {
      main: this.mainMenu,
      singleplayer: this.sp,
      multiplayer: this.mp,
      lobby: this.lobby,
      loading: this.loading,
      results: this.results,
    };
    for (const v of Object.values(this.views)) {
      v.el.classList.add('dz-hidden');
      this.screensEl.appendChild(v.el);
    }
    this.pauseMenu = new PauseMenu(this.modals, this);

    initKeyboardLayout();
    onLanguageChange(() => {
      retranslate(this.root);
      for (const cb of this.langCallbacks) cb();
    });
    window.addEventListener('keydown', this.onKeyDown, true);
    this.root.addEventListener('click', this.onClickSound, true);
    this.root.addEventListener('pointerover', this.onHoverSound);
    this.root.addEventListener('contextmenu', (ev) => {
      const target = ev.target as HTMLElement;
      if (!target.closest('input, textarea')) ev.preventDefault();
    });
    this.applyScreen(null);
  }

  // ---------------------------------------------------------------------------
  // UiCtx
  // ---------------------------------------------------------------------------

  get screen(): Screen {
    return this.current;
  }

  openSettings(): void {
    this.settingsModal ??= new SettingsModal(this.modals, this);
    this.settingsModal.open();
  }

  openControls(): void {
    this.controlsModal ??= new ControlsModal(this.modals, this);
    this.controlsModal.open();
  }

  toast(text: string, kind: 'error' | 'info' = 'info'): void {
    this.toasts.show(text, kind);
  }

  onLanguage(cb: () => void): void {
    this.langCallbacks.push(cb);
  }

  // ---------------------------------------------------------------------------
  // UiApi
  // ---------------------------------------------------------------------------

  show(screen: Screen): void {
    const prev = this.current;
    this.current = screen;
    this.applyScreen(prev);
  }

  setLobbyList(list: LobbySummary[]): void {
    this.mp.setLobbies(list);
  }

  setLobbyState(state: LobbyState | null, myClientId: string): void {
    this.lobby.setState(state, myClientId);
  }

  addChat(from: string, text: string): void {
    this.lobby.addChat(from, text);
  }

  showError(code: UiErrorCode): void {
    this.toasts.show(uiErrorText(code), 'error');
    if (isConnectionLoss(code)) this.mp.onError(code);
  }

  setLoading(progress: number, stepKey: string): void {
    this.loading.set(progress, stepKey);
  }

  attachGame(game: ClientGameApi, context: MatchContext): void {
    this.hud.attach(game, context);
    this.pauseMenu.setMultiplayer(context === 'mp');
  }

  detachGame(): void {
    this.hud.detach();
    this.pauseMenu.close();
  }

  updateHud(frame: FrameState, cam: CameraState, dt: number): void {
    if (this.current !== 'game') return;
    this.hud.update(frame, cam, dt);
  }

  showResults(results: MatchResults, frame: FrameState | null, context: MatchContext): void {
    this.hud.closeOverlays(false);
    this.pauseMenu.close();
    this.results.set(results, frame, context);
    this.show('results');
  }

  setPaused(open: boolean): void {
    if (open) {
      if (this.current !== 'game') return;
      this.hud.closeOverlays(false);
      if (!this.pauseMenu.isOpen) this.pauseMenu.open();
    } else {
      // Closing the pause menu also closes settings / controls opened from it.
      this.settingsModal?.close();
      this.controlsModal?.close();
      this.pauseMenu.close();
    }
  }

  isOverlayOpen(): boolean {
    return this.pauseMenu.isOpen
      || !!this.settingsModal?.isOpen
      || !!this.controlsModal?.isOpen
      || this.hud.overlayOpen;
  }

  setRenderStats(stats: RenderStats, ping: number, entities: number): void {
    this.hud.setRenderStats(stats, ping, entities);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private applyScreen(prev: Screen | null): void {
    const screen = this.current;
    this.root.dataset.screen = screen;
    if (prev && prev !== screen && prev !== 'game') this.views[prev].onHide?.();
    for (const [name, view] of Object.entries(this.views) as [MenuScreen, ScreenView][]) {
      const on = name === screen;
      view.el.classList.toggle('dz-hidden', !on);
      if (on && prev !== screen) {
        view.el.classList.remove('dz-screen-enter');
        void view.el.offsetWidth;
        view.el.classList.add('dz-screen-enter');
      }
    }
    const inGame = screen === 'game';
    this.hud.setVisible(inGame);
    this.screensEl.classList.toggle('dz-screens-idle', inGame);
    this.nameplateLayer.classList.toggle('dz-hidden', !inGame);
    this.feelLayer.classList.toggle('dz-hidden', !inGame && screen !== 'loading');
    if (!inGame) {
      this.hud.closeOverlays(false);
      this.pauseMenu.close();
    }
    if (screen === 'main' && prev !== null && prev !== 'main') this.mp.reset();
    if (inGame) {
      // Keys must reach the game, not a focused menu button.
      (document.activeElement as HTMLElement | null)?.blur?.();
    } else if (prev !== screen) {
      const view = this.views[screen];
      view.onShow?.();
      if (!this.modals.open) {
        const target = view.el.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
        target?.focus({ preventScroll: true });
      }
    }
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (this.modals.open) {
      if (this.modals.handleKey(ev)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      return;
    }
    if (this.current === 'game') {
      if (this.hud.handleKey(ev)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      return;
    }
    if (ev.key === 'Escape' && !isTyping()) {
      const view = this.views[this.current];
      if (view.onEscape?.()) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }
  };

  private readonly onClickSound = (ev: MouseEvent): void => {
    const el = (ev.target as HTMLElement | null)?.closest('button, select, input[type="checkbox"], .dz-click');
    if (!el || (el as HTMLButtonElement).disabled) return;
    audio.ui('click');
  };

  private readonly onHoverSound = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'mouse') return;
    const el = (ev.target as HTMLElement | null)?.closest('.dz-screens button, .dz-modals button, .dz-inventory button');
    if (el === this.lastHover) return;
    this.lastHover = el;
    if (!el || (el as HTMLButtonElement).disabled) return;
    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_SOUND_GAP_MS) return;
    this.lastHoverAt = now;
    audio.ui('hover');
  };
}

/** Entry point used by the app controller. */
export const createUI: CreateUI = (root: HTMLElement, actions: AppActions): UiApi => new Ui(root, actions);
