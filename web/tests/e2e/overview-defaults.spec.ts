import { expect, test, type Page } from '@playwright/test';

// 工业简报 with the plug-ins at their defaults (none of the optional ones on), at the 1280×800 baseline.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('defaults: no 进行中, no 派发任务 or 屏幕识读 in the action band, no error, no sideways overflow', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?still=1');
  await expect(page.locator('section[aria-label="待处理"]')).toBeVisible();
  const band = page.locator('[data-shell="bottom-bar"]').getByRole('toolbar', { name: '常用操作' });
  await expect(band.getByRole('button', { name: /^快速输入/ })).toBeVisible();
  await expect(page.locator('section[aria-label="进行中"]')).toHaveCount(0);
  for (const name of ['派发任务', '屏幕识读']) await expect(band.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/失败|已在别处更新|无响应|拒绝访问|没有读到/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
