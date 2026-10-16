// Browser smoke tests (headless Chromium with SwiftShader WebGL). They boot the real client against
// the real server (production build) and exercise the three entry points. Screenshots land in
// test-results/. Assertions poll on game state rather than fixed sleeps, because software WebGL runs
// at a few FPS and machine load varies.
import { expect, test, type Page } from '@playwright/test';

const tid = (id: string) => `[data-testid="${id}"]`;

// Cheapest graphics settings so the game loop advances quickly enough to observe.
test.use({ viewport: { width: 960, height: 540 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem('dz.settings')) {
        localStorage.setItem('dz.settings', JSON.stringify({ quality: 'low', renderScale: 0.5 }));
      }
    } catch { /* ignore */ }
  });
});

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|GPU stall|AudioContext/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

interface SelfInfo { phase: string; mode: string | null; pos: { x: number; y: number; z: number } | null; interaction: string | null }

async function frameSelf(page: Page): Promise<SelfInfo | null> {
  return page.evaluate(() => {
    type F = { self: { pos: { x: number; y: number; z: number }; mode: string } | null; phase: string; interaction: { kind: string } | null };
    const app = (window as unknown as { __dz?: { session?: { game: { getFrame(): F } } } }).__dz;
    const f = app?.session?.game.getFrame();
    return f ? { phase: f.phase, mode: f.self?.mode ?? null, pos: f.self?.pos ?? null, interaction: f.interaction?.kind ?? null } : null;
  });
}

/** No render / feel module may have fallen back to its minimal implementation. */
async function expectNoFallbacks(page: Page): Promise<void> {
  const fallbacks = await page.evaluate(() => (window as unknown as { __dzFallbacks?: () => string[] }).__dzFallbacks?.() ?? []);
  expect(fallbacks).toEqual([]);
}

test('main menu renders and language switch applies RTL', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.locator(tid('main-sp'))).toBeVisible({ timeout: 30_000 });
  await page.locator(tid('lang-select')).selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.screenshot({ path: 'test-results/menu-ar.png' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.locator(tid('lang-select')).selectOption('ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.locator(tid('lang-select')).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(errors).toEqual([]);
});

test('training ground loads and the player can move', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator(tid('main-training')).click();
  await expect(page.locator('[data-screen="game"]')).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await frameSelf(page))?.mode, { timeout: 30_000 }).toBe('ground');
  await expectNoFallbacks(page);
  const before = (await frameSelf(page))!.pos!;
  await page.mouse.click(480, 270);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => {
    const p = (await frameSelf(page))?.pos;
    return p ? Math.hypot(p.x - before.x, p.z - before.z) : 0;
  }, { timeout: 30_000 }).toBeGreaterThan(2);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: 'test-results/training.png' });
  expect(errors).toEqual([]);
});

test('single player match: plane, jump, freefall', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator(tid('main-sp')).click();
  await page.locator(tid('sp-players')).fill('12');
  await page.locator(tid('sp-start')).click();
  await expect(page.locator('[data-screen="game"]')).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await frameSelf(page))?.mode, { timeout: 30_000 }).toBe('plane');
  await expectNoFallbacks(page);
  await page.screenshot({ path: 'test-results/sp-plane.png' });
  await page.mouse.click(480, 270);
  // Wait until the plane is over the island (jump prompt), then jump: must reach freefall/parachute.
  await expect.poll(async () => (await frameSelf(page))?.interaction, { timeout: 60_000 }).toBe('jump');
  await page.keyboard.press('KeyF');
  await expect.poll(async () => (await frameSelf(page))?.mode, { timeout: 30_000 }).toMatch(/^(freefall|parachute)$/);
  await page.screenshot({ path: 'test-results/sp-drop.png' });
  expect(errors).toEqual([]);
});

test('two browser windows join the same lobby and start a match', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errA = trackErrors(a);
  const errB = trackErrors(b);
  for (const p of [a, b]) {
    await p.addInitScript(() => localStorage.setItem('dz.settings', JSON.stringify({ quality: 'low', renderScale: 0.4 })));
  }
  await a.goto('/');
  await b.goto('/');
  await a.locator(tid('main-mp')).click();
  await a.locator(tid('mp-name')).fill('Alpha');
  await a.locator(tid('mp-connect')).click();
  await a.locator(tid('create-name')).fill('Smoke Lobby');
  await a.locator(tid('create-submit')).click();
  await expect(a.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 15_000 });

  await b.locator(tid('main-mp')).click();
  await b.locator(tid('mp-name')).fill('Bravo');
  await b.locator(tid('mp-connect')).click();
  await b.locator(tid('mp-refresh')).click();
  await b.locator(tid('lobby-row')).filter({ hasText: 'Smoke Lobby' }).locator(tid('lobby-join')).click();
  await expect(b.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 15_000 });
  await b.locator(tid('lobby-ready')).click();
  await a.locator(tid('lobby-start')).click();
  await expect(a.locator('[data-screen="game"]')).toBeVisible({ timeout: 90_000 });
  await expect(b.locator('[data-screen="game"]')).toBeVisible({ timeout: 90_000 });
  // Each window sees the other human player.
  const seesOther = (p: Page, name: string) => p.evaluate((n) => {
    type F = { players: Map<number, { name: string; isSelf: boolean }> };
    const f = (window as unknown as { __dz?: { session?: { game: { getFrame(): F } } } }).__dz?.session?.game.getFrame();
    return !!f && [...f.players.values()].some((x) => !x.isSelf && x.name === n);
  }, name);
  await expect.poll(() => seesOther(a, 'Bravo'), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => seesOther(b, 'Alpha'), { timeout: 30_000 }).toBe(true);
  await expectNoFallbacks(a);
  await a.screenshot({ path: 'test-results/mp-a.png' });
  await b.screenshot({ path: 'test-results/mp-b.png' });
  expect([...errA, ...errB]).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});
