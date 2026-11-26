import { expect, test } from '@playwright/test';

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
