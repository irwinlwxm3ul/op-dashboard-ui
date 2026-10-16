// Lobby room: settings summary (host can edit), team grid (click a team to join it), ready / start,
// leave and chat.

import { fmtNumber, t } from '../../i18n';
import { audio } from '../../audio';
import { MAX_CHAT_LEN } from '../../../shared/constants';
import type { LobbyMember, LobbyState } from '../../../shared/protocol';
import { sanitizeText } from '../../../shared/validate';
import type { ScreenView, UiCtx } from '../context';
import { ariaTx, button, clear, h, placeholderTx, svgIcon, tx, txp } from '../dom';
import { ICONS } from '../icons';
import { difficultyKey, teamSizeKey, zoneSpeedKey } from '../options';
import { menuBackdrop } from './mainMenu';
import { LobbyForm } from './lobbyForm';

const MAX_CHAT_LINES = 120;

export class LobbyRoomScreen implements ScreenView {
  readonly el: HTMLElement;
  private state: LobbyState | null = null;
  private myId = '';
  private lastCountdown = -1;
  private editing = false;

  private readonly title: HTMLElement;
  private readonly statusChip: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly editBtn: HTMLButtonElement;
  private readonly formWrap: HTMLElement;
  private readonly form: LobbyForm;
  private readonly teamsHead: HTMLElement;
  private readonly teams: HTMLElement;
  private readonly readyBtn: HTMLButtonElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly chatLog: HTMLElement;
  private readonly chatInput: HTMLInputElement;
  private chatLobbyId = '';

  constructor(private readonly ctx: UiCtx) {
    this.el = h('section', 'dz-screen dz-lobby');
    menuBackdrop(this.el);
    const wrap = h('div', 'dz-screen-wrap dz-wide', this.el);
    const header = h('header', 'dz-screen-header', wrap);
    button({ cls: 'dz-btn-ghost dz-back', label: 'lobby.leave', parent: header, onClick: () => ctx.actions.leaveLobby() })
      .dataset.testid = 'lobby-leave';
    this.title = h('h2', 'dz-screen-title', header);
    this.statusChip = h('span', 'dz-chip', header);
    this.statusChip.setAttribute('role', 'status');

    const grid = h('div', 'dz-lobby-grid', wrap);
    const main = h('div', 'dz-lobby-main', grid);

    // Settings summary / editor.
    const setPanel = h('div', 'dz-panel dz-lobby-settings', main);
    const setHead = h('div', 'dz-panel-head', setPanel);
    tx(h('h3', 'dz-panel-title', setHead), 'lobby.settings');
    this.editBtn = button({ cls: 'dz-btn-ghost dz-btn-sm', label: 'ui.lobby.edit', icon: ICONS.gear, parent: setHead, onClick: () => this.toggleEdit() });
    this.summary = h('div', 'dz-chips', setPanel);
    this.formWrap = h('div', 'dz-lobby-edit dz-hidden', setPanel);
    this.form = new LobbyForm({ name: '', maxPlayers: 16, teamSize: 1, botFill: true, botDifficulty: 'normal', zoneSpeed: 1 });
    this.formWrap.appendChild(this.form.el);
    const formFoot = h('div', 'dz-panel-foot', this.formWrap);
    button({ cls: 'dz-btn-ghost', label: 'common.cancel', parent: formFoot, onClick: () => this.toggleEdit(false) });
    button({ cls: 'dz-btn-primary', label: 'common.apply', parent: formFoot, onClick: () => this.saveSettings() });

    // Teams.
    const teamPanel = h('div', 'dz-panel dz-lobby-teams', main);
    const teamHead = h('div', 'dz-panel-head', teamPanel);
    tx(h('h3', 'dz-panel-title', teamHead), 'ui.lobby.teams');
    this.teamsHead = h('span', 'dz-panel-sub', teamHead);
    this.teams = h('div', 'dz-team-grid', teamPanel);

    // Chat.
    const chat = h('div', 'dz-panel dz-chat', grid);
    const chatHead = h('div', 'dz-panel-head', chat);
    tx(h('h3', 'dz-panel-title', chatHead), 'lobby.chat');
    this.chatLog = h('div', 'dz-chat-log', chat);
    this.chatLog.setAttribute('role', 'log');
    this.chatLog.setAttribute('aria-live', 'polite');
    const chatForm = h('form', 'dz-chat-form', chat);
    this.chatInput = h('input', 'dz-input', chatForm);
    this.chatInput.type = 'text';
    this.chatInput.maxLength = MAX_CHAT_LEN;
    this.chatInput.autocomplete = 'off';
    placeholderTx(this.chatInput, 'lobby.chatPlaceholder');
    ariaTx(this.chatInput, 'lobby.chatPlaceholder');
    const send = button({ cls: 'dz-btn-icon-only', icon: ICONS.send, parent: chatForm });
    send.type = 'submit';
    ariaTx(send, 'common.send');
    chatForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.sendChat();
    });

    // Footer actions.
    const footer = h('footer', 'dz-screen-footer', wrap);
    this.hint = h('span', 'dz-lobby-hint', footer);
    this.readyBtn = button({ cls: 'dz-btn-xl', parent: footer, onClick: () => this.toggleReady() });
    this.startBtn = button({ cls: 'dz-btn-primary dz-btn-xl', label: 'lobby.startMatch', icon: ICONS.play, parent: footer, onClick: () => this.start() });
    this.readyBtn.dataset.testid = 'lobby-ready';
    this.startBtn.dataset.testid = 'lobby-start';

    ctx.onLanguage(() => {
      this.form.relabel();
      this.render();
    });
  }

  onShow(): void {
    this.render();
  }

  setState(state: LobbyState | null, myId: string): void {
    const prev = this.state;
    this.state = state;
    this.myId = myId;
    if (!state) {
      this.editing = false;
      this.lastCountdown = -1;
      return;
    }
    if (state.id !== this.chatLobbyId) {
      this.chatLobbyId = state.id;
      clear(this.chatLog);
      this.editing = false;
    }
    if (state.countdown >= 0) {
      const c = Math.ceil(state.countdown);
      if (c !== this.lastCountdown) audio.ui(c <= 0 ? 'start' : 'countdown');
      this.lastCountdown = c;
    } else this.lastCountdown = -1;
    if (prev && !this.isHost(prev) && this.isHost(state)) this.editing = false;
    this.render();
  }

  addChat(from: string, text: string): void {
    const atBottom = this.chatLog.scrollHeight - this.chatLog.scrollTop - this.chatLog.clientHeight < 24;
    const line = h('div', 'dz-chat-line', this.chatLog);
    const me = this.me();
    if (!from) {
      line.classList.add('dz-chat-system');
      h('span', 'dz-chat-text', line).textContent = text;
    } else {
      const who = h('span', 'dz-chat-from', line);
      who.textContent = from;
      if (me && me.name === from) who.classList.add('dz-chat-me');
      h('span', 'dz-chat-text', line).textContent = text;
    }
    while (this.chatLog.childElementCount > MAX_CHAT_LINES) this.chatLog.firstElementChild?.remove();
    if (atBottom) this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  private me(): LobbyMember | null {
    return this.state?.members.find((m) => m.clientId === this.myId) ?? null;
  }

  private isHost(s: LobbyState | null = this.state): boolean {
    return !!s && s.hostId === this.myId;
  }

  private toggleEdit(force?: boolean): void {
    if (!this.state || !this.isHost()) return;
    this.editing = force ?? !this.editing;
    if (this.editing) this.form.set(this.state.settings);
    this.render();
    if (this.editing) this.form.focusName();
  }

  private saveSettings(): void {
    const s = this.form.get();
    if (!s) return;
    this.ctx.actions.updateLobbySettings(s);
    this.editing = false;
    this.render();
  }

  private toggleReady(): void {
    const me = this.me();
    if (!me) return;
    audio.ui('ready');
    this.ctx.actions.setReady(!me.ready);
  }

  private start(): void {
    if (!this.canStart()) return;
    this.ctx.actions.startLobbyMatch();
  }

  private canStart(): boolean {
    const s = this.state;
    if (!s || !this.isHost() || s.status !== 'waiting') return false;
    return s.members.every((m) => m.clientId === this.myId || m.ready);
  }

  private sendChat(): void {
    const text = sanitizeText(this.chatInput.value, MAX_CHAT_LEN);
    if (!text) return;
    this.ctx.actions.sendChat(text);
    this.chatInput.value = '';
  }

  private render(): void {
    const s = this.state;
    if (!s) {
      this.title.textContent = '';
      clear(this.teams);
      return;
    }
    const host = this.isHost();
    const me = this.me();
    this.title.textContent = s.settings.name;

    // Status chip.
    this.statusChip.className = `dz-chip dz-status-${s.status}`;
    if (s.countdown >= 0) txp(this.statusChip, 'lobby.startingIn', { count: Math.max(0, Math.ceil(s.countdown)) });
    else tx(this.statusChip, s.status === 'in_game' ? 'mp.status.in_game' : s.status === 'starting' ? 'mp.status.starting' : 'mp.status.waiting');

    // Settings summary.
    clear(this.summary);
    const chip = (label: string, value: string) => {
      const c = h('span', 'dz-chip dz-chip-kv', this.summary);
      h('span', 'dz-chip-k', c).textContent = label;
      h('span', 'dz-chip-v', c).textContent = value;
    };
    chip(t('lobby.maxPlayers'), fmtNumber(s.settings.maxPlayers));
    chip(t('lobby.teamSize'), t(teamSizeKey(s.settings.teamSize)));
    chip(t('lobby.botFill'), t(s.settings.botFill ? 'common.on' : 'common.off'));
    chip(t('lobby.botDifficulty'), t(difficultyKey(s.settings.botDifficulty)));
    chip(t('lobby.zoneSpeed'), t(zoneSpeedKey(s.settings.zoneSpeed)));
    this.editBtn.classList.toggle('dz-hidden', !host || s.status !== 'waiting');
    this.formWrap.classList.toggle('dz-hidden', !(host && this.editing));
    this.summary.classList.toggle('dz-hidden', host && this.editing);

    // Teams.
    txp(this.teamsHead, 'mp.playersOfMax', { players: s.members.length, max: s.settings.maxPlayers });
    this.renderTeams(s, me);

    // Footer.
    this.readyBtn.classList.toggle('dz-hidden', host);
    if (me) {
      this.readyBtn.classList.toggle('dz-btn-ok', me.ready);
      clear(this.readyBtn);
      if (me.ready) this.readyBtn.appendChild(svgIcon(ICONS.check, 'dz-btn-icon'));
      tx(h('span', 'dz-btn-label', this.readyBtn), me.ready ? 'lobby.unready' : 'lobby.readyUp');
      this.readyBtn.setAttribute('aria-pressed', me.ready ? 'true' : 'false');
    }
    this.readyBtn.disabled = s.status !== 'waiting';
    this.startBtn.classList.toggle('dz-hidden', !host);
    this.startBtn.disabled = !this.canStart();
    const others = s.members.filter((m) => m.clientId !== this.myId);
    const waiting = others.filter((m) => !m.ready).length;
    if (s.status === 'in_game') tx(this.hint, 'lobby.inGame');
    else if (host) {
      if (waiting > 0) tx(this.hint, 'lobby.waitingForReady');
      else tx(this.hint, s.settings.botFill || others.length > 0 ? 'lobby.allReady' : 'lobby.waitingForPlayers');
    } else tx(this.hint, me?.ready ? 'lobby.waitingForHost' : 'ui.lobby.readyHint');
  }

  private renderTeams(s: LobbyState, me: LobbyMember | null): void {
    clear(this.teams);
    const size = s.settings.teamSize;
    this.teams.classList.toggle('dz-team-grid-solo', size === 1);
    const byTeam: LobbyMember[][] = Array.from({ length: s.teamCount }, () => []);
    for (const m of s.members) if (m.team >= 0 && m.team < s.teamCount) byTeam[m.team].push(m);
    for (let i = 0; i < s.teamCount; i++) {
      const members = byTeam[i];
      const mine = !!me && me.team === i;
      const full = members.length >= size;
      const card = h('button', 'dz-team-card', this.teams);
      card.type = 'button';
      card.classList.toggle('dz-team-mine', mine);
      card.classList.toggle('dz-team-full', full && !mine);
      card.disabled = s.status !== 'waiting' || (full && !mine);
      card.setAttribute('aria-label', t('lobby.team', { n: i + 1 }));
      card.dataset.testid = `team-${i}`;
      const head = h('div', 'dz-team-head', card);
      txp(h('span', 'dz-team-name', head), 'lobby.team', { n: fmtNumber(i + 1) });
      h('span', 'dz-team-count', head).textContent = `${fmtNumber(members.length)}/${fmtNumber(size)}`;
      for (let k = 0; k < size; k++) {
        const m = members[k];
        const slot = h('div', 'dz-slot', card);
        if (!m) {
          slot.classList.add('dz-slot-empty');
          tx(slot, mine || full ? 'lobby.emptySlot' : 'lobby.joinTeam');
          continue;
        }
        if (m.clientId === this.myId) slot.classList.add('dz-slot-me');
        if (m.isHost) {
          const crown = svgIcon(ICONS.crown, 'dz-icon dz-icon-sm dz-accent');
          crown.title = t('lobby.host');
          slot.appendChild(crown);
        }
        const name = h('span', 'dz-slot-name', slot);
        name.textContent = m.name;
        const ready = h('span', `dz-slot-ready${m.ready || m.isHost ? ' dz-on' : ''}`, slot);
        if (m.isHost) tx(ready, 'lobby.host');
        else if (m.ready) {
          ready.appendChild(svgIcon(ICONS.check, 'dz-icon dz-icon-sm'));
          ready.title = t('lobby.ready');
        } else tx(ready, 'lobby.notReady');
        if (m.ping > 0) {
          const ping = h('span', `dz-slot-ping${m.ping > 150 ? ' dz-warn' : ''}`, slot);
          txp(ping, 'unit.ms', { n: fmtNumber(Math.round(m.ping)) });
        }
      }
      card.addEventListener('click', () => {
        if (!mine && !full) this.ctx.actions.setTeam(i);
      });
    }
  }
}
