// Single-player setup: player count, team size, bot difficulty, zone speed → actions.startSinglePlayer.

import { fmtNumber, t } from '../../i18n';
import { MAX_PLAYERS, MIN_PLAYERS } from '../../../shared/constants';
import type { SinglePlayerOptions } from '../contracts';
import type { ScreenView, UiCtx } from '../context';
import { fieldRow, Segmented, Select, Slider } from '../controls';
import { button, h, tx, txp } from '../dom';
import { ICONS } from '../icons';
import {
  DIFFICULTY_OPTIONS, difficultyDescKey, difficultyKey, isDifficulty, isTeamSize, loadJson, nearestZoneSpeed, saveJson,
  TEAM_SIZE_OPTIONS, teamSizeKey, ZONE_SPEED_OPTIONS,
} from '../options';
import { menuBackdrop } from './mainMenu';

const STORE_KEY = 'dz.ui.sp';

const DEFAULTS: SinglePlayerOptions = { maxPlayers: 32, teamSize: 4, botDifficulty: 'normal', zoneSpeed: 1 };

/** Last used single-player options (persisted per browser), validated. */
export function loadSpOptions(): SinglePlayerOptions {
  const raw = loadJson(STORE_KEY) as Partial<SinglePlayerOptions> | null;
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const mp = typeof raw.maxPlayers === 'number' && Number.isFinite(raw.maxPlayers)
    ? Math.round(Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, raw.maxPlayers)))
    : DEFAULTS.maxPlayers;
  return {
    maxPlayers: mp,
    teamSize: isTeamSize(raw.teamSize) ? raw.teamSize : DEFAULTS.teamSize,
    botDifficulty: isDifficulty(raw.botDifficulty) ? raw.botDifficulty : DEFAULTS.botDifficulty,
    zoneSpeed: typeof raw.zoneSpeed === 'number' ? nearestZoneSpeed(raw.zoneSpeed) : DEFAULTS.zoneSpeed,
  };
}

export class SinglePlayerScreen implements ScreenView {
  readonly el: HTMLElement;
  private readonly players: Slider;
  private readonly teamSize: Select<1 | 2 | 4>;
  private readonly difficulty: Segmented<'easy' | 'normal' | 'hard'>;
  private readonly zone: Segmented<number>;
  private readonly diffHint: HTMLElement;
  private readonly summary: HTMLElement;
  private opts: SinglePlayerOptions;

  constructor(private readonly ctx: UiCtx) {
    this.opts = loadSpOptions();
    this.el = h('section', 'dz-screen dz-sp');
    menuBackdrop(this.el);
    const wrap = h('div', 'dz-screen-wrap dz-narrow', this.el);
    const header = h('header', 'dz-screen-header', wrap);
    button({ cls: 'dz-btn-ghost dz-back', label: 'common.back', parent: header, onClick: () => ctx.show('main') });
    tx(h('h2', 'dz-screen-title', header), 'sp.title');

    const panel = h('div', 'dz-panel dz-form', wrap);
    tx(h('p', 'dz-lead', panel), 'sp.description');

    this.players = new Slider({
      min: MIN_PLAYERS, max: MAX_PLAYERS, step: 1, value: this.opts.maxPlayers,
      format: (v) => fmtNumber(v),
      onInput: (v) => { this.opts.maxPlayers = v; this.refreshSummary(); },
    });
    fieldRow(panel, 'sp.players', this.players, 'sp.playersHint');

    this.players.input.dataset.testid = 'sp-players';

    this.teamSize = new Select(TEAM_SIZE_OPTIONS, this.opts.teamSize, (v) => {
      this.opts.teamSize = v;
      this.refreshSummary();
    });
    this.teamSize.el.dataset.testid = 'sp-teamsize';
    fieldRow(panel, 'sp.teamSize', this.teamSize, 'sp.teamSizeHint');

    this.difficulty = new Segmented(DIFFICULTY_OPTIONS, this.opts.botDifficulty, (v) => {
      this.opts.botDifficulty = v;
      this.refreshSummary();
    }, 'sp.botDifficulty');
    const diffRow = fieldRow(panel, 'sp.botDifficulty', this.difficulty);
    this.diffHint = h('div', 'dz-field-hint', diffRow.querySelector('.dz-field-text') as HTMLElement);

    this.zone = new Segmented(ZONE_SPEED_OPTIONS, this.opts.zoneSpeed, (v) => { this.opts.zoneSpeed = v; }, 'sp.zoneSpeed');
    fieldRow(panel, 'sp.zoneSpeed', this.zone, 'sp.zoneSpeedHint');

    this.summary = h('p', 'dz-sp-summary', panel);

    const footer = h('footer', 'dz-screen-footer', wrap);
    const start = button({ cls: 'dz-btn-primary dz-btn-xl', label: 'sp.startMatch', icon: ICONS.play, parent: footer, onClick: () => this.start() });
    start.dataset.autofocus = '';
    start.dataset.testid = 'sp-start';

    ctx.onLanguage(() => {
      this.players.relabel();
      this.refreshSummary();
    });
    this.refreshSummary();
  }

  onShow(): void {
    this.opts = loadSpOptions();
    this.players.value = this.opts.maxPlayers;
    this.teamSize.value = this.opts.teamSize;
    this.difficulty.value = this.opts.botDifficulty;
    this.zone.value = this.opts.zoneSpeed;
    this.refreshSummary();
  }

  onEscape(): boolean {
    this.ctx.show('main');
    return true;
  }

  private refreshSummary(): void {
    tx(this.diffHint, difficultyDescKey(this.opts.botDifficulty));
    txp(this.summary, 'sp.summary', {
      players: this.opts.maxPlayers,
      teamSize: t(teamSizeKey(this.opts.teamSize)),
      difficulty: t(difficultyKey(this.opts.botDifficulty)),
    });
  }

  private start(): void {
    const opts: SinglePlayerOptions = {
      maxPlayers: this.players.value,
      teamSize: this.teamSize.value,
      botDifficulty: this.difficulty.value,
      zoneSpeed: this.zone.value,
    };
    saveJson(STORE_KEY, opts);
    this.ctx.actions.startSinglePlayer(opts);
  }
}

