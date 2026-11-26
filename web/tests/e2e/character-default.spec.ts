import { expect, test } from '@playwright/test';

// character-default has no big avatar; no Chinese under 12 px. The memory cases moved to memory.spec.ts.

// The page brings back the preview stage as the page's main visual; its English marks are aria-hidden decoration.

test('character motions: group heads stay inside the table, a behavior-only row has a disabled preview mark, a missing duration reads —', async ({ page }) => {
  await page.setViewportSize({ width: 1385, height: 770 });
  await page.goto('main.html#/character?still=1&pane=motion');
  const grid = page.getByRole('grid', { name: '全部动作' });
  await expect(grid.locator('[data-motion="walk"]')).toBeVisible();
  const outside = await grid.evaluate((g) => {
    const right = g.getBoundingClientRect().right;
    return [...g.querySelectorAll('[role="rowgroup"] > :first-child *')].filter((c) => c.getBoundingClientRect().right > right + 0.5).map((c) => c.textContent);
  });
  expect(outside).toEqual([]);
  await expect(grid).not.toContainText('不支持单独预览');
  // A behavior-only row has the AUTO lead and says why on hover.
  await expect(grid.locator('[data-motion="walk"]')).toHaveAttribute('title', '由行为触发 │ 不支持单独预览');
  await expect(grid.locator('[data-motion="walk"] [data-mark="auto"]')).toBeVisible();
  await expect(grid.locator('[data-motion="nod"]')).not.toHaveAttribute('title', /不支持单独预览/);
  for (const id of ['drag', 'idle', 'walk']) await expect(grid.locator(`[data-motion="${id}"]`)).toContainText('—');
});

