import { expect, test, type Page } from '@playwright/test';

// 雷霆大字 (`stack.html#/title`): the game's map_toast_inout timeline, read at set points of the page's animations.

test.use({ viewport: { width: 1920, height: 1080 } });

async function open(page: Page, params: Record<string, string>) {
  await page.goto('about:blank');
  await page.goto(`stack.html#/title?${new URLSearchParams(params).toString()}`);
  await expect(page.locator('[data-slot="name"]')).toHaveText(params.name!);
}

/** The block's opacity and vertical offset in px with every animation held at `ms`. */
async function at(page: Page, ms: number): Promise<{ opacity: number; y: number }> {
  return page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
    const s = getComputedStyle(document.querySelector('[data-slot="block"]')!);
    return { opacity: Number(s.opacity), y: s.transform === 'none' ? 0 : new DOMMatrix(s.transform).m42 };
  }, ms);
}

test('invisible before 167 ms, fully shown and settled at 1200 ms, gone after 5333 ms', async ({ page }) => {
  await open(page, { name: '佩丽卡', en: 'Perlica' });
  for (const ms of [0, 100, 160]) {
    const s = await at(page, ms);
    expect(s.opacity, `${ms} ms`).toBe(0);
    // 40 game px at 1080: the block starts above its place.
    expect(s.y, `${ms} ms`).toBeCloseTo(-40, 0);
  }
  const fading = await at(page, 400);
  expect(fading.opacity).toBeGreaterThan(0);
  expect(fading.opacity).toBeLessThan(1);
  expect(fading.y).toBeGreaterThan(-40);
  expect(fading.y).toBeLessThan(0);
  for (const ms of [1200, 3000, 4990]) expect(await at(page, ms), `${ms} ms`).toEqual({ opacity: 1, y: 0 });
  const leaving = await at(page, 5200);
  expect(leaving.opacity).toBeGreaterThan(0);
  expect(leaving.opacity).toBeLessThan(1);
  expect(leaving.y).toBe(0);
  for (const ms of [5334, 6000]) expect((await at(page, ms)).opacity, `${ms} ms`).toBe(0);
});

test('with reduced motion it only fades', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, { name: '佩丽卡' });
  expect(await at(page, 100)).toEqual({ opacity: 0, y: 0 });
  const fading = await at(page, 400);
  expect(fading.y).toBe(0);
  expect(fading.opacity).toBeGreaterThan(0);
  expect(await at(page, 1200)).toEqual({ opacity: 1, y: 0 });
  expect((await at(page, 5334)).opacity).toBe(0);
});

test('the name sits in the middle of the screen at 5.9 % of its height, the band centred on the text', async ({ page }) => {
  await open(page, { name: '佩丽卡', en: 'Perlica' });
  await at(page, 1200);
  const box = (sel: string) => page.locator(sel).first().boundingBox();
  const block = (await box('[data-slot="block"]'))!;
  expect(block.y + block.height / 2).toBeCloseTo(540, 0);
  const name = page.locator('[data-slot="name"]');
  expect(Number.parseFloat(await name.evaluate((el) => getComputedStyle(el).fontSize))).toBeCloseTo(63.7, 0);
  const band = (await box('[data-slot="band"]'))!;
  expect(band.width).toBe(1920);
  expect(band.height).toBeCloseTo(500, 0);
  expect(band.y + band.height / 2).toBeCloseTo(block.y + block.height / 2, 0);
  await expect(page.locator('[data-slot="sub"]')).toHaveText('Perlica');
});
