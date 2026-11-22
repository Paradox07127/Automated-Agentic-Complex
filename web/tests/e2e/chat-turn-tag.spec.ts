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

// The user's bubble must stand out from the dialog plate, and its text must read on it.
test('chat light: the user line bubble reads against the stream', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&still=1&theme=light');
  const line = page.locator('[data-kind="me"] [class*="_bub_"]').last();
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
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    // The bubble is a gradient: its stops are the backgrounds the text sits on.
    const stops = c.backgroundImage.match(/rgb\([^)]*\)/g) ?? [];
    const plate = getComputedStyle(el.closest('[aria-label="消息"]')!).backgroundColor;
    return { stops: stops.length, text: Math.min(...stops.map((x) => contrast(c.color, x))), plate: Math.max(...stops.map((x) => contrast(x, plate))) };
  });
  expect(s.stops).toBeGreaterThan(0);
  expect(s.text).toBeGreaterThanOrEqual(4.5);
  expect(s.plate).toBeGreaterThanOrEqual(3);
});
