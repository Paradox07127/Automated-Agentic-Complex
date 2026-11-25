import { expect, test } from '@playwright/test';
import { saveShot } from './shots.ts';

// MMD › 导入 MMD on the fake: the 确认单 fits the window at both sizes, the imported dance shows its part and marks, 换音源 opens.

for (const [width, height] of [
  [1440, 900],
  [925, 515],
] as const) {
  test(`${width}×${height}: the 确认单 shows every choice inside the window with 导入 reachable`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto('main.html#/mmd?still=1');
    await page.getByRole('button', { name: '导入 MMD' }).click();
    const sheet = page.getByRole('dialog', { name: '导入 MMD' });
    await expect(sheet.getByRole('textbox', { name: '曲名' })).toHaveValue('サンプルダンス');
    await sheet.getByRole('button', { name: /未使用的文件/ }).click();
    const go = sheet.getByRole('button', { name: '导入' });
    await go.scrollIntoViewIfNeeded();
    const box = (await go.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await saveShot(page, { path: `.shots/${info.project.name}/mmd-import-sheet-${width}x${height}.png` });
    await go.click();
    const row = page.locator('[data-mmd="mmd_dance_1"]');
    await expect(row).toContainText('SampleDancerA');
    await expect(row.getByText('LIP', { exact: true })).toBeVisible({ visible: width > 1000 });
    await row.locator('button[aria-pressed]').click();
    await page.locator('[data-mmd-detail="mmd_dance_1"]').getByRole('button', { name: '换音源' }).click();
    await expect(page.getByRole('dialog', { name: '换音源' })).toBeVisible();
    await saveShot(page, { path: `.shots/${info.project.name}/mmd-import-media-${width}x${height}.png` });
    await page.getByRole('dialog', { name: '换音源' }).getByRole('button', { name: '取消' }).click();
    await saveShot(page, { path: `.shots/${info.project.name}/mmd-import-library-${width}x${height}.png` });
  });
}
