import { expect, test, type Page } from '@playwright/test';

// Leaving a page keeps an inert copy of it over the new page while its out clip plays; a closing Modal plays popupOut on its copy.

interface Seen {
  sel: string;
  attr: string | null;
  hidden: string | null;
  inert: boolean;
  count: number;
  anims: number;
  t: number;
}

/** Records every node matching sel as it is added to and removed from the document. */
async function watch(page: Page, sel: string) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __seen: Seen[]; __gone: number[] };
    w.__seen = [];
    w.__gone = [];
    new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement) || !n.matches(sel)) continue;
          w.__seen.push({
            sel,
            attr: n.getAttribute('data-page-exit'),
            hidden: n.getAttribute('aria-hidden'),
            inert: n.inert,
            count: document.querySelectorAll(sel).length,
            anims: n.getAnimations({ subtree: true }).length,
            t: performance.now(),
          });
        }
        for (const n of m.removedNodes) if (n instanceof HTMLElement && n.matches(sel)) w.__gone.push(performance.now());
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, sel);
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
const gone = (page: Page) => page.evaluate(() => (window as unknown as { __gone: number[] }).__gone);
const count = (page: Page, sel: string) => page.evaluate((sel) => document.querySelectorAll(sel).length, sel);

/** Waits until only endless loops are left running under sel. */
async function settle(page: Page, sel = 'body') {
  const running = () =>
    page.evaluate(
      (sel) => (document.querySelector(sel)?.getAnimations({ subtree: true }) ?? []).filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length,
      sel,
    );
  await expect.poll(running, { timeout: 5000 }).toBe(0);
}

/** 主页's 工业简报 slot at the bottom of the watch. */
const brief = (page: Page) => page.getByRole('button', { name: /^工业简报：/ });

/** Picks a page from the command bar's page menu. */
async function menu(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: /^工业简报/ }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
}

test('leaving home leaves one inert copy that plays watchOut and is gone within 1500 ms', async ({ page }) => {
  await page.goto('main.html#/home?plugins=all');
  await expect(page.locator('main[data-route-id="home"]')).toBeVisible();
  await settle(page);
  await watch(page, '[data-page-exit]');
  await brief(page).click();
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await expect.poll(() => seen(page).then((s) => s.length)).toBe(1);
  const [copy] = await seen(page);
  expect(copy).toMatchObject({ attr: 'home', hidden: 'true', inert: true, count: 1 });
  expect(copy!.anims).toBeGreaterThan(0);
  await expect.poll(() => count(page, '[data-page-exit]'), { timeout: 1500 }).toBe(0);
  const [end] = await gone(page);
  expect(end! - copy!.t).toBeLessThan(1500);
  expect((await seen(page)).length).toBe(1);
});

test('still=1 makes no copy when the page changes', async ({ page }) => {
  await page.goto('main.html#/home?plugins=all&still=1');
  await expect(page.locator('main[data-route-id="home"]')).toBeVisible();
  await watch(page, '[data-page-exit]');
  await brief(page).click();
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await menu(page, '记忆');
  await expect(page.locator('main[data-route-id="memory"]')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await seen(page)).toEqual([]);
  expect(await count(page, '[data-page-exit]')).toBe(0);
});

test('a search-param change on the same page makes no copy', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  // Overview's countdown bars run every second, so there is no settled moment to wait for.
  await page.waitForTimeout(800);
  await watch(page, '[data-page-exit]');
  await page.evaluate(() => (window.location.hash = '#/overview?exit=1'));
  await expect(page).toHaveURL(/exit=1/);
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await seen(page)).toEqual([]);
});

test('closing a Modal leaves a copy that plays popupOut and is gone within 1000 ms', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: '命令' });
  await input.fill('停止');
  await expect(page.locator('#ef-cmd-list [role="option"]').first()).toContainText('停止任务');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog').filter({ hasText: '不能恢复执行' });
  await expect(dialog).toBeVisible();
  await settle(page, '[data-stub="Modal"]');
  await watch(page, '[data-stub="Modal"][data-closing]');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => seen(page).then((s) => s.length)).toBe(1);
  const [copy] = await seen(page);
  expect(copy).toMatchObject({ hidden: 'true', inert: true, count: 1 });
  expect(copy!.anims).toBeGreaterThan(0);
  await expect.poll(() => count(page, '[data-stub="Modal"][data-closing]'), { timeout: 1000 }).toBe(0);
  const [end] = await gone(page);
  expect(end! - copy!.t).toBeLessThan(1000);
});
