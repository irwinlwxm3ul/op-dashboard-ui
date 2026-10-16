// Shared helpers for the browser acceptance tests (tests/e2e/acceptance.spec.ts).
//
// The page is the production build served by the real game server. Gameplay state is observed
// through the debug handle the App exposes (`window.__dz`, see src/client/main.ts): the running
// MatchSession's ClientGame (`getFrame()`, the client event bus, the InputController). Aim and
// trigger are driven through the InputController's public raw handlers (`setAim`, `mouseButton`)
// because headless Chromium cannot take pointer lock (the canvas ignores mouse buttons until the
// pointer is captured); keyboard input goes through real key presses.

import type { Page } from '@playwright/test';
import type { ClientAction, GameEvent, Vec3 } from '../../src/shared/types';
import type { ClientEvent, FrameState, LocalEvent } from '../../src/client/game/types';

export const tid = (id: string): string => `[data-testid="${id}"]`;

/** Cheapest graphics (SwiftShader renders a few FPS at best) unless a test seeds other settings. */
export async function prepare(page: Page, storage: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((seed: Record<string, unknown>) => {
    try {
      if (!localStorage.getItem('dz.settings')) {
        localStorage.setItem('dz.settings', JSON.stringify({ quality: 'low', renderScale: 0.5 }));
      }
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  }, storage);
  await installEventTap(page);
}

/** Page errors and console errors (minus known-harmless headless noise). */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|WebGL|GPU stall|AudioContext|pointer ?lock/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------
// In-page access
// ---------------------------------------------------------------------------------------------

interface InputLike {
  setAim(yaw: number, pitch: number): void;
  mouseButton(button: number, down: boolean): void;
}
interface GameLike {
  getFrame(): FrameState;
  queueAction(a: ClientAction): void;
  performInteraction(): void;
  readonly input: InputLike;
  readonly events: { onAny(cb: (ev: ClientEvent) => void): () => void };
}
export interface DzWindow {
  __dz?: {
    session?: { game: GameLike; feel?: { state?: { kick?: { pitch: number } } } } | null;
    core?: { stats(): { fps: number; drawCalls: number } } | null;
  };
  __dzTap?: { events: TapEvent[]; game: unknown };
}

/** A client event as recorded in the page (performance.now() of the frame that dispatched it). */
export interface TapEvent { at: number; ev: ClientEvent }

/**
 * Records every client event (server GameEvents and locally predicted events) of whichever match
 * is running, re-attaching when a new MatchSession starts.
 */
async function installEventTap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as DzWindow;
    const tap = { events: [] as TapEvent[], game: null as unknown };
    w.__dzTap = tap;
    setInterval(() => {
      const g = w.__dz?.session?.game;
      if (!g || g === tap.game) return;
      tap.game = g;
      g.events.onAny((ev) => {
        // Matches can end with large results payloads; everything here is plain JSON data.
        tap.events.push({ at: performance.now(), ev: JSON.parse(JSON.stringify(ev)) as ClientEvent });
        if (tap.events.length > 6000) tap.events.splice(0, 1000);
      });
    }, 50);
  });
}

type EvOf<T extends ClientEvent['type']> = Extract<GameEvent | LocalEvent, { type: T }>;

/** Recorded events of the given types (oldest first), optionally after page time `since`. */
export async function events<T extends ClientEvent['type']>(page: Page, types: T[], since = 0): Promise<{ at: number; ev: EvOf<T> }[]> {
  return page.evaluate(({ types, since }) => {
    const tap = (window as unknown as DzWindow).__dzTap;
    return (tap?.events ?? []).filter((e) => e.at >= since && (types as string[]).includes(e.ev.type));
  }, { types, since }) as Promise<{ at: number; ev: EvOf<T> }[]>;
}

export async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

/** JSON-safe digest of the current frame (null while no match is running). */
export interface FrameDigest {
  screen: string | null;
  phase: string;
  localId: number | null;
  localTeam: number;
  serverNow: number;
  self: {
    mode: string; life: string; pos: Vec3; eye: Vec3; weapon: string | null; weapons: (string | null)[];
    recoilPitch: number; ads: number; drawProgress: number; fireCooldown: number; reloadProgress: number;
    placement: number; health: number;
  } | null;
  players: { id: number; name: string; isBot: boolean; isTeammate: boolean; hp: number | null; life: string; pos: Vec3; age: number }[];
  roster: { id: number; name: string; team: number; isBot: boolean }[];
  trainingTargets: { id: number; range: number; kind: string; center: Vec3 }[];
  hasResults: boolean;
  zoneR: number;
}

export async function frame(page: Page): Promise<FrameDigest | null> {
  return page.evaluate(() => {
    const f = (window as unknown as DzWindow).__dz?.session?.game.getFrame();
    if (!f) return null;
    const s = f.self;
    return {
      screen: document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null,
      phase: f.phase,
      localId: f.localId,
      localTeam: f.localTeam,
      serverNow: f.serverNow,
      self: s ? {
        mode: s.mode, life: s.life, pos: { ...s.pos }, eye: { ...s.eye }, weapon: s.weapon,
        weapons: s.weapons.map((w) => (w ? w.id : null)), recoilPitch: s.recoilPitch, ads: s.ads,
        drawProgress: s.drawProgress, fireCooldown: s.fireCooldown, reloadProgress: s.reloadProgress,
        placement: s.placement, health: s.health,
      } : null,
      players: [...f.players.values()].map((p) => ({
        id: p.id, name: p.name, isBot: p.isBot, isTeammate: p.isTeammate, hp: p.hp, life: p.life, pos: { ...p.pos }, age: p.age,
      })),
      roster: [...f.roster.values()].map((r) => ({ id: r.id, name: r.name, team: r.team, isBot: r.isBot })),
      trainingTargets: (f.world.training?.targets ?? []).map((t) => ({ id: t.id, range: t.range, kind: t.kind, center: { ...t.pos } })),
      hasResults: f.results !== null,
      zoneR: f.zone.r,
    };
  });
}

/** Poll the frame digest until `pred` holds. */
export async function waitForFrame(page: Page, pred: (f: FrameDigest) => boolean, timeoutMs: number, what: string): Promise<FrameDigest> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const f = await frame(page);
    if (f && pred(f)) return f;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last frame: ${JSON.stringify(f && { phase: f.phase, self: f.self })}`);
    await page.waitForTimeout(250);
  }
}

export async function queueAction(page: Page, a: ClientAction): Promise<void> {
  await page.evaluate((act) => (window as unknown as DzWindow).__dz?.session?.game.queueAction(act), a);
}

export async function setAim(page: Page, yaw: number, pitch: number): Promise<void> {
  await page.evaluate(([y, p]) => (window as unknown as DzWindow).__dz?.session?.game.input.setAim(y, p), [yaw, pitch]);
}

export async function mouse(page: Page, button: 0 | 2, down: boolean): Promise<void> {
  await page.evaluate(([b, d]) => (window as unknown as DzWindow).__dz?.session?.game.input.mouseButton(b as number, d as boolean), [button, down]);
}

/** yaw / pitch from `from` to `to` (yaw 0 faces -Z, positive yaw turns left). */
export function anglesTo(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

export const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Main menu -> Training; resolves once the local player stands on the training ground. */
export async function startTraining(page: Page): Promise<FrameDigest> {
  await page.goto('/');
  await page.locator(tid('main-training')).click();
  await page.locator('[data-screen="game"]').waitFor({ timeout: 150_000 });
  return waitForFrame(page, (f) => f.phase === 'playing' && f.self?.mode === 'ground', 60_000, 'training ground ready');
}

/**
 * Visible text of the current page (text nodes of rendered elements), excluding the language
 * picker's native language names.
 */
export async function visibleTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 2) continue;
      const el = n.parentElement;
      if (!el || el.closest('select, option, script, style, [aria-hidden="true"]')) continue;
      const vis = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })
        ?? el.getClientRects().length > 0;
      if (!vis) continue;
      out.add(text);
    }
    return [...out];
  });
}
