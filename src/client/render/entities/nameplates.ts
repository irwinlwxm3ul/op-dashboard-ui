// World-anchored DOM nameplates and off-screen markers.
//   * Teammates: always (through walls): name, health bar (red downed bar from downedHp), distance,
//     team colour; downed teammates get a pulsing icon. Off-screen teammates get an edge arrow.
//   * Enemies: only while the local player aims within ~2 deg of them, with line of sight and within
//     ENEMY_NAMEPLATE_RANGE: name only.
// Elements are pooled; positioning uses CSS transforms only; text is rewritten only when it changes.

import * as THREE from 'three';
import { DOWNED_HEALTH, ENEMY_NAMEPLATE_RANGE, MAX_HEALTH } from '../../../shared/constants';
import { dirFromAngles } from '../../../shared/math';
import { lineOfSight } from '../../../shared/physics';
import type { EntityId, Vec3, World } from '../../../shared/types';
import type { FrameState } from '../../game/types';
import { onLanguageChange, t } from '../../i18n';
import { teamCss } from './palette';
import type { PlayerEntry } from './players';

const STYLE_ID = 'dz-entity-nameplates-style';
const CSS = `
.dz-ent-layer{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;overflow:visible;z-index:1}
.dz-np{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:2px;
  transform-origin:50% 100%;will-change:transform,opacity;white-space:nowrap;
  font:600 12px/1.15 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 3px rgba(0,0,0,.6);transition:opacity .15s linear}
.dz-np-name{max-width:140px;overflow:hidden;text-overflow:ellipsis}
.dz-np-bar{position:relative;width:58px;height:5px;background:rgba(0,0,0,.55);border-radius:2px;overflow:hidden;
  box-shadow:0 0 0 1px rgba(0,0,0,.35)}
.dz-np-hp,.dz-np-dhp{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 50%}
html[dir=rtl] .dz-np-hp,html[dir=rtl] .dz-np-dhp{transform-origin:100% 50%}
.dz-np-hp{background:#f2f2f2}
.dz-np-dhp{background:#e23b3b}
.dz-np-dist{font-size:10px;font-weight:500;opacity:.9}
.dz-np-row{display:flex;align-items:center;gap:4px}
.dz-np-down{position:relative;width:14px;height:14px;animation:dz-np-pulse .9s ease-in-out infinite}
.dz-np-down::before,.dz-np-down::after{content:"";position:absolute;left:5px;top:0;width:4px;height:14px;
  border-radius:1px;background:#ff4040;box-shadow:0 0 4px rgba(255,40,40,.8)}
.dz-np-down::after{transform:rotate(90deg)}
.dz-np-enemy .dz-np-name{color:#fff;border-bottom:2px solid currentColor;padding-bottom:1px}
@keyframes dz-np-pulse{0%,100%{transform:scale(.8);opacity:.55}50%{transform:scale(1.15);opacity:1}}
.dz-np-edge{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:1px;
  will-change:transform;font:600 10px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.95)}
.dz-np-arrow{width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;
  border-bottom:14px solid currentColor;filter:drop-shadow(0 0 2px rgba(0,0,0,.9))}
.dz-np-edge.dz-np-downed .dz-np-arrow{animation:dz-np-pulse .9s ease-in-out infinite;color:#ff4040}
`;

/** Aim cone (rad) within which an enemy nameplate appears. */
const ENEMY_AIM_CONE = (2 * Math.PI) / 180;
/** Seconds an enemy plate lingers after the crosshair leaves. */
const ENEMY_LINGER = 0.45;
/** Line-of-sight results are cached this long (s). */
const LOS_CACHE = 0.15;
const EDGE_MARGIN = 34;

interface Plate {
  root: HTMLDivElement;
  name: HTMLDivElement;
  bar: HTMLDivElement;
  hp: HTMLDivElement;
  dhp: HTMLDivElement;
  row: HTMLDivElement;
  down: HTMLDivElement;
  dist: HTMLDivElement;
  // cached state
  nameText: string;
  color: string;
  distM: number;
  hpVal: number;
  dhpVal: number;
  downed: boolean;
  enemy: boolean;
  shown: boolean;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  stamp: number;
}

interface Edge {
  root: HTMLDivElement;
  arrow: HTMLDivElement;
  dist: HTMLDivElement;
  color: string;
  distM: number;
  downed: boolean;
  shown: boolean;
  stamp: number;
}

interface LosEntry {
  age: number;
  visible: boolean;
  stamp: number;
}

const _p = new THREE.Vector3();
const _dir: Vec3 = { x: 0, y: 0, z: 0 };
const _eye: Vec3 = { x: 0, y: 0, z: 0 };
const _tgt: Vec3 = { x: 0, y: 0, z: 0 };

function div(cls: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (parent) parent.appendChild(d);
  return d;
}

export class NameplateRenderer {
  private readonly layer: HTMLDivElement;
  private readonly plates = new Map<EntityId, Plate>();
  private readonly platePool: Plate[] = [];
  private readonly edges = new Map<EntityId, Edge>();
  private readonly edgePool: Edge[] = [];
  private readonly los = new Map<EntityId, LosEntry>();
  private readonly removeIds: EntityId[] = [];
  private stamp = 0;
  private width = 1;
  private height = 1;
  private left = 0;
  private top = 0;
  private readonly resizeObs: ResizeObserver | null = null;
  private readonly offLang: () => void;
  private enemyId: EntityId = -1;
  private enemyLinger = 0;
  // Per-frame parameters for the bound visitor.
  private frame: FrameState | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private dt = 0;

  constructor(overlay: HTMLElement, private readonly canvas: HTMLCanvasElement, private readonly world: World) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.layer = div('dz-ent-layer', overlay);
    this.layer.setAttribute('aria-hidden', 'true');
    const measure = (): void => {
      const r = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, r.width);
      this.height = Math.max(1, r.height);
      this.left = r.left;
      this.top = r.top;
      this.layer.style.transform = `translate3d(${this.left}px,${this.top}px,0)`;
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(measure);
      this.resizeObs.observe(this.canvas);
    }
    window.addEventListener('resize', measure);
    this.onResize = measure;
    // Distance labels are language dependent: force a rewrite on language change.
    this.offLang = onLanguageChange(() => {
      this.plates.forEach((p) => { p.distM = -1; });
      this.edges.forEach((e) => { e.distM = -1; });
    });
  }

  private readonly onResize: () => void;

  private plate(id: EntityId): Plate {
    let p = this.plates.get(id);
    if (p) return p;
    p = this.platePool.pop();
    if (!p) {
      const root = div('dz-np', this.layer);
      const name = div('dz-np-name', root);
      const bar = div('dz-np-bar', root);
      const hp = div('dz-np-hp', bar);
      const dhp = div('dz-np-dhp', bar);
      const row = div('dz-np-row', root);
      const down = div('dz-np-down', row);
      const dist = div('dz-np-dist', row);
      p = {
        root, name, bar, hp, dhp, row, down, dist, nameText: '', color: '', distM: -1, hpVal: -1, dhpVal: -1,
        downed: true, enemy: true, shown: true, x: Number.NaN, y: Number.NaN, scale: -1, opacity: -1, stamp: 0,
      };
      this.setDowned(p, false);
      this.setEnemy(p, false);
    }
    p.root.style.display = '';
    p.shown = true;
    this.plates.set(id, p);
    return p;
  }

  private edge(id: EntityId): Edge {
    let e = this.edges.get(id);
    if (e) return e;
    e = this.edgePool.pop();
    if (!e) {
      const root = div('dz-np-edge', this.layer);
      const arrow = div('dz-np-arrow', root);
      const dist = div('dz-np-dist', root);
      e = { root, arrow, dist, color: '', distM: -1, downed: false, shown: true, stamp: 0 };
    }
    e.root.style.display = '';
    e.shown = true;
    this.edges.set(id, e);
    return e;
  }

  private setDowned(p: Plate, downed: boolean): void {
    if (p.downed === downed) return;
    p.downed = downed;
    p.down.style.display = downed ? '' : 'none';
    p.hp.style.display = downed ? 'none' : '';
    p.dhp.style.display = downed ? '' : 'none';
  }

  private setEnemy(p: Plate, enemy: boolean): void {
    if (p.enemy === enemy) return;
    p.enemy = enemy;
    p.root.classList.toggle('dz-np-enemy', enemy);
    p.bar.style.display = enemy ? 'none' : '';
    p.row.style.display = enemy ? 'none' : '';
  }

  private writeDistance(el: HTMLDivElement, meters: number): void {
    el.textContent = t('hud.distanceMeters', { n: meters });
  }

  /** Project a world point; returns false when behind the camera. Writes screen px into _p.x/_p.y. */
  private project(cam: THREE.PerspectiveCamera, x: number, y: number, z: number): boolean {
    _p.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    const behind = _p.z > -0.05;
    _p.applyMatrix4(cam.projectionMatrix);
    _p.x = (_p.x * 0.5 + 0.5) * this.width;
    _p.y = (-_p.y * 0.5 + 0.5) * this.height;
    return !behind;
  }

  update(frame: FrameState, camera: THREE.PerspectiveCamera, entries: ReadonlyMap<EntityId, PlayerEntry>, dt: number): void {
    this.stamp++;
    this.frame = frame;
    this.camera = camera;
    this.dt = dt;
    camera.updateMatrixWorld();
    this.pickEnemy(frame, entries, dt);
    entries.forEach(this.visit);
    // Hide unused plates / edges.
    this.removeIds.length = 0;
    this.plates.forEach(this.collectPlate);
    for (const id of this.removeIds) {
      const p = this.plates.get(id)!;
      p.root.style.display = 'none';
      p.shown = false;
      this.plates.delete(id);
      this.platePool.push(p);
    }
    this.removeIds.length = 0;
    this.edges.forEach(this.collectEdge);
    for (const id of this.removeIds) {
      const e = this.edges.get(id)!;
      e.root.style.display = 'none';
      e.shown = false;
      this.edges.delete(id);
      this.edgePool.push(e);
    }
    this.frame = null;
    this.camera = null;
  }

  private readonly collectPlate = (p: Plate, id: EntityId): void => {
    if (p.stamp !== this.stamp) this.removeIds.push(id);
  };

  private readonly collectEdge = (e: Edge, id: EntityId): void => {
    if (e.stamp !== this.stamp) this.removeIds.push(id);
  };

  /** Choose the enemy under the crosshair (aim cone + range + line of sight), with a short linger. */
  private pickEnemy(frame: FrameState, entries: ReadonlyMap<EntityId, PlayerEntry>, dt: number): void {
    const self = frame.self;
    this.los.forEach(this.ageLos);
    this.bestId = -1;
    this.bestAng = Infinity;
    if (self && self.life !== 'dead') {
      dirFromAngles(self.aimYaw, self.aimPitch, _dir);
      _eye.x = self.eye.x; _eye.y = self.eye.y; _eye.z = self.eye.z;
      entries.forEach(this.considerEnemy);
    }
    if (this.bestId >= 0) {
      this.enemyId = this.bestId;
      this.enemyLinger = ENEMY_LINGER;
    } else {
      this.enemyLinger -= dt;
      if (this.enemyLinger <= 0) this.enemyId = -1;
    }
  }

  private bestId: EntityId = -1;
  private bestAng = Infinity;

  private readonly considerEnemy = (e: PlayerEntry): void => {
    const v = e.view;
    if (!v || v.isTeammate || v.isSelf || v.life === 'dead' || !e.tracked) return;
    const dx = e.chest.x - _eye.x, dy = e.chest.y - _eye.y, dz = e.chest.z - _eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > ENEMY_NAMEPLATE_RANGE || d < 0.5) return;
    const cosA = (dx * _dir.x + dy * _dir.y + dz * _dir.z) / d;
    const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
    // The cone grows with the target's angular size up close.
    const cone = Math.max(ENEMY_AIM_CONE, Math.atan(0.45 / d));
    if (ang > cone || ang >= this.bestAng) return;
    if (!this.hasLos(e)) return;
    this.bestId = e.id;
    this.bestAng = ang;
  };

  private readonly ageLos = (l: LosEntry): void => {
    l.age += this.dt;
  };

  private hasLos(e: PlayerEntry): boolean {
    let l = this.los.get(e.id);
    if (!l) {
      l = { age: Infinity, visible: false, stamp: 0 };
      this.los.set(e.id, l);
    }
    if (l.age > LOS_CACHE) {
      _tgt.x = e.chest.x; _tgt.y = e.chest.y; _tgt.z = e.chest.z;
      l.visible = lineOfSight(this.world, _eye, _tgt);
      l.age = 0;
    }
    return l.visible;
  }

  private readonly visit = (e: PlayerEntry): void => {
    const frame = this.frame!, cam = this.camera!;
    const v = e.view;
    if (!v || v.isSelf || !e.tracked || v.id === frame.viewTargetId || v.life === 'dead') return;
    const teammate = v.isTeammate;
    const enemyShown = !teammate && v.id === this.enemyId;
    if (!teammate && !enemyShown) return;
    const color = teamCss(v.team, frame.localTeam);
    const meters = Math.round(e.dist);
    const onScreen = this.project(cam, e.anchor.x, e.anchor.y, e.anchor.z)
      && _p.x > -20 && _p.x < this.width + 20 && _p.y > -20 && _p.y < this.height + 20;
    if (onScreen) {
      const p = this.plate(v.id);
      p.stamp = this.stamp;
      this.setEnemy(p, !teammate);
      if (p.nameText !== v.name) {
        p.nameText = v.name;
        p.name.textContent = v.name;
      }
      if (p.color !== color) {
        p.color = color;
        p.name.style.color = color;
        p.root.style.setProperty('--dz-team', color);
      }
      if (teammate) {
        const downed = v.life === 'downed';
        this.setDowned(p, downed);
        if (downed) {
          const dh = Math.max(0, Math.min(1, (v.downedHp ?? 0) / DOWNED_HEALTH));
          const q = Math.round(dh * 200) / 200;
          if (q !== p.dhpVal) {
            p.dhpVal = q;
            p.dhp.style.transform = `scaleX(${q})`;
          }
        } else {
          const h = Math.max(0, Math.min(1, (v.hp ?? MAX_HEALTH) / MAX_HEALTH));
          const q = Math.round(h * 200) / 200;
          if (q !== p.hpVal) {
            p.hpVal = q;
            p.hp.style.transform = `scaleX(${q})`;
          }
        }
        if (meters !== p.distM) {
          p.distM = meters;
          this.writeDistance(p.dist, meters);
        }
      }
      // Gentle shrink with distance; enemy plates fade in/out with the linger timer.
      const scale = Math.round(Math.max(0.72, Math.min(1, 1.05 - e.dist / 700)) * 100) / 100;
      const x = Math.round(_p.x * 2) / 2, y = Math.round(_p.y * 2) / 2;
      if (x !== p.x || y !== p.y || scale !== p.scale) {
        p.x = x; p.y = y; p.scale = scale;
        p.root.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%) scale(${scale})`;
      }
      const opacity = teammate ? 1 : Math.round(Math.min(1, this.enemyLinger / 0.15) * 20) / 20;
      if (opacity !== p.opacity) {
        p.opacity = opacity;
        p.root.style.opacity = String(opacity);
      }
      return;
    }
    if (!teammate) return;
    // Off-screen teammate: arrow on the screen edge pointing toward them.
    const ed = this.edge(v.id);
    ed.stamp = this.stamp;
    _p.set(e.anchor.x, e.anchor.y, e.anchor.z).applyMatrix4(cam.matrixWorldInverse);
    const sx0 = _p.x;
    // Behind the camera: keep the side, push the marker to the lower half of the screen.
    const sy0 = _p.z > 0 ? Math.abs(_p.y) + 0.5 * (Math.abs(_p.x) + 0.1) : -_p.y;
    let sx = sx0, sy = sy0;
    const len = Math.hypot(sx, sy) || 1;
    sx /= len; sy /= len;
    const hw = this.width / 2 - EDGE_MARGIN, hh = this.height / 2 - EDGE_MARGIN;
    const k = Math.min(hw / Math.max(1e-6, Math.abs(sx)), hh / Math.max(1e-6, Math.abs(sy)));
    const x = Math.round(this.width / 2 + sx * k), y = Math.round(this.height / 2 + sy * k);
    const angle = Math.round((Math.atan2(sy, sx) * 180) / Math.PI + 90);
    ed.root.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%)`;
    ed.arrow.style.transform = `rotate(${angle}deg)`;
    if (ed.color !== color) {
      ed.color = color;
      ed.root.style.color = color;
    }
    const downed = v.life === 'downed';
    if (ed.downed !== downed) {
      ed.downed = downed;
      ed.root.classList.toggle('dz-np-downed', downed);
    }
    if (meters !== ed.distM) {
      ed.distM = meters;
      this.writeDistance(ed.dist, meters);
    }
  };

  dispose(): void {
    this.resizeObs?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.offLang();
    this.layer.remove();
    this.plates.clear();
    this.edges.clear();
  }
}
