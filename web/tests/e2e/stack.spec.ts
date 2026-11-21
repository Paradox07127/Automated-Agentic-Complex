import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { STACK_DEMOS } from '../../src/surfaces/stack/demos.ts';

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

for (const theme of ['dark', 'light'] as const) {
  for (const demo of STACK_DEMOS) {
    test(`hud ${theme} ${demo.name}: renders without errors`, async ({ page }, info) => {
      const errors = collectErrors(page);
      const qs = new URLSearchParams({ ...demo.params, still: '1', theme }).toString();
      await page.goto(`stack.html#/hud?${qs}`);
      await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await saveShot(page, { path: `${shotsDir}${info.project.name}/hud-${theme}-${demo.name}.png`, omitBackground: true });
      expect(errors).toEqual([]);
    });
  }
}
