import { expect, test } from '@playwright/test';

// The HUD follows the system appearance; effect tags stay neutral until a restart is pending.

const theme = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.dataset.theme);

test('the HUD follows the system appearance, also when it changes while open', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('stack.html#/hud?still=1');
  await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
  await expect.poll(() => theme(page)).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');
});

test('HUD theme= in the URL wins over the system appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('stack.html#/hud?still=1&theme=dark');
  await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
  await expect.poll(() => theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  // A hash-only change does not reload the panel, so leave the page first.
  await page.goto('about:blank');
  await page.goto('stack.html#/hud?still=1&theme=light');
  await expect.poll(() => theme(page)).toBe('light');
});

