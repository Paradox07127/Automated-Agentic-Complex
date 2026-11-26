import { expect, test, type Page } from '@playwright/test';
import { A1, T1 } from '../../src/mock/fixtures/ids';

// 今天: what the removed 任务 and 观察 pages checked, on the page that took them over (old links, details, activity, sizes).

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// The task detail has a 待处理 section of its own.
const need = (page: Page) => page.locator('section[aria-label="待处理"][data-stub="Fold"]');

test('今天 has the 待处理 card; approving it moves the card on', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=daily_brief&still=1');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  const card = need(page).locator(`[data-item="${A1}"]`);
  await expect(card).toContainText('rm -rf build/');
  await card.getByRole('button', { name: /^批准/ }).click();
  await expect(card).toHaveCount(0);
  await expect(need(page).locator('[data-item]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a task selection on 今天 opens the tasks page in its place', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/overview?sel=${encodeURIComponent(T1)}&demo=full&plugins=all&still=1`);
  await expect(page.locator('main[data-route-id="tasks"]')).toBeVisible();
  await expect(page).toHaveURL(/#\/tasks\?.*sel=job%3A/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an episode link opens that episode on 今天, with 删除片段 and 排除 its app', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?ep=1203&still=1');
  const sheet = page.getByRole('dialog', { name: '活动片段' });
  await expect(sheet).toContainText('排查 HostLink 断线');
  await expect(sheet.getByRole('button', { name: '删除片段' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /排除 Terminal/ })).toBeVisible();
  // The day timeline is on 每日简报 › 时间.
  await expect(page.locator('section[aria-label="今日时间线"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('每日简报 › 时间 has the day timeline under the hour chart, with no foreground and site count buttons', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?tab=tm&still=1');
  const line = page.locator('section[aria-label="今日时间线"]');
  await expect(line).toBeVisible();
  const chart = (await page.locator('section[aria-label="在电脑前"]').boundingBox())!;
  expect((await line.boundingBox())!.y).toBeGreaterThanOrEqual(chart.y + chart.height);
  await expect(page.getByRole('button', { name: /^前台 / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /在运行记录的今日时间线看/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

