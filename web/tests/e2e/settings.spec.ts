import { expect, test } from '@playwright/test';

// Settings drawn after the game's settings panel: the outbound plate, the eight group icon tabs and the search in the command bar, rows and bands, no horizontal overflow.

test('a type in the outbound plate jumps to its setting row', async ({ page }) => {
  await page.goto('main.html#/settings?plugins=all&group=privacy&still=1');
  await page.getByRole('region', { name: '外发总览' }).getByRole('button', { name: '截图', exact: true }).click();
  await expect(page).toHaveURL(/item=shot/);
  await expect(page.locator('#set-shot')).toBeInViewport();
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

