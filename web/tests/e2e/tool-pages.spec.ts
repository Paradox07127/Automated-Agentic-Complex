import { expect, test, type Locator } from '@playwright/test';

// Diag process rows are read-only, trace turn rows are pressable; the first-run step cells and step card; nothing scrolls sideways at 900.

const css = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

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

