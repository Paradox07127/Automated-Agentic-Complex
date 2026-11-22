import { expect, test, type Page } from '@playwright/test';

// The command bar gives its tabs the room 回主页 and the status chip leave; 回主页 stays whole at every width.

async function open(page: Page, width: number, height: number, hash: string) {
  await page.setViewportSize({ width, height });
  // The macOS shell's traffic-light inset.
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--ef-chrome-left', '84px')));
  await page.goto(`main.html#${hash}`);
  await expect(page.locator('main[data-route-id="settings"]')).toBeVisible();
  // demo=disconnected: the chip names the backend that is down, as wide as it gets.
  await expect(page.getByRole('navigation', { name: '主导航' }).locator('[data-lamp="bad"]')).toHaveCount(1);
}

/** Tabs whole inside the plate, of all tabs in it. */
function fit(page: Page) {
  return page.getByRole('navigation', { name: '主导航' }).evaluate((nav) => {
    const plate = nav.querySelector('[data-slot="tabs"]')!.getBoundingClientRect();
    const tabs = [...nav.querySelectorAll('[data-slot="tabs"] [role="tab"]')].map((t) => t.getBoundingClientRect());
    return { shown: tabs.filter((r) => r.left >= plate.left - 0.5 && r.right <= plate.right + 0.5).length, all: tabs.length };
  });
}

function homeWhole(page: Page) {
  return page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回主页' }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const bar = el.closest('nav')!.getBoundingClientRect();
    return el.scrollWidth <= el.clientWidth && r.left >= bar.left && r.width > 0 && [...el.children].every((c) => c.getBoundingClientRect().width > 0);
  });
}

test('900 wide: at least five of the eight settings tabs show and 回主页 stays whole', async ({ page }) => {
  await open(page, 900, 600, '/settings?demo=disconnected&group=speak&still=1');
  await expect.poll(() => fit(page)).toMatchObject({ all: 8 });
  expect((await fit(page)).shown).toBeGreaterThanOrEqual(5);
  expect(await homeWhole(page)).toBe(true);
});

test('1385 wide: all eight settings tabs show with every plug-in on, and 回主页 stays whole', async ({ page }) => {
  await open(page, 1385, 770, '/settings?plugins=all&demo=disconnected&group=speak&still=1');
  await expect.poll(() => fit(page)).toMatchObject({ all: 8 });
  expect(await fit(page)).toEqual({ shown: 8, all: 8 });
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '向右滚动页签' })).toBeHidden();
  expect(await homeWhole(page)).toBe(true);
});
