import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// The notice native raises itself gets a HUD line (电脑操作); its other notices stay off the HUD.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

async function open(page: Page, demo: string, theme: 'dark' | 'light' = 'dark') {
  await page.goto(`stack.html#/hud?demo=${demo}&still=1&theme=${theme}`);
  await page.getByRole('button', { name: /^展开全部/ }).click();
  await expect(page.locator('[data-card-id]').first()).toBeVisible();
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: native cards shots`, async ({ page }, info) => {
    await page.setViewportSize({ width: 520, height: 760 });
    for (const demo of ['desktop']) {
      await open(page, demo, theme);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await saveShot(page, { path: `${shotsDir}${info.project.name}/native-cards-${theme}-${demo}.png` });
      // A hash-only change does not reload the panel, so leave the page first.
      await page.goto('about:blank');
    }
  });
}

test('电脑操作: scope folded, 停止 stops and 收起 hides it', async ({ page }) => {
  await open(page, 'desktop');
  const card = page.locator('[data-card-id="computer-use"]');
  await expect(card.getByRole('alertdialog', { name: /^电脑操作/ })).toBeVisible();
  await expect(card.locator('[data-art-slot="card-head"]')).toHaveCount(1);
  await expect(card.getByText('正在操作「访达」')).toBeVisible();
  const fold = card.getByRole('button', { name: /^窗口与范围/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByText('下载文件夹', { exact: true })).toBeHidden();
  await fold.click();
  await expect(card.getByText('下载文件夹', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: /^停止/ }).click();
  await expect(card.getByRole('button', { name: /^已停止/ })).toBeDisabled();
  await card.getByRole('button', { name: '收起' }).click();
  await expect(card).toBeHidden();
});

// 语音提示, 角色加载 and the 屏幕识读 receipt are not lines of the HUD; it shows its sessions instead.
test('语音提示, 角色加载 and 屏幕识读 stay off the HUD', async ({ page }) => {
  await page.goto('stack.html#/hud?demo=desktop-progress&still=1');
  await page.getByRole('button', { name: /^展开全部/ }).click();
  await expect(page.locator('[data-hud-row]').first()).toBeVisible();
  for (const id of ['avatar-loading', 'voice-hint', 'n-look']) await expect(page.locator(`[data-hud-row="${id}"], [data-card-id="${id}"]`)).toHaveCount(0);
  await page.goto('about:blank');
  await open(page, 'desktop');
  await expect(page.locator('[data-card-id="voice-hint"]')).toHaveCount(0);
});
