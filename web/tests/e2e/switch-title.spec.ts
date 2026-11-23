import { expect, test, type Page } from '@playwright/test';

// 雷霆大字 (`stack.html#/title`): her name in the white big text layout, shown still in the middle of the screen.

test.use({ viewport: { width: 1920, height: 1080 } });

async function open(page: Page, params: Record<string, string>) {
  await page.goto('about:blank');
  await page.goto(`stack.html#/title?${new URLSearchParams(params).toString()}`);
  await expect(page.locator('[data-slot="name"]')).toHaveText(params.name!);
}

/** The ink box of the white pixels in a shot of the page, in CSS px. */
async function ink(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const png = await page.screenshot({ omitBackground: true });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), k = c.getContext('2d')!;
    k.drawImage(img, 0, 0);
    const d = k.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (d[o + 3]! > 200 && d[o]! > 200) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }, png.toString('base64'));
}

test('the name is Source Han Sans Bold at 24.72 % of the screen height, its ink in the middle of the screen', async ({ page }) => {
  await open(page, { name: '佩丽卡' });
  const name = page.locator('[data-slot="name"]');
  const style = await name.evaluate((el) => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight, family: getComputedStyle(el).fontFamily }));
  expect(Number.parseFloat(style.size)).toBeCloseTo(267, 0);
  expect(style.weight).toBe('700');
  expect(style.family.startsWith('"HarmonyOS Sans SC"')).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('700 100px "HarmonyOS Sans SC"', '佩'))).toBe(true);
  const box = await ink(page);
  // Ink about 0.92 of the font size tall, centred on the screen within a few px.
  expect(box.h).toBeGreaterThan(230);
  expect(box.h).toBeLessThan(260);
  expect(box.x + box.w / 2).toBeCloseTo(960, -1);
  expect(box.y + box.h / 2).toBeCloseTo(540, -1);
  // Three glyphs about 0.92 em wide with the generator's gap of 0.469 % of 1920 px between their ink.
  expect(box.w).toBeGreaterThan(3 * 0.88 * 267 + 2 * 9);
  expect(box.w).toBeLessThan(3 * 0.97 * 267 + 2 * 9);
});

test('the English name runs under the name in HarmonyOS Sans SC caps at 2.5 % of the screen height, fading downwards', async ({ page }) => {
  await open(page, { name: '佩丽卡', en: 'Perlica' });
  const sub = page.locator('[data-slot="sub"]');
  await expect(sub).toHaveText('Perlica');
  const s = await sub.evaluate((el) => ({ size: getComputedStyle(el).fontSize, transform: getComputedStyle(el).textTransform, mask: getComputedStyle(el).maskImage }));
  expect(Number.parseFloat(s.size)).toBeCloseTo(27, 0);
  expect(s.transform).toBe('uppercase');
  expect(s.mask).toContain('linear-gradient');
  const name = (await page.locator('[data-slot="name"]').boundingBox())!, under = (await sub.boundingBox())!;
  expect(under.y).toBeGreaterThan(name.y + name.height - 10);
});

test('a soft ellipse 1.2 times the text wide sits under it, a fifth of its height lower', async ({ page }) => {
  await open(page, { name: '佩丽卡', en: 'Perlica' });
  const block = (await page.locator('[data-slot="block"]').boundingBox())!;
  const shadow = (await page.locator('[data-slot="shadow"]').boundingBox())!;
  expect(shadow.width).toBeCloseTo(block.width * 1.2, 0);
  expect(shadow.height).toBeCloseTo(block.height, 0);
  expect(shadow.y - block.y).toBeCloseTo(block.height * 0.2, 0);
});

test('shot: 佩丽卡 at rest', async ({ page }) => {
  await open(page, { name: '佩丽卡', en: 'Perlica' });
  await page.evaluate(() => (document.body.style.background = 'linear-gradient(#5f7487, #98a8b3 55%, #6c7769 55%, #414d43)'));
  await page.screenshot({ path: test.info().outputPath('title-rest.png') });
});
