import { expect, test, type Page } from '@playwright/test';

// Character wiring on the fake bridge: agentd's shapes reach the screen, reset replaces the state, no_state reads as empty.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('character: activity key in words on the stage, mood word and multipliers on 调参', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1');
  await expect(page.locator('[data-stage]')).toContainText('坐着');
  await page.goto('main.html#/tune?still=1');
  await expect(page.locator('main')).toContainText('有点低落');
  await expect(page.locator('main')).toContainText('状态倍数');
  expect(errors).toEqual([]);
});

test('调参: reset replaces the state with what agentd answers', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/tune?still=1');
  await expect(page.locator('main')).toContainText('有点低落');
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: /重置角色状态/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('状态历史');
  await dialog.getByRole('button', { name: '重置' }).click();
  await expect(page.locator('main')).toContainText('平稳');
  await expect(page.locator('main')).not.toContainText('有点低落');
  expect(errors).toEqual([]);
});

test('character disconnected: the stale time is the page clock of the last state read, where the curve stops', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/character?still=1&demo=disconnected');
  await expect(page.locator('main')).toContainText('下面是 14:32 的数据');
  expect(errors).toEqual([]);
});

test('调参 state-none: agentd 503 no_state reads as not recorded yet', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/tune?still=1&demo=state-none');
  await expect(page.getByText(/状态还没开始记录/)).toHaveCount(1);
  await expect(page.locator('main')).not.toContainText('读取角色状态失败');
  expect(errors).toEqual([]);
});
