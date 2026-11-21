import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// 设置: outbound matrix, launch keys via the config file, bottom apply bar, search still lands on the row.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// The flow map is back; the matrix is its 外发明细, folded by default.
const shots = (name: string) => `.shots/${test.info().project.name}/settings-outbound-${name}.png`;

for (const theme of ['dark', 'light'] as const) {
  test(`settings-default shows the flow map, with the outbound matrix as its detail (${theme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`main.html#/settings?plugins=all&still=1&theme=${theme}`);
    await page.getByRole('button', { name: '展开' }).click();
    await expect(page.locator('svg[aria-label^="外发流向"]')).toBeVisible();
    await page.getByText('读取范围与目的地').click();
    const grid = page.getByRole('grid', { name: '外发' });
    await expect(grid).toBeVisible();
    // The settings default screen_context_level is focused.
    await expect(grid.getByRole('row', { name: /窗口文字/ }).locator('td').first()).toHaveText('窗口文字 │ 仅焦点元素');
    await expect(page.getByText(/需新增|未核实|policy_epoch/)).toHaveCount(0);
    await saveShot(grid, { path: shots(`outbound-matrix-${theme}`) });
    expect(errors).toEqual([]);
  });
}

test('settings-adv sends the launch keys to the config file, no raw keys on screen', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=adv&still=1');
  // The row's description sits in its ⓘ tip.
  await expect(page.getByText('只能在配置文件里改')).toBeAttached();
  await expect(page.getByRole('button', { name: '打开配置文件' })).toBeEnabled();
  await expect(page.getByText(/tts_url/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('settings search still lands on the row', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=about&still=1');
  await page.getByRole('textbox', { name: '搜索设置' }).fill('截图');
  await page.getByRole('button', { name: /屏幕识读时附上截图/ }).click();
  await expect(page).toHaveURL(/#\/settings\?.*group=privacy.*item=shot/);
  await expect(page.locator('#set-shot')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('kernel drafts show one bottom bar with the only primary button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=kernel&demo=draft&still=1');
  const bar = page.getByRole('region', { name: '未应用的改动' });
  await expect(bar).toBeInViewport();
  await expect(bar).toContainText('未应用 2 项');
  await expect(page.locator('main [data-stub="Btn"][data-variant="primary"]')).toHaveCount(1);
  await bar.getByRole('button', { name: '撤销' }).click();
  await expect(bar).toHaveCount(0);
  expect(errors).toEqual([]);
});
