import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CONSOLE_DEMOS } from '../../src/surfaces/desktop/cmd/console/demos.ts';
import { DESKTOP_DEMOS } from '../../src/surfaces/desktop/demos.ts';
import { STACK_DEMOS } from '../../src/surfaces/stack/demos.ts';

// Style guard, every page demo, the HUD in each stack preset and every desktop panel demo, dark and light:
// visible Chinese text >= 12px; other text >= 11px, or >= 9px for decorative English inside aria-hidden;
// drop shadows only on controls, popups and marked depth frames, cast down and right with no edge above;
// yellow fill counts primary buttons only, <= 1 per view.
// On the desktop panels, visible text is also drawn at an effective opacity >= 0.9.
// The #/ds and #/dv catalogs show many components side by side, so only the text and shadow rules apply there.

/** Every desktop panel demo, plus each 控制台 demo. */
const PANEL_DEMOS = [
  ...DESKTOP_DEMOS,
  ...Object.keys(CONSOLE_DEMOS).map((name) => ({ name, path: '/console', params: { demo: name } })),
];

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
const pageIds = readdirSync(`${srcDir}pages`, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(`${srcDir}pages/${e.name}/route.ts`))
  .map((e) => e.name);

/** Popups: the only places a blurred inset shadow may sit. */
const POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-overlay]';
/** Elements that may cast a shadow: controls, popups, desktop glass, stack cards and frames marked `data-depth`. */
const CASTS = `button, [role="tab"], [role="switch"], [role="slider"], ${POPUP}, [data-glass], [data-card-id], [data-depth]`;

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** Rule hits on the current view, one line each; `perView` adds the primary-button count, `faded` the text opacity rule. */
function audit(page: Page, perView = true, faded = false): Promise<string[]> {
  return page.evaluate(([castSel, popupSel, perView, faded]) => {
    const hits: string[] = [];
    const seen = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    };
    const name = (el: Element) => {
      const cls = typeof el.className === 'string' ? el.className.split(' ')[0] ?? '' : '';
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
    };

    // Product of `opacity` up the tree; null where fading is allowed: decoration, disabled controls, a fade still running.
    const opacity = (el: Element) => {
      if (el.closest('[aria-hidden="true"], :disabled, [aria-disabled="true"]')) return null;
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) {
        if (e.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)) return null;
        o *= parseFloat(getComputedStyle(e).opacity);
      }
      return o;
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim() ?? '';
      const el = n.parentElement;
      if (!text || !el || el.closest('script, style, noscript') || !seen(el)) continue;
      const box = document.createRange();
      box.selectNodeContents(n);
      const r = box.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      const min = /[㐀-䶿一-鿿]/.test(text) ? 12 : el.closest('[aria-hidden="true"]') ? 9 : 11;
      if (size < min) hits.push(`font ${size}px < ${min}: ${name(el)} "${text.slice(0, 24)}"`);
      const o = faded ? opacity(el) : null;
      if (o != null && o < 0.9) hits.push(`opacity ${o.toFixed(2)} < 0.9: ${name(el)} "${text.slice(0, 24)}"`);
    }

    // The game lights its controls from above left: a shadow falls down and right, never as a ring all round.
    for (const el of document.body.querySelectorAll('*')) {
      if (!seen(el)) continue;
      // Parts inside a control (a switch thumb, a key face, a segmented control's knob) shade with it.
      const casts = el.matches(castSel) || !!el.parentElement?.closest('button, [role="tab"], [role="switch"], [role="slider"], [role="radiogroup"]');
      const inPopup = !!el.closest(popupSel);
      for (const pseudo of ['', '::before', '::after']) {
        const s = getComputedStyle(el, pseudo || null);
        if (s.boxShadow === 'none' || (pseudo && s.content === 'none')) continue;
        const bad = s.boxShadow.split(/,(?![^(]*\))/).filter((l) => {
          // Transparent layers draw nothing; unblurred rings and inset edges are strokes, not shadows.
          if (/rgba\([^)]*,\s*0\)|\/\s*0\)/.test(l)) return false;
          const [x = 0, y = 0, blur = 0, spread = 0] = l.replace(/(rgba?|color)\([^)]*\)/, '').match(/-?[\d.]+(?=px)/g)?.map(Number) ?? [];
          const inset = /inset/.test(l);
          if (blur === 0 && (inset || (x === 0 && y === 0))) return false;
          if (inset) return !inPopup;
          return !casts || x < 0 || y <= 0 || blur + spread - y > 2;
        });
        if (bad.length > 0) hits.push(`box-shadow${pseudo} ${bad.join(',')}: ${name(el)}`);
      }
    }

    if (!perView) return hits;
    // An open dialog or sheet is the view; the page behind its scrim does not count.
    // Selected nav blocks and tabs are not counted: only yellow primary buttons are.
    const modals = document.querySelectorAll('[aria-modal="true"]');
    const view = modals.length > 0 ? modals[modals.length - 1]! : document.body;
    const primary = [...view.querySelectorAll('[data-stub="Btn"][data-variant="primary"]')].filter(seen);
    if (primary.length > 1) hits.push(`primary x${primary.length}: ${primary.map(name).join(' / ')}`);
    return hits;
  }, [CASTS, POPUP, perView, faded] as const);
}

for (const scheme of ['dark', 'light'] as const) {
  for (const id of pageIds) {
    test(`style guard ${scheme}: ${id}`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('main.html');
      const manifest = await page.evaluate(() => window.__EF_ROUTES__ ?? []);
      const route = manifest.find((r) => r.id === id);
      expect(route, `route ${id} is registered`).toBeTruthy();
      const hits: string[] = [];
      for (const demo of route?.demos ?? []) {
        const qs = new URLSearchParams({ ...demo.params, still: '1' }).toString();
        await page.goto('about:blank');
        await page.goto(`main.html#${route?.path}?${qs}`);
        await expect(page.locator(`main[data-route-id="${id}"]`)).toBeVisible();
        await settle(page);
        hits.push(...(await audit(page)).map((h) => `${id}-${demo.name}: ${h}`));
      }
      expect(hits).toEqual([]);
    });
  }

  test(`style guard ${scheme}: ds and dv catalogs`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const hits: string[] = [];
    for (const id of ['ds', 'dv']) {
      await page.goto('about:blank');
      await page.goto(`main.html#/${id}?still=1`);
      await expect(page.locator(`main[data-route-id="${id}"]`)).toBeVisible();
      await settle(page);
      hits.push(...(await audit(page, false)).map((h) => `${id}: ${h}`));
    }
    expect(hits).toEqual([]);
  });

  test(`style guard ${scheme}: hud in each stack preset`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.emulateMedia({ colorScheme: scheme });
    const hits: string[] = [];
    for (const demo of STACK_DEMOS) {
      const qs = new URLSearchParams({ ...demo.params, still: '1' }).toString();
      await page.goto('about:blank');
      await page.goto(`stack.html#/hud?${qs}`);
      await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
      await settle(page);
      hits.push(...(await audit(page)).map((h) => `hud-${demo.name}: ${h}`));
    }
    expect(hits).toEqual([]);
  });

  test(`style guard ${scheme}: desktop panels`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.emulateMedia({ colorScheme: scheme });
    const hits: string[] = [];
    for (const demo of PANEL_DEMOS) {
      const qs = new URLSearchParams({ ...demo.params, still: '1' }).toString();
      await page.goto('about:blank');
      await page.goto(`stack.html#${demo.path}?${qs}`);
      await expect(page.locator(`[data-surface-root="${demo.path.slice(1)}"]`)).toBeAttached();
      await settle(page);
      hits.push(...(await audit(page, true, true)).map((h) => `${demo.name}: ${h}`));
    }
    expect(hits).toEqual([]);
  });
}
