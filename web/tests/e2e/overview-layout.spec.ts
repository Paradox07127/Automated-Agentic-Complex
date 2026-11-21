import { expect, test, type Locator, type Page } from '@playwright/test';

// Overview acceptance at the 1280×800 baseline; diag is in diag.spec.ts.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function inFirstScreen(el: Locator) {
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  expect(box, 'has a box').not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
}

test('overview-default (工业简报): the first paper card and the running rows are on the first screen', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  await inFirstScreen(page.locator('section[aria-label="待处理"] [data-stub="Paper"]'));
  const running = page.locator('section[aria-label="进行中"] [data-run]');
  expect(await running.count()).toBeGreaterThan(0);
  for (const el of await running.all()) await inFirstScreen(el);
  expect(errors).toEqual([]);
});

test('overview: 派发任务 sits in the bottom action band with 快速输入, 屏幕识读 and 命令面板; ⌘N still dispatches', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  const band = page.getByRole('toolbar', { name: '常用操作' });
  for (const name of ['派发任务', '快速输入', '屏幕识读', '命令面板']) await expect(band.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' }).locator('[data-slot="action"] button')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page).toHaveURL(/#\/overview\?.*create=role/);
  await expect(page.getByRole('dialog', { name: '新建' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('home: the 工业简报 counts line shows both numbers whole at 1385 and 900 wide', async ({ page }) => {
  for (const [width, height] of [[1385, 770], [900, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('about:blank');
    await page.goto('main.html#/home?plugins=all&still=1');
    const line = page.getByRole('button', { name: /^工业简报：/ }).locator('.num');
    await expect(line).toBeVisible();
    expect(await line.evaluate((e) => e.scrollWidth - e.clientWidth), `${width}`).toBeLessThanOrEqual(0);
  }
});

test('overview-decided: after a decision the next item takes the card; the view has at most one primary button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&demo=decided&still=1');
  await expect(page.locator('section[aria-label="待处理"]').getByRole('status')).toContainText('已批准');
  await expect(page.locator('section[aria-label="待处理"] [data-stub="Paper"]')).toHaveCount(1);
  expect(await page.locator('main [data-stub="Btn"][data-variant="primary"]').count()).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
