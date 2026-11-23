import { expect, test, type Locator, type Page } from '@playwright/test';

// ui/game press feedback (CharInfo ANIM §1): each control's rest / hover / pressed state read from computed style, the release replaying
// the hover clip, no movement on press anywhere, and `still` switching states without timing.

const MOTION = 'main.html#/character?demo=ok&pane=motion';

test.use({ viewport: { width: 1440, height: 900 } });

/** The click still reaches the element, but not React: pressing a control here does not change the page under the test. */
async function quiet(loc: Locator) {
  await loc.evaluate((el) => el.addEventListener('click', (e) => e.stopPropagation()));
}

/** Every transform-ish value under el (itself included). */
const moves = (loc: Locator) =>
  loc.evaluate((el) =>
    [el, ...el.querySelectorAll('*')]
      .map((e) => {
        const s = getComputedStyle(e);
        return `${s.transform}|${s.translate}|${s.scale}`;
      })
      .join(';'),
  );

const num = (loc: Locator, read: (el: Element) => string) => loc.evaluate(read).then(Number);
/** `rgb(a)(r, g, b[, a])`, `color(srgb r g b[ / a])` or `oklab(L a b[ / a])` as sRGB [r, g, b, a] in 0–1. */
function srgb(css: string): number[] {
  const rgb = /^rgba?\(([^)]*)\)$/.exec(css);
  const fn = /^(color\(srgb|oklab\() ?([^)/]*)(?:\/([^)]*))?\)$/.exec(css);
  if (rgb) {
    const [r = NaN, g = NaN, b = NaN, a = 1] = rgb[1]!.split(',').map(Number);
    return [r / 255, g / 255, b / 255, a];
  }
  if (!fn) throw new Error(`not an sRGB or Oklab colour: ${css}`);
  const [x = NaN, y = NaN, z = NaN] = fn[2]!.trim().split(/\s+/).map(Number);
  const alpha = fn[3] ? Number(fn[3]) : 1;
  if (fn[1] === 'color(srgb') return [x, y, z, alpha];
  // Oklab to linear sRGB (Ottosson's matrices), then the sRGB transfer curve.
  const l = (x + 0.3963377774 * y + 0.2158037573 * z) ** 3;
  const m = (x - 0.1055613458 * y - 0.0638541728 * z) ** 3;
  const s = (x - 0.0894841775 * y - 1.291485548 * z) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return [...lin.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)), alpha];
}
/** Names of the CSS animations running on el (pseudo-elements included), as one string: CSS modules hash the keyframe names. */
const running = (loc: Locator) =>
  loc.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running')
      .map((a) => (a as CSSAnimation).animationName ?? '')
      .join(' '),
  );

/** Scales the page's animation clock (CDP), so a check right after release still sees the clip it restarted. */
async function rate(page: Page, playbackRate: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate });
}

/** Lets go with the clock at a tenth of its speed; `rate(page, 1)` puts it back. */
async function release(page: Page) {
  await rate(page, 0.1);
  await page.mouse.up();
}

/** Hover, hold the button, release with the pointer still inside. */
async function down(page: Page, loc: Locator) {
  await loc.hover();
  await page.mouse.down();
}

test('RailCell: hover widens the plate leftwards and lights it; press pulls it back; release replays the hover clip', async ({ page }) => {
  await page.goto(MOTION);
  const cell = page.locator('[data-stub="RailCell"]:not([aria-current])').first();
  await quiet(cell);
  const plate = cell.locator(':scope > span').nth(0);
  const light = cell.locator(':scope > span').nth(1);
  const grow = () => cell.evaluate((el) => {
    const c = el.getBoundingClientRect();
    const p = el.children[0]!.getBoundingClientRect();
    return Math.round(((p.width - c.width) / c.width) * 1000) / 1000;
  });
  const rightEdge = () => cell.evaluate((el) => Math.round(el.getBoundingClientRect().right - el.children[0]!.getBoundingClientRect().right));
  const lit = () => num(light, (el) => getComputedStyle(el).opacity);
  const rest = await moves(cell);
  expect(await grow()).toBe(0);
  expect(await lit()).toBe(0);

  await cell.hover();
  await expect.poll(grow).toBeCloseTo(0.118, 2);
  await expect.poll(lit).toBeCloseTo(0.239, 2);
  expect(await rightEdge()).toBe(0);
  await expect.poll(() => running(plate)).toBe('');

  await page.mouse.down();
  await expect.poll(grow).toBe(0);
  await expect.poll(lit).toBe(0);
  expect(await moves(cell)).toBe(rest);

  await release(page);
  expect(await running(plate)).toContain('rc-hover');
  await rate(page, 1);
  await expect.poll(grow).toBeCloseTo(0.118, 2);

  await page.mouse.move(0, 0);
  await expect.poll(grow).toBe(0);
});

test('GameTabs: a 100 ms light overlay, white .502 on hover and #444 .502 while pressed', async ({ page }) => {
  await page.goto(MOTION);
  const tab = page.getByRole('tablist', { name: '角色页签' }).getByRole('tab', { selected: false }).first();
  await quiet(tab);
  const light = () => tab.evaluate((el) => {
    const s = getComputedStyle(el, '::before');
    return `${s.backgroundColor} ${s.opacity}`;
  });
  const rest = await moves(tab);
  expect(await light()).toMatch(/ 0$/);
  await tab.hover();
  await expect.poll(light).toBe('rgb(255, 255, 255) 0.502');
  await page.mouse.down();
  await expect.poll(light).toBe('rgb(68, 68, 68) 0.502');
  expect(await moves(tab)).toBe(rest);
  await page.mouse.up();
  await expect.poll(light).toBe('rgb(255, 255, 255) 0.502');
});

test('WhiteCapsule: one background tint per state and no movement on press', async ({ page }) => {
  await page.goto(MOTION);
  const cap = page.locator('[data-stub="WhiteCapsule"]:not(:disabled)').first();
  await quiet(cap);
  const bg = () => cap.evaluate((el) => getComputedStyle(el).backgroundColor);
  const rest = await moves(cap);
  expect(await bg()).toBe('rgba(255, 255, 255, 0.85)');
  await cap.hover();
  await expect.poll(bg).toBe('rgba(255, 255, 255, 0.93)');
  await page.mouse.down();
  await expect.poll(bg).toBe('rgb(255, 255, 255)');
  expect(await moves(cap)).toBe(rest);
  await page.mouse.up();
  await expect.poll(bg).toBe('rgba(255, 255, 255, 0.93)');
});

test('YellowKey: the face dims to .6 on hover and .478 while pressed, flashes back to 1 on release and re-dims', async ({ page }) => {
  await page.goto(MOTION);
  const key = page.locator('[data-stub="YellowKey"]:not(:disabled)').first();
  await quiet(key);
  const mul = () => num(key, (el) => getComputedStyle(el).getPropertyValue('--yk-mul'));
  const face = () => key.evaluate((el) => getComputedStyle(el.firstElementChild!).backgroundImage);
  const rest = await moves(key);
  const restFace = await face();
  expect(await mul()).toBe(1);
  await key.hover();
  await expect.poll(mul).toBeCloseTo(0.6, 3);
  expect(await face()).not.toBe(restFace);
  await page.mouse.down();
  await expect.poll(mul).toBeCloseTo(0.478, 3);
  expect(await moves(key)).toBe(rest);
  await release(page);
  expect(await running(key)).toContain('yk-hover');
  await rate(page, 1);
  await expect.poll(mul).toBeCloseTo(0.6, 3);
  await page.mouse.move(0, 0);
  await expect.poll(mul).toBe(1);
});

test('GameSeg: the white SelectedLight overlay, .298 × .25 on hover and .298 × .1 at rgb .651 while pressed', async ({ page }) => {
  await page.goto(MOTION);
  const opt = page.locator('[data-stub="GameSeg"]:not([aria-disabled]) [role="radio"]:not(:disabled)').first();
  await quiet(opt);
  const track = opt.locator('xpath=..');
  const light = () => track.evaluate((el) => {
    const s = getComputedStyle(el, '::after');
    return `${s.backgroundColor} ${Math.round(Number(s.opacity) * 10000) / 10000}`;
  });
  const rest = await moves(track);
  expect(await light()).toMatch(/ 0$/);
  await opt.hover();
  await expect.poll(light).toBe('rgb(255, 255, 255) 0.0745');
  await page.mouse.down();
  await expect.poll(light).toBe('rgb(166, 166, 166) 0.0298');
  expect(await moves(track)).toBe(rest);
  await release(page);
  expect(await running(track)).toContain('gs-hover');
  await rate(page, 1);
  await expect.poll(light).toBe('rgb(255, 255, 255) 0.0745');
});

test('DarkRow: the row plate lightens on hover and once more while pressed', async ({ page }) => {
  await page.goto(MOTION);
  const row = page.locator('[data-stub="DarkRow"]:not([data-selected]):has(> button)').first();
  const hit = row.locator(':scope > button').last();
  await quiet(hit);
  // The plate is mixed in CSS, so the computed value may come back as color(srgb …) or oklab(…) rather than rgba(…).
  const off = (want: string) => async () => {
    const got = srgb(await row.evaluate((el) => getComputedStyle(el).backgroundColor));
    return Math.max(...srgb(want).map((v, i) => Math.abs(v - (got[i] ?? NaN))));
  };
  const rest = await moves(row);
  expect(await off('rgba(70, 70, 70, 0.88)')()).toBeLessThanOrEqual(1 / 255);
  await hit.hover();
  await expect.poll(off('rgba(84, 84, 84, 0.92)')).toBeLessThanOrEqual(1 / 255);
  await page.mouse.down();
  await expect.poll(off('rgba(96, 96, 96, 0.94)')).toBeLessThanOrEqual(1 / 255);
  expect(await moves(row)).toBe(rest);
  await page.mouse.up();
  await expect.poll(off('rgba(84, 84, 84, 0.92)')).toBeLessThanOrEqual(1 / 255);
});

test('Stepper: the arrow cells take the ColorTint light of the game\'s small buttons', async ({ page }) => {
  await page.goto('main.html#/character?tab=behavior');
  const ar = page.locator('[data-stub="Stepper"] button[aria-label$="个"]:not(:disabled)').first();
  await quiet(ar);
  const light = () => ar.evaluate((el) => {
    const s = getComputedStyle(el, '::before');
    return `${s.backgroundColor} ${s.opacity}`;
  });
  const rest = await moves(ar);
  expect(await light()).toMatch(/ 0$/);
  await down(page, ar);
  await expect.poll(light).toBe('rgb(68, 68, 68) 0.502');
  expect(await moves(ar)).toBe(rest);
  await page.mouse.up();
  await expect.poll(light).toBe('rgb(255, 255, 255) 0.502');
});

test('keyboard: Space held on a focused key shows the press; focus keeps a visible mark', async ({ page }) => {
  await page.goto(MOTION);
  const key = page.locator('[data-stub="YellowKey"]:not(:disabled)').first();
  await quiet(key);
  await key.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(key).toBeFocused();
  expect(await key.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.down('Space');
  await expect.poll(() => num(key, (el) => getComputedStyle(el).getPropertyValue('--yk-mul'))).toBeCloseTo(0.478, 3);
  await page.keyboard.up('Space');
  await expect.poll(() => num(key, (el) => getComputedStyle(el).getPropertyValue('--yk-mul'))).toBe(1);
});

test('still: states switch at once, with no clip running', async ({ page }) => {
  await page.goto(`${MOTION}&still=1`);
  const cell = page.locator('[data-stub="RailCell"]:not([aria-current])').first();
  await quiet(cell);
  await cell.hover();
  const now = await cell.evaluate((el) => ({
    grow: Math.round(((el.children[0]!.getBoundingClientRect().width - el.getBoundingClientRect().width) / el.getBoundingClientRect().width) * 1000) / 1000,
    anims: el.getAnimations({ subtree: true }).length,
  }));
  expect(now).toEqual({ grow: 0.118, anims: 0 });
  const key = page.locator('[data-stub="YellowKey"]:not(:disabled)').first();
  await key.hover();
  expect(await key.evaluate((el) => [getComputedStyle(el).getPropertyValue('--yk-mul'), el.getAnimations().length])).toEqual(['0.6', 0]);
});
