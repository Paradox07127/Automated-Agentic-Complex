import { expect, test } from '@playwright/test';

// Chat keeps one centered transcript and the topic column.

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} 1440: the topic column is 300 px, the current topic a yellow block`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`main.html#/chat?plugins=all&still=1&theme=${theme}`);
    const nav = page.getByRole('navigation', { name: '话题' });
    // LeftArea 600 g = 300 px at this width.
    expect((await nav.locator('xpath=..').boundingBox())!.width).toBe(300);
    const cur = nav.locator('button[aria-current="true"]');
    await expect(cur).toContainText(/^周报整理/);
    expect(await cur.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
    await expect(nav.getByRole('button', { name: /已归档 3/ })).toBeVisible();
  });
}

test('1440: the centered composer stays at the bottom, with no history button', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('main.html#/chat?plugins=all&still=1');
  const thread = page.getByRole('region', { name: '消息' });
  await expect(page.getByRole('button', { name: '历史记录' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '历史记录' })).toHaveCount(0);
  const pane = (await thread.boundingBox())!;
  const input = (await thread.locator('[data-g="composer"] > *').first().boundingBox())!;
  expect(Math.abs(input.x + input.width / 2 - pane.x - pane.width / 2)).toBeLessThanOrEqual(8);
  const send = (await thread.getByRole('button', { name: /^发送/ }).boundingBox())!;
  expect(input.y).toBeGreaterThan(pane.y + pane.height / 2);
  expect(pane.y + pane.height - (send.y + send.height)).toBeLessThanOrEqual(24);
});

test('1280: the question is an SNS vote cell, one uncut option row per line; the free answer and 取消请求 / 提交回答 stay', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&still=1');
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
