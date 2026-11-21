import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Route ids come from the directories with a route.ts (the registry enforces id === directory);
// each route's demo list is read from the running app's manifest.
const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
const routeIds = ['pages', 'dev'].flatMap((d) =>
  readdirSync(`${srcDir}${d}`, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${srcDir}${d}/${e.name}/route.ts`))
    .map((e) => e.name),
);
const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

for (const id of routeIds) {
  test(`route ${id}: every demo renders without errors`, async ({ page }, info) => {
    test.slow(id === 'ds', 'the gallery shoots ~300 demos, each waiting out the ~0.4 s header entrance clips');
    const errors = collectErrors(page);
    await page.goto('main.html');
    const manifest = await page.evaluate(() => window.__EF_ROUTES__ ?? []);
    const route = manifest.find((r) => r.id === id);
    expect(route, `route ${id} is registered`).toBeTruthy();
    if (!route) return;
    expect(route.demos.length).toBeGreaterThan(0);
    for (const demo of route.demos) {
      const qs = new URLSearchParams(demo.params).toString();
      await page.goto('about:blank');
      await page.goto(`main.html#${route.path}${qs ? `?${qs}` : ''}`);
      await expect(page.locator(`main[data-route-id="${id}"]`)).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      // Let open/fade animations finish so overlays are shot opaque; looping ones (spinners) never finish.
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
      await saveShot(page, { path: `${shotsDir}${info.project.name}/${id}-${demo.name}.png` });
    }
    expect(errors).toEqual([]);
  });
}

test('stack.html with no path renders the HUD without errors', async ({ page }, info) => {
  const errors = collectErrors(page);
  await page.goto('stack.html');
  await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
  await saveShot(page, { path: `${shotsDir}${info.project.name}/hud-default.png`, omitBackground: true });
  expect(errors).toEqual([]);
});
