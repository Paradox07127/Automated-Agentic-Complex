import { expect, test, type Page } from '@playwright/test';

// 动作 › 编排 layout: lane tracks span the time axis whatever badges they carry, a long chain scrolls in its strip, and the chain
// inspector keeps every action at compact sizes.

const PONDER = 'A_clip_birch_dialog_state_think_start';

async function openPonder(page: Page) {
  await page.goto('main.html#/character?still=1&pane=chain');
  await page.getByRole('radio', { name: /^事件反应/ }).click();
  await page.locator('[data-pool-cell="session.thinking"]').click();
  await page.locator(`[data-chain="${PONDER}"]`).getByRole('button', { name: /^展开/ }).click();
  const d = page.locator('[data-chain-detail]');
  await expect(d).toBeVisible();
  return d;
}

test('every lane track spans the time axis, with or without its badges', async ({ page }) => {
  for (const width of [1280, 960]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('main.html#/character?still=1&pane=chain');
    const lane = page.locator('[data-lane="idle.t1"]');
    await expect(lane.locator('[data-proposed]')).toBeVisible();
    const [tr, axis] = await lane.evaluate((el) => {
      const box = (e: Element) => e.getBoundingClientRect();
      return [box(el.children[1]!), box(el.parentElement!.firstElementChild!)].map((r) => ({ left: r.left, right: r.right }));
    });
    expect(Math.abs(tr!.left - axis!.left), `left at ${width}`).toBeLessThanOrEqual(1);
    expect(Math.abs(tr!.right - axis!.right), `right at ${width}`).toBeLessThanOrEqual(1);
  }
});

test('a chain of five segments scrolls sideways in its strip to the stance it comes back to', async ({ page }) => {
  const d = await openPonder(page);
  await d.getByRole('button', { name: '编辑结构' }).click();
  for (let i = 0; i < 2; i += 1) {
    await d.getByRole('button', { name: '在「dialog_state_think_loop」前插入' }).click();
    await d.locator('[data-cand]').first().getByRole('button', { name: '在此前插入' }).click();
  }
  await expect(d.locator('[data-seg]')).toHaveCount(5);
  const strip = d.getByRole('group', { name: '链条' });
  const m = await strip.evaluate((el) => ({ x: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth }));
  expect(m.x).toBe('auto');
  expect(m.sw).toBeGreaterThan(m.cw);
  await strip.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  const back = await strip.evaluate((el) => {
    const s = el.getBoundingClientRect();
    const b = el.querySelector('[data-side="back"]')!.getBoundingClientRect();
    return { strip: s.right, back: b.right };
  });
  expect(back.back).toBeLessThanOrEqual(back.strip + 1);
});

test('at compact sizes the inspector keeps 桌面播一次, 备注, 从这个池去掉 and the blend', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 760 });
  const d = await openPonder(page);
  // The compact rules are on: the 所有池抽到时 label is gone.
  await expect(d.getByText('所有池抽到时')).toBeHidden();
  for (const name of ['桌面播一次', '备注', '从这个池去掉']) await expect(d.getByRole('button', { name })).toBeVisible();
  await d.getByRole('button', { name: /^进入「dialog_state_think_loop」的衔接/ }).click();
  await expect(d.getByRole('slider', { name: '进入「dialog_state_think_loop」的混合' })).toBeVisible();
  const box = await d.boundingBox();
  for (const name of ['桌面播一次', '备注', '从这个池去掉']) {
    const b = (await d.getByRole('button', { name }).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  }
});
