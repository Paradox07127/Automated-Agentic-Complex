import { expect, test, type Page } from '@playwright/test';

// MMD page: the stage holds no control; the timeline and the setlist stand under it; a dance added from its library row becomes a card in the setlist.

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function importAndAdd(page: Page) {
  await page.goto('main.html#/mmd?still=1');
  await page.getByRole('button', { name: '导入 MMD' }).click();
  const sheet = page.getByRole('dialog', { name: '导入 MMD' });
  await sheet.getByRole('textbox', { name: '曲名' }).fill('舞');
  await sheet.getByRole('button', { name: '导入' }).click();
  const row = page.locator('[data-mmd="mmd_dance_1"]');
  await row.getByRole('button', { name: '加入演出列表' }).click();
  return row;
}

for (const [width, height] of [
  [1440, 900],
  [925, 515],
] as const) {
  test(`${width}×${height}: no control of the page lies over the stage; the timeline, the setlist and the inspector fit the window`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await importAndAdd(page);
    await expect(page.getByRole('region', { name: 'MMD 列表' }).locator('[data-playlist-row="mmd_dance_1"]')).toBeVisible();
    const stage = (await page.locator('[data-preview-stage]').boundingBox())!;
    expect(stage.width).toBeGreaterThan(200);
    expect(stage.height).toBeGreaterThan(150);
    const boxes = await page.locator('[data-page="mmd"] :is(button, [role="radio"], [role="tab"], [role="slider"], input)').evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    );
    expect(boxes.length).toBeGreaterThan(5);
    expect(boxes.filter((b) => overlap(b, stage))).toEqual([]);
    for (const name of ['时间线', 'MMD 列表', '这支舞']) {
      const box = (await page.getByRole('region', { name }).boundingBox())!;
      expect(box.y + box.height, name).toBeLessThanOrEqual(height);
    }
    await expect(page.getByRole('region', { name: '时间线' }).locator('[data-lane="face"] svg')).toHaveAttribute('data-bins', '600');
    await expect(page.getByRole('region', { name: '这支舞' }).getByRole('button', { name: '删除' })).toBeVisible();
  });
}

test('a dance added from its row shows as a card with 移出 on hover, its name whole in the row', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 650 });
  const row = await importAndAdd(page);
  const card = page.getByRole('region', { name: 'MMD 列表' }).locator('[data-playlist-row="mmd_dance_1"]');
  await expect(card).toContainText('舞 · SampleDancerA');
  await expect(row).toContainText('01');
  await card.hover();
  await expect(card.getByRole('button', { name: '移出' })).toBeVisible();
  const cut = await row.getByText('舞 · SampleDancerA', { exact: true }).evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(cut).toBe(false);
});
