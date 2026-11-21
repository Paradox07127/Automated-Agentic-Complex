import { expect, test, type Page } from '@playwright/test';

// Settings: saved ChatGPT accounts, readiness reason with its fix row, hook install steps, permission rows, agentd rows offline.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('model group lists every saved ChatGPT account', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?group=model&demo=chatgpt&still=1');
  const list = page.getByRole('list', { name: 'ChatGPT 账号' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('button', { name: '使用' })).toHaveCount(1);
  await expect(list.getByRole('button', { name: '重新连接' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('kernel not ready names the reason and jumps to the row that fixes it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?group=kernel&demo=no-key&still=1');
  await expect(page.getByText('未就绪：还没有保存 Anthropic API Key')).toBeVisible();
  await page.getByRole('button', { name: '去填写 API Key' }).click();
  await expect(page).toHaveURL(/group=model.*item=apikey/);
  expect(errors).toEqual([]);
});

test('a coding tool that is not hooked up shows its install steps', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?group=model&demo=hooks-off&item=hooks2&still=1');
  await expect(page.getByRole('list', { name: 'Codex 接入步骤' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText(/install_hooks/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('permission rows include Input Monitoring with 允许, and 操作电脑 can be switched', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?group=perm&still=1');
  const row = page.locator('[data-row="inputMonitoring"]');
  await expect(row).toContainText('输入监控');
  await expect(row.getByRole('button', { name: '允许' })).toBeVisible();
  await expect(page.getByRole('switch', { name: '操作电脑' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('agentd rows are read-only while it is down', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?group=privacy&demo=agentdoff&still=1');
  await expect(page.getByRole('button', { name: '暂停 1 小时' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: '键鼠计数' })).toBeEnabled();
  expect(errors).toEqual([]);
});
