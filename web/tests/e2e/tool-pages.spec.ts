import { expect, test, type Locator } from '@playwright/test';

// Diag process rows are read-only, trace turn rows are pressable; the first-run step cells and step card; nothing scrolls sideways at 900.

const css = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

test('diag process rows are read-only: no hover step, no cut', async ({ page }) => {
  await page.goto('main.html#/diag?still=1&tab=proc');
  const row = page.locator('[data-nav-target="proc-agentd"]');
  await expect(row).toBeVisible();
  const before = await css(row, 'background-color');
  await row.hover({ position: { x: 20, y: 20 } });
  expect(await css(row, 'background-color')).toBe(before);
  expect(await css(row, 'clip-path')).toBe('none');
  expect(await page.locator('main [data-toolbar]').count()).toBe(0);
});

test('trace turn rows are pressable: hover draws the stripes, the picked row is the yellow band', async ({ page }) => {
  await page.goto('main.html#/diag?tab=turns&still=1&demo=full');
  const row = page.getByRole('listbox', { name: '近 24 小时的轮次' }).getByRole('option').nth(1);
  await row.hover();
  await expect.poll(() => row.evaluate((e) => getComputedStyle(e, '::after').opacity)).toBe('1');
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  expect(await css(row, 'background-color')).toBe('rgb(255, 241, 0)');
});

for (const theme of ['dark', 'light'] as const) {
  test(`onboarding ${theme}: the step cells on a dark bar, the step card beside the media frame, no paging arrows`, async ({ page }) => {
    await page.goto(`main.html#/onboarding?demo=chat&theme=${theme}&still=1`);
    const guide = page.locator('[data-page="onboarding"]');
    await expect(page.getByRole('tab', { name: '02 对话' })).toHaveAttribute('aria-selected', 'true');
    expect(await css(guide.locator('header'), 'background-color')).toBe('rgb(22, 22, 22)');
    expect(await css(guide.getByRole('heading', { level: 1 }), 'font-size')).toBe('28px');
    const card = await guide.getByRole('heading', { level: 1 }).boundingBox();
    const frame = await guide.locator('[data-stub="GameFrame"]').boundingBox();
    expect(card!.x + card!.width).toBeLessThan(frame!.x);
    await expect(guide.getByRole('button', { name: /上一页|下一页/, includeHidden: true })).toHaveCount(0);
  });
}

test('tool pages do not scroll sideways at 900×600', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  for (const id of ['diag?', 'memory?view=pipeline&'] as const) {
    await page.goto('about:blank');
    await page.goto(`main.html#/${id}still=1`);
    await expect(page.locator('[data-page]').first()).toBeVisible();
    const over = await page.evaluate(() =>
      [document.documentElement, ...document.querySelectorAll('main, [data-shell="content"], [data-page], [data-page] table')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.tagName}.${el.getAttribute('aria-label') ?? ''} ${el.scrollWidth}>${el.clientWidth}`),
    );
    expect(over, id).toEqual([]);
  }
});
