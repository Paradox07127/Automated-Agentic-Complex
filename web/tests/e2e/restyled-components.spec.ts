import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Restyled base components checked by computed style and keyboard in a real browser.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const css = (el: Locator, prop: string, pseudo?: string) => el.evaluate((n, [p, s]) => getComputedStyle(n, s).getPropertyValue(p as string), [prop, pseudo ?? null] as const);

/** A token's resolved colour as the browser reports it. */
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  }, name);

async function openDemo(page: Page, c: string, d?: string, theme?: 'light') {
  const qs = new URLSearchParams({ c, ...(d ? { d } : {}), still: '1', ...(theme ? { theme } : {}) });
  await page.goto('about:blank');
  await page.goto(`tests/fixtures/catalog/index.html#?plugins=all&${qs.toString()}`);
  await expect(page.locator(`[data-component="${c}"]`)).toBeVisible();
}

test('Tabs: arrows, Home/End and E switch tabs and move focus; selection is the white plate with dark bold text', async ({ page }) => {
  const errors = collectErrors(page);
  await openDemo(page, 'Tabs', 'tasks');
  const tabs = page.getByRole('tab');
  const selected = page.getByRole('tab', { selected: true });
  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(selected).toHaveText('全部任务');
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(selected).toHaveText('目标');
  await expect(tabs.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(selected).toHaveText('待处理[3]');
  await page.keyboard.press('ArrowLeft');
  await expect(selected).toHaveText('目标');
  await page.keyboard.press('Home');
  await expect(selected).toHaveText('待处理[3]');
  await page.locator('body').click({ position: { x: 1200, y: 760 } });
  await page.keyboard.press('e');
  await expect(selected).toHaveText('全部任务');

  // Second-level tab: plate --ef-tab2-sel-bg, text --ef-tab2-sel-text, bold; unselected names --ef-tab2-text; Q and E caps at both ends.
  expect(await css(selected, 'background-color', '::before')).toBe(await token(page, '--ef-tab2-sel-bg'));
  expect(await css(selected, 'color')).toBe(await token(page, '--ef-tab2-sel-text'));
  expect(Number(await css(selected, 'font-weight'))).toBeGreaterThanOrEqual(600);
  expect(await css(page.getByRole('tab', { selected: false }).first(), 'color')).toBe(await token(page, '--ef-tab2-text'));
  const strip = page.getByRole('tablist');
  const caps = strip.locator('kbd');
  await expect(caps).toHaveText(['Q', 'E']);
  await expect(caps.first()).toBeVisible();
  expect((await caps.first().boundingBox())!.x).toBeLessThan((await tabs.first().boundingBox())!.x);
  expect((await caps.last().boundingBox())!.x).toBeGreaterThan((await tabs.last().boundingBox())!.x);
  expect(errors).toEqual([]);
});

test('restyled components, dark and light, for review', async ({ page }, info) => {
  const dir = fileURLToPath(new URL(`../../.shots/${info.project.name}/`, import.meta.url));
  // Tall enough that no component runs past the viewport under the sticky page header.
  await page.setViewportSize({ width: 1280, height: 2000 });
  for (const c of ['Btn', 'Tabs', 'SecHead', 'Row', 'SRow', 'Select', 'SearchField', 'Empty', 'Banner', 'ErrBar', 'Card', 'GameSeg', 'Plate', 'Paper']) {
    for (const theme of [undefined, 'light'] as const) {
      await openDemo(page, c, undefined, theme);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await saveShot(page.locator(`[data-component="${c}"]`), { path: `${dir}b1b-${c}-${theme ?? 'dark'}.png` });
    }
  }
});
