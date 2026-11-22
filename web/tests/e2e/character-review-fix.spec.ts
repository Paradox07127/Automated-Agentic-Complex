import { expect, test } from '@playwright/test';

// 角色页 after the review of 11-22 (fix card 3): 编排 scrolls its pool rows only, so its commit bar stays in view; a wide but short window
// takes the compact room under the compact stage.

for (const [width, height] of [
  [1440, 900],
  [925, 515],
] as const) {
  test(`编排 at ${width}×${height} with 她建议 open keeps the commit bar in the panel`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('main.html#/character?still=1&pane=chain');
    await expect(page.locator('[data-commit]')).toBeVisible();
    await expect(page.getByText('她建议').first()).toBeVisible();
    const m = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-g="detail"] [role="tabpanel"]')!;
      const b = body.getBoundingClientRect();
      const c = document.querySelector('[data-commit]')!.getBoundingClientRect();
      return { bodyBottom: b.bottom, commitBottom: c.bottom, viewport: window.innerHeight };
    });
    expect(m.commitBottom).toBeLessThanOrEqual(m.bodyBottom + 1);
    expect(m.commitBottom).toBeLessThanOrEqual(m.viewport);
  });
}

test('a window wider than 1100 and 520 tall takes the compact room values the stage uses', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto('main.html#/character?still=1&pane=look');
  await expect(page.locator('[data-stage]')).toBeVisible();
  await expect(page.locator('[data-page="character"]')).toHaveAttribute('data-compact', 'true');
  const rail = await page.locator('[data-training-room]').evaluate((el) => getComputedStyle(el).getPropertyValue('--room-rail').trim());
  expect(rail).toBe('52px');
});
