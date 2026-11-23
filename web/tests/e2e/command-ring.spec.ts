import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Her wheel on `stack.html#/cmd` (one level of 8 slots), and 快速输入, which opens in the bubble (`#/bubble`).

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));
const DEMOS = ['ring', 'input', 'input-err-agentd', 'input-err-kernel'] as const;

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

for (const theme of ['dark', 'light'] as const) {
  for (const demo of DEMOS) {
    test(`${theme} ${demo}: renders without errors`, async ({ page }, info) => {
      const errors = collectErrors(page);
      if (demo === 'ring') await open(page, { mode: 'ring', theme });
      else await openInput(page, { demo, theme });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      if (demo === 'ring') await expect(page.getByRole('menu', { name: '角色的轮盘' })).toBeVisible();
      else await expect(page.getByRole('dialog', { name: '快速输入' })).toBeVisible();
      if (demo === 'input-err-agentd') await expect(page.getByRole('button', { name: '重启后台服务' })).toBeVisible();
      if (demo === 'input-err-kernel') await expect(page.getByRole('button', { name: /重新检测/ })).toBeVisible();
      if (demo.startsWith('input-err')) await expect(page.getByRole('textbox')).toHaveValue('帮我查这个报错');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await saveShot(page, { path: `${shotsDir}${info.project.name}/command-ring-${theme}-${demo}.png`, omitBackground: true });
      expect(errors).toEqual([]);
    });
  }
}

test('wheel: 8 numbered items with the pending count, dark in a light theme, the key help only while ⌘ is held', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { mode: 'ring', theme: 'light' });
  const wheel = page.getByRole('menu', { name: '角色的轮盘' });
  await expect(wheel).toBeVisible();
  const items = wheel.getByRole('menuitem');
  await expect(items).toHaveCount(8);
  const names = await items.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  expect(names.map((n) => n.replace(/^(\d \S+).*$/, '$1'))).toEqual(['1 对话页', '2 待处理', '3 免打扰', '4 点穿', '5 放回原位', '6 自由活动', '7 动作', '8 角色页']);
  expect(names[1]).toMatch(/^2 待处理 \d+$/);
  await expect(page.locator('[data-region][data-theme="dark"]')).toHaveCount(1);
  const help = wheel.getByText('直接执行');
  await expect(help).toBeHidden();
  await page.keyboard.down('Meta');
  await expect(help).toBeVisible();
  await page.keyboard.up('Meta');
  await expect(help).toBeHidden();
  expect(errors).toEqual([]);
});

test('wheel: centred where she was right-clicked, moved in so it stays whole', async ({ page }) => {
  for (const [at, want] of [['260,260', [260, 260]], ['40,500', [186, 302]]] as const) {
    await open(page, { mode: 'ring', at });
    const box = await page.getByRole('menu', { name: '角色的轮盘' }).boundingBox();
    const root = await page.locator('[data-slot="ring"]').boundingBox();
    expect(box && root && [Math.round(box.x - root.x + box.width / 2), Math.round(box.y - root.y + box.height / 2)]).toEqual(want);
  }
});

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

test('wheel: 自由活动 closes the wheel with no toast on the panel (its receipt goes to her bubble); with nothing pending 待处理 is greyed and runs nothing', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { mode: 'ring' });
  await page.getByRole('menu', { name: '角色的轮盘' }).press('6');
  await expect(page.getByRole('menu', { name: '角色的轮盘' })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page).toHaveURL(/stack\.html#\/cmd/);

  await open(page, { mode: 'ring', demo: 'empty' });
  const wheel = page.getByRole('menu', { name: '角色的轮盘' });
  await expect(wheel.getByRole('menuitem', { name: /^2 待处理/ })).toHaveAttribute('aria-disabled', 'true');
  await wheel.press('2');
  await expect(wheel).toContainText('没有待处理的事');
  await expect(page).toHaveURL(/stack\.html#\/cmd/);
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

test('快速输入: a failed send keeps the text and turns the line red', async ({ page }) => {
  const errors = collectErrors(page);
  await openInput(page, { demo: 'agentdoff' });
  const box = page.getByRole('textbox');
  await box.click();
  await box.fill('帮我看看');
  await box.press('Enter');
  await expect(page.getByRole('alert')).toContainText('原文已保留');
  await expect(box).toHaveValue('帮我看看');
  await expect(page.getByRole('dialog', { name: '快速输入' })).toHaveAttribute('data-err', 'agentd');
  await expect(page.getByRole('status')).toHaveCount(0);
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
