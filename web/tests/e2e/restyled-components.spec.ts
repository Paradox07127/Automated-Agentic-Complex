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

test('every Btn demo: a capsule with no cut mask, 36, 32 or 24 high; the suffix slot is a round disc on lg and md', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('tests/fixtures/catalog/index.html#?');
  const demos = await page.evaluate(() => window.__EF_CATALOG__?.find((e) => e.name === 'Btn')?.demos ?? []);
  expect(demos.length).toBeGreaterThan(5);
  const heights: Record<string, number> = { lg: 36, md: 32, sm: 24 };
  for (const theme of [undefined, 'light'] as const) {
    for (const d of demos) {
      await openDemo(page, 'Btn', d, theme);
      const btn = page.locator('[data-stub="Btn"]').first();
      const mask = (await css(btn, 'mask-image')) || (await css(btn, '-webkit-mask-image'));
      expect(mask, `${d}: no cut mask`).toBe('none');
      expect(await css(btn, 'border-top-left-radius', '::before'), `${d}: pill`).toBe('999px');
      const size = (await btn.getAttribute('data-size')) ?? 'md';
      const h = (await btn.boundingBox())?.height;
      expect(h, d).toBe(heights[size]);
      if ((await btn.getAttribute('data-tail')) && size !== 'sm') {
        const slot = btn.locator(':scope > [aria-hidden="true"]').last();
        expect(await css(slot, 'display'), `${d}: suffix slot shown`).not.toBe('none');
        expect(await css(slot, 'border-top-left-radius'), `${d}: round suffix slot`).toBe('50%');
      }
    }
  }
  expect(errors).toEqual([]);
});

test('Btn: primary is the yellow capsule, ghost the light one, secondary the dark one, danger red with ink text; hover fades the wash in and danger press sinks 2.5 px', async ({ page }) => {
  const errors = collectErrors(page);
  const fills: Array<[string, string, string]> = [
    ['primary', '--ef-accent', '--ef-btn-accent-text'],
    ['ghost', '--ef-btn-light', '--ef-btn-light-text'],
    ['secondary', '--ef-btn-dark', '--ef-btn-dark-text'],
    ['danger', '--ef-danger-vivid', '--ef-on-danger-vivid'],
  ];
  for (const [d, fill, fg] of fills) {
    await openDemo(page, 'Btn', d);
    const btn = page.locator('[data-stub="Btn"]');
    expect(await css(btn, 'background-color'), d).toBe('rgba(0, 0, 0, 0)');
    expect(await css(btn, 'background-color', '::before'), d).toBe(await token(page, fill));
    expect(await css(btn, 'color'), d).toBe(await token(page, fg));
  }
  const danger = page.locator('[data-stub="Btn"]');
  expect(await css(danger, 'opacity', '::after')).toBe('0');
  const box = (await danger.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => css(danger, 'opacity', '::after')).toBe('1');
  await page.mouse.down();
  await expect.poll(() => css(danger, 'transform')).toBe('matrix(1, 0, 0, 1, 0, 2.5)');
  await page.mouse.up();
  await page.mouse.move(1270, 790);
  expect(errors).toEqual([]);
});

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

test('Row: selected is the task row (category strip + light band, dark text) with no brackets', async ({ page }) => {
  const errors = collectErrors(page);
  await openDemo(page, 'Row', 'selected');
  const row = page.locator('[data-stub="Row"]');
  expect(await css(row, 'background-color', '::before')).toBe(await token(page, '--ef-mission-row-sel'));
  expect(await css(row, 'background-image', '::before')).toContain(await token(page, '--ef-trace'));
  expect(await css(row, 'background-size', '::before')).toBe('4px 100%');
  expect(await css(row.getByText('修 HostLink 断线重连'), 'color')).toBe(await token(page, '--ef-mission-row-sel-text'));
  await expect(row).not.toContainText('[');
  expect(await css(row, 'box-shadow')).toBe('none');
  expect(errors).toEqual([]);
});

test('Select is a light pill caption; open, a grey plate holds the list and the chosen row is dark', async ({ page }) => {
  const errors = collectErrors(page);
  await openDemo(page, 'Select', 'closed');
  const head = page.getByRole('button', { name: '主动程度' });
  expect(await css(head, 'background-color')).toBe(await token(page, '--ef-dropdown-field'));
  expect(await css(head, 'color')).toBe(await token(page, '--ef-dropdown-text'));
  expect(await css(head, 'border-top-left-radius')).toBe('14px');
  await openDemo(page, 'Select', 'open');
  expect(await css(page.getByRole('listbox'), 'background-color')).toBe(await token(page, '--ef-dropdown-list'));
  const chosen = page.getByRole('option', { selected: true });
  expect(await css(chosen, 'background-color')).toBe(await token(page, '--ef-dropdown-sel'));
  expect(await css(chosen, 'color')).toBe(await token(page, '--ef-dropdown-sel-text'));
  expect(errors).toEqual([]);
});

test('SearchField is a square panel field with a 1 px rule border and a 2 px trace bottom line on focus', async ({ page }) => {
  const errors = collectErrors(page);
  await openDemo(page, 'SearchField', 'filled');
  const raised = await token(page, '--ef-raised');
  const rule = await token(page, '--ef-rule');
  const trace = await token(page, '--ef-trace');
  const field = page.locator('[data-stub="SearchField"]');
  expect(await css(field, 'background-color')).toBe(raised);
  expect(await css(field, 'border-top-color')).toBe(rule);
  expect(await css(field, 'border-top-left-radius')).toBe('0px');
  await field.locator('input').focus();
  expect(await css(field, 'border-bottom-width')).toBe('2px');
  expect(await css(field, 'border-bottom-color')).toBe(trace);
  expect(errors).toEqual([]);
});

test('SRow: description is one line, the settings page plate with its left stripes', async ({ page }) => {
  const errors = collectErrors(page);
  await openDemo(page, 'SRow', 'toggle');
  const row = page.locator('[data-stub="SRow"]');
  expect(await css(row, 'content', '::before')).not.toBe('none');
  const desc = row.locator('[id$="-desc"]');
  const lh = parseFloat(await css(desc, 'line-height'));
  expect((await desc.boundingBox())?.height).toBeLessThanOrEqual(lh);
  expect(errors).toEqual([]);
});

test('settings danger confirm is the white paper card: opaque, red-striped, centred, at most 560 wide, footer inside the card', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/settings?plugins=all&group=privacy&still=1');
  await page.getByRole('switch', { name: '窗口文字', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-danger', 'true');
  expect(await css(dialog, 'background-image')).toMatch(/^linear-gradient/);
  expect(await css(dialog, 'background-color')).not.toMatch(/rgba\(.*,\s*0?\.\d+\)$/);
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(560);
  const vw = page.viewportSize()!;
  const scrim = (await page.locator('[data-stub="SettingsConfirm"]').boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (scrim.x + scrim.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - (scrim.y + scrim.height / 2))).toBeLessThanOrEqual(1);
  expect(scrim.width).toBeLessThanOrEqual(vw.width);
  for (const b of await dialog.getByRole('button').all()) {
    const r = (await b.boundingBox())!;
    expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height);
  }
  await expect(dialog).not.toContainText('//');
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
