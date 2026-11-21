import { expect, test, type Page } from '@playwright/test';

// 工业简报 on 总览: the regions, their jumps, the sparse / error / loading demos and four window sizes.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const band = (page: Page) => page.locator('[data-band]');
const tasks = (page: Page) => page.locator('section[aria-label="当前任务"]');
const need = (page: Page) => page.locator('section[aria-label="待处理"]');
const run = (page: Page) => page.locator('section[aria-label="进行中"]');
const brief = (page: Page) => page.locator('section[aria-label="工业简报"]');

test('default: no role band, 01 with one paper card and record rows, 02 of at most 3 rows beside it, 03 with a sentence, 2 numbers and 3 lanes; the day timeline is on 运行记录', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?still=1');
  await expect(need(page).locator('[data-stub="Paper"]')).toHaveCount(1);
  await expect(need(page).locator('[data-pending-row]')).toHaveCount(4);
  await expect(need(page)).not.toContainText('另有');
  await expect(run(page)).toBeVisible();
  await expect(page.locator('section[aria-label="她"]')).toHaveCount(0);
  const list = (await need(page).boundingBox())!;
  expect((await run(page).boundingBox())!.x).toBeGreaterThanOrEqual(list.x + list.width);
  expect(await run(page).locator('[data-run]').count()).toBeLessThanOrEqual(3);
  await expect(tasks(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '任务记录' })).toBeVisible();
  await expect(page.locator('section[aria-label="今日时间线"]')).toHaveCount(0);
  await expect(band(page)).toHaveCount(0);
  await expect(brief(page)).toContainText(/今天 \d+ 段对话/);
  for (const k of ['截图', '出错']) await expect(brief(page).getByRole('button', { name: new RegExp(`^${k}`) })).toBeVisible();
  await expect(brief(page).getByRole('button', { name: /^新增记忆/ })).toHaveCount(0);
  await expect(brief(page).getByRole('group', { name: /^今日时间轴：用户活动 \d+ 项，对话与任务 \d+ 项，主动发言 \d+ 项/ })).toBeVisible();
  await expect(brief(page).locator('[role="img"][aria-label^="提醒 │ 交报销单"]')).toHaveCount(1);
  for (const name of ['派发任务', '快速输入', '屏幕识读', '命令面板']) await expect(page.locator('[data-shell="bottom-bar"]').getByRole('toolbar', { name: '常用操作' }).getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toContainText('已连接');
  expect(errors).toEqual([]);
});

test('task records open the exact task; close and reopen works with the visible X', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?still=1&demo=absent');
  await page.getByRole('button', { name: '任务记录' }).click();
  const records = page.getByRole('dialog', { name: '任务记录' });
  const item = records.locator('[data-task]').first();
  const title = await item.locator('[class*="title"]').first().innerText();
  await item.click();
  const detail = page.getByRole('dialog', { name: `详情：${title}` });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: '关闭详情' }).click();
  await expect(detail).toHaveCount(0);
  await page.getByRole('button', { name: '任务记录' }).click();
  await records.getByRole('button', { name: '关闭', exact: true }).first().click();
  await expect(records).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the diagnostic links and command panel open their own surfaces', async ({ page }) => {
  await page.goto('main.html#/overview?still=1');
  await brief(page).getByRole('button', { name: /^截图/ }).click();
  await expect(page.locator('main[data-route-id="pipeline"]')).toBeVisible();
  await page.goto('main.html#/overview?still=1');
  await brief(page).getByRole('button', { name: /^出错/ }).click();
  await expect(page.locator('main[data-route-id="diag"]')).toBeVisible();
  await page.goto('main.html#/overview?still=1');
  await page.getByRole('button', { name: /^命令面板/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('免打扰 menu pauses observation and the page shows it with 现在恢复', async ({ page }) => {
  await page.goto('main.html#/overview?still=1');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '免打扰' }).click();
  await page.getByRole('menuitem', { name: /暂停观察 1 小时/ }).click();
  const readout = page.getByRole('status').filter({ hasText: /^观察暂停/ });
  await expect(readout).toContainText('还剩');
  await expect(readout.getByRole('button', { name: '现在恢复' })).toBeVisible();
});

test('sparse: nothing waiting, no coding sessions; 派发任务 is only in the action band', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?still=1&demo=sparse');
  await expect(need(page)).toContainText('当前没有待处理事项');
  await expect(run(page)).toContainText('当前没有编码会话');
  await expect(run(page).getByRole('button', { name: /派发/ })).toHaveCount(0);
  await expect(page.locator('main').getByRole('button', { name: /派发/ })).toHaveCount(1);
  await expect(brief(page)).toContainText('还没有编码会话');
  expect(errors).toEqual([]);
});

test('error: one bar says which reads failed and when the data is from; the regions stay at full strength', async ({ page }) => {
  await page.goto('main.html#/overview?still=1&state=error');
  await expect(page.locator('[data-stub="ErrBar"]')).toHaveCount(1);
  await expect(page.locator('[data-stub="ErrBar"]')).toContainText('读取待处理');
  // The bar carries the data time once; sections read at that time do not repeat it.
  await expect(page.locator('[data-stub="ErrBar"]')).toContainText('的数据');
  await expect(need(page)).not.toContainText('的数据');
  expect(await need(page).evaluate((el) => getComputedStyle(el.querySelector('[data-stub="Paper"]')!.parentElement!).opacity)).toBe('1');
  await expect(page.getByRole('navigation', { name: '主导航' })).toContainText('刷新失败');
  await expect(need(page).locator('[data-stub="Paper"]')).toHaveCount(1);
});

test('loading: section titles over skeletons, one 读取中 in the command bar, no numbers', async ({ page }) => {
  await page.goto('main.html#/overview?still=1&state=loading');
  await expect(need(page).locator('[aria-busy="true"]')).toBeVisible();
  await expect(brief(page)).toContainText('工业简报');
  await expect(page.locator('main [data-shell="content"]')).not.toContainText('正在读取');
  await expect(page.getByRole('navigation', { name: '主导航' })).toContainText('读取中');
});

test('960×700: a compact approval card; 02 moves under 01; the actions sit in the shell bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 700 });
  await page.goto('main.html#/overview?still=1');
  const card = need(page).locator('[data-stub="ApprovalCard"]');
  const title = (await card.locator('header').boundingBox())!;
  const approve = (await card.getByRole('button', { name: /^批准/ }).boundingBox())!;
  expect(Math.abs(approve.y + approve.height / 2 - (title.y + title.height / 2))).toBeLessThan(20);
  const left = (await need(page).boundingBox())!;
  const right = (await run(page).boundingBox())!;
  expect(right.y).toBeGreaterThan(left.y + left.height);
  const bar = page.locator('[data-shell="bottom-bar"]').getByRole('toolbar', { name: '常用操作' });
  const box = (await bar.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(700);
  await expect(bar).not.toContainText('⌘1');
});

for (const [w, h] of [[900, 600], [1280, 800], [1440, 900], [1920, 1080]] as const) {
  test(`${w}×${h}: no horizontal overflow, every region on the page`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('main.html#/overview?still=1');
    await expect(brief(page)).toBeVisible();
    const over = await page.evaluate(() => {
      const c = document.querySelector('[data-shell="content"]');
      return [document.documentElement.scrollWidth - document.documentElement.clientWidth, c ? c.scrollWidth - c.clientWidth : 0];
    });
    expect(over).toEqual([0, 0]);
    await expect(need(page)).toBeVisible();
    await expect(run(page)).toBeVisible();
    await expect(page.getByRole('button', { name: '任务记录' })).toBeVisible();
    await expect(tasks(page)).toHaveCount(0);
  });
}
