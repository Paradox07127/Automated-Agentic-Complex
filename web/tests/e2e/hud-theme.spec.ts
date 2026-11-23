import { expect, test, type Locator } from '@playwright/test';

// The HUD follows the system appearance; effect tags stay neutral until a restart is pending.

const theme = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.dataset.theme);
const color = (el: Locator) => el.evaluate((n) => getComputedStyle(n).color);
const tokenColor = (el: Locator, name: string) =>
  el.evaluate((n, v) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${v})`;
    n.parentElement!.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

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

test('effect tags are a quiet chip at rest and a yellow block only while pending', async ({ page }) => {
  for (const d of ['backend', 'character', 'pending', 'pending-backend']) {
    await page.goto(`tests/fixtures/catalog/index.html#?c=EffectTag&d=${d}&still=1`);
    const tag = page.locator('[data-stub="EffectTag"]');
    await expect(tag).toBeVisible();
    const pending = d.startsWith('pending');
    expect(await color(tag), d).toBe(await tokenColor(tag, pending ? '--ef-on-accent' : '--ef-text-2'));
    const fill = await tag.evaluate((n) => getComputedStyle(n).backgroundColor);
    const want = await tag.evaluate((n, v) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = `var(${v})`;
      n.append(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    }, pending ? '--ef-accent' : '--ef-chip');
    expect(fill, d).toBe(want);
  }
});
