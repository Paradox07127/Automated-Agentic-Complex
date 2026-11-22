import { expect, test, type Page } from '@playwright/test';

// Memory page › 用户档案: profile first, 待确认 (open while it has asks), list and sheet; four window sizes.
// 活动回顾 opens first. 项目 and 用户档案 can be selected or opened directly.

const A3 = 'f31a3'.padEnd(32, '0');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Visible Chinese text under 12 px, as `size text`. */
async function smallChinese(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.querySelector('main') ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? '';
      const el = n.parentElement;
      if (!el || !/[一-鿿]/.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size} ${text.trim()}`);
    }
    return out;
  });
}

/** Sideways overflow of the document and of the page's scroll container. */
async function overflow(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const box = document.querySelector('[data-page="memory"]')?.parentElement;
    return [doc.scrollWidth - doc.clientWidth, box ? box.scrollWidth - box.clientWidth : 0];
  });
}

test('activity review opens the original evidence, searches, and switches source views', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('main.html#/memory?plugins=all&still=1');
  const activity = page.getByRole('region', { name: '活动回顾' });
  const row = activity.getByRole('button', { name: '查看 核对渲染测试结果' });
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '原始证据' })).toBeVisible();
  await dialog.getByRole('button', { name: '查看证据 1' }).click();
  await expect(dialog.locator('pre')).toHaveText('本地重跑通过');
  await dialog.getByRole('button', { name: '返回片段' }).click();
  await expect(dialog.getByRole('heading', { name: '原始证据' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  const search = activity.getByRole('textbox', { name: '搜索活动' });
  await search.fill('没有对应结果的文本');
  await search.press('Enter');
  await expect(activity.getByText('没有符合搜索的活动')).toBeVisible();
  await activity.getByRole('button', { name: '清除搜索' }).click();
  await expect(row).toBeVisible();
  await activity.getByText('原始观察', { exact: true }).click();
  await expect(activity.getByText('本地重跑通过')).toBeVisible();
  // The day and week briefs are on 每日简报, not here.
  await expect(activity.getByRole('button', { name: '日报与周报' })).toHaveCount(0);
  expect(await overflow(page)).toEqual([0, 0]);
  expect(errors).toEqual([]);
});

test('memory-about: the wiki profile leads (group cells left, key-value rows right), then two open asks and the list', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1&view=about');
  const plate = page.getByRole('region', { name: '用户档案' });
  await expect(plate.getByText('小林')).toBeVisible();
  const tabs = await page.getByRole('tablist', { name: '记忆视图' }).boundingBox();
  expect((await plate.boundingBox())!.y - (tabs!.y + tabs!.height)).toBeLessThan(68);
  expect((await plate.boundingBox())!.height).toBeLessThanOrEqual(200);
  // Every key-value row starts in one column, right of the 198.5 px group cells.
  const lefts = await plate.evaluate((p) => [...new Set([...p.querySelectorAll('[data-stub="KV"]')].map((e) => Math.round(e.getBoundingClientRect().left - p.getBoundingClientRect().left)))]);
  expect(lefts).toHaveLength(1);
  expect(lefts[0]).toBeGreaterThan(200);
  await expect(page.getByRole('region', { name: /^待确认：/ })).toHaveCount(2);
  await expect(page.getByRole('region', { name: /^待确认：/ }).first()).toBeInViewport();
  await expect(page.locator('[data-fact]')).toHaveCount(11);
  expect(await smallChinese(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('memory: ?src= filters the list; a row opens the sheet, Esc closes it and focus returns', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1&src=observed');
  await expect(page.locator('[data-fact]')).toHaveCount(1);
  await page.getByRole('button', { name: /清除筛选/ }).click();
  await expect(page.locator('[data-fact]')).toHaveCount(11);
  await page.getByRole('tab', { name: '其他事实与线索' }).click();
  const row = page.locator(`[data-fact="${A3}"] button[aria-pressed]`);
  await row.click();
  const sheet = page.getByRole('dialog', { name: '记忆详情' });
  await expect(sheet.getByText('观察 │ 排查 HostLink 断线')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(errors).toEqual([]);
});

test('memory: 确认 on an ask writes it and says so', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1&view=about');
  const card = page.getByRole('region', { name: '待确认：写代码时减少主动发言' });
  await card.getByRole('button', { name: '记住' }).click();
  await expect(page.getByText('已确认：写代码时减少主动发言')).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('memory sparse, error and empty demos', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1&demo=sparse&view=about');
  await expect(page.locator('[data-fact]')).toHaveCount(4);
  await expect(page.getByText('没有待确认的推断')).toBeVisible();
  await page.goto('about:blank');
  await page.goto('main.html#/memory?plugins=all&still=1&state=error&view=about');
  await expect(page.locator('[data-stub="ErrBar"]').getByText(/没有读到记忆：记忆库正在被另一个进程写入/)).toBeVisible();
  await expect(page.locator('[data-stub="ErrBar"]').getByRole('button', { name: '重试' })).toBeVisible();
  await expect(page.locator('[data-fact]')).toHaveCount(0);
  await page.goto('about:blank');
  await page.goto('main.html#/memory?plugins=all&still=1&state=empty&view=about');
  await expect(page.getByRole('region', { name: '用户档案' }).getByRole('button', { name: '去对话' })).toBeVisible();
  await expect(page.getByText('还没有记忆，对话后后台整理出的记忆会列在这里')).toBeVisible();
  await expect(page.getByRole('region', { name: '最近变化' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('memory: pressable profile values are plain wiki text, no cut corner; fact rows step in under the pointer, ask rows stay put', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1&view=about');
  const value = page.getByRole('button', { name: '称呼：小林，查看出处' });
  expect(await value.evaluate((e) => [getComputedStyle(e).backgroundImage, getComputedStyle(e).clipPath])).toEqual(['none', 'none']);
  const ask = page.getByRole('region', { name: '待确认：周报按项目分组，不按日期' });
  const askBox = await ask.locator('[data-stub="SRow"]').evaluate((e) => [getComputedStyle(e).backgroundImage, getComputedStyle(e).clipPath]);
  expect(askBox).toEqual(['none', 'none']);
  const before = (await ask.getByText('周报按项目分组，不按日期').boundingBox())!.x;
  await ask.getByText('周报按项目分组，不按日期').hover();
  expect((await ask.getByText('周报按项目分组，不按日期').boundingBox())!.x).toBe(before);
  await page.getByRole('tab', { name: '其他事实与线索' }).click();
  const row = page.locator(`[data-fact="${A3}"] button[aria-pressed]`);
  const title = row.locator('span').nth(1);
  const x0 = (await title.boundingBox())!.x;
  await row.hover();
  await expect.poll(async () => (await title.boundingBox())!.x).toBeGreaterThan(x0);
  expect(errors).toEqual([]);
});

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`memory ${w}×${h}: no sideways scroll in the projects, 用户档案, full and sheet views`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('main.html#/memory?plugins=all&still=1&view=projects');
    await expect(page.locator('[data-project]').first()).toBeVisible();
    expect(await overflow(page), 'projects').toEqual([0, 0]);
    expect(await smallChinese(page), 'projects').toEqual([]);
    for (const q of ['&view=about', '&demo=full&view=about', `&sel=${A3}`, '&theme=light&view=about']) {
      await page.goto('about:blank');
      await page.goto(`main.html#/memory?plugins=all&still=1${q}`);
      await expect(page.getByRole('region', { name: '用户档案' }).getByText('小林')).toBeVisible();
      expect(await overflow(page), q).toEqual([0, 0]);
      expect(await smallChinese(page), q).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}
