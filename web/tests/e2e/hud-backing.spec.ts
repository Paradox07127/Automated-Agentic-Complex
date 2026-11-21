import { expect, test, type Locator, type Page } from '@playwright/test';

// The HUD's folded line sits on its own backing in either system appearance; lines show from the first frame.

/** Lowest contrast between the element's text color and any background pixel under its text, text hidden. */
async function minContrast(page: Page, target: Locator): Promise<number> {
  const { fg, box } = await target.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    const first = walker.nextNode();
    if (!first?.parentElement) throw new Error('no text');
    const range = document.createRange();
    range.selectNodeContents(el);
    // Only the text inside the element's own box: an ellipsized or clipped title runs on under its neighbours.
    const t = range.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    const [x, y] = [Math.max(t.left, e.left), Math.max(t.top, e.top)];
    const r = { x, y, width: Math.min(t.right, e.right) - x, height: Math.min(t.bottom, e.bottom) - y };
    const color = getComputedStyle(first.parentElement).color;
    el.setAttribute('data-hide-text', '');
    return { fg: color, box: r };
  });
  const png = await page.screenshot({ clip: box });
  await target.evaluate((el) => el.removeAttribute('data-hide-text'));
  return page.evaluate(
    async ({ b64, fg }) => {
      const lum = (rgb: number[]) => {
        const [r = 0, g = 0, b = 0] = rgb.map((v) => v / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d context');
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, 1, 1);
      const text = lum([...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]);
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      let min = Infinity;
      for (let i = 0; i < px.length; i += 4) min = Math.min(min, ratio(text, lum([px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0])));
      return min;
    },
    { b64: png.toString('base64'), fg },
  );
}

for (const scheme of ['light', 'dark'] as const) {
  for (const desktop of ['#fff', '#000']) {
    test(`${scheme} system: the HUD's folded line reads at 4.5:1 on a ${desktop} desktop`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('stack.html#/hud?hud=three&still=1');
      await page.addStyleTag({
        content: `html,body{background:${desktop} !important}[data-hide-text],[data-hide-text] *{color:transparent !important;text-shadow:none !important}`,
      });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(scheme);
      const bar = page.locator('[data-hud-bar]');
      await expect(bar).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const targets: Array<[string, Locator]> = [
        ['title', bar.locator('[data-hud-title]')],
        ['action', bar.locator('[data-hud-act]')],
        ['count', bar.locator('[data-hud-count]')],
        ['处理', bar.getByRole('button', { name: '处理' })],
      ];
      for (const [name, target] of targets) {
        await expect(target, name).toBeVisible();
        expect(await minContrast(page, target), name).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

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
