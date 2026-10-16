// CONTRACT (owned by the integrator). Interface between the app controller (src/client/app) and
// the UI module (src/client/ui). The UI never talks to the network or simulation directly: it calls
// AppActions and receives state through UiApi.

import type { LobbyErrorCode, LobbySettings, LobbyState, LobbySummary } from '../../shared/protocol';
import type { BotDifficulty, MatchResults, TeamSize } from '../../shared/types';
import type { ClientGameApi, FrameState } from '../game/types';
import type { CameraState, RenderStats } from '../render/contracts';

export type Screen =
  | 'main'
  | 'singleplayer'
  | 'multiplayer'
  | 'lobby'
  | 'loading'
  | 'game'
  | 'results';

export type UiErrorCode = LobbyErrorCode | 'net.disconnected' | 'net.connectFailed' | 'net.serverOffline';

export interface SinglePlayerOptions {
  maxPlayers: number;
  teamSize: TeamSize;
  botDifficulty: BotDifficulty;
  zoneSpeed: number;
}

export type MatchContext = 'sp' | 'training' | 'mp';

/** Implemented by the app controller; called by the UI. */
export interface AppActions {
  startSinglePlayer(opts: SinglePlayerOptions): void;
  startTraining(): void;
  /** Connect to the game server (lobby browser). Rejects with a UiErrorCode string on failure. */
  connectMultiplayer(name: string): Promise<void>;
  disconnectMultiplayer(): void;
  refreshLobbies(): void;
  createLobby(settings: LobbySettings): void;
  joinLobby(id: string): void;
  leaveLobby(): void;
  updateLobbySettings(settings: LobbySettings): void;
  setTeam(team: number): void;
  setReady(ready: boolean): void;
  startLobbyMatch(): void;
  sendChat(text: string): void;
  /** Leave the running match (pause menu / results). Goes back to lobby (mp) or menu (sp/training). */
  leaveMatch(): void;
  /** Return to the main menu from anywhere. */
  backToMenu(): void;
  /** Close the pause menu and re-lock the pointer. */
  resumeGame(): void;
}

/** Implemented by src/client/ui; called by the app controller. */
export interface UiApi {
  show(screen: Screen): void;
  readonly screen: Screen;
  setLobbyList(list: LobbySummary[]): void;
  setLobbyState(state: LobbyState | null, myClientId: string): void;
  addChat(from: string, text: string): void;
  showError(code: UiErrorCode): void;
  /** Loading screen progress (0..1) with an i18n key for the current step. */
  setLoading(progress: number, stepKey: string): void;
  /** Bind the in-game HUD to a running match. */
  attachGame(game: ClientGameApi, context: MatchContext): void;
  detachGame(): void;
  /** Called every frame while a match is attached. */
  updateHud(frame: FrameState, cam: CameraState, dt: number): void;
  showResults(results: MatchResults, frame: FrameState | null, context: MatchContext): void;
  /** Pause menu (Esc) */
  setPaused(open: boolean): void;
  /** True when a UI overlay that needs the mouse is open (pause, inventory, map, settings). */
  isOverlayOpen(): boolean;
  setRenderStats(stats: RenderStats, ping: number, entities: number): void;
  /** Layer for game-feel overlays (hitmarkers, damage indicators, banners). */
  readonly feelLayer: HTMLElement;
  /** Layer for world-anchored nameplates / markers (entity renderer). */
  readonly nameplateLayer: HTMLElement;
  /** Container the 3D canvas is mounted into (behind all UI). */
  readonly canvasHost: HTMLElement;
}

export type CreateUI = (root: HTMLElement, actions: AppActions) => UiApi;
