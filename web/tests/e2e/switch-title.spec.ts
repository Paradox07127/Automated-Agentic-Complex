import { expect, test, type Page } from '@playwright/test';

// 雷霆大字 (`stack.html#/title`): her name in the white big text layout, shown still in the middle of the screen.

test.use({ viewport: { width: 1920, height: 1080 } });

async function open(page: Page, params: Record<string, string>) {
  await page.goto('about:blank');
  await page.goto(`stack.html#/title?${new URLSearchParams(params).toString()}`);
  await expect(page.locator('[data-slot="name"]')).toHaveText(params.name!);
}


test('shot: 佩丽卡 at rest', async ({ page }) => {
  await open(page, { name: '佩丽卡', en: 'Perlica' });
  await page.evaluate(() => (document.body.style.background = 'linear-gradient(#5f7487, #98a8b3 55%, #6c7769 55%, #414d43)'));
  await page.screenshot({ path: test.info().outputPath('title-rest.png') });
});
