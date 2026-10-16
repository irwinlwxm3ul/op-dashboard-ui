// Lobby browser: connect with a player name, list / refresh / join lobbies, create a lobby.

import { t } from '../../i18n';
import { settings } from '../../game';
import { MAX_LOBBY_NAME_LEN, MAX_NAME_LEN } from '../../../shared/constants';
import { DEFAULT_LOBBY_SETTINGS, type LobbySummary } from '../../../shared/protocol';
import { sanitizeName, sanitizeText } from '../../../shared/validate';
import type { UiErrorCode } from '../contracts';
import type { ScreenView, UiCtx } from '../context';
import { button, clear, h, placeholderTx, svgIcon, tx, txp } from '../dom';
import { isConnectionLoss, uiErrorText } from '../errors';
import { ICONS } from '../icons';
import { teamSizeKey } from '../options';
import { menuBackdrop } from './mainMenu';
import { LobbyForm } from './lobbyForm';

type ConnState = 'idle' | 'connecting' | 'connected' | 'error';

const REFRESH_MS = 5000;

export class MultiplayerScreen implements ScreenView {
  readonly el: HTMLElement;
  private state: ConnState = 'idle';
  private errorCode: UiErrorCode | string | null = null;
  private lobbies: LobbySummary[] = [];
  private connectedAs = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private joinLockUntil = 0;
  private visible = false;
  private connectSeq = 0;

  private readonly connPanel: HTMLElement;
  private readonly nameRow: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly statusLine: HTMLElement;
  private readonly connectedRow: HTMLElement;
  private readonly connectedText: HTMLElement;
  private readonly listBody: HTMLElement;
  private readonly listEmpty: HTMLElement;
  private readonly listPanel: HTMLElement;
  private readonly createPanel: HTMLElement;
  private readonly form: LobbyForm;
  private readonly createBtn: HTMLButtonElement;
  private readonly refreshBtn: HTMLButtonElement;
  private formTouched = false;

  constructor(private readonly ctx: UiCtx) {
    this.el = h('section', 'dz-screen dz-mp');
    menuBackdrop(this.el);
    const wrap = h('div', 'dz-screen-wrap', this.el);
    const header = h('header', 'dz-screen-header', wrap);
    button({ cls: 'dz-btn-ghost dz-back', label: 'common.back', parent: header, onClick: () => this.back() });
    tx(h('h2', 'dz-screen-title', header), 'mp.title');

    // --- connection bar -----------------------------------------------------------------------
    this.connPanel = h('div', 'dz-panel dz-mp-conn', wrap);
    this.nameRow = h('div', 'dz-mp-conn-row', this.connPanel);
    const nameLabel = tx(h('label', 'dz-field-label', this.nameRow), 'menu.playerName');
    this.nameInput = h('input', 'dz-input', this.nameRow);
    this.nameInput.id = 'dz-mp-name';
    nameLabel.htmlFor = this.nameInput.id;
    this.nameInput.type = 'text';
    this.nameInput.maxLength = MAX_NAME_LEN;
    this.nameInput.spellcheck = false;
    placeholderTx(this.nameInput, 'menu.playerNamePlaceholder');
    this.nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.connect();
    });
    this.nameInput.addEventListener('input', () => this.nameInput.classList.remove('dz-invalid'));
    this.nameInput.dataset.testid = 'mp-name';
    this.connectBtn = button({ cls: 'dz-btn-primary', label: 'mp.connect', parent: this.nameRow, onClick: () => this.connect() });
    this.connectBtn.dataset.testid = 'mp-connect';

    this.connectedRow = h('div', 'dz-mp-conn-row', this.connPanel);
    h('span', 'dz-dot dz-dot-ok', this.connectedRow);
    this.connectedText = h('span', 'dz-mp-conn-text', this.connectedRow);
    button({ cls: 'dz-btn-ghost', label: 'ui.mp.disconnect', parent: this.connectedRow, onClick: () => this.disconnect() });

    this.statusLine = h('div', 'dz-mp-status', this.connPanel);
    this.statusLine.setAttribute('role', 'status');

    // --- lobby list + create -------------------------------------------------------------------
    const grid = h('div', 'dz-mp-grid', wrap);
    this.listPanel = h('div', 'dz-panel dz-mp-list', grid);
    const listHead = h('div', 'dz-panel-head', this.listPanel);
    tx(h('h3', 'dz-panel-title', listHead), 'mp.lobbies');
    this.refreshBtn = button({ cls: 'dz-btn-ghost dz-btn-sm', label: 'mp.refresh', icon: ICONS.refresh, parent: listHead, onClick: () => this.refresh() });
    this.refreshBtn.dataset.testid = 'mp-refresh';

    const table = h('div', 'dz-table dz-lobby-table', this.listPanel);
    table.setAttribute('role', 'table');
    const thead = h('div', 'dz-tr dz-th', table);
    thead.setAttribute('role', 'row');
    for (const k of ['mp.col.name', 'mp.col.host', 'mp.col.players', 'mp.col.mode', 'mp.col.status'] as const) {
      const c = tx(h('div', 'dz-td', thead), k);
      c.setAttribute('role', 'columnheader');
    }
    h('div', 'dz-td', thead).setAttribute('role', 'columnheader');
    this.listBody = h('div', 'dz-tbody', table);
    this.listEmpty = h('div', 'dz-empty', this.listPanel);

    this.createPanel = h('div', 'dz-panel dz-mp-create', grid);
    const createHead = h('div', 'dz-panel-head', this.createPanel);
    tx(h('h3', 'dz-panel-title', createHead), 'mp.createLobby');
    this.form = new LobbyForm({ ...DEFAULT_LOBBY_SETTINGS, name: '' }, () => { this.formTouched = true; }, 'create');
    this.createPanel.appendChild(this.form.el);
    const createFooter = h('div', 'dz-panel-foot', this.createPanel);
    this.createBtn = button({ cls: 'dz-btn-primary', label: 'common.create', parent: createFooter, onClick: () => this.create() });
    this.createBtn.dataset.testid = 'create-submit';

    ctx.onLanguage(() => {
      this.form.relabel();
      this.render();
    });
    this.render();
  }

  onShow(): void {
    this.visible = true;
    this.nameInput.value = settings.get().playerName;
    if (!this.formTouched) this.form.set({ ...DEFAULT_LOBBY_SETTINGS, name: this.defaultLobbyName() });
    if (this.state === 'connected') {
      // Re-validate the connection silently (the app may have dropped it while we were away).
      this.connect(true);
    } else {
      // Connecting is an explicit action (the name is sent to the server).
      this.nameInput.focus();
    }
    this.startAutoRefresh();
    this.render();
  }

  onHide(): void {
    this.visible = false;
    this.stopAutoRefresh();
  }

  onEscape(): boolean {
    this.back();
    return true;
  }

  /** The app returned to the main menu (connection closed). */
  reset(): void {
    this.state = 'idle';
    this.errorCode = null;
    this.lobbies = [];
    this.connectSeq++;
    this.render();
  }

  setLobbies(list: LobbySummary[]): void {
    this.lobbies = list.slice().sort((a, b) => {
      const sa = a.status === 'waiting' ? 0 : 1;
      const sb = b.status === 'waiting' ? 0 : 1;
      return sa - sb || b.players - a.players || a.name.localeCompare(b.name);
    });
    if (this.state !== 'connected' && this.state !== 'connecting') this.state = 'connected';
    this.renderList();
  }

  /** Error reported by the app (or a failed connect). */
  onError(code: UiErrorCode | string): void {
    if (isConnectionLoss(code)) {
      this.state = 'error';
      this.errorCode = code;
      this.lobbies = [];
      this.render();
    }
  }

  private defaultLobbyName(): string {
    const name = sanitizeName(settings.get().playerName);
    return name ? sanitizeText(t('ui.mp.defaultLobbyName', { name }), MAX_LOBBY_NAME_LEN) : '';
  }

  private connect(silent = false): void {
    const name = sanitizeName(this.nameInput.value);
    if (!name) {
      this.nameInput.classList.add('dz-invalid');
      this.nameInput.focus();
      this.ctx.toast(t('mp.nameRequired'), 'error');
      return;
    }
    this.nameInput.value = name;
    if (name !== settings.get().playerName) settings.set({ playerName: name });
    if (!silent) {
      this.state = 'connecting';
      this.errorCode = null;
      this.render();
    }
    const seq = ++this.connectSeq;
    this.ctx.actions.connectMultiplayer(name).then(
      () => {
        if (seq !== this.connectSeq) return;
        this.state = 'connected';
        this.connectedAs = name;
        if (!this.formTouched) this.form.set({ ...DEFAULT_LOBBY_SETTINGS, name: this.defaultLobbyName() });
        this.render();
      },
      (err: unknown) => {
        if (seq !== this.connectSeq) return;
        const code = typeof err === 'string' ? err : 'net.connectFailed';
        this.state = 'error';
        this.errorCode = code;
        this.lobbies = [];
        this.ctx.toast(uiErrorText(code), 'error');
        this.render();
      },
    );
  }

  private disconnect(): void {
    this.connectSeq++;
    this.ctx.actions.disconnectMultiplayer();
    this.state = 'idle';
    this.errorCode = null;
    this.lobbies = [];
    this.render();
  }

  private back(): void {
    this.disconnect();
    this.ctx.show('main');
  }

  private refresh(): void {
    if (this.state !== 'connected') return;
    this.ctx.actions.refreshLobbies();
    this.refreshBtn.classList.remove('dz-spin');
    void this.refreshBtn.offsetWidth;
    this.refreshBtn.classList.add('dz-spin');
  }

  private create(): void {
    if (this.state !== 'connected') return;
    const s = this.form.get();
    if (!s) return;
    this.ctx.actions.createLobby(s);
    this.formTouched = false;
  }

  private join(l: LobbySummary): void {
    const now = performance.now();
    if (now < this.joinLockUntil || this.state !== 'connected') return;
    this.joinLockUntil = now + 1500;
    this.ctx.actions.joinLobby(l.id);
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      if (this.visible && this.state === 'connected' && document.visibilityState === 'visible') this.ctx.actions.refreshLobbies();
    }, REFRESH_MS);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private render(): void {
    const connected = this.state === 'connected';
    this.nameRow.classList.toggle('dz-hidden', connected);
    this.connectedRow.classList.toggle('dz-hidden', !connected);
    this.nameInput.disabled = this.state === 'connecting';
    this.connectBtn.disabled = this.state === 'connecting';
    if (connected) txp(this.connectedText, 'ui.mp.connectedAs', { name: this.connectedAs || settings.get().playerName });
    this.statusLine.className = 'dz-mp-status';
    switch (this.state) {
      case 'connecting':
        this.statusLine.classList.add('dz-busy');
        tx(this.statusLine, 'mp.connecting');
        break;
      case 'error':
        this.statusLine.classList.add('dz-error');
        this.statusLine.textContent = uiErrorText(this.errorCode ?? 'net.connectFailed');
        break;
      case 'idle':
        tx(this.statusLine, 'ui.mp.connectHint');
        break;
      default:
        this.statusLine.textContent = '';
        delete this.statusLine.dataset.i18n;
    }
    this.listPanel.classList.toggle('dz-disabled', !connected);
    this.createPanel.classList.toggle('dz-disabled', !connected);
    this.form.setDisabled(!connected);
    this.createBtn.disabled = !connected;
    this.refreshBtn.disabled = !connected;
    this.renderList();
  }

  private renderList(): void {
    clear(this.listBody);
    const connected = this.state === 'connected';
    if (!connected || this.lobbies.length === 0) {
      this.listEmpty.classList.remove('dz-hidden');
      tx(this.listEmpty, connected ? 'mp.noLobbies' : this.state === 'connecting' ? 'mp.connecting' : 'ui.mp.notConnected');
      return;
    }
    this.listEmpty.classList.add('dz-hidden');
    for (const l of this.lobbies) {
      const row = h('div', 'dz-tr', this.listBody);
      row.setAttribute('role', 'row');
      row.dataset.testid = 'lobby-row';
      row.dataset.lobbyId = l.id;
      const full = l.players >= l.maxPlayers;
      const joinable = l.status === 'waiting' && !full;
      row.classList.toggle('dz-row-muted', !joinable);
      const name = h('div', 'dz-td dz-td-strong', row);
      name.textContent = l.name;
      name.title = l.name;
      const host = h('div', 'dz-td', row);
      host.appendChild(svgIcon(ICONS.crown, 'dz-icon dz-icon-sm dz-accent'));
      h('span', '', host).textContent = l.host;
      const players = h('div', 'dz-td dz-num', row);
      txp(players, 'mp.playersOfMax', { players: l.players, max: l.maxPlayers });
      tx(h('div', 'dz-td', row), teamSizeKey(l.teamSize));
      const status = h('div', `dz-td dz-status dz-status-${l.status}`, row);
      tx(status, l.status === 'waiting' ? (full ? 'mp.full' : 'mp.status.waiting')
        : l.status === 'starting' ? 'mp.status.starting' : 'mp.status.in_game');
      for (const c of Array.from(row.children)) c.setAttribute('role', 'cell');
      const cell = h('div', 'dz-td dz-td-action', row);
      cell.setAttribute('role', 'cell');
      const join = button({ cls: 'dz-btn-sm dz-btn-primary', label: 'mp.joinLobby', parent: cell, onClick: () => this.join(l) });
      join.disabled = !joinable;
      join.dataset.testid = 'lobby-join';
      row.addEventListener('dblclick', () => { if (joinable) this.join(l); });
    }
  }
}
