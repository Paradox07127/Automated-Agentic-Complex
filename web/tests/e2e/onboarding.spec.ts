import { expect, test, type Page } from '@playwright/test';

// First-run guide on main.html#/onboarding (fake bridge, onboarding surface): the step cells, the settings rows, the action bar.

async function open(page: Page, query = '') {
  await page.goto('about:blank');
  await page.goto(`main.html#/onboarding${query ? `?${query}` : ''}`);
  const guide = page.locator('[data-page="onboarding"]');
  await expect(guide).toBeVisible();
  return guide;
}

test('跳过引导 asks on white paper; Esc keeps the guide', async ({ page }) => {
  const guide = await open(page);
  await guide.locator('header').getByRole('button', { name: '跳过引导' }).click();
  const paper = page.getByRole('dialog', { name: '跳过首次设置？' });
  await expect(paper).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(paper).toHaveCount(0);
  await guide.locator('header').getByRole('button', { name: '跳过引导' }).click();
  await page.getByRole('dialog', { name: '跳过首次设置？' }).getByRole('button', { name: '跳过' }).click();
  await expect(page.locator('main[data-route-id="home"]')).toBeVisible();
});

test('Q and E step through the cells', async ({ page }) => {
  const guide = await open(page, 'demo=chat-ok');
  await expect(guide).toHaveAttribute('data-step', '2');
  await page.keyboard.press('q');
  await expect(guide).toHaveAttribute('data-step', '1');
  await page.keyboard.press('e');
  await expect(guide).toHaveAttribute('data-step', '2');
});

