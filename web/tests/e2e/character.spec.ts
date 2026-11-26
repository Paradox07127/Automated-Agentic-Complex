import { expect, test, type Page } from '@playwright/test';

// Character page and 诊断 › 行为决策 it hands the state curves to: blocks, interactions, error and offline demos, and no sideways scroll at the four window sizes.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// The section jump row scrolls sideways on purpose (`data-hscroll`).
const overflowX = (page: Page, id: string) =>
  page.evaluate((id) =>
    [document.documentElement, document.querySelector('[data-shell="content"]'), ...document.querySelectorAll(`[data-page="${id}"] *`)].some(
      (e) => e != null && !e.hasAttribute('data-hscroll') && getComputedStyle(e).overflowX !== 'visible' && getComputedStyle(e).overflowX !== 'hidden' && getComputedStyle(e).overflowX !== 'clip' && e.scrollWidth > e.clientWidth + 1,
    ),
  id);

/** The roster opens from the 切换角色 key of 总览's head strip. */
async function roster(page: Page) {
  await page.getByRole('button', { name: /^切换角色/ }).click();
  const nav = page.getByRole('navigation', { name: '角色名册' });
  await expect(nav).toBeVisible();
  return nav;
}

test('ok: roster, stage and the motion table with two unsaved switches; no state tabs', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1&demo=ok');
  await expect(page.getByRole('navigation', { name: '角色名册' })).toHaveCount(0);
  await roster(page);
  await page.goto('main.html#/character?still=1&demo=ok&pane=motion');
  await expect(page.getByRole('button', { name: /^切换角色/ })).toHaveCount(0);
  // The selected motion is its row; the stage has no 当前动作 band.
  await expect(page.locator('[data-motion="nod"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('grid', { name: '全部动作' })).toContainText('移动与姿态');
  await expect(page.getByRole('region', { name: '状态与行为决策' })).toHaveCount(0);
  await expect(page.getByText(/已修改\s*2\s*项/)).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('loading: the header and an empty stage show before the catalog', async ({ page }) => {
  await page.goto('main.html#/character?still=1&state=loading');
  await expect(page.getByRole('status').filter({ hasText: '读取中' }).first()).toBeVisible();
  await expect(page.locator('[data-stage][aria-busy="true"]')).toBeVisible();
});

test('900×600: the portrait stays beside the action list', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('main.html#/character?still=1&pane=motion');
  const preview = page.locator('[data-preview-stage]');
  await expect(preview).toBeVisible();
  const stage = (await preview.boundingBox())!;
  const grid = page.getByRole('grid', { name: '全部动作' });
  await expect(grid).toBeVisible();
  const table = (await grid.boundingBox())!;
  expect(table.x).toBeGreaterThan(stage.x + stage.width);
  expect(table.width).toBeGreaterThan(stage.width);
  expect(await overflowX(page, 'character')).toBe(false);
});

test('interactions: pick a motion, preview on the desktop', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1&pane=motion');
  const stage = page.locator('[data-stage]');
  await page.locator('[data-motion="wave"]').getByRole('button', { pressed: false }).click();
  await expect(page.locator('[data-motion="wave"]')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /桌面预览/ }).click();
  await expect(stage.getByRole('status')).toContainText('挥手');
  expect(errors).toEqual([]);
});

test('设定 › 画面 holds the developer quality rows, 诊断 › 行为决策 the state and decisions on one chart', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1&tab=render');
  await expect(page.locator('#set-rnd\\.shadow')).toBeVisible();
  await expect(page.locator('#set-rnd\\.shadow [data-stub="DevMark"]')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: '活动方式' })).toHaveCount(0);
  await page.goto('main.html#/diag?still=1');
  await page.getByRole('tab', { name: '行为决策' }).click();
  await expect(page.getByRole('region', { name: '精神与心情 │ 行为决策' })).toContainText('硬规则');
  await expect(page.locator('[data-motion]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('error: says the state read failed and keeps the page', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1&state=error&pane=motion');
  await expect(page.getByText(/读取角色状态失败/)).toBeVisible();
  await expect(page.getByRole('grid', { name: '全部动作' })).toBeVisible();
  expect(errors).toEqual([]);
});

// The 外观 and 显示 tabs head their rows; the 大小 title bar heads one row that holds the presets (while they fit), the slider and the readout on one line.
for (const w of [900, 1050, 1280]) {
  test(`${w}: 外观, 显示 and 大小 head their rows, and the 大小 row keeps presets, slider and readout on one line`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto('main.html#/character?still=1&pane=look');
    const tabs = page.getByRole('tablist', { name: '角色页签' });
    const pane = page.locator('[data-view="operator"] [data-pane="look"]');
    const heads = async (tab: string, list: ReturnType<Page['locator']>) => {
      const t = (await tabs.getByRole('tab', { name: tab }).boundingBox())!;
      const c = (await list.boundingBox())!;
      expect(c.y, tab).toBeGreaterThanOrEqual(t.y + t.height - 1);
    };
    await heads('外观', pane.getByRole('group', { name: '外观' }));
    const title = (await pane.getByRole('heading', { name: '大小', exact: true }).boundingBox())!;
    const row = (await pane.locator('[data-size-row]').boundingBox())!;
    const slider = (await pane.getByRole('slider', { name: '大小' }).boundingBox())!;
    const out = (await pane.locator('[data-size-row] output').boundingBox())!;
    expect(row.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    for (const box of [slider, out]) {
      expect(box.y).toBeGreaterThanOrEqual(row.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height + 1);
    }
    expect(out.x).toBeGreaterThan(slider.x + slider.width - 1);
    expect(out.x + out.width).toBeLessThanOrEqual(row.x + row.width + 1);
    const presets = pane.getByRole('button', { name: '大小预设' });
    if (await presets.isVisible()) {
      const p = (await presets.boundingBox())!;
      expect(slider.x).toBeGreaterThan(p.x + p.width - 1);
      expect(Math.abs(p.y + p.height / 2 - (slider.y + slider.height / 2))).toBeLessThan(10);
    }
    // 显示 has its own tab in the detail panel.
    await tabs.getByRole('tab', { name: '显示' }).click();
    await heads('显示', pane.getByRole('group', { name: '服装分层' }));
  });
}

