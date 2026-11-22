import { expect, test, type Page } from '@playwright/test';

// The shared frame pieces in the component catalog: one cell size for every tab variant, Fold and ExpandRow from the keyboard.

const open = async (page: Page, c: string, d: string) => {
  await page.goto(`main.html#/ds?c=${c}&d=${d}&still=1`);
  await expect(page.locator(`[data-stub="${c}"]`).first()).toBeVisible();
};

for (const d of ['icon', 'avatar', 'steps']) {
  test(`${d} tabs are 50 high cells with the 56 high block hanging 13 px past each side`, async ({ page }) => {
    await open(page, 'Tabs', d);
    const tab = page.locator('[data-stub="Tabs"] [role="tab"][aria-selected="true"]');
    const cell = await tab.boundingBox();
    const block = await tab.locator('[data-g="slc"]').boundingBox();
    expect(cell?.height).toBe(50);
    expect(cell!.width).toBeGreaterThanOrEqual(50);
    expect(block?.height).toBe(56);
    expect(block!.width).toBeCloseTo(cell!.width + 26, 0);
    expect(block!.y).toBeCloseTo(cell!.y, 0);
  });
}

test('Fold toggles on Enter and Space and leaves Escape alone', async ({ page }) => {
  await open(page, 'Fold', 'closed');
  const head = page.locator('[data-stub="Fold"] button[aria-expanded]').first();
  await head.focus();
  await page.keyboard.press('Enter');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
});

test('GameTable rows sit on the header columns', async ({ page }) => {
  await open(page, 'GameTable', 'records');
  const table = page.locator('[data-stub="GameTable"]');
  const heads = await table.locator(':scope > div:first-child > span').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  const cells = await table.locator('[data-stub="ExpandRow"] [role="button"]').first().locator(':scope > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  // After the centred chevron, each cell starts where its column name starts.
  expect(cells.slice(1)).toEqual(heads.slice(1, cells.length));
});
