import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Shell shortcuts, Q/E caps on hover, readable effect tags, one title in the chat task sheet, one yellow button per view.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const css = (el: Locator, prop: string) => el.evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop);

for (const from of ['chat', 'memory', 'settings', 'diag']) {
  test(`⌘N on ${from} opens the 派发任务 editor on the tasks page`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`main.html#/${from}?plugins=all&still=1`);
    await expect(page.locator(`main[data-route-id="${from}"]`)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+n');
    await expect(page).toHaveURL(/#\/tasks\?/);
    await expect(page.getByRole('form', { name: '派发任务' })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

// At this width the chat task Sheet is docked as a column, not a modal, so ⌘N still goes to 派发任务.
test('⌘N works beside the chat task column', async ({ page }) => {
  await page.goto('main.html#/chat?plugins=all&demo=plan-snapshot&still=1');
  await expect(page.getByRole('complementary', { name: '任务', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page).toHaveURL(/#\/tasks\?/);
});

test('⌘K lists 快速输入 and 免打扰 under 动作', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/memory?plugins=all&still=1&demo=palette');
  const list = page.getByRole('listbox');
  const actions = list.locator('[data-group="动作"] ~ [role="option"]');
  await expect(actions.filter({ hasText: '快速输入' })).toHaveCount(1);
  await expect(actions.filter({ hasText: '免打扰' })).toHaveCount(1);
  await page.getByRole('combobox', { name: '命令' }).fill('免打扰');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/已进入免打扰/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('page tabs sit in the command bar without caps of their own, and Q and E step them on 记忆', async ({ page }) => {
  await page.goto('main.html#/memory?plugins=all&still=1');
  const tabs = page.getByRole('navigation', { name: '主导航' }).getByRole('tablist', { name: '记忆视图' });
  await expect(tabs).toBeVisible();
  await expect(tabs.locator('kbd')).toHaveCount(0);
  const all = await tabs.getByRole('tab').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  const before = await tabs.getByRole('tab', { selected: true }).getAttribute('title');
  const i = all.indexOf(before);
  await page.keyboard.press('e');
  await expect(tabs.getByRole('tab', { selected: true })).toHaveAttribute('title', all[(i + 1) % all.length]!);
  await expect(page.locator('main[data-route-id="memory"]')).toBeVisible();
  await page.keyboard.press('q');
  await expect(tabs.getByRole('tab', { selected: true })).toHaveAttribute('title', before ?? '');
});

test('EffectTag Chinese is at least 12 px', async ({ page }) => {
  for (const d of ['backend', 'pending']) {
    await page.goto(`main.html#/ds?plugins=all&c=EffectTag&d=${d}&still=1`);
    const tag = page.locator('[data-stub="EffectTag"]');
    await expect(tag).toBeVisible();
    expect(parseFloat(await css(tag, 'font-size'))).toBeGreaterThanOrEqual(12);
  }
});

test('TraceLine sets Chinese in the sans face and only the path in mono', async ({ page }) => {
  await page.goto('main.html#/ds?plugins=all&c=TraceLine&d=failed&still=1');
  const line = page.locator('[data-stub="TraceLine"]');
  await expect(line).toBeVisible();
  const desc = line.locator('[title]').filter({ hasText: '资料授权已撤销' });
  const mono = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.fontFamily = 'var(--ef-font-mono)';
    document.body.append(probe);
    const f = getComputedStyle(probe).fontFamily;
    probe.remove();
    return f;
  });
  expect(await css(desc, 'font-family')).not.toBe(mono);
  expect(await css(desc.locator('[data-mono]'), 'font-family')).toBe(mono);
  await expect(desc.locator('[data-mono]')).toHaveText('~/Downloads');
});

test('chat task column: one task title, one set of task actions and a tool section', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/chat?plugins=all&demo=plan-snapshot&still=1');
  const sheet = page.getByRole('complementary', { name: '任务', exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: '整理本周提交周报' })).toHaveCount(1);
  await expect(sheet.getByRole('region', { name: '工具调用' })).toBeVisible();
  await expect(sheet.getByText(/在任务中打开/)).toHaveCount(1);
  await expect(sheet.getByText(/打开过/)).toHaveCount(1);
  // /agent/runs carries no plan, so the demo run shows the「还没有计划」note until plan events fill it.
  await expect(sheet.getByText(/逐步状态|重连后显示步骤|还没有计划/)).toHaveCount(1);
  // The drawer's title starts at the drawer's left edge.
  const drawer = sheet.locator('[data-stub="TaskDrawer"]');
  expect((await drawer.boundingBox())?.x).toBe((await sheet.getByRole('heading', { name: '整理本周提交周报' }).boundingBox())?.x);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await saveShot(page, { path: `${shotsDir}${test.info().project.name}/shortcuts-and-caps-chat-sheet.png` });
  expect(errors).toEqual([]);
});

test('DiffPreview +1 −1 is not on a dark chip in the light theme', async ({ page }) => {
  await page.goto('main.html#/ds?plugins=all&c=ApprovalCard&d=normal&still=1&theme=light');
  const num = page.locator('[data-stub="DiffPreview"] > span .num');
  await expect(num).toBeVisible();
  const lum = await num.evaluate((el) => {
    let n: Element | null = el;
    // First painted background up the tree.
    while (n) {
      const c = getComputedStyle(n).backgroundColor;
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
      if (m.length >= 3 && (m[3] ?? 1) > 0) return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
      n = n.parentElement;
    }
    return 1;
  });
  expect(lum).toBeGreaterThan(0.5);
});

test('every page demo has at most one visible yellow primary button', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('main.html');
  const manifest = await page.evaluate(() => window.__EF_ROUTES__ ?? []);
  const over: string[] = [];
  for (const route of manifest.filter((r) => r.id !== 'ds' && r.id !== 'dv')) {
    for (const demo of route.demos) {
      const qs = new URLSearchParams({ ...demo.params, still: '1' }).toString();
      await page.goto('about:blank');
      await page.goto(`main.html#${route.path}?${qs}`);
      await expect(page.locator(`main[data-route-id="${route.id}"]`)).toBeVisible();
      await page.waitForLoadState('networkidle');
      // An open dialog or sheet is the view; the page behind its scrim does not count.
      const top = page.locator('[aria-modal="true"]').last();
      const scope = (await top.count()) > 0 ? top : page.locator('body');
      const yellow = await scope.locator('[data-stub="Btn"][data-variant="primary"]').evaluateAll((els) =>
        els.filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden').map((el) => el.textContent?.trim() ?? ''),
      );
      if (yellow.length > 1) over.push(`${route.id}-${demo.name}: ${yellow.join(' / ')}`);
    }
  }
  for (const hud of ['three', 'standalone']) {
    for (const expand of [false, true]) {
      await page.goto('about:blank');
      await page.goto(`stack.html#/hud?hud=${hud}${expand ? '&expand=1' : ''}&still=1`);
      await expect(page.locator('[data-hud-row]').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const yellow = await page.locator('[data-stub="Btn"][data-variant="primary"]').evaluateAll((els) =>
        els.filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden').map((el) => el.textContent?.trim() ?? ''),
      );
      if (yellow.length > 1) over.push(`hud-${hud}${expand ? '-expanded' : ''}: ${yellow.join(' / ')}`);
    }
  }
  expect(over).toEqual([]);
});
