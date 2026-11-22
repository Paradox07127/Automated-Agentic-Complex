import { expect, test, type Locator, type Page } from '@playwright/test';

// Tool pages get a filter bar (filters, hatch band, main action at the right); process rows are read-only,
// trace turn rows are pressable; the first-run step bar and word mark; nothing scrolls sideways at 900.

// 运行记录 has no filter bar: its search and filters sit at the head of the turn list; 记忆管线 has none either, its stations pick the view.
const TOOLS = ['diag'] as const;

const css = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement('i');
    probe.style.backgroundColor = `var(${n})`;
    document.body.append(probe);
    const v = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return v;
  }, name);

for (const id of TOOLS) {
  test(`${id}: the filter bar sits under the command bar with a hatch band to the right edge`, async ({ page }) => {
    await page.goto(`main.html#/${id}?still=1`);
    const bar = page.locator('main [data-toolbar]');
    await expect(bar).toHaveCount(1);
    const band = bar.locator('[data-band]');
    expect(await css(band, 'background-image')).toContain('repeating-linear-gradient');
    // The command bar's 3 px stripe runs along its bottom edge.
    const header = (await page.locator('[data-shell="tri"]').boundingBox())!;
    const b = (await bar.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(b.y).toBeLessThan(header.y + header.height + 2);
    const action = bar.locator('[data-toolbar-action]');
    if (await action.count()) {
      const a = (await action.boundingBox())!;
      const h = (await band.boundingBox())!;
      expect(a.x).toBeGreaterThan(h.x + h.width - 1);
      expect(b.x + b.width - (a.x + a.width)).toBeLessThanOrEqual(25);
    }
  });
}

test('diag process rows are read-only: no hover step, no cut', async ({ page }) => {
  await page.goto('main.html#/diag?still=1');
  const row = page.locator('[data-nav-target="proc-agentd"]');
  await expect(row).toBeVisible();
  const before = await css(row.locator('td').first(), 'background-image');
  await row.locator('td').first().hover();
  expect(await css(row.locator('td').first(), 'background-image')).toBe(before);
  expect(await css(row, 'clip-path')).toBe('none');
  expect(await css(page.locator('table thead th').first(), 'background-color')).toBe(await token(page, '--ef-chip'));
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
  for (const id of TOOLS) {
    await page.goto('about:blank');
    await page.goto(`main.html#/${id}?still=1`);
    await expect(page.locator('main [data-toolbar]')).toBeVisible();
    const over = await page.evaluate(() =>
      [document.documentElement, ...document.querySelectorAll('main, [data-shell="content"], [data-page], [data-toolbar], [data-page] table')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.tagName}.${el.getAttribute('aria-label') ?? ''} ${el.scrollWidth}>${el.clientWidth}`),
    );
    expect(over, id).toEqual([]);
  }
  await page.goto('about:blank');
  await page.goto('main.html#/pipeline?still=1');
  await expect(page.getByRole('tablist', { name: '工位' })).toBeVisible();
  const over = await page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll('main, [data-shell="content"], [data-page]')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName} ${el.scrollWidth}>${el.clientWidth}`),
  );
  expect(over, 'pipeline').toEqual([]);
});
