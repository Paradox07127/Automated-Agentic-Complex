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

const cut = (f: Fit) => f.sw > f.cw + 1 || f.sh > f.ch + 1;

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

test('每日简报 900×600: the date pager in the command bar is not cut', async ({ page }) => {
  await open(page, 900, 600, 'overview?plugins=coding_sessions');
  const pager = page.locator('nav[aria-label="主导航"] [data-slot="status"] > span:first-child');
  await expect(pager.getByRole('button', { name: '前一天' })).toBeVisible();
  await expect(pager).toContainText('今天');
  const f = (await fits(pager))[0]!;
  expect(cut(f), JSON.stringify(f)).toBe(false);
  expect(f.lines).toBeLessThanOrEqual(1);
});

test('每日简报 › 时间 1280: a focused timeline entry draws its ring inside its own box', async ({ page }) => {
  await open(page, 1280, 800, 'overview?tab=tm');
  // From the keyboard, so the entry's focus is drawn as a keyboard ring.
  await page.keyboard.press('Tab');
  const entry = page.locator('button[data-entry]').first();
  await entry.focus();
  const ring = await entry.evaluate((e) => {
    const s = getComputedStyle(e);
    return parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth);
  });
  expect(ring).toBeLessThanOrEqual(0);
});

test('对话 1440 and 1920: history speakers fit and long previews retain their full text', async ({ page }) => {
  for (const [w, h] of [
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await open(page, w, h, 'chat');
    await page.getByRole('button', { name: '历史记录', exact: true }).click();
    const history = page.getByRole('dialog', { name: '历史记录' });
    const who = history.locator('li > button > span:first-child');
    await expect(who.first()).toBeAttached();
    for (const f of await fits(who)) {
      expect(cut(f), `${w} ${JSON.stringify(f)}`).toBe(false);
    }
    for (const f of await fits(history.locator('li > button > span:nth-child(2)'))) {
      expect(f.title, f.text).toBe(f.text);
      expect(f.lines).toBeLessThanOrEqual(2);
    }
    await page.keyboard.press('Escape');
    await expect(history).toHaveCount(0);
  }
});

test('对话 900×700: the composer status hint is shown whole; at 900×600 it may end in … and carries its full text as a title', async ({ page }) => {
  await open(page, 900, 700, 'chat?plugins=all');
  const hint = page.getByText('前台执行中，新消息由只读旁路回答');
  await expect(hint).toBeVisible();
  const f = (await fits(hint))[0]!;
  expect(cut(f), JSON.stringify(f)).toBe(false);
  await page.setViewportSize({ width: 900, height: 600 });
  const g = (await fits(hint))[0]!;
  expect(g.title).toBe(g.text);
});

for (const view of ['trace?demo=full&turn=tr7', 'trace?demo=sparse', 'trace?tab=logs']) {
  test(`运行记录 925×515 ${view}: nothing in the page runs past its right edge`, async ({ page }) => {
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
