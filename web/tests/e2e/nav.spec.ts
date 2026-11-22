import { expect, test, type Page } from '@playwright/test';

// Cross-page jumps through shell/nav.ts: each chain checks the landing hash and that the landing element
// carries the highlight (`data-nav-hl`). `still=1` keeps the highlight and is carried across the jump.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function expectLanding(page: Page, hash: RegExp, target: string | RegExp) {
  await expect(page).toHaveURL(hash);
  const hl = page.locator('[data-nav-hl]');
  await expect(hl).toBeVisible();
  await expect(hl).toHaveAttribute('data-nav-target', target);
  await expect(page).toHaveURL(/still=1/);
}

/** A task selection opens it on the tasks page, selected in its list with its detail beside. */
async function expectDetail(page: Page, hash: RegExp) {
  await expect(page).toHaveURL(hash);
  await expect(page.locator('[role="option"][aria-selected="true"]')).toBeVisible();
  await expect(page.getByRole('region', { name: '详情' }).getByRole('heading', { level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/still=1/);
}

test('overview: a role task row under 进行中 opens that task on the tasks page and lands on its row', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  await page.getByRole('button', { name: /^角色任务「汇总 10 月开销表」/ }).click();
  await expectLanding(page, /#\/tasks\?.*sel=(job|task)%3A[\w-]+/, /^task-(job|task):/);
  await expect(page.getByRole('region', { name: '详情' }).getByRole('heading', { name: '汇总 10 月开销表' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('diag 前往设置 lands on the voice source row in settings', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?plugins=all&still=1');
  await page.getByRole('status').filter({ hasText: '语音受限' }).getByRole('button', { name: '前往设置' }).click();
  await expectLanding(page, /#\/settings\?.*group=speak.*item=tts/, 'set-tts');
  expect(errors).toEqual([]);
});

test('the HUD error line title opens the failed task', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('stack.html#/hud?demo=task-error&still=1');
  await page.getByRole('button', { name: /^展开全部/ }).click();
  await page.locator('[data-hud-row][data-status="error"] button[data-hud-title]').first().click();
  await expectDetail(page, /main\.html#\/tasks\?.*sel=(job|task)%3A[\w-]+/);
  expect(errors).toEqual([]);
});

test('⌘K jumps to a page', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('诊断');
  await page.keyboard.press('Enter');
  // A page landing has no page header to highlight any more.
  await expect(page).toHaveURL(/#\/diag\?.*focus=page/);
  await expect(page.locator('main[data-route-id="diag"]')).toBeVisible();
  await expect(page).toHaveURL(/still=1/);
  expect(errors).toEqual([]);
});

test('⌘1–⌘3 reach 每日简报, 对话 and 记忆', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&still=1');
  await expect(page.locator('main[data-route-id="settings"]')).toBeVisible();
  const pages = ['overview', 'chat', 'memory'];
  for (const [i, id] of pages.entries()) {
    await page.keyboard.press(`ControlOrMeta+${i + 1}`);
    await expect(page.locator(`main[data-route-id="${id}"]`)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/${id}\\?`));
  }
  expect(errors).toEqual([]);
});

test('900×600: the command bar does not wrap or scroll, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  // The macOS shell's traffic-light inset.
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--ef-chrome-left', '84px')));
  await page.goto('main.html#/overview?plugins=all&still=1');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav).toBeVisible();
  expect((await nav.boundingBox())?.height).toBe(50);
  expect(await nav.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  // 回主页 keeps its icon, 主页 and the esc cap whole, inside the bar.
  const homeWhole = () =>
    nav.getByRole('button', { name: '回主页' }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const bar = el.closest('nav')!.getBoundingClientRect();
      const parts = [...el.children].map((c) => c.getBoundingClientRect());
      return el.scrollWidth <= el.clientWidth && r.left >= bar.left && parts.every((p) => p.width > 0 && p.left >= r.left && p.right <= r.right);
    });
  expect(await homeWhole()).toBe(true);
  const wide = () =>
    page.evaluate(() => {
      const html = document.documentElement;
      const content = document.querySelector('[data-shell="content"]') as HTMLElement;
      return { html: html.scrollWidth - html.clientWidth, content: content.scrollWidth - content.clientWidth };
    });
  expect(await wide()).toEqual({ html: 0, content: 0 });
  await nav.getByRole('button', { name: /^每日简报/ }).click();
  await page.getByRole('menuitem', { name: /^记忆/ }).click();
  await expect(page.locator('main[data-route-id="memory"]')).toBeVisible();
  expect((await wide()).html).toBe(0);
  await page.goto('main.html#/settings?plugins=all&still=1');
  await expect(page.locator('main[data-route-id="settings"]')).toBeVisible();
  expect(await nav.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  expect(await homeWhole()).toBe(true);
});

test('1920×1080: the content area is at most 1600 wide and centred', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('main.html#/overview?plugins=all&still=1');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav).toBeVisible();
  const box = await page.locator('[data-shell="content"]').boundingBox();
  expect(box?.width).toBeLessThanOrEqual(1600);
  const main = await page.locator('main').boundingBox();
  expect(box !== null && main !== null && Math.abs(box.x - main.x - (main.x + main.width - box.x - box.width))).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-shell="content"]')!).containerName)).toBe('page');
});

test('switching pages cuts straight to the next page: no view transition', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __vt: number };
    w.__vt = 0;
    const real = document.startViewTransition?.bind(document);
    if (!real) return;
    document.startViewTransition = ((arg: Parameters<typeof real>[0]) => {
      w.__vt += 1;
      return real(arg);
    }) as typeof document.startViewTransition;
  });
  await page.goto('main.html#/chat?plugins=all');
  await expect(page.locator('main[data-route-id="chat"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+1');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+3');
  await expect(page.locator('main[data-route-id="memory"]')).toBeVisible();
  await page.evaluate(() => (window.location.hash = '#/diag?tab=timeline'));
  await expect(page.locator('main[data-route-id="diag"]')).toBeVisible();
  await expect(page).toHaveURL(/tab=timeline/);
  expect(await page.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBe(0);
  expect(errors).toEqual([]);
});

test('settings 「用量和费用 → 诊断」 lands on the diag usage card', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=model&still=1');
  await page.getByRole('button', { name: '用量和费用 → 诊断' }).click();
  await expectLanding(page, /#\/diag\?.*item=usage/, 'diag-usage');
  expect(errors).toEqual([]);
});
