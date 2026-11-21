import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('chat: disconnected keeps the last messages with their time, 查看诊断 and 重试', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&demo=disconnected&still=1');
  const bar = page.getByRole('alert').filter({ hasText: '后台服务已断开' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/下面是 \d\d:\d\d 的数据/);
  await expect(bar.getByRole('button', { name: '重试' })).toBeVisible();
  await expect(page.getByRole('region', { name: '消息' }).getByText('按项目分组，不要按日期。')).toBeVisible();
  await expect(page.getByText('开始第一段对话')).toHaveCount(0);
  await bar.getByRole('button', { name: /查看诊断/ }).click();
  await expect(page).toHaveURL(/#\/diag\?/);
  expect(errors).toEqual([]);
});

// A reply's turn tag ⌁n opens 轮次详情 beside the stream; the turn row comes from /trace/turns by turn_id.
test('chat: the turn tag opens 轮次详情 for that turn', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1');
  await page.getByRole('button', { name: /^第 10 轮，成功/ }).click();
  const col = page.getByRole('complementary', { name: '轮次详情' });
  await expect(col.getByText('第 10 轮')).toBeAttached();
  await expect(col.getByText('14:14:00 │', { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

// The user's SNS self bubble must stand out from the dialog plate and the page, and its text must read on it.
test('chat light: the user line box reads against the stream', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&still=1&theme=light');
  const line = page.locator('[data-kind="me"] .sns-bubble-self').last();
  await line.scrollIntoViewIfNeeded();
  const s = await line.evaluate((el) => {
    const c = getComputedStyle(el);
    const lum = (rgb: string) => {
      const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
        const x = Number(v) / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [hi, lo] = [lum(c.color), lum(c.backgroundColor)].sort((a, b) => b - a);
    return { bg: c.backgroundColor, contrast: (hi! + 0.05) / (lo! + 0.05) };
  });
  const thread = page.getByRole('region', { name: '消息' });
  const plate = await thread.evaluate((el) => getComputedStyle(el).backgroundColor);
  const stream = await thread.evaluate((el) => getComputedStyle(el.closest('main') ?? el).backgroundColor);
  expect(s.bg).not.toBe(plate);
  expect(s.bg).not.toBe(stream);
  expect(s.contrast).toBeGreaterThanOrEqual(4.5);
});
