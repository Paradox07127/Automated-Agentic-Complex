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

test('diag voice row ↗ lands on the voice source row in settings', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?plugins=all&still=1');
  await page.locator('[data-row="voice"]').getByRole('button', { name: '设置 › 交流' }).click();
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
  // A plain page jump names no landing, so nothing is framed.
  await expect(page.locator('main[data-route-id="diag"]')).toBeVisible();
  await expect(page).not.toHaveURL(/focus=/);
  await expect(page.locator('[data-nav-hl]')).toHaveCount(0);
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

