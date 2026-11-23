import { expect, test, type Page } from '@playwright/test';

// Layout checks that need a real browser.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}


// 诊断 › 总览 has two plain section heads (链路, 运行); no icon block, no status dot on the heads.
test('diag section heads are plain titles', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  const heads = page.locator('main [data-stub="SecHead"]');
  await expect(heads).toHaveCount(2);
  await expect(heads.locator('[data-icon-block]')).toHaveCount(0);
  await expect(heads.locator('[data-dot]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the mood word is shown whole', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?tab=behavior&still=1');
  const word = page.getByText('有点低落', { exact: true }).first();
  await expect(word).toBeVisible();
  const clipped = await word.evaluate((n) => n.scrollWidth > n.clientWidth || n.scrollHeight > n.clientHeight);
  expect(clipped).toBe(false);
  expect(errors).toEqual([]);
});

