// Keyboard / mouse input with pointer lock and a rebindable keymap. Produces exactly one
// PlayerInput per fixed tick (intent only: axes, base aim without recoil, buttons, stance, slot,
// actions) and edge events for the UI. The raw handlers (keyDown, mouseMove, ...) are public so
// the controller can be driven without a DOM (tests, bots-in-browser, replays).

import { clamp, DEG, damp, lerp } from '../../shared/math';
import type { ClientAction, ConsumableId, LifeState, MovementMode, PlayerInput, Stance, WeaponInstance } from '../../shared/types';
import { BTN, STANCE_CODE } from '../../shared/types';
import type { CameraMode, InputApi, InputUiEvent, KeyAction, Settings, SettingsStore } from './types';

/** Mouse look: radians per pixel of raw movement at sensitivity 1. */
export const LOOK_RAD_PER_PX = 0.0022;
export const PITCH_LIMIT = 89 * DEG;
/** Free look (Alt) range around the body heading. */
const FREE_LOOK_YAW_LIMIT = 120 * DEG;
const FREE_LOOK_RETURN_RATE = 14;
/** Browsers occasionally report absurd pointer-lock deltas; ignore spikes beyond this (px). */
const MAX_MOUSE_DELTA = 600;
/** Max actions per input (validate.ts limit). */
const MAX_ACTIONS_PER_INPUT = 4;
/** Escape keydown arriving this soon after losing pointer lock is the same press (do not toggle twice). */
const LOCK_LOSS_ESC_WINDOW_MS = 400;

/** Game state the controller needs to map keys correctly (refreshed by ClientGame every tick). */
export interface InputContext {
  mode: MovementMode;
  life: LifeState;
  stance: Stance;
  /** Seat in a vehicle (0 = driver) or -1 on foot. */
  seat: number;
  weapons: readonly (WeaponInstance | null)[];
  activeSlot: -1 | 0 | 1 | 2;
  frags: number;
  /** Current ADS blend 0..1 and the active weapon's zoom (FOV multiplier) / scope. */
  ads: number;
  adsZoom: number;
  scoped: boolean;
}

const DEFAULT_CONTEXT: InputContext = {
  mode: 'ground', life: 'alive', stance: 'stand', seat: -1, weapons: [null, null, null], activeSlot: -1,
  frags: 0, ads: 0, adsZoom: 1, scoped: false,
};

const QUICK_USE: Partial<Record<KeyAction, ConsumableId>> = {
  useBandage: 'bandage',
  useFirstAid: 'firstaid',
  useMedkit: 'medkit',
  useEnergy: 'energy',
  refuel: 'fuel',
};
const SLOT_KEYS: Partial<Record<KeyAction, number>> = { slot1: 0, slot2: 1, slot3: 2, slot4: 3 };

/** Keys that never trigger the browser default while the game has focus. */
const PREVENT_DEFAULT: ReadonlySet<KeyAction> = new Set<KeyAction>([
  'inventory', 'stats', 'freeLook', 'jump', 'menu', 'map', 'scoreboard',
]);

export class InputController implements InputApi {
  /** Base aim (radians). Yaw is continuous (not wrapped) so cameras never see a 2π jump. */
  yaw = 0;
  pitch = 0;
  /** Free-look camera offsets relative to the aim. */
  freeYaw = 0;
  freePitch = 0;
  cameraMode: CameraMode;
  /** Called when the interact key is pressed (ClientGame performs the current interaction). */
  onInteract: (() => void) | null = null;

  private settingsValue: Settings;
  private codeToAction = new Map<string, KeyAction>();
  private readonly held = new Set<KeyAction>();
  private ctx: InputContext = DEFAULT_CONTEXT;
  private enabledFlag = true;
  private target: HTMLElement | null = null;
  private lockedFlag = false;
  private intentionalUnlock = false;
  private lastLockLoss = -Infinity;
  private readonly uiListeners = new Map<InputUiEvent, Set<() => void>>();
  private readonly unsubSettings: () => void;
  private readonly domCleanup: Array<() => void> = [];

  // Mouse buttons and per-tick latches (a press shorter than a tick still registers).
  private fireHeld = false;
  private fireLatch = false;
  private adsHeld = false;
  private adsToggled = false;
  private jumpLatch = false;
  private reloadLatch = false;
  private interactLatch = false;
  private freeLookHeld = false;

  /** Desired stance (toggle / hold logic applied). */
  private wantStance: Stance = 'stand';
  /** Requested weapon slot and the seq at which it was last changed by the player. */
  private slot: -1 | 0 | 1 | 2 = -1;
  private slotChangedSeq = 0;
  private slotDirty = false;
  private grenadeArmed = false;
  private slotBeforeGrenade: -1 | 0 | 1 | 2 = -1;
  private readonly actions: ClientAction[] = [];

  constructor(private readonly settings: SettingsStore) {
    this.settingsValue = settings.get();
    this.cameraMode = this.settingsValue.cameraMode;
    this.rebuildKeymap();
    this.unsubSettings = settings.subscribe((s) => {
      const keysChanged = s.keybinds !== this.settingsValue.keybinds;
      this.settingsValue = s;
      if (keysChanged) {
        this.rebuildKeymap();
        this.held.clear();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // InputApi
  // ---------------------------------------------------------------------------

  get enabled(): boolean {
    return this.enabledFlag;
  }

  set enabled(v: boolean) {
    if (v === this.enabledFlag) return;
    this.enabledFlag = v;
    if (!v) this.releaseAll();
  }

  get locked(): boolean {
    return this.lockedFlag;
  }

  attach(target: HTMLElement): void {
    this.detach();
    this.target = target;
    const doc = target.ownerDocument;
    const win = doc.defaultView ?? window;
    const listen = <K extends string>(el: EventTarget, type: K, fn: (ev: Event) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(type, fn, opts);
      this.domCleanup.push(() => el.removeEventListener(type, fn, opts));
    };

    listen(win, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (isTypingTarget(e.target)) return;
      if (this.keyDown(e.code, e.repeat)) e.preventDefault();
    });
    listen(win, 'keyup', (ev) => {
      const e = ev as KeyboardEvent;
      if (this.keyUp(e.code)) e.preventDefault();
    });
    listen(target, 'mousedown', (ev) => {
      const e = ev as MouseEvent;
      if (!this.lockedFlag) {
        // First click only captures the mouse (it must not fire).
        if (this.enabledFlag && e.button === 0) this.requestLock();
        return;
      }
      e.preventDefault();
      this.mouseButton(e.button, true);
    });
    listen(win, 'mouseup', (ev) => {
      this.mouseButton((ev as MouseEvent).button, false);
    });
    listen(doc, 'mousemove', (ev) => {
      if (!this.lockedFlag) return;
      const e = ev as MouseEvent;
      this.mouseMove(e.movementX, e.movementY);
    });
    listen(target, 'wheel', (ev) => {
      if (!this.lockedFlag) return;
      ev.preventDefault();
      this.wheel((ev as WheelEvent).deltaY);
    }, { passive: false });
    listen(target, 'contextmenu', (ev) => ev.preventDefault());
    listen(doc, 'pointerlockchange', () => {
      const now = this.target?.ownerDocument.pointerLockElement === this.target;
      if (this.lockedFlag && !now) {
        if (!this.intentionalUnlock) this.lastLockLoss = performance.now();
        this.releaseAll();
      }
      this.intentionalUnlock = false;
      this.lockedFlag = now;
    });
    listen(win, 'blur', () => this.releaseAll());
    this.lockedFlag = doc.pointerLockElement === target;
  }

  detach(): void {
    for (const fn of this.domCleanup.splice(0)) fn();
    this.target = null;
    this.lockedFlag = false;
    this.releaseAll();
  }

  requestLock(): void {
    const t = this.target;
    if (!t || this.lockedFlag) return;
    type LockFn = (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
    const req = t.requestPointerLock as unknown as LockFn;
    const fallback = (): void => {
      try {
        const p = req.call(t);
        if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => undefined);
      } catch {
        // Lock refused (no user gesture / cooldown after Esc); the next click retries.
      }
    };
    try {
      // Raw (unaccelerated) mouse movement where supported.
      const p = req.call(t, { unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch((err: unknown) => {
          if (err instanceof Error && err.name === 'NotSupportedError') fallback();
        });
      }
    } catch {
      fallback();
    }
  }

  exitLock(): void {
    const doc = this.target?.ownerDocument;
    if (doc && doc.pointerLockElement === this.target) {
      this.intentionalUnlock = true;
      doc.exitPointerLock();
    }
  }

  on(ev: InputUiEvent, cb: () => void): () => void {
    let set = this.uiListeners.get(ev);
    if (!set) {
      set = new Set();
      this.uiListeners.set(ev, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  // ---------------------------------------------------------------------------
  // Raw handlers
  // ---------------------------------------------------------------------------

  /** Returns true when the key is bound (caller may preventDefault). */
  keyDown(code: string, repeat = false): boolean {
    const action = this.codeToAction.get(code);
    if (!action) return false;
    if (repeat) return true;

    // UI toggles work even while game input is disabled (closing the inventory / map with the same key).
    switch (action) {
      case 'inventory': this.emitUi('toggleInventory'); return true;
      case 'map': this.emitUi('toggleMap'); return true;
      case 'stats': this.emitUi('toggleStats'); return true;
      case 'scoreboard': this.emitUi('toggleScoreboard'); return true;
      case 'menu': {
        // Browsers release pointer lock on Esc; that release already opens the menu.
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (!this.lockedFlag && now - this.lastLockLoss > LOCK_LOSS_ESC_WINDOW_MS) this.emitUi('menu');
        return true;
      }
      default: break;
    }
    if (!this.enabledFlag) return PREVENT_DEFAULT.has(action);
    this.held.add(action);
    this.onPress(action);
    return true;
  }

  keyUp(code: string): boolean {
    const action = this.codeToAction.get(code);
    if (!action) return false;
    const was = this.held.delete(action);
    if (was && action === 'crouch' && !this.settingsValue.toggleCrouch && this.wantStance === 'crouch') {
      this.wantStance = 'stand';
    }
    if (action === 'freeLook') this.freeLookHeld = false;
    return true;
  }

  /** Raw pointer-lock deltas (px). */
  mouseMove(dx: number, dy: number): void {
    if (!this.enabledFlag) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
    const s = this.settingsValue;
    const c = this.ctx;
    const zoomSens = (c.scoped ? s.scopeSensitivity : s.adsSensitivity) * c.adsZoom;
    const k = LOOK_RAD_PER_PX * s.mouseSensitivity * lerp(1, zoomSens, clamp(c.ads, 0, 1));
    const ddy = dy * k * (s.invertY ? -1 : 1);
    if (this.freeLookHeld) {
      this.freeYaw = clamp(this.freeYaw - dx * k, -FREE_LOOK_YAW_LIMIT, FREE_LOOK_YAW_LIMIT);
      this.freePitch = clamp(this.pitch + this.freePitch - ddy, -PITCH_LIMIT, PITCH_LIMIT) - this.pitch;
      return;
    }
    this.yaw -= dx * k;
    this.pitch = clamp(this.pitch - ddy, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** button: 0 left (fire), 2 right (ADS). */
  mouseButton(button: number, down: boolean): void {
    if (button === 0) {
      if (down) {
        if (!this.enabledFlag) return;
        if (this.grenadeArmed) {
          this.throwGrenade();
          return;
        }
        this.fireHeld = true;
        this.fireLatch = true;
      } else {
        this.fireHeld = false;
      }
    } else if (button === 2) {
      if (down) {
        if (!this.enabledFlag) return;
        this.adsHeld = true;
        if (this.settingsValue.toggleAds) this.adsToggled = !this.adsToggled;
      } else {
        this.adsHeld = false;
      }
    }
  }

  /** Wheel cycles through the weapons that are present (deltaY > 0 = next). */
  wheel(deltaY: number): void {
    if (!this.enabledFlag || deltaY === 0 || this.ctx.seat >= 0) return;
    const w = this.ctx.weapons;
    const dir = deltaY > 0 ? 1 : -1;
    let cur: number = this.slot < 0 ? (dir > 0 ? -1 : 3) : this.slot;
    for (let i = 0; i < 3; i++) {
      cur = (cur + dir + 3) % 3;
      if (w[cur]) {
        this.selectSlot(cur as 0 | 1 | 2);
        return;
      }
    }
  }

  /** Release every held key / button (focus loss, menus). */
  releaseAll(): void {
    this.held.clear();
    this.fireHeld = false;
    this.fireLatch = false;
    this.adsHeld = false;
    this.jumpLatch = false;
    this.reloadLatch = false;
    this.interactLatch = false;
    this.freeLookHeld = false;
    if (!this.settingsValue.toggleCrouch && this.wantStance === 'crouch') this.wantStance = 'stand';
  }

  // ---------------------------------------------------------------------------
  // Game side
  // ---------------------------------------------------------------------------

  setContext(ctx: InputContext): void {
    const prev = this.ctx;
    this.ctx = ctx;
    const wasMounted = prev.seat >= 0 || prev.mode !== 'ground';
    const mounted = ctx.seat >= 0 || (ctx.mode !== 'ground' && ctx.mode !== 'swim');
    if (mounted && !wasMounted) {
      // Entering a vehicle / the drop resets on-foot toggles.
      this.adsToggled = false;
      this.wantStance = 'stand';
      this.grenadeArmed = false;
    }
    if (ctx.life !== 'alive') {
      this.adsToggled = false;
      this.grenadeArmed = false;
    }
    if (this.grenadeArmed && ctx.frags <= 0) this.cancelGrenade();
  }

  /** Set the aim (spawn heading, spectator handoff). */
  setAim(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Free look is active while Alt is held or the camera is still easing back. */
  get freeLook(): boolean {
    return this.freeLookHeld || Math.abs(this.freeYaw) > 1e-3 || Math.abs(this.freePitch) > 1e-3;
  }

  get requestedSlot(): -1 | 0 | 1 | 2 {
    return this.slot;
  }

  /** Seq of the input in which the player last changed the requested slot. */
  get slotRequestSeq(): number {
    return this.slotChangedSeq;
  }

  /** The authoritative state settled on another slot (pickup auto-equip, weapon dropped...). */
  adoptSlot(slot: -1 | 0 | 1 | 2): void {
    this.slot = slot;
    this.slotDirty = false;
    if (slot !== -1) this.grenadeArmed = false;
  }

  get wantsAds(): boolean {
    return this.enabledFlag && (this.adsHeld || this.adsToggled) && !this.grenadeArmed;
  }

  get isGrenadeArmed(): boolean {
    return this.grenadeArmed;
  }

  queueAction(a: ClientAction): void {
    if (this.actions.length < 16) this.actions.push(a);
  }

  /** Per frame: free look easing. */
  update(dt: number): void {
    if (!this.freeLookHeld && (this.freeYaw !== 0 || this.freePitch !== 0)) {
      const k = damp(FREE_LOOK_RETURN_RATE, dt);
      this.freeYaw -= this.freeYaw * k;
      this.freePitch -= this.freePitch * k;
      if (Math.abs(this.freeYaw) < 1e-4) this.freeYaw = 0;
      if (Math.abs(this.freePitch) < 1e-4) this.freePitch = 0;
    }
  }

  /** Build the input for the next fixed tick and clear per-tick latches. */
  sample(seq: number, rt: number): PlayerInput {
    const h = this.held;
    const c = this.ctx;
    const on = this.enabledFlag;
    let mx = 0, mz = 0;
    if (on) {
      if (h.has('right')) mx += 1;
      if (h.has('left')) mx -= 1;
      if (h.has('forward')) mz += 1;
      if (h.has('back')) mz -= 1;
    }
    const inVehicle = c.seat >= 0 || c.mode === 'vehicle';
    const driving = inVehicle && c.seat === 0;
    const dropping = c.mode === 'freefall' || c.mode === 'parachute';
    let buttons = 0;
    if (on) {
      const ads = this.wantsAds;
      if ((this.fireHeld || this.fireLatch) && !this.grenadeArmed) buttons |= BTN.FIRE;
      if (driving) {
        if (h.has('jump')) buttons |= BTN.HANDBRAKE;
        if (h.has('sprint')) buttons |= BTN.BOOST;
      } else if (dropping) {
        if (h.has('back')) buttons |= BTN.FLARE;
      } else {
        if (ads) buttons |= BTN.ADS;
        if (h.has('sprint')) buttons |= ads ? (c.scoped ? BTN.HOLD_BREATH : 0) : BTN.SPRINT;
        if (this.jumpLatch) buttons |= BTN.JUMP;
        if (h.has('walk')) buttons |= BTN.WALK;
        const ll = h.has('leanLeft'), lr = h.has('leanRight');
        if (ll && !lr) buttons |= BTN.LEAN_L;
        if (lr && !ll) buttons |= BTN.LEAN_R;
      }
      if (inVehicle && !driving && ads) buttons |= BTN.ADS;
      if (this.reloadLatch) buttons |= BTN.RELOAD;
      if (h.has('interact') || this.interactLatch) buttons |= BTN.INTERACT;
      if (this.freeLookHeld) buttons |= BTN.FREELOOK;
    }
    this.fireLatch = false;
    this.jumpLatch = false;
    this.reloadLatch = false;
    this.interactLatch = false;
    if (this.slotDirty) {
      this.slotDirty = false;
      this.slotChangedSeq = seq;
    }

    const input: PlayerInput = {
      seq,
      mx,
      mz,
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
      stance: STANCE_CODE[inVehicle || dropping ? 'stand' : this.wantStance],
      slot: this.slot,
      rt,
    };
    if (this.actions.length > 0) input.actions = this.actions.splice(0, MAX_ACTIONS_PER_INPUT);
    return input;
  }

  dispose(): void {
    this.detach();
    this.unsubSettings();
    this.uiListeners.clear();
    this.onInteract = null;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private rebuildKeymap(): void {
    this.codeToAction.clear();
    const binds = this.settingsValue.keybinds;
    for (const action of Object.keys(binds) as KeyAction[]) this.codeToAction.set(binds[action], action);
  }

  private emitUi(ev: InputUiEvent): void {
    const set = this.uiListeners.get(ev);
    if (!set) return;
    for (const cb of set) {
      try {
        cb();
      } catch (err) {
        console.error(`[input] '${ev}' listener failed`, err);
      }
    }
  }

  private onPress(action: KeyAction): void {
    const c = this.ctx;
    const inVehicle = c.seat >= 0 || c.mode === 'vehicle';
    const onFoot = !inVehicle && (c.mode === 'ground' || c.mode === 'swim');
    const slotKey = SLOT_KEYS[action];
    if (slotKey !== undefined) {
      if (inVehicle) this.queueAction({ a: 'seat', seat: slotKey });
      else if (slotKey === 3) this.toggleGrenade();
      else if (c.weapons[slotKey]) this.selectSlot(slotKey as 0 | 1 | 2);
      return;
    }
    const quick = QUICK_USE[action];
    if (quick) {
      this.queueAction({ a: 'use', item: quick });
      return;
    }
    switch (action) {
      case 'jump':
        if (!onFoot) return;
        if (this.wantStance === 'prone') {
          this.wantStance = 'stand'; // Space stands up from prone instead of jumping
          return;
        }
        if (this.wantStance === 'crouch') this.wantStance = 'stand';
        this.jumpLatch = true;
        return;
      case 'crouch':
        if (!onFoot) return;
        if (this.settingsValue.toggleCrouch) this.wantStance = this.wantStance === 'crouch' ? 'stand' : 'crouch';
        else this.wantStance = 'crouch';
        return;
      case 'prone':
        if (!onFoot) return;
        this.wantStance = this.wantStance === 'prone' ? 'stand' : 'prone';
        return;
      case 'sprint':
        if (onFoot && this.held.has('forward')) {
          if (this.wantStance !== 'stand') this.wantStance = 'stand';
          if (!this.adsHeld) this.adsToggled = false;
        }
        return;
      case 'reload':
        this.reloadLatch = true;
        return;
      case 'interact':
        this.interactLatch = true;
        this.onInteract?.();
        return;
      case 'throw':
        if (onFoot && c.frags > 0) this.queueAction({ a: 'throw' });
        return;
      case 'holster':
        if (!inVehicle) this.selectSlot(-1);
        return;
      case 'swapWeapons':
        if (!inVehicle) this.queueAction({ a: 'swapWeapons' });
        return;
      case 'cameraToggle':
        this.cameraMode = this.cameraMode === 'tpp' ? 'fpp' : 'tpp';
        this.emitUi('toggleCamera');
        return;
      case 'freeLook':
        this.freeLookHeld = true;
        return;
      default:
        return;
    }
  }

  private selectSlot(slot: -1 | 0 | 1 | 2): void {
    this.grenadeArmed = false;
    if (slot === this.slot) return;
    this.slot = slot;
    this.slotDirty = true;
    this.adsToggled = false;
  }

  private toggleGrenade(): void {
    if (this.grenadeArmed) {
      this.cancelGrenade();
      return;
    }
    if (this.ctx.frags <= 0) return;
    this.slotBeforeGrenade = this.slot;
    this.selectSlot(-1);
    this.grenadeArmed = true;
    this.adsToggled = false;
  }

  private cancelGrenade(): void {
    if (!this.grenadeArmed) return;
    this.grenadeArmed = false;
    const back = this.slotBeforeGrenade;
    if (back === -1 || this.ctx.weapons[back]) this.selectSlot(back);
  }

  private throwGrenade(): void {
    this.queueAction({ a: 'throw' });
    // Back to the previous weapon (PUBG style) unless more frags remain and the player keeps it armed.
    this.cancelGrenade();
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== 'string') return false;
  const el = t as HTMLElement;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
