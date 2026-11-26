import { expect, test, type Page } from '@playwright/test';
import {  T2 } from '../../src/mock/fixtures/ids';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('approval: Esc on the approval paper only leaves; nothing is denied', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/tasks?plugins=all&sel=${encodeURIComponent(T2)}&still=1`);
  const card = page.getByRole('region', { name: '详情' }).locator('[data-focus-card]').first();
  await card.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/^已拒绝/)).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/tasks/);
  await page.goBack();
  await expect(page.getByRole('region', { name: '详情' }).locator('[data-focus-card]').first()).toBeVisible();
  expect(errors).toEqual([]);
});
