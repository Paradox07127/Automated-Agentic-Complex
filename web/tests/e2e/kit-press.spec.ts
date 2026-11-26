import { expect, test, type Locator } from '@playwright/test';

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
