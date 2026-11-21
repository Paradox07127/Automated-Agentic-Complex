import { expect, test, type Page } from '@playwright/test';

// The approval blocks on the expanded HUD keep their buttons inside them, and English eyebrows read at size.

async function open(page: Page, theme: 'dark' | 'light') {
  await page.goto(`stack.html#/hud?still=1&theme=${theme}`);
  await page.getByRole('button', { name: /^展开全部/ }).click();
  await expect(page.locator('[data-card-id]').first()).toBeVisible();
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: approval buttons sit inside their block; eyebrows read at size`, async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 1400 });
    await open(page, theme);
    const papers = page.locator('[data-stub="ApprovalCard"], [data-stub="SessionApproval"]');
    expect(await papers.count()).toBeGreaterThan(1);
    for (const paper of await papers.all()) {
      const box = (await paper.boundingBox())!;
      for (const btn of await paper.getByRole('button', { name: /^(拒绝|批准)$/ }).all()) {
        const b = (await btn.boundingBox())!;
        expect(b.y).toBeGreaterThanOrEqual(box.y);
        expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height);
      }
    }
    const px = (l: ReturnType<Page['locator']>) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    for (const eyebrow of await page.locator('[data-card-id] [lang="en"]').all()) expect(await px(eyebrow)).toBeGreaterThanOrEqual(12);
  });
}
