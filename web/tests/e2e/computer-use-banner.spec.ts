import { expect, test } from '@playwright/test';
import { saveShot } from './shots.ts';

const shots = (name: string) => `.shots/${test.info().project.name}/computer-use-banner-${name}.png`;

for (const theme of ['dark', 'light'] as const) {
  test(`the computer-use banner sits above the page content with one stop button (${theme})`, async ({ page }) => {
    await page.goto(`main.html#/overview?still=1&demo=computer-use&theme=${theme}`);
    const banner = page.getByRole('status').filter({ hasText: '电脑操作进行中' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('已允许：观察控件、执行操作');
    await expect(banner.getByRole('button', { name: '停止' })).toBeVisible();
    const header = await page.locator('[data-shell="content"]').boundingBox();
    const box = await banner.boundingBox();
    expect(box !== null && header !== null && box.y + box.height <= header.y).toBe(true);
    await saveShot(page, { path: shots(`computer-use-${theme}`) });
  });

}

test('without a session acting there is no banner', async ({ page }) => {
  await page.goto('main.html#/overview?still=1');
  await expect(page.locator('main[data-route-id="overview"]')).toBeVisible();
  await expect(page.getByText('电脑操作进行中')).toHaveCount(0);
});
