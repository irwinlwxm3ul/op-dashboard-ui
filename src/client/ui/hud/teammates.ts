// Left-side squad list: member number + colour, name, health (or bleed-out) bar, downed / dead
// state and distance from the viewer.

import { t } from '../../i18n';
import { DOWNED_HEALTH, MAX_HEALTH } from '../../../shared/constants';
import type { EntityId, LifeState } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import { BarFill, ClassFlag, h, markUserText, NumSlot, StyleSlot, svgIcon, TextSlot, Vis } from '../dom';
import { ICONS } from '../icons';
import { viewPos, type HudEnv, type Widget } from './shared';

class MateRow {
  readonly el: HTMLDivElement;
  readonly vis: Vis;
  private readonly num: TextSlot;
  private readonly name: TextSlot;
  private readonly state: TextSlot;
  private readonly dist: NumSlot;
  private readonly fill: BarFill;
  private readonly color: StyleSlot;
  private readonly downed: ClassFlag;
  private readonly dead: ClassFlag;
  private readonly me: ClassFlag;
  private readonly vehicle: Vis;
  private id: EntityId = -1;
  private life: LifeState | '' = '';

  constructor(parent: HTMLElement) {
    this.el = h('div', 'dz-mate', parent);
    this.vis = new Vis(this.el);
    this.num = new TextSlot(h('span', 'dz-mate-num', this.el));
    const main = h('div', 'dz-mate-main', this.el);
    const top = h('div', 'dz-mate-top', main);
    const nameEl = h('span', 'dz-mate-name', top);
    markUserText(nameEl);
    this.name = new TextSlot(nameEl);
    const veh = svgIcon(ICONS.car, 'dz-icon dz-icon-xs dz-mate-veh');
    top.appendChild(veh);
    this.vehicle = new Vis(veh);
    this.state = new TextSlot(h('span', 'dz-mate-state', top));
    this.dist = new NumSlot(h('span', 'dz-mate-dist', top), (n) => (n < 0 ? '' : t('unit.meters', { n })));
    const bar = h('div', 'dz-mate-bar', main);
    this.fill = new BarFill(h('div', 'dz-mate-fill', bar));
    this.color = new StyleSlot(this.el, '--c');
    this.downed = new ClassFlag(this.el, 'dz-mate-downed');
    this.dead = new ClassFlag(this.el, 'dz-mate-dead');
    this.me = new ClassFlag(this.el, 'dz-mate-me');
  }

  set(id: EntityId, num: number, color: string, name: string, life: LifeState, hp: number, dist: number, isMe: boolean, inVehicle: boolean): void {
    if (id !== this.id) {
      this.id = id;
      this.num.set(String(num));
      this.name.set(name);
      this.color.set(color);
      this.life = '';
    }
    if (life !== this.life) {
      this.life = life;
      this.state.set(life === 'downed' ? t('hud.stateDown') : life === 'dead' ? t('hud.stateDead') : '');
      this.downed.set(life === 'downed');
      this.dead.set(life === 'dead');
    }
    this.me.set(isMe);
    this.vehicle.set(inVehicle && life !== 'dead');
    this.fill.set(life === 'dead' ? 0 : life === 'downed' ? hp / DOWNED_HEALTH : hp / MAX_HEALTH);
    this.dist.set(isMe || life === 'dead' ? -1 : Math.round(dist));
  }

  invalidate(): void {
    this.id = -1;
    this.life = '';
    this.dist.invalidate();
  }
}

export class Teammates implements Widget {
  readonly el: HTMLDivElement;
  private readonly vis: Vis;
  private readonly rows: MateRow[] = [];

  constructor() {
    this.el = h('div', 'dz-mates');
    this.vis = new Vis(this.el);
    for (let i = 0; i < 4; i++) this.rows.push(new MateRow(this.el));
  }

  update(frame: FrameState, _cam: unknown, env: HudEnv): void {
    const show = frame.config.teamSize > 1 && env.team.length > 1 && !!frame.self;
    this.vis.set(show);
    if (!show) return;
    const pos = viewPos(frame);
    const self = frame.self!;
    let i = 0;
    for (const id of env.team) {
      if (i >= this.rows.length) break;
      const row = this.rows[i++];
      const isMe = id === self.id;
      const p = frame.players.get(id);
      const name = frame.roster.get(id)?.name ?? p?.name ?? '';
      let life: LifeState = p ? p.life : 'alive';
      let hp = MAX_HEALTH;
      let inVehicle = false;
      if (isMe) {
        life = self.life;
        hp = self.life === 'downed' ? self.downedHp : self.health;
        inVehicle = self.vehicleId !== null;
      } else if (p) {
        hp = p.life === 'downed' ? p.downedHp ?? 0 : p.hp ?? MAX_HEALTH;
        inVehicle = p.vehicleId !== null;
      }
      const dist = p && pos ? Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z) : -1;
      row.vis.set(true);
      row.set(id, env.memberNumber(id), env.memberColor(id) ?? '#fff', name, life, hp, dist, isMe, inVehicle);
    }
    for (; i < this.rows.length; i++) this.rows[i].vis.set(false);
  }

  relabel(): void {
    for (const r of this.rows) r.invalidate();
  }

  reset(): void {
    this.relabel();
    this.vis.invalidate();
    for (const r of this.rows) r.vis.set(false);
  }
}
