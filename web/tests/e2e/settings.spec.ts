import { expect, test, type Page } from '@playwright/test';

// Settings drawn after the game's settings panel: the outbound plate, the eight group icon tabs and the search in the command bar, rows and bands, no horizontal overflow.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('观察: the outbound plate is one line, the types that leave, where to and whether they are masked, and the way to 每日简报', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=privacy&still=1');
  const plate = page.getByRole('region', { name: '外发总览' });
  await expect(plate).toBeVisible();
  await expect(plate).toContainText(/^会离开这台电脑的/);
  await expect(plate).toContainText(/→ .+ │ 发出前遮蔽 (开|关|—)/);
  await expect(plate.getByRole('button', { name: /在每日简报看今天的截图/ })).toBeVisible();
  await expect(plate.locator('svg[aria-label^="外发流向"]')).toHaveCount(0);
  await expect(plate.getByRole('grid')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开' })).toHaveCount(0);
  await expect(page.locator('[data-row="pause"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a type in the outbound plate jumps to its setting row', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&group=privacy&still=1');
  await page.getByRole('region', { name: '外发总览' }).getByRole('button', { name: '截图', exact: true }).click();
  await expect(page).toHaveURL(/item=shot/);
  await expect(page.locator('#set-shot')).toBeInViewport();
});

test('the eight groups are 50 px icon tabs in the command bar; the selected one drops the 76x56 yellow plate with a dark icon; a click switches group', async ({ page }) => {
  for (const theme of ['dark', 'light'] as const) {
    await page.goto(`main.html#/settings?plugins=all&still=1&theme=${theme}`);
    const nav = page.getByRole('navigation', { name: '主导航' }).getByRole('tablist', { name: '设置分组' });
    await expect(nav.getByRole('tab')).toHaveCount(8);
    const on = nav.getByRole('tab', { selected: true });
    await expect(on).toHaveText(/说话/);
    await expect(on).toHaveAttribute('title', '说话');
    const look = await on.evaluate((el) => {
      const plate = getComputedStyle(el.querySelector('[data-g="slc"]')!);
      return { w: el.getBoundingClientRect().width, plate: [plate.backgroundColor, plate.width, plate.height], icon: getComputedStyle(el.querySelector('svg')!).color };
    });
    expect(look).toEqual({ w: 50, plate: ['rgb(255, 241, 0)', '76px', '56px'], icon: 'rgb(33, 33, 33)' });
  }
  const nav = page.getByRole('tablist', { name: '设置分组' });
  await nav.getByRole('tab', { name: /按键/ }).click();
  await expect(page.locator('#set-hk_page_overview')).toContainText('每日简报');
  await expect(page.locator('#set-hk_page_memory')).toContainText('⌘3');
});

test('error demo: the config.json groups say the read failed and stay read-only, the others render', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&state=error&group=privacy&still=1');
  // Shown once above the group; disabled switches keep it as their hidden description.
  await expect(page.getByText('读取设置失败，这一组暂不能修改').filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText('不可用：')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '外发总览' })).toBeVisible();
  await page.goto('main.html#/settings?plugins=all&state=error&group=kernel&still=1');
  await expect(page.getByRole('region', { name: '当前内核' })).toBeVisible();
  await expect(page.getByText(/读取设置失败/)).toHaveCount(0);
});

test('switches are the game 开 | 关 track, 200 wide, in both themes', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await page.goto(`main.html#/settings?plugins=all&group=privacy&still=1&theme=${theme}`);
    const sw = page.getByRole('switch', { name: '键鼠计数' });
    await expect(sw).toHaveText('开关');
    expect((await sw.boundingBox())?.width).toBe(200);
  }
});

test('rows: the row plate, name 15/500 with its ⓘ, one line under it; a child row is indented; section titles are yellow over a rule', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&still=1&theme=dark');
  const row = page.locator('[data-row="mute"]');
  const look = await row.evaluate((el) => {
    const s = getComputedStyle(el);
    const t = getComputedStyle(el.querySelector('[id$="-title"]')!.parentElement!);
    return { bg: s.backgroundColor, title: [t.fontSize, t.fontWeight], desc: el.querySelector('[id$="-desc"]')?.textContent };
  });
  expect(look).toEqual({ bg: expect.stringMatching(/^rgba\(255, 255, 255, 0\.10[56]\)$/), title: ['15px', '500'], desc: '只显示文字时照样回答，只是不念' });
  await expect(row.getByRole('button', { name: '说明' })).toBeVisible();
  await page.goto('main.html#/settings?plugins=all&group=privacy&still=1&theme=dark');
  expect(await page.locator('[data-row="grain"]').evaluate((el) => parseFloat(getComputedStyle(el).marginLeft))).toBe(24);
  const sec = page.getByRole('region', { name: '遮蔽与排除' });
  await expect(sec.locator('[data-stub="SecHead"]')).toHaveCount(0);
  expect(await sec.locator('h3').evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontSize])).toEqual(['rgb(255, 241, 0)', '15px']);
});

test('a plug-in that is off folds its rows into one line under its band', async ({ page }) => {
  await page.goto('main.html#/settings?group=privacy&still=1');
  await expect(page.getByRole('switch', { name: '屏幕感知' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(/^关着 │ 打开后可以设：窗口文字/)).toBeVisible();
  await expect(page.locator('[data-row="wintext"]')).toHaveCount(0);
});

for (const [w, h] of [
  [900, 600],
  [925, 515],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`no horizontal overflow at ${w}×${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const q of ['', '&group=perm', '&group=privacy', '&group=kernel', '&group=model', '&group=keys', '&group=data', '&group=about']) {
      await page.goto(`main.html#/settings?plugins=all&still=1${q}`);
      await expect(page.getByRole('tablist', { name: '设置分组' })).toBeVisible();
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
      const main = page.locator('[data-g="content"]').locator('xpath=..');
      expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    }
    // The search sits in the command bar's status slot at every width.
    await page.goto('main.html#/settings?plugins=all&still=1');
    const barSearch = page.getByRole('navigation', { name: '主导航' }).locator('[data-slot="status"]').getByRole('textbox', { name: '搜索设置' });
    await expect(barSearch).toHaveCount(1);
  });
}
