import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('overview action band: 快速输入 and 屏幕识读 run the desktop ops and say so', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?still=1');
  const band = page.getByRole('toolbar', { name: '常用操作' });
  const done = { 快速输入: '已打开快速输入', 屏幕识读: '正在识读前台窗口' };
  for (const [name, toast] of Object.entries(done)) {
    await band.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(page.getByText(toast)).toBeVisible();
  }
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '免打扰' }).click();
  await expect(page.getByRole('menuitem', { name: /暂停观察 1 小时/ })).not.toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

test('overview: expired approvals leave the 01 count and the card moves to the next open item', async ({ page }) => {
  const errors = collectErrors(page);
  await page.clock.install();
  await page.goto('main.html#/overview');
  const sec = page.locator('section[aria-label="待处理"]');
  const head = sec.locator('[data-stub="SecHead"]');
  await expect(head).toContainText('[5]');
  await page.clock.fastForward(30_000);
  await expect(head).toContainText('[4]');
  await expect(sec.locator('[data-pending-row]')).toHaveCount(3);
  await page.clock.fastForward(32_000);
  await expect(head).toContainText('[2]');
  await expect(sec.locator('[data-stub="ApprovalCard"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
