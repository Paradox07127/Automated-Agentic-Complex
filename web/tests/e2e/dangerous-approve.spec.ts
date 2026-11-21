import { expect, test, type Page } from '@playwright/test';
import { A1 } from '../../src/mock/fixtures/ids';

// Under the browser's fake bridge a dangerous approve on the HUD decides only on the second click
// within a second (确认批准); a single click, or a second one after the window, decides nothing.

// A1 sits on its session line in the default demo, as the compact block, once the HUD is expanded.
const card = (page: Page) => page.locator(`[data-card-id="${A1}"] [data-stub="SessionApproval"]`);
const approve = (page: Page) => page.locator(`[data-card-id="${A1}"] [data-approve] button`);

test('dangerous 批准 needs 确认批准 within a second', async ({ page }) => {
  await page.goto('stack.html#/hud?still=1');
  await page.locator('[data-hud-bar]').click();
  await expect(card(page)).toHaveAttribute('data-dangerous', 'true');
  await expect(approve(page)).toHaveText('批准');

  await approve(page).click();
  await expect(approve(page)).toHaveText('确认批准');
  await expect(approve(page)).toHaveText('批准', { timeout: 3000 });
  await expect(card(page)).not.toHaveAttribute('data-outcome');

  await approve(page).click();
  await expect(approve(page)).toHaveText('确认批准');
  await expect(card(page)).not.toHaveAttribute('data-outcome');
  await approve(page).click();
  await expect(card(page)).toHaveAttribute('data-outcome', 'approved');
});
