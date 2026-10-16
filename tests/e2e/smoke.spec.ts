// Browser smoke tests (headless Chromium with SwiftShader WebGL). They boot the real client against
// the real server and exercise the three entry points. Screenshots land in test-results/.
import { expect, test, type Page } from '@playwright/test';

const tid = (id: string) => `[data-testid="${id}"]`;

// Headless Chromium renders WebGL in software (SwiftShader), a few FPS at best: run with the
// cheapest graphics settings so the game loop advances quickly enough to observe.
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
    if (m.type() === 'error' && !/favicon|WebGL|GPU stall|AudioContext/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function frameSelf(page: Page) {
  return page.evaluate(() => {
    const app = (window as unknown as { __dz?: { session?: { game: { getFrame(): { self: { pos: { x: number; y: number; z: number }; mode: string } | null; phase: string } } } } }).__dz;
    const f = app?.session?.game.getFrame();
    return f ? { phase: f.phase, mode: f.self?.mode ?? null, pos: f.self?.pos ?? null } : null;
  });
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
  await page.waitForTimeout(1500);
  const before = await frameSelf(page);
  expect(before?.mode).toBe('ground');
  await page.mouse.click(480, 270);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  const after = await frameSelf(page);
  const moved = Math.hypot((after!.pos!.x - before!.pos!.x), (after!.pos!.z - before!.pos!.z));
  expect(moved).toBeGreaterThan(2);
  await page.screenshot({ path: 'test-results/training.png' });
  expect(errors).toEqual([]);
});

test('single player match starts in the plane', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator(tid('main-sp')).click();
  await page.locator(tid('sp-players')).fill('12');
  await page.locator(tid('sp-start')).click();
  await expect(page.locator('[data-screen="game"]')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(3000);
  const f = await frameSelf(page);
  expect(f?.phase).toBe('plane');
  await page.screenshot({ path: 'test-results/sp-plane.png' });
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(4000);
  const g = await frameSelf(page);
  expect(['freefall', 'parachute', 'plane']).toContain(g?.mode);
  await page.screenshot({ path: 'test-results/sp-drop.png' });
  expect(errors).toEqual([]);
});

test('two browser windows join the same lobby and start a match', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errors = [...trackErrors(a), ...trackErrors(b)];
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
  await a.waitForTimeout(3000);
  await a.screenshot({ path: 'test-results/mp-a.png' });
  await b.screenshot({ path: 'test-results/mp-b.png' });
  expect(errors).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});
