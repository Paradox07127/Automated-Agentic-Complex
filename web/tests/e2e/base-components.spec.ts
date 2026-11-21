import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// The new base components behave in WebKit; each demo opens from #/ds?c=<Name>&d=<demo>.

const open = async (page: Page, c: string, d: string, extra = '') => {
  await page.goto('about:blank');
  await page.goto(`main.html#/ds?c=${c}&d=${d}&still=1${extra}`);
  await expect(page.locator(`[data-demo="${c}-${d}"]`)).toBeVisible();
};

test('Dialog: solid panel, focus starts in the body and Tab never leaves it', async ({ page }) => {
  await open(page, 'Dialog', 'create');
  const dialog = page.getByRole('dialog', { name: '派发任务' });
  await expect(page.getByRole('textbox').first()).toBeFocused();
  const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toMatch(/^rgb\(/);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
});

test('Dialog: a long body scrolls while the footer stays on screen', async ({ page }) => {
  await open(page, 'Dialog', 'long');
  const dialog = page.getByRole('dialog');
  const body = dialog.locator('[data-part="body"]');
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const foot = await dialog.locator('[data-part="foot"]').boundingBox();
  const box = await dialog.boundingBox();
  expect(foot && box && foot.y + foot.height <= box.y + box.height + 0.5).toBe(true);
  expect(box?.width).toBe(560);
});

test('Sheet: 360 and 480 wide, pinned to the right edge', async ({ page }) => {
  for (const [d, w] of [
    ['narrow', 360],
    ['wide', 480],
  ] as const) {
    await open(page, 'Sheet', d);
    const sheet = page.getByRole('dialog');
    const stage = await page.locator(`[data-demo="Sheet-${d}"] [data-stub="Sheet"]`).boundingBox();
    const box = await sheet.boundingBox();
    expect(box?.width).toBe(w);
    expect(Math.round((box?.x ?? 0) + w)).toBe(Math.round((stage?.x ?? 0) + (stage?.width ?? 0)));
  }
});

test('Switch: Space and Enter each flip it exactly once', async ({ page }) => {
  await open(page, 'Switch', 'off');
  const sw = page.getByRole('switch', { name: '窗口文字' });
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // Switch: pill track, dark knob (--ef-toggle-knob) over 开 (left) when on, over 关 (right) when off.
  const knob = sw.locator('[data-part="knob"]');
  const look = await sw.evaluate((el) => {
    const probe = document.createElement('i');
    probe.style.background = 'var(--ef-toggle-knob)';
    el.after(probe);
    const tone = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const k = el.querySelector('[data-part="knob"]')!;
    return { knob: getComputedStyle(k).backgroundColor, radius: parseFloat(getComputedStyle(k).borderTopLeftRadius), tone };
  });
  expect(look.knob).toBe(look.tone);
  expect(look.radius).toBeGreaterThanOrEqual(10);
  const edge = async (side: 'left' | 'right') => {
    const k = (await knob.boundingBox())!;
    const s = (await sw.boundingBox())!;
    return Math.round(side === 'left' ? k.x - s.x : s.x + s.width - (k.x + k.width));
  };
  await expect.poll(() => edge('left')).toBe(0);
  await page.keyboard.press('Enter');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => edge('right')).toBe(0);
});

test('Table: ↑↓ move the selection, the header sticks and number cells are tnum right-aligned', async ({ page }) => {
  await open(page, 'Table', 'sticky');
  const grid = page.getByRole('grid', { name: '运行记录' });
  const rows = grid.locator('tbody tr');
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');

  const wrap = page.locator('[data-demo="Table-sticky"] [data-stub="Table"]');
  await wrap.evaluate((el) => {
    el.scrollTop = 120;
  });
  const head = await grid.getByRole('columnheader', { name: '任务' }).boundingBox();
  const top = await wrap.boundingBox();
  expect(Math.round(head?.y ?? -1)).toBe(Math.round(top?.y ?? -2));

  const num = grid.locator('tbody td[data-num]').first();
  const style = await num.evaluate((el) => ({ align: getComputedStyle(el).textAlign, nums: getComputedStyle(el).fontVariantNumeric }));
  expect(style).toEqual({ align: 'right', nums: 'tabular-nums' });
});

test('FilterChips: Tab in, ←→ move, Space picks', async ({ page }) => {
  await open(page, 'FilterChips', 'single');
  const group = page.getByRole('group', { name: '按状态筛选' });
  await group.getByRole('button').first().focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('button', { name: /^失败/ })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(group.getByRole('button', { name: /^待处理/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(group.getByRole('button', { name: /^失败/ })).toHaveAttribute('aria-pressed', 'true');
});

test('InfoTip: keyboard focus shows the tip, Esc hides it', async ({ page }) => {
  await open(page, 'InfoTip', 'closed');
  const btn = page.getByRole('button', { name: '说明' });
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeHidden();
  await btn.focus();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});

test('light-theme screenshots for review', async ({ page }, info) => {
  const dir = fileURLToPath(new URL(`../../.shots/${info.project.name}/`, import.meta.url));
  for (const [c, d] of [
    ['Dialog', 'create'],
    ['Sheet', 'narrow'],
    ['Table', 'runs'],
    ['FilterChips', 'single'],
    ['Switch', 'on'],
    ['InfoTip', 'open'],
    ['KV', 'run'],
  ] as const) {
    await open(page, c, d, '&theme=light');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await saveShot(page, { path: `${dir}base-components-${c}-${d}-light.png` });
  }
});
