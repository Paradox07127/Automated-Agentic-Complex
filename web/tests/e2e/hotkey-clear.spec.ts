import { expect, test } from '@playwright/test';
import { saveShot } from './shots.ts';

// A cleared hot key reads 未设置 and offers 更改 only.

const shots = (name: string) => `.shots/${test.info().project.name}/hotkey-clear-${name}.png`;

for (const theme of ['dark', 'light'] as const) {
  test(`清除 leaves a hot key 未设置 (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`main.html#/settings?group=keys&still=1&theme=${theme}`);
    const row = page.locator('[data-row="hk_look"]');
    await row.getByRole('button', { name: '清除' }).click();
    await expect(row).toContainText('未设置');
    await expect(row.getByRole('button', { name: '清除' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: '更改' })).toBeVisible();
    await saveShot(page, { path: shots(`hotkey-unset-${theme}`) });
    expect(errors).toEqual([]);
  });
}
