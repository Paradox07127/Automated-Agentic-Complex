import { expect, test } from '@playwright/test';

// The HUD's folded line sits on its own backing in either system appearance; lines show from the first frame.

// smoke's hud-default.png is taken right after mount without still=1; an entrance fade from opacity 0 would leave it blank.
test('HUD default: no line entrance animates opacity, so lines show from the first frame', async ({ page }) => {
  await page.goto('stack.html');
  const first = page.locator('[data-hud-row]').first();
  await first.waitFor({ state: 'attached' });
  const fades = await page.locator('[data-hud-row]').evaluateAll((els) => {
    const names = new Set(els.flatMap((e) => getComputedStyle(e).animationName.split(',').map((n) => n.trim())));
    const out: string[] = [];
    for (const sheet of document.styleSheets)
      for (const rule of sheet.cssRules) if (rule instanceof CSSKeyframesRule && names.has(rule.name) && /opacity/.test(rule.cssText)) out.push(rule.name);
    return out;
  });
  expect(fades).toEqual([]);
  await expect(first).toBeInViewport();
});
