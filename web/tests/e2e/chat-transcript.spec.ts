import { expect, test } from '@playwright/test';

// Chat keeps one centered transcript and the topic column.

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

