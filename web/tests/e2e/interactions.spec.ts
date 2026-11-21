import { expect, test, type Locator, type Page } from '@playwright/test';
import { A1 } from '../../src/mock/fixtures/ids';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const focusInside = (box: Locator) => box.evaluate((el) => el.contains(document.activeElement));

test.describe('HUD: dangerous approval never approves from the keyboard', () => {
  // A1 sits on its session line in the default demo, as the compact block, once the HUD is expanded.
  const card = (page: Page) => page.locator(`[data-card-id="${A1}"] [data-stub="SessionApproval"]`);
  const approve = (page: Page) => page.locator(`[data-card-id="${A1}"] [data-approve] button`);

  for (const key of ['Enter', 'Space']) {
    test(`${key} on 批准 shows the mouse-only hint`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto('stack.html#/hud?still=1');
      await page.locator('[data-hud-bar]').click();
      await expect(card(page)).toHaveAttribute('data-dangerous', 'true');
      await expect(card(page).getByRole('alert')).toHaveCount(0);
      await approve(page).focus();
      await page.keyboard.press(key);
      await expect(card(page).getByRole('alert')).toContainText('只能用鼠标点');
      await expect(card(page).getByRole('status')).toContainText('只能用鼠标点');
      await expect(card(page)).not.toHaveAttribute('data-outcome');
      await expect(page.locator(`[data-card-id="${A1}"]`)).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }

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

async function openWintextConfirm(page: Page) {
  await page.goto('main.html#/settings?group=privacy&still=1');
  const sw = page.getByRole('switch', { name: '窗口文字', exact: true });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await focusInside(dialog)).toBe(true);
  return { sw, dialog };
}

test('settings: Tab and Shift+Tab stay inside the danger confirm', async ({ page, browserName }) => {
  // Product bug: WebKit skips buttons on Tab, so focus leaves the two-button dialog for <body>.
  const errors = collectErrors(page);
  const { dialog } = await openWintextConfirm(page);
  for (const key of [...Array<string>(6).fill('Tab'), ...Array<string>(6).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    expect(await focusInside(dialog), `focus after ${key}`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('settings: Esc closes the danger confirm and keeps the switch on', async ({ page }) => {
  const errors = collectErrors(page);
  const { sw, dialog } = await openWintextConfirm(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(errors).toEqual([]);
});

test('settings: Esc returns focus to the switch that opened the confirm', async ({ page, browserName }) => {
  // Product bug: a WebKit click does not focus the button, so Modal restores focus to <body>.
  const errors = collectErrors(page);
  const { sw, dialog } = await openWintextConfirm(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(sw).toBeFocused();
  expect(errors).toEqual([]);
});
