// Results screen: placement, winner celebration, personal stats, per-team breakdown, next actions.

import { fmtDuration, fmtNumber, t } from '../../i18n';
import type { MatchResults, PlayerResult } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import type { MatchContext } from '../contracts';
import type { ScreenView, UiCtx } from '../context';
import { button, clear, h, svgIcon, tx, txp } from '../dom';
import { ICONS } from '../icons';
import { loadSpOptions } from './singlePlayer';

export class ResultsScreen implements ScreenView {
  readonly el: HTMLElement;
  private results: MatchResults | null = null;
  private myId: number | null = null;
  private myTeam: number | null = null;
  private context: MatchContext = 'sp';

  private readonly hero: HTMLElement;
  private readonly confetti: HTMLElement;
  private readonly headline: HTMLElement;
  private readonly placeLabel: HTMLElement;
  private readonly placeNum: HTMLElement;
  private readonly placeTotal: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly table: HTMLElement;
  private readonly actionsEl: HTMLElement;

  constructor(private readonly ctx: UiCtx) {
    this.el = h('section', 'dz-screen dz-results');
    this.el.dataset.testid = 'results';
    const wrap = h('div', 'dz-screen-wrap dz-wide', this.el);
    this.hero = h('div', 'dz-results-hero', wrap);
    this.confetti = h('div', 'dz-confetti', this.hero);
    this.confetti.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 28; i++) {
      // Deterministic scatter (no correlation between position, delay and colour).
      const c = h('i', '', this.confetti);
      c.style.setProperty('--x', `${(i * 37) % 100}%`);
      c.style.setProperty('--d', `${-(((i * 53) % 29) / 10).toFixed(1)}s`);
      c.style.setProperty('--h', `${(i * 71) % 360}deg`);
      c.style.setProperty('--s', String(0.75 + ((i * 13) % 7) / 12));
    }
    this.headline = h('h2', 'dz-results-headline', this.hero);
    const place = h('div', 'dz-results-place', this.hero);
    this.placeLabel = h('div', 'dz-results-place-label', place);
    const big = h('div', 'dz-results-place-big', place);
    this.placeNum = h('span', 'dz-results-place-num', big);
    this.placeTotal = h('span', 'dz-results-place-total', big);
    this.meta = h('div', 'dz-results-meta', this.hero);

    const grid = h('div', 'dz-results-grid', wrap);
    const statsPanel = h('div', 'dz-panel', grid);
    tx(h('h3', 'dz-panel-title', h('div', 'dz-panel-head', statsPanel)), 'ui.results.yourStats');
    this.stats = h('div', 'dz-stat-grid', statsPanel);

    const teamPanel = h('div', 'dz-panel dz-results-teams', grid);
    tx(h('h3', 'dz-panel-title', h('div', 'dz-panel-head', teamPanel)), 'results.teamBreakdown');
    this.table = h('div', 'dz-table dz-results-table', teamPanel);
    this.table.setAttribute('role', 'table');

    this.actionsEl = h('footer', 'dz-screen-footer', wrap);
    ctx.onLanguage(() => this.render());
  }

  set(results: MatchResults, frame: FrameState | null, context: MatchContext): void {
    this.results = results;
    this.context = context;
    this.myId = frame?.localId ?? null;
    let me = this.myId !== null ? results.players.find((p) => p.id === this.myId) : undefined;
    if (!me) {
      const humans = results.players.filter((p) => !p.isBot);
      if (humans.length === 1) me = humans[0];
    }
    this.myId = me?.id ?? null;
    this.myTeam = me?.team ?? frame?.localTeam ?? null;
    this.render();
  }

  private me(): PlayerResult | null {
    return this.results?.players.find((p) => p.id === this.myId) ?? null;
  }

  private render(): void {
    const r = this.results;
    if (!r) return;
    const me = this.me();
    const teams = new Map<number, PlayerResult[]>();
    for (const p of r.players) {
      let list = teams.get(p.team);
      if (!list) teams.set(p.team, (list = []));
      list.push(p);
    }
    const placement = me?.placement ?? 0;
    const won = (me && placement === 1) || (this.myTeam !== null && r.winnerTeam === this.myTeam);
    this.hero.classList.toggle('dz-results-win', !!won);

    tx(this.headline, won ? 'results.victory' : me ? 'banner.eliminated' : 'results.title');
    tx(this.placeLabel, 'results.placement');
    this.placeNum.textContent = placement > 0 ? `#${fmtNumber(placement)}` : '—';
    txp(this.placeTotal, 'ui.results.ofTotal', { n: fmtNumber(teams.size) });
    clear(this.meta);
    const dur = h('span', 'dz-kv', this.meta);
    tx(h('span', 'dz-kv-k', dur), 'results.matchDuration');
    h('span', 'dz-kv-v', dur).textContent = fmtDuration(r.duration);
    if (r.winnerTeam !== null && !won) {
      const winners = teams.get(r.winnerTeam);
      if (winners?.length) {
        const w = h('span', '', this.meta);
        w.appendChild(svgIcon(ICONS.trophy, 'dz-icon dz-icon-sm dz-accent'));
        h('span', '', w).textContent = t('ui.results.winners', { names: winners.map((p) => p.name).join(', ') });
      }
    }

    // Personal stats.
    clear(this.stats);
    const stat = (labelKey: Parameters<typeof tx>[1], value: string, accent = false) => {
      const c = h('div', `dz-stat${accent ? ' dz-stat-accent' : ''}`, this.stats);
      h('div', 'dz-stat-value', c).textContent = value;
      tx(h('div', 'dz-stat-label', c), labelKey);
    };
    if (me) {
      stat('results.kills', fmtNumber(me.kills), true);
      stat('results.knocks', fmtNumber(me.knocks));
      stat('results.damage', fmtNumber(Math.round(me.damage)));
      stat('results.headshots', fmtNumber(me.headshots));
      stat('results.revives', fmtNumber(me.revives));
      stat('results.longestKill', t('unit.meters', { n: fmtNumber(Math.round(me.longestKill)) }));
      stat('results.survivalTime', fmtDuration(me.survivalTime));
      stat('results.accuracy', t('unit.percent', { n: fmtNumber(Math.round(me.accuracy * (me.accuracy <= 1 ? 100 : 1))) }));
    } else {
      tx(h('p', 'dz-empty', this.stats), 'ui.results.spectator');
    }

    // Team breakdown.
    clear(this.table);
    const head = h('div', 'dz-tr dz-th', this.table);
    head.setAttribute('role', 'row');
    for (const k of ['results.placement', 'results.player', 'results.kills', 'results.knocks', 'results.damage', 'results.survivalTime'] as const) {
      tx(h('div', 'dz-td', head), k).setAttribute('role', 'columnheader');
    }
    const ordered = Array.from(teams.entries()).sort((a, b) => {
      const pa = Math.min(...a[1].map((p) => p.placement || 999));
      const pb = Math.min(...b[1].map((p) => p.placement || 999));
      return pa - pb || a[0] - b[0];
    });
    for (const [team, members] of ordered) {
      const group = h('div', 'dz-tgroup', this.table);
      group.classList.toggle('dz-tgroup-mine', team === this.myTeam);
      group.classList.toggle('dz-tgroup-winner', team === r.winnerTeam);
      members.sort((a, b) => b.kills - a.kills || b.damage - a.damage);
      members.forEach((p, i) => {
        const row = h('div', 'dz-tr', group);
        row.setAttribute('role', 'row');
        row.classList.toggle('dz-row-me', p.id === this.myId);
        const place = h('div', 'dz-td dz-num', row);
        if (i === 0) {
          if (team === r.winnerTeam) place.appendChild(svgIcon(ICONS.trophy, 'dz-icon dz-icon-sm dz-accent'));
          h('span', '', place).textContent = p.placement > 0 ? `#${fmtNumber(p.placement)}` : '—';
        }
        const name = h('div', 'dz-td dz-td-strong', row);
        h('span', '', name).textContent = p.name;
        if (p.isBot) tx(h('span', 'dz-tag', name), 'common.bot');
        h('div', 'dz-td dz-num', row).textContent = fmtNumber(p.kills);
        h('div', 'dz-td dz-num', row).textContent = fmtNumber(p.knocks);
        h('div', 'dz-td dz-num', row).textContent = fmtNumber(Math.round(p.damage));
        h('div', 'dz-td dz-num', row).textContent = fmtDuration(p.survivalTime);
        for (const c of Array.from(row.children)) c.setAttribute('role', 'cell');
      });
    }

    // Actions.
    clear(this.actionsEl);
    const a = this.ctx.actions;
    if (this.context === 'mp') {
      const back = button({ cls: 'dz-btn-primary dz-btn-xl', label: 'results.backToLobby', parent: this.actionsEl, onClick: () => a.leaveMatch() });
      back.dataset.autofocus = '';
      back.dataset.testid = 'results-back';
    } else {
      button({ cls: 'dz-btn-ghost dz-btn-xl', label: 'results.backToMenu', parent: this.actionsEl, onClick: () => a.backToMenu() })
        .dataset.testid = 'results-back';
      const again = button({
        cls: 'dz-btn-primary dz-btn-xl', label: 'results.playAgain', icon: ICONS.play, parent: this.actionsEl,
        onClick: () => (this.context === 'training' ? a.startTraining() : a.startSinglePlayer(loadSpOptions())),
      });
      again.dataset.autofocus = '';
      again.dataset.testid = 'results-again';
    }
  }

  onShow(): void {
    // Replay the hero animation.
    this.hero.classList.remove('dz-anim');
    void this.hero.offsetWidth;
    this.hero.classList.add('dz-anim');
    this.actionsEl.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }
}
