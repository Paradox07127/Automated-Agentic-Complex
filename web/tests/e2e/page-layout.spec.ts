import { expect, test, type Locator, type Page } from '@playwright/test';

// Layout: 角色, 记忆, 定时任务, 管线, 调参 and 诊断 text stays inside its box, nothing starts a line with a stray divider, nothing covers a label.

type Box = { x: number; y: number; width: number; height: number };

const open = async (page: Page, hash: string) => {
  await page.goto(`main.html#${hash}${hash.includes('?') ? '&' : '?'}still=1`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
};
const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!;

/** Focus rings of `sel` (box grown by outline-offset plus width) that a clipping ancestor cuts, for controls fully inside it. */
function ringCuts(page: Page, sel: string) {
  return page.evaluate((sel) => {
    const cuts: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      el.focus();
      const name = (el.textContent ?? '').trim().slice(0, 8);
      if (!el.matches(':focus-visible')) {
        cuts.push(`${name}: not focus-visible`);
        continue;
      }
      const cs = getComputedStyle(el);
      const ring = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth);
      const r = el.getBoundingClientRect();
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        const [l, t] = [c.left + a.clientLeft, c.top + a.clientTop];
        const [rr, b] = [l + a.clientWidth, t + a.clientHeight];
        if (r.left < l || r.right > rr || r.top < t || r.bottom > b) continue;
        const cut = Math.max(l - (r.left - ring), r.right + ring - rr, t - (r.top - ring), r.bottom + ring - b);
        if (cut > 0.5) cuts.push(`${name}: ${cut.toFixed(1)}px cut by ${a.className.split(' ')[0]}`);
      }
    }
    return cuts;
  }, sel);
}

for (const [w, h] of [
  [1280, 800],
  [900, 600],
] as const) {
  test(`${w}: the motion jump bar has its own row and shows every section name in full`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const route of ['/character?pane=motion']) {
      await open(page, route);
      const jump = page.getByRole('group', { name: '跳转到分区' });
      await expect(jump).toBeVisible();
      const [top, chipBottom] = await jump.evaluate((el) => [el.getBoundingClientRect().top, el.parentElement!.querySelector('button[aria-pressed]')!.getBoundingClientRect().bottom]);
      expect(top, `${route}: below the search and filter`).toBeGreaterThanOrEqual(chipBottom!);
      const cut = await jump.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [...el.querySelectorAll('button')].filter((b) => {
          const q = b.getBoundingClientRect();
          return q.left < r.left - 0.5 || q.right > r.right + 0.5 || b.scrollWidth > b.clientWidth + 1;
        }).map((b) => b.textContent);
      });
      expect(cut, route).toEqual([]);
      await jump.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.keyboard.press('Tab');
      expect(await ringCuts(page, '[role="group"][aria-label="跳转到分区"] button'), route).toEqual([]);
    }
  });
}

test('focus rings on the roster and 桌面预览 are not clipped', async ({ page }) => {
  await open(page, '/character');
  // The roster opens from the 切换角色 key of 总览's head strip.
  await page.getByRole('button', { name: /^切换角色/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: '角色名册' })).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await ringCuts(page, 'nav[aria-label="角色名册"] button')).toEqual([]);
  expect(await ringCuts(page, '[data-view="operator"] button[data-stub="Btn"]')).toEqual([]);
});

test('the 用户档案 nameplate shows its whole field line', async ({ page }) => {
  for (const q of ['', '&theme=light']) {
    await open(page, `/memory?plugins=all${q}`);
    const plate = page.getByRole('button', { name: '用户档案：小林' });
    await expect(plate).toBeVisible();
    const cut = await plate.locator('span').evaluateAll((els) => els.filter((v) => v.scrollWidth > v.clientWidth + 1).map((v) => v.textContent));
    expect(cut, q || 'dark').toEqual([]);
  }
});

test('evidence lines in the detail column wrap instead of cutting the place', async ({ page }) => {
  for (const id of ['g2', 'a3']) {
    await open(page, `/memory?sel=${`f31${id}`.padEnd(32, '0')}`);
    const source = page.getByRole('complementary', { name: '这条记忆' }).getByRole('region', { name: '出处' });
    await expect(source.locator('button').first()).toBeVisible();
    const cut = await source.locator('div, span').evaluateAll((els) => els.filter((m) => m.scrollWidth > m.clientWidth + 1).map((m) => m.textContent));
    expect(cut, id).toEqual([]);
  }
});

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

test('the memory-trend peak label stays below the 14 天新增 header', async ({ page }) => {
  for (const q of ['', '?theme=light']) {
    await open(page, `/pipeline${q}`);
    const trend = page.getByRole('img', { name: /^14 天新增/ });
    const peak = await box(trend.locator('> span[aria-hidden="true"]').first());
    const hd = await box(trend.locator('xpath=preceding-sibling::*[1]'));
    expect(peak.y, q || 'dark').toBeGreaterThanOrEqual(hd.y + hd.height);
  }
});

test('调参 chart: cause tags, labels and lines stay inside the chart', async ({ page }) => {
  for (const demo of ['sparse', 'default', 'disconnected']) {
    await open(page, `/tune?demo=${demo}`);
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

test('diag process rows: 查看日志 sits in the same column on every row', async ({ page }) => {
  await open(page, '/diag');
  const xs = await page.locator('[data-stub="Btn"]', { hasText: '查看日志' }).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(xs.length).toBeGreaterThan(2);
  expect(new Set(xs).size).toBe(1);
});

test('diag gate: the 7-day line takes at most two lines', async ({ page }) => {
  for (const demo of ['default', 'full']) {
    await open(page, `/diag?item=state&demo=${demo}`);
    const line = page.locator('span', { hasText: /^近 7 天主动/ }).last();
    await expect(line).toBeVisible();
    // Two lines of 12 px text are under 2 × 1.6 em tall; the flex row with its row gap was 45 px.
    const [height, max] = await line.evaluate((el) => [el.getBoundingClientRect().height, 2 * 1.6 * parseFloat(getComputedStyle(el).fontSize)]);
    expect(height, demo).toBeLessThanOrEqual(max!);
  }
});

test('diag live fps readout uses tabular digits', async ({ page }) => {
  await open(page, '/diag?demo=full');
  const num = await page.evaluate(() => {
    const s = [...document.querySelectorAll('span')].find((e) => e.nextSibling?.nodeType === Node.TEXT_NODE && e.nextSibling.textContent?.trim() === 'fps');
    return s ? getComputedStyle(s).fontVariantNumeric : 'missing';
  });
  expect(num).toContain('tabular-nums');
});
