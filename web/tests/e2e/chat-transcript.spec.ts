import { expect, test } from '@playwright/test';

// Chat keeps one centered transcript, a narrower conversation list and an on-demand history dialog.

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} 1440: SNS contact cells, the current one in a 2px frame with corner brackets, not a yellow block`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`main.html#/chat?still=1&theme=${theme}`);
    const nav = page.getByRole('navigation', { name: '对话列表' });
    // LeftArea 600 g = 300 px at this width.
    expect((await nav.locator('xpath=..').boundingBox())!.width).toBe(300);
    const cur = nav.locator('button[aria-current="true"]');
    await expect(cur).toContainText(/周报整理.*\d{2}:\d{2}\s*\d+ 轮/);
    const s = await cur.evaluate((el, dark) => {
      // The frame and brackets are the selected cell's itembig_selectedbg layer beside the button.
      const c = getComputedStyle(el.parentElement!.querySelector('[data-g="sel"]')!);
      const a = getComputedStyle(el.parentElement!.querySelector('[data-g="selLine"]')!);
      const probe = document.createElement('i');
      probe.style.color = dark ? '#ffffff' : 'var(--ef-text-1)';
      el.append(probe);
      const frame = getComputedStyle(probe).color;
      probe.remove();
      return { w: c.borderTopWidth, style: c.borderTopStyle, color: c.borderTopColor, bg: getComputedStyle(el).backgroundColor, frame, brackets: a.display !== 'none' && a.backgroundImage.includes('gradient') };
    }, theme === 'dark');
    expect(s.w).toBe('2px');
    expect(s.style).toBe('solid');
    expect(s.color).toBe(s.frame);
    expect(s.brackets).toBe(true);
    expect(s.bg).not.toBe('rgb(255, 241, 0)');
    // Group headers stay Chinese.
    for (const g of ['置顶', '今天', '更早']) await expect(nav.getByRole('group', { name: g })).toBeAttached();
  });
}

test('1440: history opens on demand and the centered composer stays at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('main.html#/chat?still=1');
  const thread = page.getByRole('region', { name: '消息' });
  const history = page.getByRole('dialog', { name: '历史记录' });
  await expect(history).toHaveCount(0);
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await expect(history.getByRole('textbox', { name: '搜索已载入的记录' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(history).toHaveCount(0);
  const pane = (await thread.boundingBox())!;
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '管理对话' })).toBeVisible();
  const input = (await thread.getByRole('textbox', { name: '消息' }).boundingBox())!;
  expect(Math.abs(input.x + input.width / 2 - pane.x - pane.width / 2)).toBeLessThanOrEqual(8);
  const send = (await thread.getByRole('button', { name: /^发送/ }).boundingBox())!;
  expect(input.y).toBeGreaterThan(pane.y + pane.height / 2);
  expect(pane.y + pane.height - (send.y + send.height)).toBeLessThanOrEqual(24);
});

test('1280: the question is an SNS vote cell, one uncut option row per line; the free answer and 取消请求 / 提交回答 stay', async ({ page }) => {
  await page.goto('main.html#/chat?still=1');
  const card = page.locator('[data-kind="question"][data-pending]').first();
  await expect(card).toBeVisible();
  const opts = card.getByRole('option');
  expect(await opts.count()).toBeGreaterThan(1);
  const boxes = await opts.evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      const c = getComputedStyle(e);
      return { y: Math.round(r.y), w: r.width, mask: c.maskImage || c.webkitMaskImage, h: r.height };
    }),
  );
  const list = (await card.getByRole('listbox').boundingBox())!;
  for (const b of boxes) {
    expect(b.mask === '' || b.mask === 'none').toBe(true);
    expect(b.w).toBeLessThanOrEqual(list.width);
    expect(b.h).toBeGreaterThanOrEqual(32);
  }
  expect(new Set(boxes.map((b) => b.y)).size).toBe(boxes.length);
  await expect(card.getByRole('textbox', { name: '写下回答' })).toBeVisible();
  await expect(card.getByRole('button', { name: '取消请求' })).toBeVisible();
  await expect(card.getByRole('button', { name: '提交回答' })).toBeVisible();
});
