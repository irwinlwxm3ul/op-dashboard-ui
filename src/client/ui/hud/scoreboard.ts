// Scoreboard overlay (toggle key): every team with its members' status and kills (derived from the
// kill events this client received), your team first. Read-only; does not take the mouse.

import { fmtNumber, t } from '../../i18n';
import type { EntityId, TeamId } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import { clear, h, tx } from '../dom';
import type { HudEnv } from './shared';

const REFRESH_MS = 250;

type Status = 'alive' | 'down' | 'dead';

export class Scoreboard {
  readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly summary: HTMLDivElement;
  private open = false;
  private lastRender = 0;
  private env: HudEnv | null = null;
  private readonly kills = new Map<EntityId, number>();
  private readonly dead = new Set<EntityId>();
  private readonly eliminated = new Map<TeamId, number>();

  constructor() {
    this.el = h('div', 'dz-scoreboard dz-hidden');
    const panel = h('div', 'dz-scoreboard-panel dz-panel', this.el);
    const head = h('div', 'dz-panel-head', panel);
    tx(h('h2', 'dz-panel-title', head), 'scoreboard.title');
    this.summary = h('div', 'dz-scoreboard-summary', head);
    const table = h('div', 'dz-table dz-scoreboard-table', panel);
    const th = h('div', 'dz-tr dz-th', table);
    for (const k of ['scoreboard.team', 'scoreboard.player', 'scoreboard.kills', 'scoreboard.status'] as const) tx(h('div', 'dz-td', th), k);
    this.body = h('div', 'dz-tbody', table);
  }

  get isOpen(): boolean {
    return this.open;
  }

  bind(env: HudEnv): () => void {
    this.env = env;
    this.kills.clear();
    this.dead.clear();
    this.eliminated.clear();
    const ev = env.game.events;
    const offs = [
      ev.on('kill', (e) => {
        this.dead.add(e.victim);
        if (e.attacker !== null && e.attacker !== e.victim) this.kills.set(e.attacker, (this.kills.get(e.attacker) ?? 0) + 1);
      }),
      ev.on('teamEliminated', (e) => this.eliminated.set(e.team, e.placement)),
      ev.on('revived', (e) => this.dead.delete(e.target)),
    ];
    return () => {
      for (const off of offs) off();
      this.env = null;
    };
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('dz-hidden', !open);
    this.lastRender = 0;
  }

  update(frame: FrameState): void {
    if (!this.open || !this.env) return;
    const now = performance.now();
    if (now - this.lastRender < REFRESH_MS) return;
    this.lastRender = now;
    this.render(frame, this.env);
  }

  private status(frame: FrameState, id: EntityId): Status {
    if (frame.self && frame.self.id === id) return frame.self.life === 'dead' ? 'dead' : frame.self.life === 'downed' ? 'down' : 'alive';
    const p = frame.players.get(id);
    if (p) return p.life === 'dead' ? 'dead' : p.life === 'downed' ? 'down' : 'alive';
    return this.dead.has(id) ? 'dead' : 'alive';
  }

  private render(frame: FrameState, env: HudEnv): void {
    const teams = new Map<TeamId, EntityId[]>();
    for (const r of frame.roster.values()) {
      let list = teams.get(r.team);
      if (!list) teams.set(r.team, (list = []));
      list.push(r.id);
    }
    const aliveCount = (ids: EntityId[]) => ids.reduce((n, id) => n + (this.status(frame, id) === 'dead' ? 0 : 1), 0);
    const order = Array.from(teams.entries()).sort((a, b) => {
      if (a[0] === frame.localTeam) return -1;
      if (b[0] === frame.localTeam) return 1;
      const ea = this.eliminated.has(a[0]) ? 1 : 0, eb = this.eliminated.has(b[0]) ? 1 : 0;
      return ea - eb || aliveCount(b[1]) - aliveCount(a[1]) || a[0] - b[0];
    });
    clear(this.summary);
    h('span', 'dz-chip', this.summary).textContent = t('hud.alive', { count: frame.alive });
    if (frame.config.teamSize > 1) h('span', 'dz-chip', this.summary).textContent = t('hud.teamsAlive', { count: frame.teamsAlive });
    clear(this.body);
    const localKills = frame.self?.stats.kills;
    for (const [team, ids] of order) {
      const group = h('div', 'dz-tgroup', this.body);
      group.classList.toggle('dz-tgroup-mine', team === frame.localTeam);
      const teamOut = this.eliminated.has(team) || aliveCount(ids) === 0;
      group.classList.toggle('dz-tgroup-out', teamOut);
      ids.sort((a, b) => a - b);
      ids.forEach((id, i) => {
        const row = h('div', 'dz-tr', group);
        const isMe = frame.self?.id === id;
        row.classList.toggle('dz-row-me', isMe);
        const teamCell = h('div', 'dz-td dz-num', row);
        if (i === 0) teamCell.textContent = t('hud.teamN', { n: team + 1 });
        const name = h('div', 'dz-td dz-td-strong', row);
        const color = env.memberColor(id);
        if (color) name.style.setProperty('--c', color);
        h('span', color ? 'dz-name-mate' : '', name).textContent = frame.roster.get(id)?.name ?? '';
        if (isMe) tx(h('span', 'dz-tag', name), 'common.you');
        else if (frame.roster.get(id)?.isBot) tx(h('span', 'dz-tag dz-tag-dim', name), 'common.bot');
        const kills = isMe && localKills !== undefined ? localKills : this.kills.get(id) ?? 0;
        h('div', 'dz-td dz-num', row).textContent = fmtNumber(kills);
        const st = this.status(frame, id);
        const stCell = h('div', `dz-td dz-sb-${st}`, row);
        tx(stCell, st === 'dead' ? 'scoreboard.eliminated' : st === 'down' ? 'scoreboard.down' : 'scoreboard.alive');
      });
    }
  }

  relabel(): void {
    this.lastRender = 0;
  }

  reset(): void {
    this.setOpen(false);
    this.kills.clear();
    this.dead.clear();
    this.eliminated.clear();
  }
}
