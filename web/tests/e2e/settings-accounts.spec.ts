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
  await page.goto('main.html#/settings?plugins=all&group=kernel&demo=chatgpt&still=1');
  const list = page.getByRole('list', { name: 'ChatGPT 账号' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('button', { name: '使用' })).toHaveCount(1);
  await expect(list.getByRole('button', { name: '重新连接' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a coding tool that is not hooked up shows its install steps', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=privacy&demo=hooks-off&item=hooks2&still=1');
  await expect(page.getByRole('list', { name: 'Codex 接入步骤' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText(/install_hooks/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

