import { expect, test } from '@playwright/test';

// 动作 → 图 draws with Cytoscape's canvas renderer. Leaving 角色 must free its layers and buffers at once: Chromium frees a
// detached canvas only at GC, and a few visits would pass the window's memory limit.
test('leaving 角色 frees the motion graph canvases', async ({ page }) => {
  await page.addInitScript(() => {
    // Strong references, so GC cannot free a canvas the page left holding pixels.
    const made: HTMLCanvasElement[] = [];
    (window as unknown as { __canvases: HTMLCanvasElement[] }).__canvases = made;
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
      const el = create.call(this, tag, options);
      if (tag.toLowerCase() === 'canvas') made.push(el as HTMLCanvasElement);
      return el;
    } as typeof Document.prototype.createElement;
  });
  await page.goto('main.html#/character?pane=chain');
  await expect(page.locator('main canvas').first()).toBeAttached();
  await page.goto('main.html#/overview');
  await expect(page.locator('main canvas')).toHaveCount(0);
  const held = await page.evaluate(() =>
    (window as unknown as { __canvases: HTMLCanvasElement[] }).__canvases
      // Cytoscape's text-measuring canvas stays at the 300×150 default.
      .filter((c) => !c.isConnected && c.width * c.height > 300 * 150)
      .map((c) => `${c.getAttribute('data-id') ?? '-'} ${c.width}×${c.height}`),
  );
  expect(held).toEqual([]);
});
