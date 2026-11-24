import { expect, test } from '@playwright/test';

// Review 11-22 (949c#9): the compact motion table rules reach the elements they name.

test('the motion table in a short wide window drops its column titles with the compact rows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto('main.html#/character?still=1&pane=motion');
  await expect(page.locator('[data-motion="nod"]')).toBeVisible();
  const cols = page.locator('[data-motions] > [aria-hidden="true"]').filter({ hasText: '名称' });
  expect(await cols.evaluate((e) => getComputedStyle(e).display)).toBe('none');
  // The row's name cell and its switch line up as the compact metrics say: the trigger column is gone.
  const trigger = page.locator('[data-motion="nod"]').getByText('批准之后');
  await expect(trigger).toBeHidden();
});
