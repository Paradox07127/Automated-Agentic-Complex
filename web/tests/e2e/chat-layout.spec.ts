import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('chat default: the command bar is visible, no right column, and the reading column is centered and up to 48rem wide', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1');
  const thread = page.getByRole('region', { name: '消息' });
  await expect(thread.getByText('按项目分组，不要按日期。')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: /轮次详情|任务/ })).toHaveCount(0);
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const pane = (await thread.boundingBox())!;
  const reply = (await page.locator('[data-kind="ai"]').last().boundingBox())!;
  expect(reply.width).toBeLessThanOrEqual(48 * rem);
  expect(reply.width).toBeGreaterThanOrEqual(48 * rem - 16);
  expect(Math.abs(reply.x + reply.width / 2 - pane.x - pane.width / 2)).toBeLessThanOrEqual(8);
  const font = await page.locator('[data-kind="ai"] [class*="_text_"]').last().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]);
  expect(font).toEqual(['15px', '24px']);
  expect(errors).toEqual([]);
});

test('chat default: the inline task opens the 任务 tab in the right column, 收起右栏 closes it', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&still=1');
  await page.getByRole('button', { name: /^任务 整理本周提交周报/ }).click();
  const col = page.getByRole('complementary', { name: '任务', exact: true });
  await expect(col).toBeVisible();
  await expect(col.getByRole('heading', { name: '整理本周提交周报' })).toHaveCount(1);
  await col.getByRole('button', { name: '收起右栏' }).click();
  await expect(col).toHaveCount(0);
});

test('chat empty: 还没有对话 once, offering 新建对话 as the one primary button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&state=empty&still=1');
  await expect(page.getByText('还没有对话')).toBeVisible();
  await expect(page.getByText('暂无对话')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /新建对话/ }).last()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('chat 900×600: the composer keeps a one-line field and its hint above it, so the thread keeps the height', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('main.html#/chat?plugins=all&still=1');
  const field = page.getByRole('textbox', { name: '消息' });
  const hint = page.getByText('前台执行中，新消息由只读旁路回答');
  await expect(hint).toBeVisible();
  const [f, h, msgs] = await Promise.all([field.boundingBox(), hint.boundingBox(), page.locator('[data-g="messages"]').boundingBox()]);
  expect(f!.height).toBeLessThanOrEqual(42);
  expect(h!.y + h!.height).toBeLessThanOrEqual(f!.y + 2);
  expect(msgs!.height).toBeGreaterThanOrEqual(260);
  const fit = await hint.evaluate((e) => ({ cut: e.scrollWidth > e.clientWidth + 1, ellipsis: getComputedStyle(e).textOverflow, title: e.getAttribute('title') }));
  if (fit.cut) expect(fit).toEqual({ cut: true, ellipsis: 'ellipsis', title: '前台执行中，新消息由只读旁路回答' });
});
