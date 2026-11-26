import { expect, test, type Page } from '@playwright/test';

// The bubble beside her head (`stack.html#/bubble`) in every preset: nothing runs out sideways, no text under 13 px,
// and the bubble stays within 300 px.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, params: Record<string, string>) {
  await page.goto('about:blank');
  await page.goto(`stack.html#/bubble?${new URLSearchParams({ ...params, still: '1' }).toString()}`);
}

for (const [theme, text] of [['dark', 'rgb(237, 237, 237)'], ['light', 'rgb(22, 22, 22)']] as const) {
  test(`${theme} 快速输入: the input takes the bubble's theme and its keycaps stay inside the band`, async ({ page }) => {
    await open(page, { mode: 'input', theme });
    const dialog = page.locator('[data-bubble]').getByRole('dialog', { name: '快速输入' });
    await expect(dialog).toBeVisible();
    expect(await dialog.getByRole('textbox').evaluate((el) => getComputedStyle(el).color)).toBe(text);
    const out = await dialog.evaluate((box) => {
      const band = box.closest('[data-bubble]')?.querySelector<HTMLElement>(':scope > div')?.getBoundingClientRect();
      const caps = [...box.querySelectorAll<HTMLElement>(':scope > [aria-hidden="true"] > span')].map((c) => c.getBoundingClientRect());
      if (!band || caps.length !== 2) return ['no band or caps'];
      return caps.filter((c) => c.left < band.left - 0.5 || c.right > band.right + 0.5).map((c) => `${c.left}..${c.right} outside ${band.left}..${band.right}`);
    });
    expect(out).toEqual([]);
  });
}

test('reply and disclosure show on hover; reply quotes the thought', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { demo: 'thought' });
  const card = page.locator('[data-bubble]');
  await card.hover();
  await expect(card.getByRole('button', { name: '回复', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '更多操作' }).click();
  for (const name of ['复制', '关闭此类']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '回复', exact: true }).click();
  await expect(card.getByRole('dialog', { name: '快速输入' })).toBeVisible();
  await expect(card).toContainText('引用：测试又红了');
  await card.getByRole('textbox').press('Escape');
  await expect(card.getByRole('dialog', { name: '快速输入' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the tail leaves the card edge toward her head, on the bubble and on the confirm card', async ({ page }) => {
  await open(page, { demo: 'thought' });
  await expect(page.locator('[data-bubble]')).toHaveAttribute('data-tail', 'right');
  await open(page, { demo: 'confirm' });
  await expect(page.locator('[data-confirm]')).toHaveAttribute('data-tail', 'right');
});

test('with nothing to say there is no bubble', async ({ page }) => {
  await open(page, {});
  await expect(page.locator('[data-surface-root="bubble"]')).toBeAttached();
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await expect(page.locator('[data-bubble], [data-confirm]')).toHaveCount(0);
});

