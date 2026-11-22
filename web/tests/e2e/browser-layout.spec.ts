import { expect, test, type Locator, type Page } from '@playwright/test';

// Layout checks that need a real browser.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const style = (el: Locator, prop: string) => el.evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop);

// The search box is a square field on the raised panel colour in both themes.
async function expectCapsule(field: Locator, fill: string) {
  await expect(field).toBeVisible();
  const box = await field.boundingBox();
  const icon = await field.locator('[data-icon="search"]').boundingBox();
  expect(box && icon).toBeTruthy();
  // The magnifier sits inside the box, not beside it.
  expect(icon!.x).toBeGreaterThanOrEqual(box!.x);
  expect(icon!.x + icon!.width).toBeLessThanOrEqual(box!.x + box!.width);
  expect(await style(field, 'border-top-left-radius')).toBe('0px');
  expect(await style(field, 'background-color')).toBe(fill);
}

test('the chat list search box is the raised search field', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&still=1');
  const fill = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--ef-raised)';
    document.body.append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  await expectCapsule(page.locator('[data-stub="SearchField"]', { has: page.getByRole('textbox', { name: '搜索对话' }) }), fill);
  expect(errors).toEqual([]);
});

// Diag is one page of numbered open sections (processes live in the health strip); no icon block, no status dot on the heads.
test('diag section heads are plain numbered titles', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  const heads = page.locator('main [data-stub="SecHead"]');
  await expect(heads).toHaveCount(3);
  await expect(heads.locator('[data-icon-block]')).toHaveCount(0);
  await expect(heads.locator('[data-dot]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the mood word is shown whole', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/tune?still=1');
  const word = page.getByText('有点低落', { exact: true }).first();
  await expect(word).toBeVisible();
  const clipped = await word.evaluate((n) => n.scrollWidth > n.clientWidth || n.scrollHeight > n.clientHeight);
  expect(clipped).toBe(false);
  expect(errors).toEqual([]);
});

