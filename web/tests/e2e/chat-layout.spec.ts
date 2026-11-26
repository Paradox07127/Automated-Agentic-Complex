import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('chat default: the command bar is visible, no right column, and the reading column is centered and up to 48rem wide', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1');
  const thread = page.getByRole('region', { name: '消息' });
  await expect(thread.getByText('按项目分组，不要按日期。')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: /轮次详情|任务/ })).toHaveCount(0);
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const pane = (await thread.boundingBox())!;
  const reply = (await page.locator('[data-kind="ai"]').last().boundingBox())!;
  expect(reply.width).toBeLessThanOrEqual(48 * rem);
  expect(reply.width).toBeGreaterThanOrEqual(48 * rem - 16);
  expect(Math.abs(reply.x + reply.width / 2 - pane.x - pane.width / 2)).toBeLessThanOrEqual(8);
  const font = await page.locator('[data-kind="ai"] [class*="_text_"]').last().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]);
  expect(font).toEqual(['15px', '24px']);
  expect(errors).toEqual([]);
});

test('chat default: the inline task opens the 任务 tab in the right column, its 关闭 key closes it', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&still=1');
  await page.getByRole('button', { name: /^任务 整理本周提交周报/ }).click();
  const col = page.getByRole('complementary', { name: '任务', exact: true });
  await expect(col).toBeVisible();
  await expect(col.getByRole('heading', { name: '整理本周提交周报' })).toHaveCount(1);
  await col.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(col).toHaveCount(0);
});

