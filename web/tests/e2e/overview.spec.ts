import { expect, test, type Page } from '@playwright/test';

// 每日简报 on 总览: the four tabs, the date pager, the readout band and the blocks each switch set shows, the sparse /
// error / loading demos and four window sizes.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const tasks = (page: Page) => page.locator('section[aria-label="当前任务"]');
const need = (page: Page) => page.locator('section[aria-label="待处理"]');
const run = (page: Page) => page.locator('section[aria-label="进行中"]');
const sec = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);
const band = (page: Page) => page.getByRole('list', { name: '读数' }).locator('[data-item]');
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: '简报页签' }).getByRole('tab', { name });

test("default: 今日一句, the six pinned readouts, 01 with one paper card and record rows, 02 of at most 3 rows, 做完了, 今天聊了什么, 提醒 and yesterday's observation brief", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  for (const name of ['总览', '她', '时间', '明细']) await expect(tab(page, name)).toBeVisible();
  await expect(tab(page, '总览')).toHaveAttribute('aria-selected', 'true');
  await expect(sec(page, '今日一句')).toContainText(/\d+ 段对话/);
  await expect(band(page)).toHaveCount(6);
  expect(await band(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-item')))).toEqual(['done', 'err', 'turn', 'fg', 'say', 'cost']);
  await expect(band(page).first()).toContainText('比近 7 天均值');
  await expect(need(page).locator('[data-stub="Paper"]')).toHaveCount(1);
  await expect(need(page).locator('[data-pending-row]')).toHaveCount(4);
  await expect(need(page)).not.toContainText('另有');
  await expect(run(page)).toBeVisible();
  expect(await run(page).locator('[data-run]').count()).toBeLessThanOrEqual(3);
  for (const name of ['做完了', '今天聊了什么', '提醒', '前一天的观察日报']) await expect(sec(page, name)).toBeVisible();
  await expect(sec(page, '她今天说的一句')).toHaveCount(0);
  await expect(sec(page, '工业简报')).toHaveCount(0);
  await expect(tasks(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '任务记录' })).toHaveCount(0);
  for (const name of ['快速输入', '屏幕识读', '命令面板']) await expect(page.locator('[data-shell="bottom-bar"]').getByRole('toolbar', { name: '常用操作' }).getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the four tabs switch the view and stay in the address across a reload', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  for (const [name, id] of [['她', 'her'], ['时间', 'tm'], ['明细', 'dt']] as const) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`tab=${id}`));
    await expect(band(page)).toHaveCount(0);
  }
  await page.reload();
  await expect(tab(page, '明细')).toHaveAttribute('aria-selected', 'true');
  await tab(page, '总览').click();
  await expect(band(page)).toHaveCount(6);
  expect(errors).toEqual([]);
});

test('the date pager goes back at most 6 days, never past today, and the day stays across a reload', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  const prev = page.getByRole('button', { name: '前一天' });
  const next = page.getByRole('button', { name: '后一天' });
  await expect(next).toBeDisabled();
  for (let i = 0; i < 6; i++) await prev.click();
  await expect(prev).toBeDisabled();
  await expect(page).toHaveURL(/date=2026-10-23/);
  // Another day has no approvals or running work; its readouts are that day's.
  await expect(need(page)).toHaveCount(0);
  await expect(run(page)).toHaveCount(0);
  await expect(band(page)).toHaveCount(6);
  await page.reload();
  await expect(page.locator('[data-date="2026-10-23"]')).toBeVisible();
  await next.click();
  await expect(page).toHaveURL(/date=2026-10-24/);
  await page.goto('main.html#/overview?plugins=all&still=1&date=2026-10-30');
  await expect(page.locator('[data-date="2026-10-29"]')).toContainText('今天');
  expect(errors).toEqual([]);
});

test("sw=voice: six readouts of her own, no 做完了, 进行中 or 时间 tab; her line of the day takes the brief's place", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1&sw=voice&tab=tm');
  await expect(tab(page, '总览')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, '时间')).toHaveCount(0);
  await expect(band(page)).toHaveCount(6);
  await expect(sec(page, '做完了')).toHaveCount(0);
  await expect(run(page)).toHaveCount(0);
  await expect(need(page)).toHaveCount(0);
  await expect(sec(page, '前一天的观察日报')).toHaveCount(0);
  await expect(sec(page, '她今天说的一句')).toBeVisible();
  await sec(page, '她今天说的一句').getByRole('button', { name: /看她这一天/ }).click();
  await expect(tab(page, '她')).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test("sw=scr,read: yesterday's observation brief with its counts, and 看全文 opens the briefs", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1&sw=scr,read');
  await expect(band(page)).toHaveCount(6);
  await expect(sec(page, '做完了')).toHaveCount(0);
  await expect(run(page)).toHaveCount(0);
  const obs = sec(page, '前一天的观察日报');
  await expect(obs).toContainText('看到的事');
  await obs.getByRole('button', { name: /看全文/ }).click();
  await expect(page.getByRole('dialog', { name: '观察日报' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a task in 做完了 opens on the tasks page; the brief has no task drawer of its own', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  const done = sec(page, '做完了').getByRole('button').first();
  const title = (await done.innerText()).split('\n')[0]!.trim();
  await done.click();
  await expect(page).toHaveURL(/#\/tasks\?.*sel=/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '详情' }).getByRole('heading', { level: 2 })).toContainText(title.slice(0, 4));
  expect(errors).toEqual([]);
});

test('the command panel opens from the action band', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1');
  await page.getByRole('button', { name: /^命令面板/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('免打扰 menu pauses observation and the page shows it with 现在恢复', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '免打扰' }).click();
  await page.getByRole('menuitem', { name: /暂停观察 1 小时/ }).click();
  const readout = page.getByRole('status').filter({ hasText: /^观察暂停/ });
  await expect(readout).toContainText('还剩');
  await expect(readout.getByRole('button', { name: '现在恢复' })).toBeVisible();
});

test('sparse: nothing waiting, no coding sessions; no 派发任务 on the brief', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1&demo=sparse');
  await expect(need(page)).toContainText('当前没有待处理事项');
  await expect(run(page)).toContainText('当前没有编码会话');
  await expect(run(page).getByRole('button', { name: /派发/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /派发/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('error: one bar says which reads failed and when the data is from; the regions stay at full strength', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1&state=error');
  await expect(page.locator('[data-stub="ErrBar"]')).toHaveCount(1);
  await expect(page.locator('[data-stub="ErrBar"]')).toContainText('读取待处理');
  // The bar carries the data time once; sections read at that time do not repeat it.
  await expect(page.locator('[data-stub="ErrBar"]')).toContainText('的数据');
  await expect(need(page)).not.toContainText('的数据');
  expect(await need(page).evaluate((el) => getComputedStyle(el.querySelector('[data-stub="Paper"]')!.parentElement!).opacity)).toBe('1');
  await expect(page.getByRole('navigation', { name: '主导航' })).toContainText('刷新失败');
  await expect(need(page).locator('[data-stub="Paper"]')).toHaveCount(1);
});

test('loading: a skeleton, one 读取中 in the command bar, no numbers', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1&state=loading');
  await expect(page.locator('main [aria-busy="true"]').first()).toBeVisible();
  await expect(band(page)).toHaveCount(0);
  await expect(page.locator('main [data-shell="content"]')).not.toContainText('正在读取');
  await expect(page.getByRole('navigation', { name: '主导航' })).toContainText('读取中');
});

test('960×700: a compact approval card; 02 moves under 01; the actions sit in the shell bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 700 });
  await page.goto('main.html#/overview?plugins=all&still=1');
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
    await page.goto('main.html#/overview?plugins=all&still=1');
    await expect(band(page)).toHaveCount(6);
    const over = await page.evaluate(() => {
      const c = document.querySelector('[data-shell="content"]');
      return [document.documentElement.scrollWidth - document.documentElement.clientWidth, c ? c.scrollWidth - c.clientWidth : 0];
    });
    expect(over).toEqual([0, 0]);
    await expect(need(page)).toBeVisible();
    await expect(run(page)).toBeVisible();
    await expect(tasks(page)).toHaveCount(0);
  });
}
