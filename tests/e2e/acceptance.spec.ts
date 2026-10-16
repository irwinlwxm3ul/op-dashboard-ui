// PLAN.md §8 manual acceptance tests, automated in headless Chromium against the production build
// served by the real game server (see playwright.config.ts). Software WebGL renders a few FPS, so
// these tests assert behaviour and state (frame state, client events, DOM), never pixels, and
// the timing-sensitive parts of each test (ballistic flight times, fire cadence, lag compensation,
// vehicles, knock / revive) are verified precisely at the Node level in
// tests/integration/acceptance.test.ts with the same ClientGame / MatchRunner code.
//
// Coverage map (PLAN.md §8):
//   1 Languages / RTL ............ here (two tests)
//   2 Training ballistics ........ here (event flow) + integration (flight time, drop, holdover)
//   3 Game feel .................. here (spray, recoil, camera kick) + integration (rpm, pattern)
//   4 SP full loop ............... here (UI loop to results and back) + integration (full loop)
//   5 Two-window multiplayer ..... here (lobby -> match -> see each other -> back to the lobby)
//                                  + integration (hits / kill in both clients)
//   6 Teammates online ........... here (duo flags + health) + integration (knock -> revive)
//   7 Lag compensation ........... integration only (needs a controlled 150 ms link)
//   8 Vehicles ................... integration only (scripted driving / crash / fuel / wreck)
//   9 Distance visibility ........ here (best effort) + integration (interest management + LOD)
//  10 Anti-cheat ................. tests/cheats.test.ts
//  11 Performance overlay ........ here (F3)

import { expect, test, type Browser, type Page } from '@playwright/test';
import { WEAPONS, sightDrop } from '../../src/shared/items';
import { ar } from '../../src/client/i18n/locales/ar';
import { de } from '../../src/client/i18n/locales/de';
import { en } from '../../src/client/i18n/locales/en';
import { ja } from '../../src/client/i18n/locales/ja';
import {
  anglesTo, distXZ, events, frame, mouse, pageNow, prepare, queueAction, setAim, startTraining, tid, trackErrors,
  visibleTexts, waitForFrame, type DzWindow,
} from './helpers';

test.use({ viewport: { width: 960, height: 540 } });

// ---------------------------------------------------------------------------------------------
// 1. Languages / RTL
// ---------------------------------------------------------------------------------------------

/** Strings the translators deliberately keep identical to English (brand, key caps, units). */
const NEUTRAL = new Set<string>(
  Object.keys(en).filter((k) => (ar as Record<string, string>)[k] === (en as Record<string, string>)[k])
    .map((k) => (en as Record<string, string>)[k]),
);
const LATIN_WORD = /[A-Za-z]{2,}/;
const ARABIC = /[؀-ۿ]/;

/** Menu screens go back to the main menu on Escape. */
async function backToMain(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-screen="main"]')).toBeVisible();
}

/** Collect the visible text of each menu screen / modal (back to the main menu afterwards). */
async function sampleScreens(page: Page): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  await expect(page.locator(tid('main-sp'))).toBeVisible();
  out.main = await visibleTexts(page);
  await page.locator(tid('main-sp')).click();
  await expect(page.locator('[data-screen="singleplayer"]')).toBeVisible();
  out.singleplayer = await visibleTexts(page);
  await backToMain(page);
  await page.locator(tid('main-mp')).click();
  await expect(page.locator('[data-screen="multiplayer"]')).toBeVisible();
  out.multiplayer = await visibleTexts(page);
  await backToMain(page);
  for (const modal of ['main-settings', 'main-controls']) {
    await page.locator(tid(modal)).click();
    await page.waitForTimeout(400);
    out[modal] = (await visibleTexts(page)).filter((t) => !out.main.includes(t));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  return out;
}

test('AT1 languages: Arabic translates every menu screen and mirrors RTL, persists across reloads; Japanese; English', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  await prepare(page);
  await page.goto('/');
  await expect(page.locator(tid('main-sp'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  const english = await sampleScreens(page);
  const englishAll = new Set(Object.values(english).flat());
  expect(englishAll.size).toBeGreaterThan(30);

  await page.locator(tid('lang-select')).selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator(tid('main-sp'))).toContainText(ar['menu.singlePlayer']);
  const arabic = await sampleScreens(page);
  const leaks: string[] = [];
  for (const [screen, texts] of Object.entries(arabic)) {
    expect(texts.some((t) => ARABIC.test(t)), `${screen} shows Arabic text`).toBe(true);
    for (const t of texts) {
      if (LATIN_WORD.test(t) && englishAll.has(t) && !NEUTRAL.has(t)) leaks.push(`${screen}: ${t}`);
    }
  }
  expect(leaks, 'English strings left on Arabic screens').toEqual([]);
  // Layout mirrors: the main navigation sits on the right half in RTL.
  const box = await page.locator(tid('main-sp')).boundingBox();
  expect(box!.x + box!.width / 2).toBeGreaterThan(960 / 2);
  await page.screenshot({ path: 'test-results/acceptance-ar.png' });

  await page.reload();
  await expect(page.locator(tid('main-sp'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator(tid('main-sp'))).toContainText(ar['menu.singlePlayer']);

  await page.locator(tid('lang-select')).selectOption('ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator(tid('main-sp'))).toContainText(ja['menu.singlePlayer']);
  await page.locator(tid('lang-select')).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator(tid('main-sp'))).toContainText(en['menu.singlePlayer']);
  await page.reload();
  await expect(page.locator(tid('main-sp'))).toContainText(en['menu.singlePlayer'], { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('AT1 a first visit with a German browser opens in German', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ locale: 'de-DE', viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await prepare(page);
  await page.goto('/');
  await expect(page.locator(tid('main-sp'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator(tid('main-sp'))).toContainText(de['menu.singlePlayer']);
  await expect(page.locator(tid('main-training'))).toContainText(de['menu.training']);
  await expect(page.locator(tid('main-mp'))).toContainText(de['menu.multiplayer']);
  await expect(page.locator(tid('lang-select'))).toHaveValue('de');
  expect(errors).toEqual([]);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------
// 2, 3, 11. Training ground (one shared page: the training world takes a while to load)
// ---------------------------------------------------------------------------------------------

test.describe.serial('training ground', () => {
  let page: Page;
  let errors: string[] = [];

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    test.setTimeout(240_000);
    page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    errors = trackErrors(page);
    await prepare(page);
    await startTraining(page);
  });
  test.afterAll(async () => { await page?.close(); });

  test('AT11 F3 toggles the performance overlay (FPS, frame time, draw calls, triangles, entities, ping)', async () => {
    test.setTimeout(90_000);
    const fps = page.getByText(en['hud.stats.fps'], { exact: true });
    const draws = page.getByText(en['hud.stats.drawCalls'], { exact: true });
    await expect(draws).toBeHidden();
    await page.keyboard.press('F3');
    for (const key of ['hud.stats.fps', 'hud.stats.frame', 'hud.stats.drawCalls', 'hud.stats.triangles', 'hud.stats.entities', 'hud.stats.ping'] as const) {
      await expect(page.getByText(en[key], { exact: true }), en[key]).toBeVisible({ timeout: 20_000 });
    }
    // Each label is followed by its live value.
    const valueOf = async (label: typeof draws) => (await label.locator('xpath=following-sibling::*[1]').textContent())?.trim() ?? '';
    await expect.poll(async () => Number((await valueOf(draws)).replace(/[^\d.]/g, '')), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => Number((await valueOf(fps)).replace(/[^\d.]/g, '')), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/acceptance-f3.png' });
    await page.keyboard.press('F3');
    await expect(draws).toBeHidden({ timeout: 10_000 });
  });

  test('AT2 sniper shot at the 300 m target: ballistic projectile, delayed hit; the AR hits instantly', async () => {
    test.setTimeout(180_000);
    await queueAction(page, { a: 'give', item: 'sniper' });
    await page.waitForTimeout(800);
    await queueAction(page, { a: 'give', item: 'ammo_300' });
    await waitForFrame(page, (f) => f.self!.weapons.includes('sniper'), 30_000, 'sniper in the inventory');
    const slot = (await frame(page))!.self!.weapons.indexOf('sniper');
    await page.keyboard.press(`Digit${slot + 1}`);
    await waitForFrame(page, (f) => f.self!.weapon === 'sniper' && f.self!.drawProgress < 0, 30_000, 'sniper drawn');
    await mouse(page, 2, true);
    await waitForFrame(page, (f) => f.self!.ads >= 0.99, 20_000, 'scoped in');
    const f0 = (await frame(page))!;
    const t300 = f0.trainingTargets.find((t) => t.kind === 'static' && t.range === 300)!;
    const eye = f0.self!.eye;
    const d = distXZ(eye, t300.center);
    // Hold over by the drop at this distance (sights are zeroed at 100 m).
    const aim = anglesTo(eye, { ...t300.center, y: t300.center.y + sightDrop(WEAPONS.sniper, d) });
    await setAim(page, aim.yaw, aim.pitch);
    await page.waitForTimeout(1500);
    const since = await pageNow(page);
    await mouse(page, 0, true);
    await page.waitForTimeout(600);
    await mouse(page, 0, false);
    let hit: { at: number; ev: { target: number; part: string; distance: number } } | undefined;
    await expect.poll(async () => {
      hit = (await events(page, ['targetHit'], since)).find((e) => e.ev.target === t300.id);
      return !!hit;
    }, { timeout: 60_000, message: 'targetHit on the 300 m plate' }).toBe(true);
    const local = (await events(page, ['localShot'], since)).filter((e) => e.ev.weapon === 'sniper');
    expect(local.length).toBe(1);
    expect(local[0].ev.ballistic).toBe(true);
    const shot = (await events(page, ['shot'], since)).find((e) => e.ev.weapon === 'sniper');
    expect(shot?.ev.projectiles?.length, 'the server fired a ballistic projectile').toBe(1);
    expect(hit!.ev.distance).toBeGreaterThan(290);
    // The impact read-out arrives at least the ~0.4 s time of flight after the shot.
    expect(hit!.at - shot!.at).toBeGreaterThan(350);
    expect(hit!.at - local[0].at).toBeGreaterThan(350);
    await mouse(page, 2, false);

    // AR at the 100 m plate: hitscan, the read-out comes with the shot itself.
    await queueAction(page, { a: 'give', item: 'ar' });
    await page.waitForTimeout(800);
    await queueAction(page, { a: 'give', item: 'ammo_556' });
    await waitForFrame(page, (f) => f.self!.weapons.includes('ar'), 30_000, 'AR in the inventory');
    const arSlot = (await frame(page))!.self!.weapons.indexOf('ar');
    await page.keyboard.press(`Digit${arSlot + 1}`);
    await waitForFrame(page, (f) => f.self!.weapon === 'ar' && f.self!.drawProgress < 0, 30_000, 'AR drawn');
    await mouse(page, 2, true);
    await waitForFrame(page, (f) => f.self!.ads >= 0.99, 20_000, 'ADS');
    const f1 = (await frame(page))!;
    const t100 = f1.trainingTargets.find((t) => t.kind === 'static' && t.range === 100)!;
    const aim100 = anglesTo(f1.self!.eye, t100.center);
    await setAim(page, aim100.yaw, aim100.pitch);
    await page.waitForTimeout(1500);
    const since2 = await pageNow(page);
    await mouse(page, 0, true);
    await page.waitForTimeout(150);
    await mouse(page, 0, false);
    let hit2: { at: number; ev: { target: number } } | undefined;
    await expect.poll(async () => {
      hit2 = (await events(page, ['targetHit'], since2)).find((e) => e.ev.target === t100.id);
      return !!hit2;
    }, { timeout: 60_000, message: 'targetHit on the 100 m plate' }).toBe(true);
    const arShot = (await events(page, ['shot'], since2)).find((e) => e.ev.weapon === 'ar');
    expect(arShot?.ev.projectiles).toBeUndefined();
    // Same snapshot as its shot event (no travel time).
    expect(hit2!.at - arShot!.at).toBeLessThan(5);
    await mouse(page, 2, false);
    expect(errors).toEqual([]);
  });

  test('AT3 AR spray: predicted shots + tracers, recoil climbs and recovers, cosmetic camera kick', async () => {
    test.setTimeout(150_000);
    await waitForFrame(page, (f) => f.self!.weapon === 'ar', 20_000, 'AR in hand');
    const f0 = (await frame(page))!;
    const t25 = f0.trainingTargets.find((t) => t.kind === 'static' && t.range === 25)!;
    const aim = anglesTo(f0.self!.eye, { ...t25.center, y: t25.center.y - 1 });
    await setAim(page, aim.yaw, aim.pitch);
    await page.waitForTimeout(800);
    const since = await pageNow(page);
    let maxRecoil = 0;
    let maxKick = 0;
    let kickSeen = false;
    await mouse(page, 0, true);
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const s = await page.evaluate(() => {
        const ses = (window as unknown as DzWindow).__dz?.session;
        return { r: ses?.game.getFrame().self?.recoilPitch ?? 0, k: ses?.feel?.state?.kick?.pitch };
      });
      maxRecoil = Math.max(maxRecoil, s.r);
      if (typeof s.k === 'number') { kickSeen = true; maxKick = Math.max(maxKick, Math.abs(s.k)); }
      await page.waitForTimeout(100);
    }
    await mouse(page, 0, false);
    const local = (await events(page, ['localShot'], since)).filter((e) => e.ev.weapon === 'ar');
    const shots = (await events(page, ['shot'], since)).filter((e) => e.ev.weapon === 'ar' && e.ev.shooter === f0.localId);
    expect(local.length, 'predicted shots (tracer, muzzle flash, sound)').toBeGreaterThanOrEqual(5);
    expect(shots.length, 'authoritative shots').toBeGreaterThanOrEqual(5);
    expect(shots.every((e) => e.ev.ends.length === 1), 'hitscan tracer end points').toBe(true);
    expect(maxRecoil, 'recoil climbs during the spray').toBeGreaterThan(0.02);
    if (kickSeen) expect(maxKick, 'cosmetic camera kick').toBeGreaterThan(0);
    await expect.poll(async () => (await frame(page))!.self!.recoilPitch, { timeout: 30_000, message: 'recoil recovers' })
      .toBeLessThan(maxRecoil * 0.3);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Single-player full loop (UI): setup -> match -> results -> back to the setup screen
// ---------------------------------------------------------------------------------------------

test('AT4 single player: 2 players vs a hard bot, fast zone -> plane -> drop -> results -> back to setup', async ({ page }) => {
  test.setTimeout(16 * 60_000);
  const errors = trackErrors(page);
  await prepare(page, { 'dz.ui.sp': { maxPlayers: 2, teamSize: 1, botDifficulty: 'hard', zoneSpeed: 0.6 } });
  await page.goto('/');
  await page.locator(tid('main-sp')).click();
  await expect(page.locator('[data-screen="singleplayer"]')).toBeVisible();
  await page.locator(tid('sp-players')).fill('2');
  await page.locator(tid('sp-start')).click();
  await expect(page.locator('[data-screen="game"]')).toBeVisible({ timeout: 150_000 });
  const f0 = await waitForFrame(page, (f) => f.phase === 'plane' && f.self?.mode === 'plane', 60_000, 'in the plane');
  expect(f0.roster.length).toBe(2);
  expect(f0.roster.filter((r) => r.isBot).length).toBe(1);
  expect(f0.self!.placement).toBe(0);

  // Jump with F once the prompt appears (the auto-eject at the end of the route is the fallback).
  const jumpBy = Date.now() + 120_000;
  for (;;) {
    const f = (await frame(page))!;
    if (f.self!.mode !== 'plane') break;
    expect(Date.now(), 'left the plane').toBeLessThan(jumpBy);
    await page.keyboard.press('KeyF');
    await page.waitForTimeout(500);
  }
  await waitForFrame(page, (f) => f.self!.mode === 'ground' || f.self!.mode === 'swim' || f.self!.life !== 'alive', 180_000, 'landed');
  const jumps = await events(page, ['jumpPlane', 'chuteOpen']);
  expect(jumps.some((e) => e.ev.type === 'jumpPlane' && e.ev.player === f0.localId)).toBe(true);
  expect(jumps.some((e) => e.ev.type === 'chuteOpen' && e.ev.player === f0.localId)).toBe(true);
  await page.screenshot({ path: 'test-results/acceptance-sp-landed.png' });

  // Play on until the zone / the bot decides the match: winner or elimination -> results screen.
  await expect(page.locator('[data-screen="results"]')).toBeVisible({ timeout: 13 * 60_000 });
  await expect(page.locator(tid('results'))).toBeVisible();
  const ends = await events(page, ['matchEnd', 'zonePhase', 'kill']);
  expect(ends.filter((e) => e.ev.type === 'zonePhase').length).toBeGreaterThan(1);
  const end = ends.find((e) => e.ev.type === 'matchEnd');
  if (end && end.ev.type === 'matchEnd') {
    expect(end.ev.results.players.map((p) => p.placement).sort()).toEqual([1, 2]);
  }
  await page.screenshot({ path: 'test-results/acceptance-sp-results.png' });
  await page.locator(tid('results-back')).click();
  await expect(page.locator('[data-screen="singleplayer"], [data-screen="main"]').first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// 5 + 6. Two windows online
// ---------------------------------------------------------------------------------------------

async function openWindow(browser: Browser, name: string): Promise<{ page: Page; errors: string[]; close(): Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await prepare(page);
  await page.goto('/');
  await page.locator(tid('main-mp')).click();
  await page.locator(tid('mp-name')).fill(name);
  await page.locator(tid('mp-connect')).click();
  return { page, errors, close: () => ctx.close() };
}

async function lobbyFlow(a: Page, b: Page, lobbyName: string, opts: { teamSize: 1 | 2; botFill: boolean; max: number }): Promise<void> {
  await a.locator(tid('create-name')).fill(lobbyName);
  await a.locator(tid('create-max')).fill(String(opts.max));
  await a.locator(tid('create-teamsize')).selectOption(String(opts.teamSize));
  await a.locator(tid('create-botfill')).setChecked(opts.botFill, { force: true });
  await a.locator(tid('create-submit')).click();
  await expect(a.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 15_000 });
  await b.locator(tid('mp-refresh')).click();
  await b.locator(tid('lobby-row')).filter({ hasText: lobbyName }).locator(tid('lobby-join')).click();
  await expect(b.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 15_000 });
}

test('AT5 two windows: lobby -> match -> each window sees the other human -> leave -> both back in the lobby', async ({ browser }) => {
  test.setTimeout(300_000);
  const A = await openWindow(browser, 'Ann');
  const B = await openWindow(browser, 'Ben');
  try {
    await lobbyFlow(A.page, B.page, 'Acceptance solo', { teamSize: 1, botFill: false, max: 8 });
    await B.page.locator(tid('lobby-ready')).click();
    await A.page.locator(tid('lobby-start')).click();
    await expect(A.page.locator('[data-screen="game"]')).toBeVisible({ timeout: 150_000 });
    await expect(B.page.locator('[data-screen="game"]')).toBeVisible({ timeout: 150_000 });
    const fa = await waitForFrame(A.page, (f) => f.players.some((p) => p.name === 'Ben'), 60_000, 'A sees Ben');
    const fb = await waitForFrame(B.page, (f) => f.players.some((p) => p.name === 'Ann'), 60_000, 'B sees Ann');
    expect(fa.roster.length).toBe(2);
    expect(fa.roster.every((r) => !r.isBot)).toBe(true);
    const ben = fa.players.find((p) => p.name === 'Ben')!;
    expect(ben.isTeammate).toBe(false);
    expect(ben.hp, 'enemy health is never sent').toBeNull();
    expect(ben.id).toBe(fb.localId);
    expect(fb.players.find((p) => p.name === 'Ann')!.id).toBe(fa.localId);
    await A.page.screenshot({ path: 'test-results/acceptance-mp-a.png' });
    await B.page.screenshot({ path: 'test-results/acceptance-mp-b.png' });

    // Leave through the pause menu: both windows return to the same lobby room.
    for (const w of [A, B]) {
      await w.page.keyboard.press('Escape');
      await expect(w.page.locator(tid('pause-menu'))).toBeVisible({ timeout: 20_000 });
      await w.page.locator(tid('pause-leave')).click();
      await expect(w.page.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 30_000 });
    }
    await expect(A.page.locator(tid('lobby-start'))).toBeVisible();
    await expect(A.page.getByText('Ben').first()).toBeVisible();
    await expect(B.page.getByText('Ann').first()).toBeVisible();
    expect([...A.errors, ...B.errors]).toEqual([]);
  } finally {
    await A.close();
    await B.close();
  }
});

test('AT6 duo online: both windows on team 1 with bots -> teammate flagged with health (nameplate data)', async ({ browser }) => {
  test.setTimeout(300_000);
  const A = await openWindow(browser, 'Cleo');
  const B = await openWindow(browser, 'Dan');
  try {
    await lobbyFlow(A.page, B.page, 'Acceptance duo', { teamSize: 2, botFill: true, max: 6 });
    await B.page.locator(tid('team-0')).click();
    await expect(A.page.locator(tid('team-0'))).toContainText('Dan', { timeout: 15_000 });
    await expect(A.page.locator(tid('team-0'))).toContainText('Cleo');
    await B.page.locator(tid('lobby-ready')).click();
    await A.page.locator(tid('lobby-start')).click();
    await expect(A.page.locator('[data-screen="game"]')).toBeVisible({ timeout: 150_000 });
    await expect(B.page.locator('[data-screen="game"]')).toBeVisible({ timeout: 150_000 });
    const fa = await waitForFrame(A.page, (f) => f.players.some((p) => p.name === 'Dan' && p.hp !== null), 60_000, 'A sees Dan with health');
    const fb = await waitForFrame(B.page, (f) => f.players.some((p) => p.name === 'Cleo' && p.hp !== null), 60_000, 'B sees Cleo with health');
    expect(fa.localTeam).toBe(fb.localTeam);
    const dan = fa.players.find((p) => p.name === 'Dan')!;
    expect(dan.isTeammate).toBe(true);
    expect(dan.hp).toBe(100);
    expect(fb.players.find((p) => p.name === 'Cleo')!.isTeammate).toBe(true);
    const bots = fa.roster.filter((r) => r.isBot);
    expect(bots.length).toBe(4);
    for (const b of bots) {
      expect(b.team).not.toBe(fa.localTeam);
      const v = fa.players.find((p) => p.id === b.id);
      if (v) {
        expect(v.isTeammate).toBe(false);
        expect(v.hp).toBeNull();
      }
    }
    await A.page.screenshot({ path: 'test-results/acceptance-duo-a.png' });
    expect([...A.errors, ...B.errors]).toEqual([]);
  } finally {
    await A.close();
    await B.close();
  }
});

// ---------------------------------------------------------------------------------------------
// 9. Distance visibility (best effort)
// ---------------------------------------------------------------------------------------------

test('AT9 single player: enemies 400-800 m away stay in the client view with fresh updates', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const errors = trackErrors(page);
  await prepare(page);
  await page.goto('/');
  await page.locator(tid('main-sp')).click();
  await page.locator(tid('sp-players')).fill('24');
  await page.locator(tid('sp-teamsize')).selectOption('1');
  await page.locator(tid('sp-start')).click();
  await expect(page.locator('[data-screen="game"]')).toBeVisible({ timeout: 150_000 });
  await waitForFrame(page, (f) => f.phase === 'plane', 60_000, 'plane');
  for (let i = 0; i < 240; i++) {
    const f = (await frame(page))!;
    if (f.self!.mode !== 'plane') break;
    await page.keyboard.press('KeyF');
    await page.waitForTimeout(500);
  }
  await waitForFrame(page, (f) => f.self!.mode === 'ground' || f.self!.mode === 'swim' || f.self!.life !== 'alive', 180_000, 'landed');
  // Bots land around the island; sample the view for a while.
  let far: { id: number; d: number; age: number }[] = [];
  const end = Date.now() + 120_000;
  while (Date.now() < end && far.length === 0) {
    await page.waitForTimeout(2000);
    const f = (await frame(page))!;
    if (!f.self) break;
    far = f.players
      .filter((p) => !p.isTeammate && p.id !== f.localId && p.life !== 'dead')
      .map((p) => ({ id: p.id, d: distXZ(p.pos, f.self!.pos), age: p.age }))
      .filter((p) => p.d >= 400 && p.d <= 800);
  }
  test.info().annotations.push({ type: 'far enemies', description: JSON.stringify(far) });
  expect(far.length, 'an enemy 400-800 m away is part of the rendered frame').toBeGreaterThan(0);
  // Updates keep flowing at range (4 Hz beyond 500 m); allow for the slow software renderer.
  for (const p of far) expect(p.age).toBeLessThan(2000);
  expect(errors).toEqual([]);
});
