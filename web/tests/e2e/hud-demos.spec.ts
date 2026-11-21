import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { DESKTOP_DEMOS } from '../../src/surfaces/desktop/demos.ts';

// The status bar and icon ring demos, dark and light: no horizontal overflow, text ≥ 13 px,
// the task-track band 359 px folded and expanded, the ring panel at its fixed size.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));
const DEMOS = DESKTOP_DEMOS.filter((d) => d.path === '/hud' || d.path === '/ring');

async function open(page: Page, path: string, params: Record<string, string>) {
  await page.goto('about:blank');
  await page.goto(`stack.html#${path}?${new URLSearchParams({ ...params, still: '1' }).toString()}`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Visible text drawn under 13 px, outside aria-hidden decoration. */
function smallText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hits: string[] = [];
    for (const el of document.querySelectorAll('[data-surface-root] *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
      if (!own || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 13) hits.push(`${el.tagName.toLowerCase()} ${size}px "${(el.textContent ?? '').trim().slice(0, 20)}"`);
    }
    return hits;
  });
}

/** Boxes that stick out of `container`, and (`scroll`) those whose content runs wider than the box. */
function overflow(page: Page, container: string, boxes: string, scroll = true): Promise<string[]> {
  return page.evaluate(
    ([container, boxes, scroll]) => {
      const hits: string[] = [];
      const outer = document.querySelector(container)?.getBoundingClientRect();
      if (!outer) return [`no ${container}`];
      for (const el of document.querySelectorAll<HTMLElement>(boxes)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 1) continue;
        if (scroll && el.scrollWidth > el.clientWidth + 1) hits.push(`scroll ${el.className} ${el.scrollWidth}>${el.clientWidth}`);
        if (r.left < outer.left - 0.5 || r.right > outer.right + 0.5) hits.push(`out ${el.className} ${r.left}–${r.right} of ${outer.left}–${outer.right}`);
      }
      return hits;
    },
    [container, boxes, scroll] as const,
  );
}

for (const theme of ['dark', 'light'] as const) {
  for (const demo of DEMOS) {
    test(`${theme} ${demo.name}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await open(page, demo.path, { ...demo.params, theme });
      const root = page.locator(`[data-surface-root="${demo.path.slice(1)}"]`);
      await expect(root).toBeAttached();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

      if (demo.path === '/hud') {
        const expanded = demo.params.expand === '1';
        await expect(page.locator('[data-hud-row]').first()).toBeVisible();
        if (expanded) {
          await expect(page.locator('[data-hud-row]')).toHaveCount(3);
          const list = page.locator('[data-hud-row]').first().locator('..');
          expect((await list.boundingBox())?.width).toBe(359);
          expect(await overflow(page, '[data-surface-root="hud"]', '[data-hud-row], [data-hud-row] > div')).toEqual([]);
        } else {
          await expect(page.locator('[data-hud-row]')).toHaveCount(1);
          expect((await page.locator('[data-hud-bar]').boundingBox())?.width).toBe(359);
          expect(await overflow(page, '[data-hud-bar]', '[data-hud-row], [data-hud-row] > div')).toEqual([]);
        }
      } else {
        await expect(root).toHaveAttribute('data-open', 'true');
        const box = await root.boundingBox();
        expect([box?.width, box?.height]).toEqual([360, 320]);
        await expect(page.locator('[data-ring-icon]')).toHaveCount(3);
        // One row along the panel's bottom: each 30 px icon centred in the 36 px row.
        await expect
          .poll(() => page.locator('[data-ring-icon]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top - e.parentElement!.getBoundingClientRect().top))))
          .toEqual([287, 287, 287]);
        if (demo.params.pop) {
          const pop = page.locator(`[data-ring-pop="${demo.params.pop}"]`);
          await expect(pop).toBeVisible();
          // The card opens above the row, clear of every icon.
          const p = await pop.boundingBox();
          expect((p?.y ?? 0) + (p?.height ?? 0) - (box?.y ?? 0)).toBeLessThanOrEqual(284);
        }
        expect(await overflow(page, '[data-surface-root="ring"]', '[data-ring-pop], [data-ring-row] p, [data-ring-tip]')).toEqual([]);
        // An icon's badge hangs over its edge by design; the icon itself stays in the panel.
        expect(await overflow(page, '[data-surface-root="ring"]', '[data-ring-icon]', false)).toEqual([]);
      }

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await smallText(page)).toEqual([]);
      await saveShot(root, { path: `${shotsDir}${info.project.name}/hud-demos-${theme}-${demo.name}.png`, omitBackground: true });
      expect(errors).toEqual([]);
    });
  }
}
