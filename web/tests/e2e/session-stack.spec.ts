import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Presence sessions as the HUD's lines, with an approval on its session.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, demo: string, theme: 'dark' | 'light') {
  await page.goto('about:blank');
  await page.goto(`stack.html#/hud?${new URLSearchParams({ demo, theme, still: '1' }).toString()}`);
  await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function shot(page: Page, project: string, name: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await saveShot(page, { path: `${shotsDir}${project}/session-stack-${name}.png`, omitBackground: true });
}

const lines = (page: Page) => page.locator('[data-hud-row]');
const expand = (page: Page) => page.getByRole('button', { name: /^展开全部/ });

for (const theme of ['dark', 'light'] as const) {

  test(`${theme}: a waiting session with its approval inline`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'session-approval', theme);
    await expand(page).click();
    const top = lines(page).first();
    await expect(top).toHaveAttribute('data-status', 'waiting');
    await expect(top.getByRole('img', { name: '待处理' })).toBeVisible();
    await expect(top.locator('[data-card-id]')).toHaveCount(1);
    await expect(top.getByRole('button', { name: '批准' })).toBeVisible();
    await expect(page.locator('[data-card-id]')).toHaveCount(1);
    // The approval stays inside the line's edges.
    const outer = await top.boundingBox();
    const inner = await top.locator('[data-card-id]').boundingBox();
    expect(outer && inner && inner.x >= outer.x && inner.x + inner.width <= outer.x + outer.width + 0.5).toBe(true);
    await shot(page, info.project.name, `${theme}-session-approval`);
    expect(errors).toEqual([]);
  });

  test(`${theme}: empty shows nothing`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'empty', theme);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    await expect(lines(page)).toHaveCount(0);
    await shot(page, info.project.name, `${theme}-empty`);
    expect(errors).toEqual([]);
  });
}
