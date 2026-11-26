import { expect, test, type Page } from '@playwright/test';

// 设置: the outbound plate, launch keys via the config file, bottom apply bar, search still lands on the row.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('kernel drafts show one bottom bar with the only primary button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=kernel&demo=draft&still=1');
  const bar = page.getByRole('region', { name: '未应用的改动' });
  await expect(bar).toBeInViewport();
  await expect(bar).toContainText('未应用 2 项');
  // 应用, in the shell's bottom bar, is the view's one primary button.
  await expect(page.locator('[data-stub="Btn"][data-variant="primary"]')).toHaveCount(1);
  await expect(bar.locator('[data-stub="Btn"][data-variant="primary"]')).toHaveText('应用');
  await bar.getByRole('button', { name: '撤销' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('region', { name: '改动怎么生效' })).toContainText('改动立即生效');
  expect(errors).toEqual([]);
});
