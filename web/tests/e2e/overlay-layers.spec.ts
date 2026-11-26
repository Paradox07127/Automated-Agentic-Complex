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

