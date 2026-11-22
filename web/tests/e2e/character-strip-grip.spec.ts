import { expect, test, type Page } from '@playwright/test';

// 总览's head strip takes the pointer only on its heads and keys: the rest of its column, all of it but 只看模型's key in
// 只看模型, goes to the stage's inspection grip under it.

/** What takes the pointer at (fx, fy) of the strip's box, or `dy` px above its bottom. */
const hit = (page: Page, fx: number, at: { fy: number } | { dy: number }) =>
  page.locator('[data-g="listSide"]').evaluate((strip, [fx, at]) => {
    const r = strip.getBoundingClientRect();
    const y = 'fy' in at ? r.top + r.height * at.fy : r.bottom - at.dy;
    const el = document.elementFromPoint(r.left + r.width * fx, y);
    if (el?.closest('[data-inspect]')) return 'grip';
    return el?.closest('button')?.getAttribute('aria-label') ?? (el && strip.contains(el) ? 'strip' : el?.tagName ?? 'none');
  }, [fx, at] as const);

test('the head strip lets camera drags through to the grip outside its heads and keys, and all of it but the key in 只看模型', async ({ page }) => {
  await page.goto('main.html#/character?still=1&demo=ok');
  const bare = page.getByRole('button', { name: '隐藏界面' });
  await expect(bare).toBeVisible();
  // Between the heads (they end 120 px above the bottom) and the keys (106 px above it).
  expect(await hit(page, 0.5, { dy: 113 })).toBe('grip');
  expect(await hit(page, 0.5, { dy: 40 })).toMatch(/^切换角色/);
  await bare.click();
  await expect(page.getByRole('button', { name: '隐藏界面', pressed: true })).toBeVisible();
  for (const fy of [0.1, 0.4, 0.7]) expect(await hit(page, 0.5, { fy }), `${fy}`).toBe('grip');
  expect(await hit(page, 0.2, { dy: 40 })).toBe('grip');
  const key = await page.getByRole('button', { name: '隐藏界面', pressed: true }).boundingBox();
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
    [key!.x + key!.width / 2, key!.y + key!.height / 2] as const)).toBe('隐藏界面');
});
