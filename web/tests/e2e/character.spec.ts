import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Character page and the 调参 page it hands 行为与画面 to: blocks, interactions, error and offline demos, 调参's sparse demo, and no sideways scroll at the four window sizes.

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
  const stage = page.locator('[data-stage]');
  await expect(stage).toContainText('点头附和');
  await expect(page.getByRole('grid', { name: '全部动作' })).toContainText('移动与姿态');
  await expect(page.getByRole('region', { name: '状态与行为决策' })).toHaveCount(0);
  await expect(page.getByText(/已修改\s*2\s*项/)).toBeVisible();
  await expect(page.getByRole('button', { name: /保存/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('stage labels are Chinese; the jump row names each section in full', async ({ page }) => {
  await page.goto('main.html#/character?still=1');
  await expect(page.locator('[data-stage] [data-nameplate]')).toHaveText('示例乙在桌面SI在做坐着');
  await page.goto('main.html#/character?still=1&pane=motion');
  const stage = page.locator('[data-stage]');
  await expect(stage).toContainText('触发');
  await expect(stage.locator('[data-nameplate]')).toHaveCount(0);
  await expect(stage).not.toContainText(/TRIGGER|TIME|TODAY|NOW|DESKTOP PARTNER|MOTION/i);
  const jump = page.getByRole('group', { name: '跳转到分区' });
  await expect(jump.getByRole('button', { name: '跳转到 移动与姿态' })).toHaveText('移动与姿态');
});

test('section tabs scroll the inner action list to the matching group in both directions', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 650 });
  await page.goto('main.html#/character?still=1&pane=motion');
  const grid = page.getByRole('grid', { name: '全部动作' });
  await grid.evaluate((el) => {
    Object.assign(el.style, { flex: 'none', height: '100px', overflowY: 'auto' });
  });
  for (const [name, key] of [['反应', 'react'], ['说话', 'talk']]) {
    await page.getByRole('button', { name: `跳转到 ${name}` }).click();
    await expect.poll(() => grid.evaluate((el, key) => {
      const group = el.querySelector(`[data-group="${key}"]`)!;
      return Math.abs(group.getBoundingClientRect().top - el.getBoundingClientRect().top);
    }, key)).toBeLessThanOrEqual(1);
  }
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
  await page.locator('[data-motion="wave"]').click();
  await expect(stage).toContainText('挥手');
  await page.getByRole('button', { name: /桌面预览/ }).click();
  await expect(stage.getByRole('status')).toContainText('挥手');
  expect(errors).toEqual([]);
});

test('调参: the old 行为与画面 tab lands here; behavior, render, 行为决策 and the full motion table', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/tune?still=1&tab=render');
  await expect(page.locator('[data-page="tune"]')).toBeVisible();
  expect(new URL(page.url()).hash).toMatch(/^#\/tune\?/);
  await expect(page.getByRole('radiogroup', { name: '活动方式' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: '镜头预设' })).toBeVisible();
  await page.getByRole('tab', { name: '行为决策' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('硬规则');
  await expect(page.locator('[data-motion="nod"]')).toContainText('批准之后');
  expect(errors).toEqual([]);
});

test('switching asks first and names what happens to the current character', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1');
  await (await roster(page)).getByRole('button', { name: '示例甲' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('示例乙 先从桌面隐藏');
  await dialog.getByRole('button', { name: '切换', exact: true }).click();
  await expect(page.getByText('已切换到 示例甲')).toBeVisible();
  expect(errors).toEqual([]);
});

test('sparse on 调参: few plays, and the state curve from where the log starts', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/tune?still=1&demo=sparse');
  await expect(page.getByText(/今日播放较少/)).toBeVisible();
  await expect(page.getByText(/起记录/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('error: says the state read failed and keeps the page', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1&state=error&pane=motion');
  await expect(page.getByText(/读取角色状态失败/)).toBeVisible();
  await expect(page.getByRole('grid', { name: '全部动作' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('offline: the stage says the character is not running and the table is read-only', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1&demo=offline&pane=motion');
  await expect(page.locator('[data-stage]').getByRole('status')).toContainText('角色未运行');
  await expect(page.getByRole('switch', { name: '挥手' })).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`import VMD (${theme}): 导入中… while the fake imports on the MMD page, then the title, the baked entry and its ＋ into the MMD 列表`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await page.goto(`main.html#/character?still=1&theme=${theme}`);
    await page.getByRole('navigation', { name: '角色分区' }).getByRole('button', { name: 'MMD' }).click();
    await expect(page.locator('[data-page="mmd"]')).toBeVisible();
    const button = page.getByRole('button', { name: '导入 VMD' });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByRole('button', { name: '导入中…' })).toBeDisabled();
    await expect(page.locator('[data-motion-import]')).toHaveText('已导入「示例舞蹈」（VMD）');
    const entry = page.locator('[data-mmd="mmd_dance_1"]');
    await expect(entry).toHaveAttribute('data-state', 'baked');
    await entry.locator('button[aria-pressed]').click();
    await expect(page.locator('[data-mmd-detail="mmd_dance_1"]').getByRole('button', { name: '桌面播放' })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'MMD 列表' })).toBeVisible();
    await expect(entry.getByRole('button', { name: '加入演出列表' })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await saveShot(page, { path: `.shots/${info.project.name}/character-import-vmd-${theme}.png` });
    expect(errors).toEqual([]);
  });
}

const ACCENT = 'rgb(255, 241, 0)';
// The character page's dark rows mark the selected one with this yellow left edge.
const ROW_MARK = 'rgb(255, 230, 0)';

for (const theme of ['dark', 'light'] as const) {
  test(`yellow marks (${theme}): the current character and the current motion's row edge; the commit line sits in the bottom bar`, async ({ page }) => {
    await page.goto(`main.html#/character?still=1&demo=ok&theme=${theme}`);
    const fill = (l: ReturnType<Page['locator']>) => l.evaluate((e) => getComputedStyle(e).backgroundImage + getComputedStyle(e).backgroundColor);
    const nav = await roster(page);
    await expect(nav.locator('button[aria-current]')).toHaveCount(1);
    expect(await fill(nav.locator('button[aria-current] [data-g="bg"]'))).toContain(ACCENT);
    await page.goto(`main.html#/character?still=1&demo=ok&pane=motion&theme=${theme}`);
    const edge = (l: ReturnType<Page['locator']>) => l.evaluate((e) => getComputedStyle(e).borderLeftColor);
    expect(await edge(page.locator('[data-motion="nod"]'))).toBe(ROW_MARK);
    expect(await edge(page.locator('[data-motion="talk"]'))).not.toBe(ROW_MARK);
    const bar = page.locator('[data-slot="bottom"]');
    await expect(bar.getByRole('button', { name: /桌面预览/ })).toBeVisible();
    await expect(bar.getByRole('button', { name: '保存' })).toBeVisible();
    await expect(bar).toContainText(/已修改\s*2\s*项/);
  });
}

// The 外观 and 显示 tabs head their rows; the 大小 row names itself left of its presets, and the slider sits on the presets' line or wraps under them.
for (const w of [900, 1050, 1280]) {
  test(`${w}: 外观, 显示 and 大小 head their options, and the 大小 slider sits beside or under its presets`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto('main.html#/character?still=1&pane=look');
    const tabs = page.getByRole('tablist', { name: '角色页签' });
    const pane = page.locator('[data-view="operator"] [data-pane="look"]');
    const heads = async (tab: string, list: ReturnType<Page['locator']>) => {
      const t = (await tabs.getByRole('tab', { name: tab }).boundingBox())!;
      const c = (await list.boundingBox())!;
      expect(c.y, tab).toBeGreaterThanOrEqual(t.y + t.height - 1);
    };
    await heads('外观', pane.getByRole('listbox', { name: '外观' }));
    const name = (await pane.getByText('大小', { exact: true }).boundingBox())!;
    const presets = (await pane.getByRole('listbox', { name: '大小预设' }).boundingBox())!;
    const slider = (await pane.getByRole('slider', { name: '大小' }).boundingBox())!;
    expect(presets.x).toBeGreaterThan(name.x + name.width - 1);
    expect(Math.abs(presets.y + presets.height / 2 - (name.y + name.height / 2))).toBeLessThan(8);
    if (slider.y >= presets.y + presets.height - 1) {
      expect(slider.x + slider.width).toBeGreaterThan(presets.x);
    } else {
      expect(Math.abs(presets.y + presets.height / 2 - (slider.y + slider.height / 2))).toBeLessThan(8);
      expect(slider.x).toBeGreaterThan(presets.x + presets.width - 1);
    }
    // 显示 has its own tab in the detail panel.
    await tabs.getByRole('tab', { name: '显示' }).click();
    await heads('显示', pane.getByRole('group', { name: '服装分层' }));
  });
}

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`${w}×${h}: no sideways scroll on 角色 or 调参`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('main.html#/character?still=1&demo=ok&pane=motion');
    await expect(page.getByRole('grid', { name: '全部动作' })).toBeVisible();
    expect(await overflowX(page, 'character')).toBe(false);
    await page.goto('main.html#/tune?still=1');
    await expect(page.getByRole('radiogroup', { name: '活动方式' })).toBeVisible();
    await expect(page.getByRole('grid', { name: '全部动作' })).toBeVisible();
    expect(await overflowX(page, 'tune')).toBe(false);
    expect(errors).toEqual([]);
  });
}
