import { expect, test, type Page } from '@playwright/test';

// 对话 (prototype pages/chat.*): list │ stream │ right column (轮次详情 / 任务).

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Elements that scroll sideways: none may, at any window size. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    const els = [...document.querySelectorAll<HTMLElement>('main *')].filter((e) => {
      const o = getComputedStyle(e).overflowX;
      return (o === 'auto' || o === 'scroll') && e.scrollWidth > e.clientWidth + 1;
    });
    return { doc, els: els.map((e) => e.className).slice(0, 5) };
  });

test('ok: list rows, on-demand history, conversation management, the track, turn tags and the composer', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1');
  const nav = page.getByRole('navigation', { name: '对话列表' });
  await expect(nav.getByRole('button', { name: /周报整理/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /周报整理/ })).toContainText(/\d+ 轮$/);
  await expect(page.getByRole('dialog', { name: '历史记录' })).toHaveCount(0);
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '历史记录' }).getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '管理对话' }).click();
  await expect(page.getByRole('menuitem', { name: /重命名/ })).toBeVisible();
  await page.keyboard.press('Escape');
  const thread = page.getByRole('region', { name: '消息' });
  const track = thread.getByRole('group', { name: /^最近 10 分钟前台与旁路/ });
  await expect(track).toBeVisible();
  const row = track.locator('xpath=..');
  const trackH = (await row.boundingBox())!.height;
  expect(trackH).toBeGreaterThanOrEqual(24);
  expect(trackH).toBeLessThanOrEqual(32);
  await expect(row).toContainText(/\d{2}:\d{2}/);
  await expect(row).not.toContainText(/\d{2}:\d{2}:\d{2}/);
  await expect(thread.getByRole('button', { name: /^第 \d+ 轮，.*打开轮次详情$/ }).first()).toBeVisible();
  await expect(thread.getByRole('button', { name: /^第 \d+ 轮，.*打开轮次详情$/ }).first()).toHaveText(/^第 \d+ 轮 │ [\d.]+ m?s/);
  await expect(nav.getByText('24 h 无轮次')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  await expect(page.getByRole('button', { name: '附加窗口' })).toBeVisible();
  await expect(page.getByRole('button', { name: '本轮不记录' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByText(/^执行中/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('turn tag opens 轮次详情; 更多 unfolds 观察, 动作 and the events; the 任务 tab switches', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1&demo=full');
  const tag = page.getByRole('button', { name: '第 12 轮，成功，打开轮次详情' });
  await tag.click();
  const col = page.getByRole('complementary', { name: '轮次详情' });
  await expect(col.getByRole('list', { name: /^瀑布：/ })).toBeVisible();
  await expect(col.getByText('选中「发言」')).toBeVisible();
  await expect(col.getByText('$0.013')).toBeVisible();
  await expect(col.getByRole('heading', { name: '观察' })).toHaveCount(0);
  await col.getByRole('button', { name: /更多/ }).click();
  await expect(col.getByRole('heading', { name: '观察' })).toBeVisible();
  await expect(col.getByRole('heading', { name: '动作' })).toBeVisible();
  await expect(col.getByRole('table')).toBeAttached();
  expect(await col.getByRole('table').locator('tbody td:first-child').evaluateAll((cells) => cells.every((cell) => getComputedStyle(cell).whiteSpace === 'nowrap'))).toBe(true);
  await col.getByRole('tab', { name: '任务' }).click();
  await expect(page.getByRole('complementary', { name: '任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起右栏' }).click();
  await expect(page.getByRole('complementary', { name: /轮次详情|任务/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const [width, height] of [[1440, 900], [900, 600]] as const) {
  test(`历史记录 at ${width}: searching a reply opens the exact turn`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('main.html#/chat?plugins=all&still=1&demo=full');
    await page.getByRole('button', { name: '历史记录', exact: true }).click();
    const history = page.getByRole('dialog', { name: '历史记录' });
    await history.getByRole('textbox').fill('改好了：Companion');
    await history.getByRole('button', { name: /改好了：Companion/ }).click();
    await expect(history).toHaveCount(0);
    await expect(page.getByRole(width < 1100 ? 'dialog' : 'complementary', { name: '轮次详情' }).getByText('第 12 轮')).toBeAttached();
  });
}

test('sparse: one conversation, four turns, both lanes idle so no track', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1&demo=sparse');
  await expect(page.getByRole('navigation', { name: '对话列表' }).getByRole('button', { name: /HostLink 早上/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /打开轮次详情$/ })).toHaveCount(4);
  await expect(page.getByRole('group', { name: /^最近 10 分钟前台与旁路/ })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByText('空闲')).toBeVisible();
  expect(errors).toEqual([]);
});

test('error: the failure shows once, in the message area, and the input box stays', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&still=1&state=error');
  const thread = page.getByRole('region', { name: '消息' });
  await expect(thread.getByText(/读取对话失败/)).toBeVisible();
  await expect(thread.getByRole('button', { name: /重试/ })).toBeVisible();
  await expect(page.locator('[data-stub="ErrBar"]')).toHaveCount(1);
  await expect(page.getByText('没读到对话列表')).toHaveCount(0);
  await expect(thread.getByRole('textbox')).toBeVisible();
});

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`${w}×${h}: no sideways scrolling, with and without the right column`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: w, height: h });
    for (const q of ['still=1', 'still=1&demo=full&turn=tr7', 'still=1&demo=sparse']) {
      await page.goto(`main.html#/chat?plugins=all&${q}`);
      await expect(page.getByRole('region', { name: '消息' })).toBeVisible();
      await page.waitForTimeout(300);
      expect(await sideways(page), q).toEqual({ doc: false, els: [] });
      if (q.includes('turn=')) {
        // Below 1100 the right column floats over the stream with a scrim; from 1100 it is the third column.
        const col = page.getByRole(w < 1100 ? 'dialog' : 'complementary', { name: '轮次详情' });
        await expect(col).toBeVisible();
        expect(await col.evaluate((el) => getComputedStyle(el).position)).toBe(w < 1100 ? 'absolute' : 'static');
      }
    }
    expect(errors).toEqual([]);
  });
}

for (const w of [1280, 1024]) {
  test(`${w}: an open question opens the stream at its card; its question line is on the first screen`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 700 });
    await page.goto('main.html#/chat?plugins=all&still=1');
    const card = page.locator('[data-pending]').first();
    await expect(card).toBeVisible();
    await page.waitForTimeout(1500);
    const gap = await card.evaluate((c) => {
      let el = c.parentElement;
      while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
      return c.getBoundingClientRect().top - (el?.getBoundingClientRect().top ?? 0);
    });
    // At the top, or as near as the stream's end lets it scroll.
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(120);
    await expect(page.getByText('周报里要不要包含外部会话的提交？')).toBeInViewport();
  });
}

test('without an open question the stream stays at the bottom after late content (turn tags, cards) settles', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&still=1&demo=sparse');
  const last = page.locator('[data-kind="ai"]').last();
  await expect(last).toBeVisible();
  await expect(page.locator('[data-pending]')).toHaveCount(0);
  await page.waitForTimeout(1500);
  const gap = await last.evaluate((t) => {
    let el: HTMLElement | null = t as HTMLElement;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(1);
});
