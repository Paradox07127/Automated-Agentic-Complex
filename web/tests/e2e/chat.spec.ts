import { expect, test, type Page } from '@playwright/test';

// 对话 v2: character tabs in the header, her topics │ stream │ task column.

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

test('ok: character tabs, her topics with their last line, management by right click, and the composer', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1');
  const tabs = page.getByRole('tablist', { name: '角色' });
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  await expect(tabs.getByRole('tab', { name: '示例乙，在桌面' })).toHaveAttribute('aria-selected', 'true');
  const nav = page.getByRole('navigation', { name: '话题' });
  await expect(nav.getByRole('button', { name: /周报整理/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /HostLink 断线排查/ })).toContainText(/日志里 11:38/);
  await expect(page.getByRole('button', { name: '历史记录' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理对话' })).toHaveCount(0);
  await nav.getByRole('button', { name: /HostLink 断线排查/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /重命名/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  const thread = page.getByRole('region', { name: '消息' });
  await expect(thread.getByRole('group', { name: /^最近 10 分钟前台与旁路/ })).toHaveCount(0);
  await expect(thread.getByRole('button', { name: /打开轮次详情$/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  await expect(page.getByRole('button', { name: '附加' })).toBeVisible();
  await expect(page.getByText(/^执行中/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('Q and E step through the character tabs and the thread follows her topic', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1');
  const thread = page.getByRole('region', { name: '消息' });
  await expect(thread.getByText('按项目分组，不要按日期。')).toBeVisible();
  await page.locator('body').press('e');
  await expect(page.getByRole('tab', { name: '示例甲' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('navigation', { name: '话题' }).getByText('协议核心的交接')).toBeVisible();
  await expect(thread.getByText('不急。看完告诉我一声就行。')).toBeVisible();
  await page.locator('body').press('q');
  await expect(page.getByRole('tab', { name: /^示例乙/ })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('the topic column starts folded at 925 px and unfolds on demand', async ({ page }) => {
  await page.setViewportSize({ width: 925, height: 515 });
  await page.goto('main.html#/chat?plugins=all&still=1');
  const nav = page.getByRole('navigation', { name: '话题' });
  await expect(nav.getByRole('button', { name: '展开左栏' })).toBeVisible();
  expect((await nav.locator('xpath=..').boundingBox())!.width).toBe(56);
  await nav.getByRole('button', { name: '展开左栏' }).click();
  await expect(nav.getByRole('textbox', { name: '搜索话题' })).toBeVisible();
  expect((await nav.locator('xpath=..').boundingBox())!.width).toBeGreaterThan(200);
});

test('the swap card covers the whole window and keeps its buttons in view with a long line', async ({ page }) => {
  await page.setViewportSize({ width: 925, height: 515 });
  await page.goto('main.html#/chat?plugins=all&still=1');
  await page.getByRole('tab', { name: '示例甲' }).click();
  const thread = page.getByRole('region', { name: '消息' });
  await expect(thread.getByText('不急。看完告诉我一声就行。')).toBeVisible();
  await page.getByRole('textbox', { name: '消息' }).fill(Array.from({ length: 30 }, (_, i) => `第${i}段 ${'很长的话'.repeat(8)}${'x'.repeat(80)}`).join('\n'));
  await page.getByRole('button', { name: '发送' }).click();
  const card = page.getByRole('dialog', { name: /出来回你/ });
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(515);
  await expect(card.getByRole('button', { name: '先不换' })).toBeInViewport();
  await expect(card.getByRole('button', { name: '换出来并发送' })).toBeInViewport();
  // The command bar at the top is under the scrim, not beside the card.
  const covered = await page.evaluate(() => document.getElementById('ef-modal-root')?.contains(document.elementFromPoint(300, 20)) ?? false);
  expect(covered).toBe(true);
  expect((await sideways(page)).doc).toBe(false);
});

test('sparse: one conversation, four replies, idle', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1&demo=sparse');
  await expect(page.getByRole('navigation', { name: '话题' }).getByRole('button', { name: /HostLink 早上/ })).toBeVisible();
  await expect(page.locator('[data-kind="ai"]')).toHaveCount(4);
  await expect(page.getByText('空闲')).toBeVisible();
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
    for (const q of ['still=1', 'still=1&demo=reject', 'still=1&demo=sparse']) {
      await page.goto(`main.html#/chat?plugins=all&${q}`);
      await expect(page.getByRole('region', { name: '消息' })).toBeVisible();
      await page.waitForTimeout(300);
      expect(await sideways(page), q).toEqual({ doc: false, els: [] });
      if (q.includes('demo=reject')) {
        // Below 1100 the task column is a Sheet drawer over the page (its scrim is absolute); from 1100 it is the third column.
        const col = page.getByRole(w < 1100 ? 'dialog' : 'complementary', { name: '任务', exact: true });
        await expect(col).toBeVisible();
        expect(await col.evaluate((el) => getComputedStyle(el.getAttribute('role') === 'dialog' ? el.parentElement! : el).position)).toBe(w < 1100 ? 'absolute' : 'static');
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
