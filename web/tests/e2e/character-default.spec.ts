import { expect, test, type Page } from '@playwright/test';

// character-default has no big avatar; no Chinese under 12 px. The memory cases moved to memory.spec.ts.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Visible text nodes with Chinese in them whose font is under 12 px, as `size text`. */
async function smallChinese(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.querySelector('main') ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? '';
      const el = n.parentElement;
      if (!el || !/[一-鿿]/.test(text)) continue;
      if (el.closest('[hidden], [aria-hidden="true"], [role="tooltip"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size} ${text.trim()}`);
    }
    return out;
  });
}

// The page brings back the preview stage as the page's main visual; its English marks are aria-hidden decoration.
test('character-default: roster heads stay small, look options and layer switches, no small Chinese', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1');
  // The roster opens from the 切换角色 key of 总览's head strip.
  await page.getByRole('button', { name: /^切换角色/ }).click();
  await expect(page.getByRole('navigation', { name: '角色名册' })).toBeVisible();
  const tallest = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('main svg[viewBox="0 0 22 30"]')].map((s) => s.getBoundingClientRect().height)));
  expect(tallest).toBeLessThanOrEqual(48);
  expect(await smallChinese(page)).toEqual([]);
  await page.goto('main.html#/character?still=1&pane=look');
  await expect(page.getByRole('group', { name: '外观' }).getByRole('button').first()).toBeVisible();
  // 显示 has its own tab in the detail panel.
  await page.getByRole('tablist', { name: '角色页签' }).getByRole('tab', { name: '显示' }).click();
  await expect(page.getByRole('group', { name: '服装分层' }).getByRole('radiogroup', { name: '外套' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/Plan\d|\bROLE\b/);
  expect(await page.locator('main [data-stage] :text-is("NOW")').evaluateAll((els) => els.every((e) => e.closest('[aria-hidden="true"]')))).toBe(true);
  expect(await smallChinese(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('character behavior uses switches', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/tune?tab=behavior&still=1');
  await expect(page.getByRole('switch', { name: '看向鼠标' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('lean_edge');
  expect(errors).toEqual([]);
});

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

test('tune: plate numbers are Title Case and no SVG text is under 11 px', async ({ page }) => {
  await page.goto('main.html#/tune?still=1');
  await expect(page.getByRole('region', { name: '屏幕示意' })).toBeVisible();
  const nos = await page.locator('main [data-stub="Plate"] > [aria-hidden="true"]').allTextContents();
  expect(nos.filter((t) => /[A-Z]{2}/.test(t))).toEqual([]);
  const small = await page.locator('main svg text').evaluateAll((els) => els.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 11).map((e) => e.textContent));
  expect(small).toEqual([]);
});

test('pipeline: the source bar carries no how-to line; memory-empty: 活动回顾 shows its empty state', async ({ page }) => {
  await page.goto('main.html#/pipeline?still=1');
  await expect(page.getByRole('region', { name: '记忆概况' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('点击一段筛选列表');
  await page.goto('about:blank');
  await page.goto('main.html#/memory?plugins=all&still=1&state=empty');
  const activity = page.getByRole('region', { name: '活动回顾' });
  await expect(activity).toContainText('还没有整理出的工作片段');
  await expect(activity.getByRole('button', { name: /^查看 / })).toHaveCount(0);
});
