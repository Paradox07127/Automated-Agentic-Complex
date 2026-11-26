import { expect, test, type Locator, type Page } from '@playwright/test';

interface Fit {
  text: string;
  title: string | null;
  sw: number;
  cw: number;
  sh: number;
  ch: number;
  lines: number;
}

/** Overflow and line count of each matched element; one line is the computed line-height. */
async function fits(loc: Locator): Promise<Fit[]> {
  return loc.evaluateAll((els) =>
    els.map((e) => {
      const lh = parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.2;
      return { text: e.textContent ?? '', title: e.getAttribute('title'), sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, lines: Math.round(e.getBoundingClientRect().height / lh) };
    }),
  );
}

async function open(page: Page, w: number, h: number, url: string) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`main.html#/${url}${url.includes('?') ? '&' : '?'}still=1`);
}

test('今天 1280: the 进行中 row message shows at most 2 lines and carries its full text as a title', async ({ page }) => {
  await open(page, 1280, 800, 'overview?plugins=all');
  const meta = page.locator('ul[aria-label="进行中"] button > span:nth-child(2) > span:nth-child(2)');
  await expect(meta.first()).toBeVisible();
  for (const f of await fits(meta)) {
    expect(f.title, f.text).toBe(f.text);
    expect(f.lines, f.text).toBeLessThanOrEqual(2);
  }
});

test('每日简报 › 时间 1280: a focused timeline entry draws its ring inside its own box', async ({ page }) => {
  await open(page, 1280, 800, 'overview?plugins=daily_brief&tab=tm');
  const entry = page.locator('button[data-entry]').first();
  // The app mounts after it starts listening for keys, so this Tab is seen and the entry's focus draws a keyboard ring.
  await expect(entry).toBeVisible();
  await page.keyboard.press('Tab');
  await entry.focus();
  const ring = await entry.evaluate((e) => {
    const s = getComputedStyle(e);
    return parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth);
  });
  expect(ring).toBeLessThanOrEqual(0);
});

for (const view of ['diag?tab=turns&demo=full&turn=tr7', 'diag?tab=turns&demo=sparse', 'diag?tab=logs']) {
  test(`诊断 回看 925×515 ${view}: nothing in the page runs past its right edge`, async ({ page }) => {
    await open(page, 925, 515, view);
    const main = page.locator('main');
    await expect(main.getByRole(view.includes('logs') ? 'log' : 'listbox').first()).toBeVisible();
    const past = await main.evaluate((root) => {
      const edge = root.getBoundingClientRect().right;
      // Text an ellipsis or a scroller cuts inside the page does not count.
      const clipped = (e: Element) => {
        for (let p = e.parentElement; p && p !== root; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible') return p.getBoundingClientRect().right <= edge + 1;
        }
        return false;
      };
      return [...root.querySelectorAll('*')]
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.right > edge + 1 && getComputedStyle(e).visibility !== 'hidden' && !clipped(e);
        })
        .map((e) => `${e.tagName} ${(e.textContent ?? '').slice(0, 30)}`);
    });
    expect(past).toEqual([]);
  });
}
