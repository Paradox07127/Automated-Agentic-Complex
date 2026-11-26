import { expect, test, type Page } from '@playwright/test';

// 每日简报 on 总览: the four tabs, the date pager, the readout band and the blocks each switch set shows, the sparse /
// error / loading demos and four window sizes.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const need = (page: Page) => page.locator('section[aria-label="待处理"]');
const run = (page: Page) => page.locator('section[aria-label="进行中"]');
const band = (page: Page) => page.getByRole('list', { name: '读数' }).locator('[data-item]');
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: '简报页签' }).getByRole('tab', { name });

test('the four tabs switch the view and stay in the address across a reload', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  for (const [name, id] of [['角色', 'char'], ['时间', 'tm'], ['明细', 'dt']] as const) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`tab=${id}`));
    await expect(band(page)).toHaveCount(0);
  }
  await page.reload();
  await expect(tab(page, '明细')).toHaveAttribute('aria-selected', 'true');
  await tab(page, '总览').click();
  await expect(band(page)).toHaveCount(6);
  expect(errors).toEqual([]);
});

test('the command panel opens from the action band', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1');
  await page.getByRole('button', { name: /^命令面板/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('sparse: nothing waiting, no coding sessions; no 派发任务 on the brief', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1&demo=sparse');
  await expect(need(page)).toContainText('当前没有待处理事项');
  await expect(run(page)).toContainText('当前没有编码会话');
  await expect(run(page).getByRole('button', { name: /派发/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /派发/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('loading: a skeleton, one 读取中 in the command bar, no numbers', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1&state=loading');
  await expect(page.locator('main [aria-busy="true"]').first()).toBeVisible();
  await expect(band(page)).toHaveCount(0);
  await expect(page.locator('main [data-shell="content"]')).not.toContainText('正在读取');
  await expect(page.getByRole('navigation', { name: '主导航' })).toContainText('读取中');
});

