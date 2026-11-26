import { expect, test, type Locator, type Page } from '@playwright/test';

// Layout: 角色, 记忆, 定时任务, 记忆管线 and 诊断 text stays inside its box, nothing starts a line with a stray divider, nothing covers a label.

type Box = { x: number; y: number; width: number; height: number };

const open = async (page: Page, hash: string) => {
  await page.goto(`main.html#${hash}${hash.includes('?') ? '&' : '?'}still=1`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
};
const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!;

for (const [w, h] of [
  [1385, 640],
  [900, 600],
] as const) {
  test(`${w}x${h}: the character 设定 list scrolls its last row fully above the bottom fade`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await open(page, '/character');
    await page.getByRole('navigation', { name: '角色分区' }).getByRole('button', { name: /设定/ }).click();
    const rows = page.locator('[data-view="operator"] [class*="rows"]').first();
    await expect(rows).toBeVisible();
    await rows.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const at = await rows.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const lastBottom = Math.max(...[...el.querySelectorAll<HTMLElement>('*')].map((x) => x.getBoundingClientRect()).filter((q) => q.height > 0).map((q) => q.bottom));
      return { top: r.top, bottom: r.bottom, lastBottom };
    });
    // The list's bottom 36 px sit under a fade.
    expect(at.lastBottom, 'the last row ends above the fade').toBeLessThanOrEqual(at.bottom - 36 + 0.5);
  });

  test(`${w}x${h}: on 动作 the rail ends above the action bar`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await open(page, '/character');
    await page.getByRole('navigation', { name: '角色分区' }).getByRole('button', { name: /动作/ }).click();
    const bar = await box(page.locator('[data-view="operator"] [data-stub="ActionBar"]').first());
    const cells = await page.locator('nav[aria-label="角色分区"] button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().bottom));
    expect(cells.length).toBeGreaterThan(0);
    for (const b of cells) expect(b, 'rail cell bottom <= bar top').toBeLessThanOrEqual(bar.y + 0.5);
  });
}

test('任务「定时」: the selected schedule has 编辑 and 立即运行 are shared pill buttons in the bottom bar, 删除 a round one apart from them', async ({ page }) => {
  await open(page, '/tasks?tab=sched&plugins=all');
  await expect(page.getByRole('region', { name: '任务列表' }).getByRole('option').first()).toBeVisible();
  const bar = page.locator('[data-tasks-bar]');
  for (const name of ['编辑', '立即运行']) await expect(bar.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('data-stub', 'Btn');
  const del = bar.getByRole('button', { name: '删除定时任务' });
  const edit = bar.getByRole('button', { name: /^编辑/ });
  await expect(del).not.toHaveAttribute('data-stub', 'Btn');
  expect((await box(del)).x).toBeLessThan((await box(edit)).x);
  const look = (l: Locator) => l.evaluate((e) => `${getComputedStyle(e).backgroundColor} ${getComputedStyle(e).color}`);
  expect(await look(del)).not.toBe(await look(edit));
});

test('行为决策 chart: cause tags, labels and lines stay inside the chart', async ({ page }) => {
  for (const demo of ['sparse', 'default', 'disconnected']) {
    await open(page, `/diag?tab=behavior&demo=${demo}`);
    const out = await page.locator('svg[aria-label^="精神和心情曲线"]').evaluateAll((svgs) =>
      svgs.flatMap((svg) => {
        const r = svg.getBoundingClientRect();
        return [...svg.querySelectorAll('text, line')]
          .filter((t) => {
            const q = t.getBoundingClientRect();
            return q.width + q.height > 0 && (q.left < r.left - 0.5 || q.right > r.right + 0.5);
          })
          .map((t) => `${t.tagName} ${t.textContent} at ${Math.round(t.getBoundingClientRect().left - r.left)}`);
      }),
    );
    expect(out, demo).toEqual([]);
  }
});

test('diag process rows: 日志 sits in the same column on every row', async ({ page }) => {
  await open(page, '/diag?tab=proc');
  const xs = await page.locator('[data-nav-target^="proc-"] [data-stub="Btn"]', { hasText: '日志' }).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(xs.length).toBeGreaterThanOrEqual(2);
  expect(new Set(xs).size).toBe(1);
});

test('diag gate: the 7-day line takes at most two lines', async ({ page }) => {
  for (const demo of ['default', 'full']) {
    await open(page, `/diag?tab=state&demo=${demo}`);
    const line = page.locator('span', { hasText: /^近 7 天主动/ }).last();
    await expect(line).toBeVisible();
    // Two lines of 12 px text are under 2 × 1.6 em tall; the flex row with its row gap was 45 px.
    const [height, max] = await line.evaluate((el) => [el.getBoundingClientRect().height, 2 * 1.6 * parseFloat(getComputedStyle(el).fontSize)]);
    expect(height, demo).toBeLessThanOrEqual(max!);
  }
});

test('diag live fps readout uses tabular digits', async ({ page }) => {
  await open(page, '/diag?demo=full&tab=render');
  const num = await page.evaluate(() => {
    const s = document.querySelector('[data-nav-target="diag-render"] [data-stub="ReadTick"] b');
    return s ? getComputedStyle(s).fontVariantNumeric : 'missing';
  });
  expect(num).toContain('tabular-nums');
});
