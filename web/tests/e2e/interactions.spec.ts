import { expect, test, type Page } from '@playwright/test';
import { A1 } from '../../src/mock/fixtures/ids';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test.describe('HUD: dangerous approval never approves from the keyboard', () => {
  // A1 sits on its session line in the default demo, as the compact block, once the HUD is expanded.
  const card = (page: Page) => page.locator(`[data-card-id="${A1}"] [data-stub="SessionApproval"]`);
  const approve = (page: Page) => page.locator(`[data-card-id="${A1}"] [data-approve] button`);

  test('Esc on 批准 denies', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('stack.html#/hud?still=1');
    await page.locator('[data-hud-bar]').click();
    await approve(page).focus();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveAttribute('data-outcome', 'denied');
    expect(errors).toEqual([]);
  });
});

