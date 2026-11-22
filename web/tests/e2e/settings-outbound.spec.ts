import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// 设置: the outbound plate, launch keys via the config file, bottom apply bar, search still lands on the row.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const shots = (name: string) => `.shots/${test.info().project.name}/settings-outbound-${name}.png`;

for (const theme of ['dark', 'light'] as const) {
  test(`观察 opens on the one-line outbound plate (${theme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`main.html#/settings?plugins=all&group=privacy&still=1&theme=${theme}`);
    const plate = page.getByRole('region', { name: '外发总览' });
    // The settings default screen_context_level is focused.
    await expect(plate.getByRole('button', { name: '窗口文字（仅焦点元素）' })).toBeVisible();
    await expect(page.getByText(/需新增|未核实|policy_epoch/)).toHaveCount(0);
    await saveShot(plate, { path: shots(`outbound-plate-${theme}`) });
    expect(errors).toEqual([]);
  });
}

test('settings-adv sends the launch keys to the config file, no raw keys on screen', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=about&still=1');
  await expect(page.getByText('只能在配置文件里改')).toBeAttached();
  await expect(page.getByRole('button', { name: '打开配置文件' })).toBeEnabled();
  await expect(page.getByText(/tts_url/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('settings search still lands on the row', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=about&still=1');
  await page.getByRole('textbox', { name: '搜索设置' }).fill('截图');
  await page.getByRole('button', { name: /^识读时附上截图/ }).click();
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
  // The yellow capsule is the view's one main button.
  await expect(page.locator('main button[data-tone="acc"]')).toHaveCount(1);
  await bar.getByRole('button', { name: '撤销' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('region', { name: '改动怎么生效' })).toContainText('改动立即生效');
  expect(errors).toEqual([]);
});
