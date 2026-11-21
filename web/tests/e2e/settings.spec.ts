import { expect, test, type Page } from '@playwright/test';

// Settings (prototype-v3/pages/settings.*), drawn as a settings panel: outbound plate, gate plate, the group icon tabs and the search in the command bar, no horizontal overflow.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('privacy: the outbound panel shows two big figures and one fold; [展开] shows the screenshot chart, hours, flow map and detail table', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&still=1');
  const plate = page.getByRole('region', { name: '外发总览' });
  await expect(plate).toBeVisible();
  await expect(plate).toContainText(/今日截图\s*37 \/ 200\s*正常\s*允许送往云端的类型\s*\d 项/);
  // A raised panel, not a grey slab; the two figures are large tabular numbers.
  expect(await plate.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
  const figs = await plate.locator('.num').evaluateAll((els) =>
    els.filter((el) => el.parentElement?.tagName !== 'SMALL').map((el) => ({ text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize), nums: getComputedStyle(el).fontVariantNumeric })),
  );
  expect(figs.map((f) => f.text)).toEqual(['37', expect.stringMatching(/^\d$/)]);
  for (const f of figs) {
    expect(f.size).toBeGreaterThanOrEqual(28);
    expect(f.nums).toContain('tabular-nums');
  }
  await expect(plate.getByRole('button')).toHaveCount(1);
  await expect(page.locator('[data-row="pause"]')).toBeInViewport();
  await plate.getByRole('button', { name: '展开' }).click();
  await expect(plate.getByRole('img', { name: '今日截图：已用 37 张，上限 200，预留 1，已拦截 3 次' })).toBeVisible();
  await expect(plate.getByRole('img', { name: '今天每小时截图次数，本小时 17 张' })).toBeVisible();
  await expect(plate.locator('svg[aria-label^="外发流向"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停 1 小时' })).toBeVisible();
  await plate.getByText('读取范围与目的地').click();
  await expect(plate.getByRole('grid', { name: '外发' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a flow route jumps to its setting row', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&still=1');
  await page.getByRole('button', { name: '展开' }).click();
  await page.locator('svg[aria-label^="外发流向"] g[data-on]').first().click();
  await expect(page).toHaveURL(/item=shot/);
  await expect(page.locator('#set-shot')).toBeInViewport();
});

test('speak: the gate plate; sparse has one line and nothing blocked', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=speak&still=1');
  const gate = page.getByRole('region', { name: '今日发言闸门' });
  await expect(gate.getByRole('img', { name: '今日主动发言：已用 6 次，上限 12，已拦截 3 次' })).toBeVisible();
  await page.goto('main.html#/settings?plugins=all&group=speak&demo=sparse&still=1');
  await expect(page.getByRole('img', { name: '今日主动发言：已用 1 次，上限 12' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the groups are 50 px icon tabs in the command bar; the selected one drops the 76x56 yellow plate with a dark icon; a click switches group', async ({ page }) => {
  for (const theme of ['dark', 'light'] as const) {
    await page.goto(`main.html#/settings?plugins=all&still=1&theme=${theme}`);
    const on = page.getByRole('navigation', { name: '主导航' }).getByRole('tablist', { name: '设置分组' }).getByRole('tab', { selected: true });
    await expect(on).toHaveText(/隐私/);
    await expect(on).toHaveAttribute('title', '隐私');
    const look = await on.evaluate((el) => {
      const plate = getComputedStyle(el.querySelector('[data-g="slc"]')!);
      return { w: el.getBoundingClientRect().width, plate: [plate.backgroundColor, plate.width, plate.height], icon: getComputedStyle(el.querySelector('svg')!).color };
    });
    expect(look).toEqual({ w: 50, plate: ['rgb(255, 241, 0)', '76px', '56px'], icon: 'rgb(33, 33, 33)' });
  }
  const nav = page.getByRole('tablist', { name: '设置分组' });
  await nav.getByRole('tab', { name: /快捷键/ }).click();
  await expect(page.getByText('切换到「工业简报」')).toBeVisible();
  await expect(page.locator('#set-hk_page_memory')).toContainText('⌘3');
});

test('error demo: the config.json groups say the read failed and stay read-only, the others render', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&state=error&still=1');
  // Shown once above the group; disabled switches keep it as their hidden description.
  await expect(page.getByText('读取设置失败，这一组暂不能修改').filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText('不可用：')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '外发总览' })).toBeVisible();
  await page.goto('main.html#/settings?plugins=all&state=error&group=kernel&still=1');
  await expect(page.getByRole('heading', { name: '选择内核' })).toBeVisible();
  await expect(page.getByText(/读取设置失败/)).toHaveCount(0);
});

test('toggles are the small switch in both themes', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await page.goto(`main.html#/settings?plugins=all&still=1&theme=${theme}`);
    const sw = page.getByRole('switch', { name: '键鼠计数' });
    expect((await sw.boundingBox())?.width).toBeLessThanOrEqual(120);
  }
});

test('rows: the row plate with a 1px rim, name 15/500 and its description in an ⓘ beside it; the child row is indented', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&still=1&theme=dark');
  const row = page.locator('[data-row="pause"]');
  const look = await row.evaluate((el) => {
    const s = getComputedStyle(el);
    const t = getComputedStyle(el.querySelector('[id$="-title"]')!);
    return { bg: s.backgroundColor, line: s.borderBottomWidth, title: [t.fontSize, t.fontWeight], desc: el.querySelector('[id$="-desc"]') === null };
  });
  expect(look).toEqual({ bg: 'rgba(92, 92, 92, 0.4)', line: '1px', title: ['15px', '500'], desc: true });
  await expect(row.getByRole('button', { name: '说明' })).toBeVisible();
  const child = await page.locator('[data-row="grain"]').evaluate((el) => {
    const s = getComputedStyle(el);
    return { left: s.borderLeftWidth, style: s.borderLeftStyle, l: getComputedStyle(el, '::before').content, indent: parseFloat(s.marginLeft) };
  });
  expect(child).toEqual({ left: '1px', style: 'solid', l: 'none', indent: 16 });
  // Section heads are a group title: a yellow title over a rule.
  const sec = page.getByRole('region', { name: '读取范围' });
  await expect(sec.locator('[data-stub="SecHead"]')).toHaveCount(0);
  expect(await sec.getByRole('heading', { name: '读取范围' }).evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontSize])).toEqual(['rgb(255, 241, 0)', '13px']);
});

test('a row whose control is a button has no suffix arrow, no trace bar and no cut corner; a switch row neither', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&group=data');
  const button = page.locator('[data-row="delact"]');
  await button.hover({ position: { x: 80, y: 20 } });
  expect(await button.locator('[data-stub="SRow"]').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none');
  expect(await button.locator('[data-stub="SRow"]').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  expect(await button.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none');
  await page.goto('main.html#/settings?plugins=all&still=1');
  const plain = page.locator('[data-row="keys"]');
  await plain.hover({ position: { x: 80, y: 20 } });
  expect(await plain.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none');
  expect(await plain.locator('[data-stub="SRow"]').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none');
});

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`no horizontal overflow at ${w}×${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const q of ['', '&group=speak', '&group=kernel', '&group=keys']) {
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
    await expect(page.getByRole('textbox', { name: '搜索设置' })).toBeVisible();
  });
}
