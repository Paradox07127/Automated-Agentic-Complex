import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// 已关闭 / 未接入: the board or strip reads as a status, its button takes focus and jumps to the settings row,
// page content is inert, and the breathing rings stop under still.

const shot = (page: Page, name: string) => saveShot(page, { path: `.shots/${test.info().project.name}/power-state-${name}.png` });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const running = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

for (const theme of ['dark', 'light'] as const) {
  for (const d of ['off-page', 'unlinked-page', 'off-block', 'unlinked-block']) {
    test(`${theme}: PowerState ${d} reads as a status with a focusable jump`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto(`tests/fixtures/catalog/index.html#?c=PowerState&d=${d}&still=1&theme=${theme}`);
      const status = page.getByRole('status');
      await expect(status).toContainText(d.startsWith('off') ? '已关闭' : '未接入');
      const go = status.getByRole('button', { name: /^前往设置/ });
      await go.focus();
      await expect(go).toBeFocused();
      const inert = page.locator('[data-stub="PowerState"] [inert]');
      await expect(inert).toHaveCount(d.endsWith('page') ? 1 : 0);
      if (d.endsWith('page')) await expect(page.getByText('按项目分组，不要按日期。')).toBeVisible();
      expect(await running(page)).toBe(0);
      await shot(page, `${d}-${theme}`);
      expect(errors).toEqual([]);
    });
  }
}

test('未接入 breathes its rings and link unless still', async ({ page }) => {
  await page.goto('tests/fixtures/catalog/index.html#?c=PowerState&d=unlinked-page');
  await expect(page.getByRole('status')).toBeVisible();
  expect(await running(page)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await running(page)).toBe(0);
});

