import { expect, test, type Page } from '@playwright/test';

// 每日简报 with only its own plug-in on (none of the other optional ones), at the 1280×800 baseline.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('defaults: the six pinned readouts, 进行中 已关闭, no 派发任务 and 屏幕识读 off in the action band, no error, no sideways overflow', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=daily_brief&still=1');
  await expect(page.locator('section[aria-label="待处理"]')).toBeVisible();
  const readouts = page.getByRole('list', { name: '读数' }).locator('[data-item]');
  await expect(readouts).toHaveCount(6);
  expect(await readouts.evaluateAll((els) => els.map((e) => e.getAttribute('data-item')))).toEqual(['done', 'err', 'turn', 'fg', 'say', 'cost']);
  await expect(page.locator('section[aria-label="工业简报"]')).toHaveCount(0);
  const band = page.locator('[data-shell="bottom-bar"]').getByRole('toolbar', { name: '常用操作' });
  await expect(band.getByRole('button', { name: /^快速输入/ })).toBeVisible();
  await expect(page.locator('section[aria-label="进行中"]')).toHaveCount(0);
  await expect(page.getByRole('status', { name: '进行中' })).toContainText('已关闭');
  await expect(band.getByRole('button', { name: /^派发任务/ })).toHaveCount(0);
  await expect(band.getByRole('button', { name: /^屏幕识读/ })).toHaveAttribute('title', '已关闭：设置里关着「屏幕识读」');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/失败|已在别处更新|无响应|拒绝访问|没有读到/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
