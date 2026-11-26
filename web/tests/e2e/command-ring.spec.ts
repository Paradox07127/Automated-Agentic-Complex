import { expect, test, type Page } from '@playwright/test';

// Her wheel on `stack.html#/cmd` (one level of 8 slots), and 快速输入, which opens in the bubble (`#/bubble`).

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, params: Record<string, string>, path = '/cmd') {
  await page.goto('about:blank');
  await page.goto(`stack.html#${path}?${new URLSearchParams({ ...params, still: '1' }).toString()}`);
}

/** 快速输入 in the bubble, opened by the fake bridge's `open input` command. */
const openInput = (page: Page, params: Record<string, string> = {}) => open(page, { ...params, mode: 'input' }, '/bubble');

test('wheel: 1 opens the chat page; Esc closes it', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { mode: 'ring' });
  await page.getByRole('menu', { name: '角色的轮盘' }).press('Escape');
  await expect(page.getByRole('menu', { name: '角色的轮盘' })).toHaveCount(0);

  await open(page, { mode: 'ring' });
  await page.getByRole('menu', { name: '角色的轮盘' }).press('1');
  await expect(page).toHaveURL(/main\.html#\/chat/);
  expect(errors).toEqual([]);
});

test('wheel: 免打扰 follows the desktop state', async ({ page }) => {
  await open(page, { mode: 'ring', demo: 'quiet' });
  await expect(page.getByRole('menuitem', { name: /^3 结束免打扰/ })).toBeVisible();
});

test('快速输入: ⏎ while composing does not send; a sent line echoes 2 s and the input folds', async ({ page }) => {
  const errors = collectErrors(page);
  await openInput(page);
  const box = page.getByRole('textbox');
  await box.click();
  await box.fill('你好');
  await box.dispatchEvent('compositionstart', { data: '' });
  await box.press('Enter');
  await expect(page.getByRole('status')).toHaveCount(0);
  // A real input method takes this ⏎; the synthetic one only adds a line break.
  await expect(box).toHaveValue(/^你好\s*$/);
  await box.dispatchEvent('compositionend', { data: '' });
  await page.waitForTimeout(100);
  await box.press('Enter');
  const echo = page.getByRole('status');
  await expect(echo).toHaveText('你：你好');
  const shown = Date.now();
  await expect(echo).toHaveCount(0, { timeout: 5000 });
  expect(Date.now() - shown).toBeGreaterThanOrEqual(1700);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('快速输入: 1–4 rows, then it stops growing, within the bubble', async ({ page }) => {
  await openInput(page);
  const box = page.getByRole('textbox');
  const h1 = (await box.boundingBox())?.height ?? 0;
  await expect(box).toHaveAttribute('rows', '1');
  await box.fill('一\n二\n三\n四');
  const h4 = (await box.boundingBox())?.height ?? 0;
  await box.fill('一\n二\n三\n四\n五\n六');
  const h6 = (await box.boundingBox())?.height ?? 0;
  await expect(box).toHaveAttribute('rows', '4');
  expect(h4 - h1).toBeGreaterThanOrEqual(40);
  expect(h6).toBe(h4);
  expect((await page.getByRole('dialog', { name: '快速输入' }).boundingBox())?.width).toBeLessThanOrEqual(364);
});
