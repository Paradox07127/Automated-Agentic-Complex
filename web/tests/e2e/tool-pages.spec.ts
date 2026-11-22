import { expect, test, type Locator, type Page } from '@playwright/test';

// Diag process rows are read-only, trace turn rows are pressable; the first-run step bar and word mark; nothing scrolls sideways at 900.

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
  await page.goto('main.html#/trace?still=1&demo=full');
  const row = page.getByRole('listbox', { name: '近 24 小时的轮次' }).getByRole('option').nth(1);
  await row.hover();
  await expect.poll(() => row.evaluate((e) => getComputedStyle(e, '::after').opacity)).toBe('1');
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  expect(await css(row, 'background-image')).toContain('linear-gradient');
});

for (const theme of ['dark', 'light'] as const) {
  test(`onboarding ${theme}: media panel index, no step bar or arrows, and the wide word mark`, async ({ page }) => {
    await page.goto(`main.html#/onboarding?demo=step2&theme=${theme}&still=1`);
    const guide = page.getByRole('dialog', { name: /^首次设置/ });
    await expect(guide.getByLabel('第 2 步，共 3 步')).toHaveText('02/03');
    await expect(page.getByRole('list', { name: '首次设置步骤' })).toHaveCount(0);
    expect(await css(guide.getByLabel('第 2 步，共 3 步'), 'font-size')).toBe('15px');
    expect(await css(guide.getByRole('heading', { level: 1 }), 'font-size')).toBe('15px');
    // The 505 px frame sits centred over the index; no paging arrows beside it.
    const frame = await guide.getByLabel('第 2 步，共 3 步').evaluate((el) => {
      const r = el.parentElement!.querySelector('.media-frame')!.getBoundingClientRect();
      const i = el.getBoundingClientRect();
      return { width: r.width, off: Math.abs(r.left + r.width / 2 - (i.left + i.width / 2)) };
    });
    expect(frame.width).toBe(505);
    expect(frame.off).toBeLessThan(1);
    await expect(guide.getByRole('button', { name: /上一页|下一页/, includeHidden: true })).toHaveCount(0);
    const mark = page.getByText('Agentic Complex', { exact: true });
    expect(await css(mark, 'font-weight')).toBe('800');
    expect(await css(mark, 'font-stretch')).toBe('125%');
    expect(await css(mark, 'font-family')).toContain('Saira');
  });
}

test('tool pages do not scroll sideways at 900×600', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  for (const id of ['diag', 'pipeline', 'tune'] as const) {
    await page.goto('about:blank');
    await page.goto(`main.html#/${id}?still=1`);
    await expect(page.locator('[data-page]').first()).toBeVisible();
    const over = await page.evaluate(() =>
      [document.documentElement, ...document.querySelectorAll('main, [data-shell="content"], [data-page], [data-page] table')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.tagName}.${el.getAttribute('aria-label') ?? ''} ${el.scrollWidth}>${el.clientWidth}`),
    );
    expect(over, id).toEqual([]);
  }
});
