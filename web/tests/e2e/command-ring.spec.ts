import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// The flat command ring on `stack.html#/cmd`, and 快速输入, which moved under the bubble (`#/bubble`).

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
      if (demo === 'ring') await open(page, { demo, theme });
      else await openInput(page, { demo, theme });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      if (demo.startsWith('ring')) await expect(page.getByRole('menu', { name: '指令环' })).toBeVisible();
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

test('ring: 8 direct items, no sub-arc; 3 opens the stack and closes the panel', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { mode: 'ring' });
  const ring = page.getByRole('menu', { name: '指令环' });
  await expect(ring).toBeVisible();
  await expect(ring.getByRole('menuitem')).toHaveCount(8);
  await expect(ring.getByRole('menuitem', { name: /待处理/ })).toContainText(/\d/);
  await expect(ring.getByRole('menuitem', { name: /^隐藏 30 分/ })).toContainText('⌃⌥H');
  await expect(ring).toContainText('1–8 直接执行 │ esc 关闭');
  for (const el of await ring.getByRole('menuitem').all()) await el.hover();
  await ring.press('ArrowRight');
  await expect(page.getByRole('menu')).toHaveCount(1);
  const box = await ring.boundingBox();
  expect(box && box.width <= 320 && box.height <= 320).toBe(true);
  await ring.press('3');
  await expect(page).toHaveURL(/stack\.html#\/cmd/);
  await expect(page.getByRole('menu', { name: '指令环' })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('ring: the center close control removes the layer with one click', async ({ page }) => {
  await open(page, { mode: 'ring' });
  await page.getByRole('button', { name: '关闭指令环' }).click();
  await expect(page.getByRole('menu', { name: '指令环' })).toHaveCount(0);
});

test('ring: toggle labels follow the desktop state', async ({ page }) => {
  await open(page, { mode: 'ring', demo: 'hidden' });
  await expect(page.getByRole('menuitem', { name: /^显示角色/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^让鼠标穿过她/ })).toBeVisible();
  await open(page, { mode: 'ring', demo: 'passthrough' });
  await expect(page.getByRole('menuitem', { name: /^结束点穿/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^隐藏 30 分/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^免打扰 30 分/ })).toBeVisible();
});

test('ring: 送礼物 answers in the panel; 打开对话 opens the chat page', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { mode: 'ring' });
  await page.getByRole('menuitem', { name: /^送礼物/ }).click();
  await expect(page.getByRole('status')).toContainText('已送出礼物');
  await expect(page).toHaveURL(/stack\.html#\/cmd/);

  await open(page, { mode: 'ring' });
  await page.getByRole('menu', { name: '指令环' }).press('4');
  await expect(page).toHaveURL(/main\.html#\/chat/);
  expect(errors).toEqual([]);
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
