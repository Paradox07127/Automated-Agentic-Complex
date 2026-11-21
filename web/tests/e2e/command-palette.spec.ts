import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function palette(page: Page, query: string) {
  await page.goto('main.html#/overview?still=1');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: '命令' });
  await expect(input).toHaveAttribute('placeholder', '搜索任务、记忆、交付，或输入动作…');
  await input.fill(query);
  const options = page.locator('#ef-cmd-list [role="option"]');
  await expect(options.first()).toBeVisible();
  await expect(page.locator('#ef-cmd-list')).not.toContainText('没有匹配的结果');
  return options;
}

test('⌘K 「停止」 opens the shared stop confirm for a running task', async ({ page }) => {
  const errors = collectErrors(page);
  const options = await palette(page, '停止');
  await expect(options.first()).toContainText('停止任务');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog').filter({ hasText: '不能恢复执行' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/停止「.+」？/);
  await expect(dialog.getByRole('button', { name: '不停止' })).toBeFocused();
  await dialog.getByRole('button', { name: '停止任务' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/^已停止「.+」/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('⌘K 「周报」 finds tasks, memory and deliveries and lands on sel=', async ({ page }) => {
  const errors = collectErrors(page);
  const options = await palette(page, '周报');
  const list = page.locator('#ef-cmd-list');
  await expect(list).toContainText('搜索');
  await expect(options.filter({ hasText: '交付' }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/overview\?.*sel=(job|task)%3A[\w-]+/);
  await expect(page.getByRole('dialog', { name: /^详情：/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('⌘K 「屏幕识读」 runs the desktop look and says so', async ({ page }) => {
  const errors = collectErrors(page);
  const options = await palette(page, '屏幕识读');
  const look = options.filter({ hasText: '屏幕识读' }).first();
  await expect(look).not.toHaveAttribute('aria-disabled', 'true');
  await expect(look).toContainText('识读前台窗口');
  await expect(options.first()).toContainText('屏幕识读');
  await page.keyboard.press('Enter');
  await expect(page.locator('#ef-cmd-list')).toHaveCount(0);
  await expect(page.getByText('正在识读前台窗口')).toBeVisible();
  expect(errors).toEqual([]);
});

test('⌘K 「内核」 re-checks the kernel and lands on the settings kernel row', async ({ page }) => {
  const errors = collectErrors(page);
  const options = await palette(page, '内核');
  await expect(options.first()).toContainText('重新检测内核');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/settings\?.*group=kernel.*item=kcur/);
  await expect(page.locator('[data-nav-hl]')).toHaveAttribute('data-nav-target', 'set-kcur');
  await expect(page.getByText(/^已重新检测：/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('⌘1–3 switch pages and ⌘, opens settings in the web layer', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?still=1');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  const pages = ['overview', 'chat', 'memory'];
  for (const [i, id] of [...pages.entries()].reverse()) {
    await page.keyboard.press(`ControlOrMeta+${i + 1}`);
    await expect(page.locator(`main[data-route-id="${id}"]`)).toBeVisible();
  }
  await page.keyboard.press('ControlOrMeta+,');
  await expect(page.locator('main[data-route-id="settings"]')).toBeVisible();
  await expect(page).toHaveURL(/still=1/);
  expect(errors).toEqual([]);
});
