import { expect, test, type Page } from '@playwright/test';

// 角色 › MMD: the stage holds no control; a dance added from its library row becomes a card in the setlist under the stage.

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function importAndAdd(page: Page) {
  await page.goto('main.html#/character?view=mmd&still=1');
  await page.getByRole('button', { name: '导入 VMD' }).click();
  const row = page.locator('[data-mmd="mmd_dance_1"]');
  await row.getByRole('button', { name: '加入演出列表' }).click();
  return row;
}

for (const [width, height] of [
  [1440, 900],
  [925, 515],
] as const) {
  test(`${width}×${height}: no control of the page lies over the stage`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await importAndAdd(page);
    await expect(page.getByRole('region', { name: 'MMD 列表' }).locator('[data-playlist-row="mmd_dance_1"]')).toBeVisible();
    const stage = (await page.locator('[data-preview-stage]').boundingBox())!;
    expect(stage.width).toBeGreaterThan(200);
    const boxes = await page.locator('[data-page="character"] :is(button, [role="radio"], [role="tab"])').evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    );
    expect(boxes.length).toBeGreaterThan(5);
    expect(boxes.filter((b) => overlap(b, stage))).toEqual([]);
  });
}

test('a dance added from its row shows as a card with 移出 on hover, its name whole in the row', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 650 });
  const row = await importAndAdd(page);
  const card = page.getByRole('region', { name: 'MMD 列表' }).locator('[data-playlist-row="mmd_dance_1"]');
  await expect(card).toContainText('示例舞蹈');
  await expect(row).toContainText('01');
  await card.hover();
  await expect(card.getByRole('button', { name: '移出' })).toBeVisible();
  const cut = await row.getByText('示例舞蹈', { exact: true }).evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(cut).toBe(false);
});

test('/mmd lands on the MMD section of 角色 with the rail', async ({ page }) => {
  await page.goto('main.html#/mmd?still=1');
  await expect(page).toHaveURL(/#\/character\?.*view=mmd/);
  await expect(page.getByRole('region', { name: 'MMD 库' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '角色分区' }).getByRole('button', { name: 'MMD' })).toHaveAttribute('aria-current', 'page');
});
