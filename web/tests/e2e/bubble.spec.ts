import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { DESKTOP_DEMOS } from '../../src/surfaces/desktop/demos.ts';

// The thought bubble beside her head (`stack.html#/bubble`) in every preset: nothing runs out sideways, no text
// under 13 px, and the bubble stays within 300 px.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));
const BUBBLE = DESKTOP_DEMOS.filter((d) => d.path === '/bubble');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, params: Record<string, string>) {
  await page.goto('about:blank');
  await page.goto(`stack.html#/bubble?${new URLSearchParams({ ...params, still: '1' }).toString()}`);
}

/** Visible text under 13 px, and elements that stick out of the bubble card or subtitle sideways. */
function layoutFaults(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-surface-root="bubble"]');
    const faults: string[] = [];
    if (!root) return ['no root'];
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (own && size < 13) faults.push(`${size}px: ${el.textContent}`);
    }
    for (const box of root.querySelectorAll<HTMLElement>('[data-bubble], [data-subtitle]')) {
      const edge = box.getBoundingClientRect();
      for (const el of box.querySelectorAll<HTMLElement>('*')) {
        if (el.closest('[aria-hidden="true"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.left < edge.left - 0.5 || r.right > edge.right + 0.5)) faults.push(`overflow: ${el.tagName} ${el.className}`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0) faults.push(`spills: ${el.tagName} ${el.className}`);
      }
    }
    return faults;
  });
}

for (const theme of ['dark', 'light'] as const) {
  for (const demo of BUBBLE) {
    test(`${theme} ${demo.name}: fits 364 px with nothing under 13 px`, async ({ page }, info) => {
      const errors = collectErrors(page);
      await open(page, { ...demo.params, theme });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      const card = page.locator('[data-bubble]');
      if (demo.params.demo === 'hidden') {
        await expect(page.locator('[data-subtitle]')).toBeVisible();
        await expect(card).toHaveCount(0);
      } else {
        await expect(card).toBeVisible();
        await expect(page.locator('[data-bubble-doing]')).toContainText('在跑 swift test');
        if (demo.params.demo === 'speech') await expect(card.getByRole('status')).toContainText('构建失败');
        else if (demo.params.demo === 'reminder') await expect(card.getByRole('button', { name: '知道了' })).toBeVisible();
        else await expect(card).toContainText('测试又红了');
        if (demo.params.mode === 'input') await expect(card.getByRole('dialog', { name: '快速输入' })).toBeVisible();
        expect((await card.boundingBox())?.width ?? 999).toBeLessThanOrEqual(364);
      }
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await layoutFaults(page)).toEqual([]);
      await saveShot(page, { path: `${shotsDir}${info.project.name}/bubble-${theme}-${demo.name}.png`, omitBackground: true });
      expect(errors).toEqual([]);
    });
  }
}

for (const [theme, text] of [['dark', 'rgb(237, 237, 237)'], ['light', 'rgb(22, 22, 22)']] as const) {
  test(`${theme} 快速输入: the input takes the bubble's theme and its keycaps stay inside the band`, async ({ page }) => {
    await open(page, { mode: 'input', theme });
    const dialog = page.locator('[data-bubble]').getByRole('dialog', { name: '快速输入' });
    await expect(dialog).toBeVisible();
    expect(await dialog.getByRole('textbox').evaluate((el) => getComputedStyle(el).color)).toBe(text);
    const out = await dialog.evaluate((box) => {
      const band = box.closest('[data-bubble]')?.querySelector<HTMLElement>(':scope > div')?.getBoundingClientRect();
      const caps = [...box.querySelectorAll<HTMLElement>(':scope > [aria-hidden="true"] > span')].map((c) => c.getBoundingClientRect());
      if (!band || caps.length !== 2) return ['no band or caps'];
      return caps.filter((c) => c.left < band.left - 0.5 || c.right > band.right + 0.5).map((c) => `${c.left}..${c.right} outside ${band.left}..${band.right}`);
    });
    expect(out).toEqual([]);
  });
}

test('reply and disclosure are available without hover; reply quotes the thought', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, {});
  const card = page.locator('[data-bubble]');
  await expect(card.getByRole('button', { name: '回复', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '更多操作' }).click();
  for (const name of ['复制', '关闭此类']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '回复', exact: true }).click();
  await expect(card.getByRole('dialog', { name: '快速输入' })).toBeVisible();
  await expect(card).toContainText('引用：测试又红了');
  await card.getByRole('textbox').press('Escape');
  await expect(card.getByRole('dialog', { name: '快速输入' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the tail leaves the card edge toward her head', async ({ page }) => {
  await open(page, {});
  await expect(page.locator('[data-bubble]')).toHaveAttribute('data-tail', 'right');
  await open(page, { demo: 'noroom' });
  await expect(page.locator('[data-bubble]')).toHaveAttribute('data-tail', 'left');
});

test('a long offer button stays inside the band and shows its whole text without cutting', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { demo: 'offer' });
  const card = page.locator('[data-bubble]');
  const offer = card.getByRole('button', { name: '要我等门禁和候选库通过后，接着构建替换测试包吗？' });
  await expect(offer).toBeVisible();
  const metrics = await offer.evaluate((btn) => {
    const band = btn.closest('[data-bubble]')?.querySelector<HTMLElement>(':scope > div');
    const bRect = btn.getBoundingClientRect();
    const bandRect = band?.getBoundingClientRect();
    const label = btn.querySelector<HTMLElement>('span');
    return {
      btnRight: bRect.right,
      bandRight: bandRect?.right ?? 0,
      scrollWidth: btn.scrollWidth,
      clientWidth: btn.clientWidth,
      labelScrollWidth: label?.scrollWidth ?? 0,
      labelClientWidth: label?.clientWidth ?? 0,
    };
  });
  expect(metrics.btnRight).toBeLessThanOrEqual(metrics.bandRight + 0.5);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.labelScrollWidth).toBeLessThanOrEqual(metrics.labelClientWidth);
  expect(await layoutFaults(page)).toEqual([]);
  expect(errors).toEqual([]);
});
