import { expect, test, type Locator, type Page } from '@playwright/test';

// Overview acceptance at the 1280×800 baseline; diag is in diag.spec.ts.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function inFirstScreen(el: Locator) {
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  expect(box, 'has a box').not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
}

test('overview-default (每日简报): the first paper card and the running rows are on the first screen', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  await inFirstScreen(page.locator('section[aria-label="待处理"] [data-stub="Paper"]'));
  const running = page.locator('section[aria-label="进行中"] [data-run]');
  expect(await running.count()).toBeGreaterThan(0);
  for (const el of await running.all()) await inFirstScreen(el);
  expect(errors).toEqual([]);
});

test('overview: the bottom action band holds 快速输入, 屏幕识读 and 命令面板, no 派发任务; ⌘N dispatches on the tasks page', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  const band = page.getByRole('toolbar', { name: '常用操作' });
  for (const name of ['快速输入', '屏幕识读', '命令面板']) await expect(band.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(band.getByRole('button', { name: /^派发任务/ })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主导航' }).locator('[data-slot="action"] button')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page).toHaveURL(/#\/tasks\?/);
  await expect(page.getByRole('form', { name: '派发任务' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('home: the 今日任务 report shows its counts whole at 1385 and 900 wide', async ({ page }) => {
  for (const [width, height] of [[1385, 770], [900, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('about:blank');
    await page.goto('main.html#/home?plugins=all&still=1');
    const report = page.getByRole('button', { name: /^今日任务/ });
    await expect(report).toBeVisible();
    // The slab's drawn layers (spans holding svg) reach past the plaque on purpose: its shadow is offset.
    expect(await report.evaluate((e) => [...e.querySelectorAll('span')].filter((s) => !s.querySelector(':scope > svg')).every((s) => s.scrollWidth <= s.clientWidth)), `${width}`).toBe(true);
  }
});

test('home: on the tilted watch every key, card and slot takes the pointer at the middle of its drawn face', async ({ page }) => {
  await page.setViewportSize({ width: 1385, height: 770 });
  await page.goto('main.html#/home?plugins=all&still=1');
  await expect(page.getByRole('button', { name: '角色', exact: true })).toBeVisible();
  const misses = await page.locator('[data-page="home"]').evaluate((home) =>
    [...home.querySelectorAll('button')].flatMap((b) => {
      // The slab's top face is its last svg; buttons without a slab (the disc's own) are checked by their box.
      const svgs = b.querySelectorAll(':scope svg[width]');
      const r = (svgs[svgs.length - 1] ?? b).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit?.closest('button') === b ? [] : [b.getAttribute('aria-label') ?? b.textContent];
    }),
  );
  expect(misses).toEqual([]);
});

test('home: a key takes the pointer near the rim of its raised face, not its neighbour', async ({ page }) => {
  for (const [width, height] of [[1385, 770], [925, 515]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('about:blank');
    await page.goto('main.html#/home?plugins=all&still=1');
    await expect(page.getByRole('button', { name: '角色', exact: true })).toBeVisible();
    const misses = await page.locator('[data-page="home"]').evaluate((home) =>
      [...home.querySelectorAll('[aria-label="主要页面"] button, [aria-label="工具"] button')].flatMap((b) => {
        const svgs = b.querySelectorAll(':scope svg[width]');
        const r = svgs[svgs.length - 1]!.getBoundingClientRect();
        return ([[0.05, 0.5], [0.95, 0.5], [0.5, 0.05], [0.5, 0.95]] as const).flatMap(([fx, fy]) =>
          document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)?.closest('button') === b ? [] : [`${b.getAttribute('aria-label')} ${fx},${fy}`],
        );
      }),
    );
    expect(misses, `${width}`).toEqual([]);
  }
});

test('home: every raised face shares the tipped watch\'s 3D space (nothing between flattens it)', async ({ page }) => {
  await page.setViewportSize({ width: 1385, height: 770 });
  await page.goto('main.html#/home?plugins=all&still=1');
  await expect(page.getByRole('button', { name: '角色', exact: true })).toBeVisible();
  // A key whose action this shell lacks is disabled; dim it as the shell would.
  const flat = await page.locator('[data-page="home"]').evaluate((home) => {
    home.querySelector('[aria-label="工具"] button')!.setAttribute('disabled', '');
    return [...home.querySelectorAll('svg[class*="_top_"]')].flatMap((face) => {
      const out: string[] = [];
      for (let e = face.parentElement; e && !/_tilt_/.test(e.className); e = e.parentElement) {
        const s = getComputedStyle(e);
        const why = [s.transformStyle !== 'preserve-3d' && 'flat', +s.opacity < 1 && 'opacity', s.filter !== 'none' && 'filter', s.overflow !== 'visible' && 'overflow'].filter(Boolean);
        if (why.length) out.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} ${why.join(',')}`);
      }
      return out;
    });
  });
  expect([...new Set(flat)]).toEqual([]);
});

test('home: once the watch has come in, no finished entrance animation stays held (a held opacity flattens the keys)', async ({ page }) => {
  await page.setViewportSize({ width: 925, height: 515 });
  await page.goto('main.html#/home?plugins=all');
  await expect(page.getByRole('button', { name: '角色', exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  const held = await page.locator('[data-hud]').evaluate((hud) =>
    hud
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'finished')
      .map((a) => ((a.effect as KeyframeEffect).target as HTMLElement).dataset.g),
  );
  expect(held).toEqual([]);
});

test('home: the tipped face turns to the pointer on the next frame and is not still easing after it', async ({ page }) => {
  await page.setViewportSize({ width: 1385, height: 770 });
  await page.goto('main.html#/home?plugins=all');
  await expect(page.getByRole('button', { name: '角色', exact: true })).toBeVisible();
  const tilt = page.locator('[data-page="home"] [class*="_tilt_"]');
  const read = () => tilt.evaluate((e) => new Promise<string>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(getComputedStyle(e).transform)))));
  const rest = await read();
  await page.mouse.move(1300, 700);
  const next = await read();
  await page.waitForTimeout(500);
  expect(next).not.toBe(rest);
  expect(next).toBe(await read());
});

test('home: with reduced motion the tipped face stays put under the pointer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1385, height: 770 });
  await page.goto('main.html#/home?plugins=all');
  await expect(page.getByRole('button', { name: '角色', exact: true })).toBeVisible();
  const tilt = page.locator('[data-page="home"] [class*="_tilt_"]');
  const rest = await tilt.evaluate((e) => getComputedStyle(e).transform);
  await page.mouse.move(1300, 700);
  await page.mouse.move(1310, 710);
  expect(await tilt.evaluate((e) => getComputedStyle(e).transform)).toBe(rest);
});

test('home: in a window wider than the pages\' 1600 the watch ground still fills it edge to edge', async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.goto('main.html#/home?plugins=all&still=1');
  const box = await page.locator('[data-page="home"]').boundingBox();
  expect(box).toMatchObject({ x: 0, width: 2000 });
});

test('overview-decided: after a decision the next item takes the card; the view has at most one primary button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&demo=decided&still=1');
  await expect(page.locator('section[aria-label="待处理"]').getByRole('status')).toContainText('已批准');
  await expect(page.locator('section[aria-label="待处理"] [data-stub="Paper"]')).toHaveCount(1);
  expect(await page.locator('main [data-stub="Btn"][data-variant="primary"]').count()).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
