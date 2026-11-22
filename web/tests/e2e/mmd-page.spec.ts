import { expect, test } from '@playwright/test';

// MMD page: a queued row of the MMD 列表 keeps its dance name whole in the side panel; 上移 / 下移 / 移出 wrap below it instead.

test('a queued MMD 列表 row keeps the dance name whole beside 上移 / 下移 / 移出', async ({ page }) => {
  // The panel is at its 240 px floor here, with the buttons still on the name's line.
  await page.setViewportSize({ width: 1100, height: 650 });
  await page.goto('main.html#/mmd?still=1');
  await page.getByRole('button', { name: '导入 MMD' }).click();
  const row = page.getByRole('region', { name: 'MMD 列表' }).locator('[data-playlist-row="mmd_dance_1"]');
  await row.getByRole('button', { name: '加入' }).click();
  await expect(row.getByRole('button', { name: '移出' })).toBeVisible();
  const cut = await row.getByText('示例舞蹈', { exact: true }).evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(cut).toBe(false);
});
