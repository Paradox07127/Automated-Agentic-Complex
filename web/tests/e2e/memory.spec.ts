import { expect, test, type Page } from '@playwright/test';

// Memory page › 档案: nameplate and category cells left, 待确认's vote cards (open while it has asks) or the list in the middle,
// the detail column right (a drawer below 1200 px); 项目 and 回顾 share the layout. Four window sizes.

const A3 = 'f31a3'.padEnd(32, '0');
const P5 = 'f31p5'.padEnd(32, '0');

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

test('回顾 opens the original evidence in the drawer, searches, and switches record kinds', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('main.html#/memory?plugins=all&still=1&view=activity');
  const review = page.getByRole('region', { name: '回顾' });
  const row = review.getByRole('button', { name: '查看 核对渲染测试结果' });
  await row.click();
  const drawer = page.getByRole('dialog', { name: '这段记录' });
  await expect(drawer.getByRole('heading', { name: '原始证据' })).toBeVisible();
  await drawer.getByRole('button', { name: /^查看证据 1/ }).click();
  await expect(drawer.locator('pre')).toHaveText('本地重跑通过');
  await drawer.getByRole('button', { name: '返回片段' }).click();
  await expect(drawer.getByRole('heading', { name: '原始证据' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(row).toBeFocused();
  const search = review.getByRole('textbox', { name: '搜索活动' });
  await search.fill('没有对应结果的文本');
  await search.press('Enter');
  await expect(review.getByText('没有符合搜索的活动')).toBeVisible();
  await review.getByRole('button', { name: '清除搜索' }).click();
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: /^原始观察/ }).click();
  await expect(review.getByText('本地重跑通过')).toBeVisible();
  // The day and week briefs are on 每日简报, not here.
  await expect(review.getByRole('button', { name: '日报与周报' })).toHaveCount(0);
  expect(await overflow(page)).toEqual([0, 0]);
  expect(errors).toEqual([]);
});

test('档案 opens on 待确认: the nameplate and cells left, three vote cards in view', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1');
  const plate = page.getByRole('button', { name: '用户档案：小林' });
  await expect(plate).toBeVisible();
  const tabs = await page.getByRole('tablist', { name: '记忆视图' }).boundingBox();
  expect((await plate.boundingBox())!.y - (tabs!.y + tabs!.height)).toBeLessThan(68);
  await expect(page.getByRole('button', { name: /^待确认/ })).toHaveAttribute('aria-pressed', 'true');
  const cards = page.getByRole('region', { name: /^待确认：/ });
  await expect(cards).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) await expect(cards.nth(i)).toBeInViewport();
  await expect(page.locator('[data-fact]')).toHaveCount(0);
  expect(await smallChinese(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('档案: ?src= lands as a search; a row fills the detail column at 1440, and opens a drawer at 900 that Esc closes', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('main.html#/memory?plugins=all&still=1&src=observed');
  await page.getByRole('button', { name: /^全部/ }).click();
  await expect(page.locator('[data-fact]')).toHaveCount(3);
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.locator('[data-fact]')).toHaveCount(18);
  const row = page.locator(`[data-fact="${A3}"] button`);
  await row.click();
  const detail = page.getByRole('complementary', { name: '这条记忆' });
  await expect(detail.getByText(/她看到：/)).toBeVisible();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(detail).toHaveCount(0);
  await row.click();
  const drawer = page.getByRole('dialog', { name: '这条记忆' });
  await expect(drawer.getByText(/她看到：/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(errors).toEqual([]);
});

test('待确认: 对，记住 writes it and says so; 不是这样 waits out its undo window before the card goes', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1');
  const keep = page.getByRole('region', { name: '待确认：写代码时减少主动发言' });
  await keep.getByRole('button', { name: '对，记住' }).click();
  await expect(page.getByText('已记住：写代码时减少主动发言')).toBeVisible();
  await expect(keep).toHaveCount(0);
  const no = page.getByRole('region', { name: '待确认：周报按项目分组，不按日期' });
  await no.getByRole('button', { name: '不是这样' }).click();
  await expect(page.getByText('划掉了，她不会再记这件事')).toBeVisible();
  await expect(no.getByText(/\[已选\]/)).toBeVisible();
  await expect(no).toHaveCount(0, { timeout: 8000 });
  await expect(page.getByText('已划掉：周报按项目分组，不按日期')).toBeVisible();
  expect(errors).toEqual([]);
});

test('档案: 删除 asks on a paper card, then deletes and says so', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/memory?plugins=all&still=1&sel=${P5}`);
  await page.getByRole('complementary', { name: '这条记忆' }).getByRole('button', { name: '删除' }).click();
  const ask = page.getByRole('alertdialog', { name: '删除这条记忆？' });
  await expect(ask.getByText('咖啡不加糖')).toBeVisible();
  await ask.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('已删除：咖啡不加糖')).toBeVisible();
  await expect(page.locator(`[data-fact="${P5}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('memory sparse, error and empty demos', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1&demo=sparse');
  await expect(page.getByRole('button', { name: /^全部/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^待确认/ })).toHaveCount(0);
  await expect(page.locator('[data-fact]').first()).toBeVisible();
  await page.goto('about:blank');
  await page.goto('main.html#/memory?plugins=all&still=1&state=error');
  await expect(page.locator('[data-stub="ErrBar"]').getByText(/没有读到记忆：记忆库正在被另一个进程写入/)).toBeVisible();
  await expect(page.locator('[data-stub="ErrBar"]').getByRole('button', { name: '重试' })).toBeVisible();
  await expect(page.locator('[data-fact]')).toHaveCount(0);
  await page.goto('about:blank');
  await page.goto('main.html#/memory?plugins=all&still=1&state=empty');
  await expect(page.getByText('她还没记住你的事')).toBeVisible();
  await expect(page.getByRole('button', { name: /去对话/ })).toBeVisible();
  await expect(page.getByRole('region', { name: '最近变化' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`memory ${w}×${h}: no sideways scroll in 项目, 回顾, 待确认, the list and the detail`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('main.html#/memory?plugins=all&still=1&view=projects');
    await expect(page.locator('[data-project]').first()).toBeVisible();
    expect(await overflow(page), 'projects').toEqual([0, 0]);
    expect(await smallChinese(page), 'projects').toEqual([]);
    for (const q of ['&view=activity', '', `&sel=${A3}`, '&theme=light']) {
      await page.goto('about:blank');
      await page.goto(`main.html#/memory?plugins=all&still=1${q}`);
      if (q === '&view=activity') await expect(page.getByRole('region', { name: '回顾' }).locator('[data-activity]').first()).toBeVisible();
      else await expect(page.getByRole('button', { name: '用户档案：小林' })).toBeVisible();
      expect(await overflow(page), q).toEqual([0, 0]);
      expect(await smallChinese(page), q).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}
