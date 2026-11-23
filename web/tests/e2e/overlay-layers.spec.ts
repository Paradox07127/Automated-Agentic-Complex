import { expect, test } from '@playwright/test';

// Tips and drawers sit above everything else on the page, including the window-drag strip of the command bar.

test('a settings row ⓘ tip is on top of the rows below it', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&still=1');
  const info = page.locator('main [data-stub="InfoTip"] button').first();
  await info.focus();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  const hits = await tip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const points = [0.25, 0.5, 0.75].flatMap((fx) => [0.25, 0.75].map((fy) => [r.left + r.width * fx, r.top + r.height * fy]));
    return points.map(([x, y]) => el.contains(document.elementFromPoint(x!, y!)));
  });
  expect(hits.every(Boolean)).toBe(true);
});

test('an open drawer takes its area out of the window-drag strip, so its close key is clickable in the app', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1');
  await page.getByRole('button', { name: /查看出错列表/ }).click();
  const sheet = page.getByRole('dialog', { name: '出错' });
  await expect(sheet).toBeVisible();
  const region = await page.evaluate(() => getComputedStyle(document.getElementById('ef-modal-root')!).getPropertyValue('-webkit-app-region'));
  expect(region).toBe('no-drag');
  await sheet.getByRole('button', { name: '关闭' }).click();
  await expect(sheet).toBeHidden();
});
