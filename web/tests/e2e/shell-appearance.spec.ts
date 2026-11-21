import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Main and the desktop panels follow the system appearance; the shell header and sidebar carry no decoration.

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

for (const [entry, ready] of [
  ['main.html#/overview?still=1', 'main[data-route-id="overview"]'],
  ['stack.html#/hud?still=1', '[data-surface-root="hud"]'],
] as const) {
  test(`${entry.split('#')[0]} data-theme follows the system appearance while open`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(entry);
    await expect(page.locator(ready)).toBeAttached();
    await expect.poll(() => theme(page)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(page)).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
  });
}

test('main theme= in the URL wins over the system appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('main.html#/overview?still=1&theme=light');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await expect.poll(() => theme(page)).toBe('light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('main.html#/overview?still=1&theme=dark');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await expect.poll(() => theme(page)).toBe('dark');
});

test('no page header: the 50 high command bar names the current page in its page menu, and 主页 has no command bar', async ({ page }) => {
  await page.goto('main.html#/overview?still=1');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav).toBeVisible();
  expect((await nav.boundingBox())?.height).toBe(50);
  await expect(page.locator('main header[data-nav-target="page"]')).toHaveCount(0);
  await expect(nav.getByRole('link')).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '工业简报', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: '工业简报', exact: true }).click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: /^记忆/ })).toBeVisible();
  await page.goto('main.html#/home?still=1');
  await expect(page.locator('main[data-route-id="home"]')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
  await expect(page.locator('[data-bare]')).toHaveCount(1);
});

test("command bar draws the page's tabs: a centred plate of 50 wide icon cells, a 76 wide block hanging 6 below, Q/E either side", async ({ page }) => {
  await page.goto('main.html#/character?still=1');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const bar = (await nav.boundingBox())!;
  const tab = nav.getByRole('tab', { name: '动作' });
  await expect(tab).toHaveAttribute('title', '动作');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const plate = (await nav.locator('[data-slot="tabs"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, width: r.width, bg: getComputedStyle(el).backgroundImage };
  }))!;
  expect(Math.abs(plate.x + plate.width / 2 - 640)).toBeLessThanOrEqual(0.5);
  expect(plate.bg).toMatch(/^repeating-linear-gradient\(/);
  const cell = (await tab.boundingBox())!;
  expect(cell.width).toBe(50);
  const block = (await tab.locator('[data-g="slc"]').boundingBox())!;
  expect(block.width).toBe(76);
  expect(block.x).toBe(cell.x - 13);
  expect(block.y + block.height).toBe(bar.y + bar.height + 6);
  // Key hints are hidden until ⌘ or Ctrl is held; they keep their place.
  const caps = await nav.locator('[data-g="tabs"] > span kbd').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return r.x + r.width / 2; }));
  expect(caps).toHaveLength(2);
  expect(Math.abs(caps[0]! + caps[1]! - 1280)).toBeLessThanOrEqual(1);
  expect(caps[0]!).toBeLessThan(plate.x);
  expect(caps[1]!).toBeGreaterThan(plate.x + plate.width);
  await expect(nav).not.toContainText('// CHARACTER');
});

test('dark shell screenshots for review', async ({ page }, info) => {
  const dir = fileURLToPath(new URL(`../../.shots/${info.project.name}/`, import.meta.url));
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const [name, hash] of [
    ['b0-overview-dark', '#/overview?still=1'],
    ['b0-chat-dark', '#/chat?still=1'],
    ['b0-palette-dark', '#/overview?still=1&demo=palette'],
  ] as const) {
    await page.goto('about:blank');
    await page.goto(`main.html${hash}`);
    await expect(page.locator('main[data-route-id]')).toBeVisible();
    await expect.poll(() => theme(page)).toBe('dark');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await saveShot(page, { path: `${dir}${name}.png` });
  }
});

test("Q and E step through the page's own tabs and wrap, do nothing while typing, and Esc goes home", async ({ page }) => {
  await page.goto('main.html#/settings?still=1');
  const tabs = page.getByRole('tablist', { name: '设置分组' });
  const selected = () => tabs.getByRole('tab', { selected: true });
  await expect(selected()).toHaveAttribute('title', '隐私');
  await page.keyboard.press('e');
  await expect(selected()).toHaveAttribute('title', '权限与授权');
  await page.keyboard.press('q');
  await page.keyboard.press('q');
  await expect(selected()).toHaveAttribute('title', 'pi 账号与凭据');
  for (let i = 0; i < 3; i++) await page.keyboard.press('q');
  await expect(selected()).toHaveAttribute('title', '说话与通知');
  await page.keyboard.press('q');
  await expect(selected()).toHaveAttribute('title', '高级');
  await page.keyboard.press('e');
  await expect(selected()).toHaveAttribute('title', '说话与通知');
  await expect(page.locator('main[data-route-id="settings"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('main[data-route-id="home"]')).toBeVisible();
  await page.goto('main.html#/chat?still=1');
  const input = page.getByRole('textbox', { name: '消息' });
  await input.click();
  await page.keyboard.type('qe');
  await page.keyboard.press('Escape');
  await expect(page.locator('main[data-route-id="chat"]')).toBeVisible();
  await expect(input).toHaveValue('qe');
});

test('tabs that do not fit show an arrow at that end, the arrow scrolls them into view, and a picked tab scrolls in', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('main.html#/settings?group=speak&still=1');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const prev = nav.getByRole('button', { name: '向左滚动页签' });
  const next = nav.getByRole('button', { name: '向右滚动页签' });
  const shown = (title: string) =>
    nav.locator(`[data-slot="tabs"] [role="tab"][title="${title}"]`).evaluate((el) => {
      const p = el.closest('[data-slot="tabs"]')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.left >= p.left && r.right <= p.right;
    });
  await expect(next).toBeVisible();
  await expect(prev).toBeHidden();
  expect(await shown('高级')).toBe(false);
  // Named cells run over two plate widths here: each arrow press pages one width.
  await next.click();
  await expect(prev).toBeVisible();
  await next.click();
  await expect.poll(() => shown('高级')).toBe(true);
  await expect(next).toBeHidden();
  await expect(prev).toBeVisible();
  await prev.click();
  await expect(next).toBeVisible();
  await prev.click();
  await expect.poll(() => shown('说话与通知')).toBe(true);
  await expect(prev).toBeHidden();
  // Q from the first group wraps to the last, which scrolls into view; its name is written in the cell.
  await page.keyboard.press('q');
  await expect(nav.getByRole('tab', { selected: true })).toHaveAttribute('title', '高级');
  await expect.poll(() => shown('高级')).toBe(true);
  await expect(nav.getByRole('tab', { selected: true })).toContainText('高级');
  await page.setViewportSize({ width: 1385, height: 770 });
  await expect(next).toBeHidden();
  await expect(prev).toBeHidden();
});

test('the page menu names the open page and its tab, and only the selected page tab has the accent background in the command bar', async ({ page }) => {
  const accentCount = (nav: ReturnType<Page['getByRole']>) =>
    nav.evaluate((root) => {
      const accent = 'rgb(255, 241, 0)';
      return [root, ...root.querySelectorAll('*')].filter((el) => getComputedStyle(el).backgroundColor === accent).length;
    });
  await page.goto('main.html#/character?still=1');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('button', { name: '角色 / 动作' })).toBeVisible();
  expect(await accentCount(nav)).toBe(1);
  expect(await nav.getByRole('tab', { selected: true }).locator('[data-g="slc"]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 241, 0)');

  await page.goto('main.html#/diag?still=1');
  await expect(nav.getByRole('button', { name: /^诊断/ })).toBeVisible();
  expect(await accentCount(nav)).toBeLessThanOrEqual(1);
});
