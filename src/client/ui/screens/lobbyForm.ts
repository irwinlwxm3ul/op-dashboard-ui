// Lobby settings form, shared by "create lobby" (lobby browser) and the host's settings editor
// (lobby room).

import { fmtNumber } from '../../i18n';
import { MAX_LOBBY_NAME_LEN, MAX_PLAYERS, MIN_PLAYERS } from '../../../shared/constants';
import type { LobbySettings } from '../../../shared/protocol';
import { sanitizeText } from '../../../shared/validate';
import { fieldRow, Segmented, Select, Slider, Toggle, type Control } from '../controls';
import { h, placeholderTx } from '../dom';
import { DIFFICULTY_OPTIONS, nearestZoneSpeed, TEAM_SIZE_OPTIONS, ZONE_SPEED_OPTIONS } from '../options';

export class LobbyForm {
  readonly el: HTMLDivElement;
  private readonly name: HTMLInputElement;
  private readonly maxPlayers: Slider;
  private readonly teamSize: Select<1 | 2 | 4>;
  private readonly botFill: Toggle;
  private readonly difficulty: Segmented<'easy' | 'normal' | 'hard'>;
  private readonly zone: Segmented<number>;

  /** `testIdPrefix` tags the inputs for the browser smoke tests (only one form instance per prefix). */
  constructor(initial: LobbySettings, onChange?: () => void, testIdPrefix?: string) {
    this.el = h('div', 'dz-form dz-lobby-form');
    const changed = () => onChange?.();

    this.name = h('input', 'dz-input');
    this.name.type = 'text';
    this.name.maxLength = MAX_LOBBY_NAME_LEN;
    this.name.spellcheck = false;
    placeholderTx(this.name, 'mp.lobbyNamePlaceholder');
    this.name.addEventListener('input', () => {
      this.name.classList.remove('dz-invalid');
      changed();
    });
    const nameCtl: Control = { el: this.name };
    fieldRow(this.el, 'mp.lobbyName', nameCtl);

    this.maxPlayers = new Slider({
      min: MIN_PLAYERS, max: MAX_PLAYERS, step: 1, value: initial.maxPlayers,
      format: (v) => fmtNumber(v),
      onInput: changed,
    });
    fieldRow(this.el, 'lobby.maxPlayers', this.maxPlayers);

    this.teamSize = new Select(TEAM_SIZE_OPTIONS, initial.teamSize, changed);
    fieldRow(this.el, 'lobby.teamSize', this.teamSize);

    this.botFill = new Toggle(initial.botFill, changed);
    fieldRow(this.el, 'lobby.botFill', this.botFill, 'lobby.botFillHint');

    this.difficulty = new Segmented(DIFFICULTY_OPTIONS, initial.botDifficulty, changed, 'lobby.botDifficulty');
    fieldRow(this.el, 'lobby.botDifficulty', this.difficulty);

    this.zone = new Segmented(ZONE_SPEED_OPTIONS, nearestZoneSpeed(initial.zoneSpeed), changed, 'lobby.zoneSpeed');
    fieldRow(this.el, 'lobby.zoneSpeed', this.zone);

    if (testIdPrefix) {
      this.name.dataset.testid = `${testIdPrefix}-name`;
      this.maxPlayers.input.dataset.testid = `${testIdPrefix}-max`;
      this.teamSize.el.dataset.testid = `${testIdPrefix}-teamsize`;
      this.botFill.input.dataset.testid = `${testIdPrefix}-botfill`;
    }
    this.set(initial);
  }

  set(s: LobbySettings): void {
    this.name.value = s.name;
    this.maxPlayers.value = s.maxPlayers;
    this.teamSize.value = s.teamSize;
    this.botFill.value = s.botFill;
    this.difficulty.value = s.botDifficulty;
    this.zone.value = nearestZoneSpeed(s.zoneSpeed);
  }

  /** Current settings, or null (and the name field flagged) when the name is unusable. */
  get(): LobbySettings | null {
    const name = sanitizeText(this.name.value, MAX_LOBBY_NAME_LEN);
    if (!name) {
      this.name.classList.add('dz-invalid');
      this.name.focus();
      return null;
    }
    return {
      name,
      maxPlayers: this.maxPlayers.value,
      teamSize: this.teamSize.value,
      botFill: this.botFill.value,
      botDifficulty: this.difficulty.value,
      zoneSpeed: this.zone.value,
    };
  }

  setDisabled(d: boolean): void {
    this.name.disabled = d;
    this.maxPlayers.input.disabled = d;
    this.teamSize.setDisabled(d);
    this.botFill.setDisabled(d);
    this.difficulty.setDisabled(d);
    this.zone.setDisabled(d);
  }

  relabel(): void {
    this.maxPlayers.relabel();
  }

  focusName(): void {
    this.name.focus();
    this.name.select();
  }
}
