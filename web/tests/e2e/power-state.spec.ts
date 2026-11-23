import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// 已关闭 / 未接入: the board or strip reads as a status, its button takes focus and jumps to the settings row,
// page content is inert, and the breathing rings stop under still.

const shot = (page: Page, name: string) => saveShot(page, { path: `.shots/${test.info().project.name}/power-state-${name}.png` });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const running = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

for (const theme of ['dark', 'light'] as const) {
  for (const d of ['off-page', 'unlinked-page', 'off-block', 'unlinked-block']) {
    test(`${theme}: PowerState ${d} reads as a status with a focusable jump`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto(`tests/fixtures/catalog/index.html#?c=PowerState&d=${d}&still=1&theme=${theme}`);
      const status = page.getByRole('status');
      await expect(status).toContainText(d.startsWith('off') ? '已关闭' : '未接入');
      const go = status.getByRole('button', { name: /^前往设置/ });
      await go.focus();
      await expect(go).toBeFocused();
      const inert = page.locator('[data-stub="PowerState"] [inert]');
      await expect(inert).toHaveCount(d.endsWith('page') ? 1 : 0);
      if (d.endsWith('page')) await expect(page.getByText('按项目分组，不要按日期。')).toBeVisible();
      expect(await running(page)).toBe(0);
      await shot(page, `${d}-${theme}`);
      expect(errors).toEqual([]);
    });
  }
}

test('未接入 breathes its rings and link unless still', async ({ page }) => {
  await page.goto('tests/fixtures/catalog/index.html#?c=PowerState&d=unlinked-page');
  await expect(page.getByRole('status')).toBeVisible();
  expect(await running(page)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await running(page)).toBe(0);
});

test('chat ai-off: the page is greyed and inert, the board leads to the 和她对话 switch', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?demo=ai-off&still=1');
  const board = page.getByRole('status', { name: '和她对话' });
  await expect(board).toContainText('已关闭');
  await expect(page.locator('[inert] [data-page="chat"]')).toHaveCount(1);
  await shot(page, 'chat-ai-off');
  await board.getByRole('button', { name: /前往设置打开/ }).click();
  await expect(page).toHaveURL(/#\/settings\?.*group=model.*item=plugins\.light_ai/);
  expect(errors).toEqual([]);
});

test('chat nomodel: 未接入 over the input leads to the model account row', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?demo=nomodel&still=1');
  const strip = page.getByRole('status', { name: '没有可用的模型' });
  await expect(strip).toContainText('未接入');
  await expect(page.getByRole('textbox', { name: '消息' })).toBeEditable();
  await shot(page, 'chat-nomodel');
  await strip.getByRole('button', { name: /前往设置连接/ }).click();
  await expect(page).toHaveURL(/#\/settings\?.*group=model.*item=svc/);
  expect(errors).toEqual([]);
});

for (const [id, name, url] of [
  ['overview', '每日简报', /#\/settings\?.*group=privacy.*item=plugins\.daily_brief/],
  ['tasks', '派发任务和定时任务', /#\/settings\?.*group=perm.*item=plugins\.personal_agent/],
] as const) {
  test(`${id} with its plug-in off: greyed and inert, no tabs or bottom bar, the board leads to its switch`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`main.html#/${id}?still=1`);
    const board = page.getByRole('status', { name });
    await expect(board).toContainText('已关闭');
    await expect(page.locator(`[inert] [data-page="${id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-slot="tabs"] > *')).toHaveCount(0);
    await expect(page.locator('[data-shell="bottom-bar"] > *')).toHaveCount(0);
    await shot(page, `${id}-off`);
    await board.getByRole('button', { name: /前往设置打开/ }).click();
    await expect(page).toHaveURL(url);
    expect(errors).toEqual([]);
  });
}

test('the page menu lists 每日简报 with its plug-in off, marked 已关闭, and it still opens', async ({ page }) => {
  await page.goto('main.html#/chat?still=1');
  await page.getByRole('navigation', { name: '主导航' }).locator('[data-look="bar"] button').click();
  const item = page.getByRole('menuitem', { name: '每日简报' });
  await expect(item).toHaveAttribute('aria-description', '已关闭：设置里关着「每日简报」');
  await expect(item).toContainText('已关闭');
  await item.click();
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
});
