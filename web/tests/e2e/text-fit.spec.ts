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

test('工业简报 900×600: the command bar fields are not cut, and 日报 carries the full day line as its title', async ({ page }) => {
  await open(page, 900, 600, 'overview');
  await expect(page.locator('button[aria-label^="一句话日报"]')).toHaveAttribute('title', /下一条提醒/);
  const facts = page.locator('nav[aria-label="主导航"] [data-slot="status"] > span:first-child');
  await expect(facts).toContainText('编码会话');
  const f = (await fits(facts))[0]!;
  expect(cut(f), JSON.stringify(f)).toBe(false);
  expect(f.lines).toBeLessThanOrEqual(1);
});

test('运行记录 1280: a focused timeline entry draws its ring inside its own box', async ({ page }) => {
  await open(page, 1280, 800, 'trace');
  // From the keyboard, so the entry's focus is drawn as a keyboard ring.
  await page.getByRole('tab', { name: '今日时间线' }).focus();
  await page.keyboard.press('Enter');
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

const WF = '[role="list"][aria-label^="瀑布"]';
const INSPECTOR = `[data-page="trace"] [data-wide]:has(${WF})`;

for (const demo of ['full', 'full-turn', 'sparse']) {
  test(`追踪 900×600 ${demo}: the inspector stacks to one column and nothing runs past its edge`, async ({ page }) => {
    await open(page, 900, 600, `trace?demo=${demo === 'sparse' ? 'sparse' : 'full'}${demo === 'full-turn' ? '&turn=tr7' : ''}`);
    const ins = page.locator(INSPECTOR);
    await expect(ins.locator(WF)).toBeVisible();
    const r = await ins.evaluate((root, wf) => {
      const box = root.getBoundingClientRect();
      const facts = root.querySelector(wf)!.closest('section')!.parentElement!.nextElementSibling!;
      const past = [...root.querySelectorAll('*')].filter((e) => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.right > box.right + 1;
      });
      const obsT = [...root.querySelectorAll('span:has(> b)')].find((e) => /文字/.test(e.textContent ?? ''));
      return {
        width: box.width,
        cols: getComputedStyle(facts).gridTemplateColumns.split(' ').length,
        past: past.map((e) => e.textContent?.slice(0, 40)),
        obsT: obsT ? obsT.getBoundingClientRect().width : null,
      };
    }, WF);
    expect(r.width).toBeLessThan(900);
    expect(r.cols).toBe(1);
    expect(r.past).toEqual([]);
    if (demo !== 'sparse') expect(r.obsT).not.toBeNull();
    if (r.obsT !== null) expect(r.obsT).toBeGreaterThanOrEqual(120);
  });

  test(`追踪 900×600 ${demo}: waterfall axis labels do not collide, even on a narrow track`, async ({ page }) => {
    await open(page, 900, 600, `trace?demo=${demo === 'sparse' ? 'sparse' : 'full'}${demo === 'full-turn' ? '&turn=tr7' : ''}`);
    const wf = page.locator(`[data-page="trace"] ${WF}`);
    await expect(wf).toBeVisible();
    for (const width of [null, 260]) {
      if (width) await wf.evaluate((e, w) => ((e as HTMLElement).style.width = `${w}px`), width);
      const boxes = await wf.locator('[data-ax] span > span').evaluateAll((els) =>
        els
          .filter((e) => getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden')
          .map((e) => {
            const b = e.getBoundingClientRect();
            return [b.left, b.right, e.textContent] as const;
          })
          .sort((a, b) => a[0] - b[0]),
      );
      expect(boxes.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < boxes.length; i++) expect(boxes[i]![0], `${width} ${JSON.stringify(boxes)}`).toBeGreaterThanOrEqual(boxes[i - 1]![1] + 2);
    }
  });
}
