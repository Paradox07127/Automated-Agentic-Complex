import { expect, test, type Page } from '@playwright/test';

// First-run guide: a full-screen layer over the shell on main.html#/onboarding (fake bridge, onboarding surface).

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, query = '') {
  await page.goto('about:blank');
  await page.goto(`main.html#/onboarding${query ? `?${query}` : ''}`);
  const guide = page.getByRole('dialog', { name: /^首次设置/ });
  await expect(guide).toBeVisible();
  return guide;
}

test('step 1 covers the whole window with the permissions, the media panel and the tally', async ({ page }) => {
  const errors = collectErrors(page);
  const guide = await open(page, 'demo=ok');
  const box = await guide.boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  // The sidebar is under the guide.
  const hit = await page.evaluate(() => document.elementFromPoint(30, 400)?.closest('[role="dialog"]') !== null);
  expect(hit).toBe(true);
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('开始使用 Agentic Complex');
  await expect(guide.getByRole('region', { name: '角色' })).toContainText('示例乙');
  await guide.getByRole('button', { name: '查看可选权限' }).click();
  await expect(guide.getByRole('list', { name: '系统权限' }).getByRole('listitem')).toHaveCount(5);
  await expect(guide.getByRole('list', { name: '设置进度' })).toContainText('2/5 已允许');
  await expect(guide.getByLabel('第 1 步，共 4 步')).toHaveText('01/04');
  // Highlight frame: the frame reaches 43 px past the row that still needs System Settings.
  await expect(guide.locator('[data-guide-ring]')).toHaveCount(1);
  const reach = () =>
    guide.locator('[data-kind="accessibility"]').evaluate((row) => {
      const r = row.getBoundingClientRect();
      const f = row.querySelector('[data-guide-ring]')!.getBoundingClientRect();
      return [r.left - f.left, f.right - r.right, r.top - f.top, f.bottom - r.bottom].every((d) => Math.abs(d - 43) <= 1);
    });
  await expect.poll(reach).toBe(true);
  await expect(guide.getByRole('button', { name: /^继续/ })).toBeVisible();
  await expect(guide.getByRole('button', { name: /^先使用角色/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('walks the guide: grant, name, copy a command, finish and open the main window', async ({ page }) => {
  const errors = collectErrors(page);
  const guide = await open(page);
  await guide.getByRole('button', { name: '查看可选权限' }).click();
  const ax = guide.locator('[data-kind="accessibility"]');
  await ax.getByRole('button', { name: /前往系统设置/ }).click();
  await expect(ax).toHaveAttribute('data-state', 'granted');
  await expect(guide.getByRole('list', { name: '设置进度' })).toContainText('3/5 已允许');

  await guide.getByRole('button', { name: /^继续/ }).click();
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('按住说话 │ 称呼');
  await expect(guide.getByText('你好，我叫阿砚')).toBeVisible();
  await guide.getByRole('textbox', { name: '名字' }).fill('小林');
  await expect(guide.getByRole('list', { name: '设置进度' })).toContainText('称呼 小林');
  await guide.getByRole('button', { name: /^下一步/ }).click();

  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('接入编码会话');
  const codex = guide.locator('[data-hook="codex"]');
  await expect(codex.getByRole('button', { name: /复制/ })).toHaveCount(3);
  await codex.getByRole('button', { name: /复制/ }).first().click();
  await expect(codex.getByRole('button', { name: /已复制/ })).toBeVisible();
  await guide.getByRole('button', { name: /重新检查/ }).click();

  await guide.getByRole('button', { name: /^完成设置/ }).click();
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('示例乙 已在桌面就位');
  await expect(guide).toContainText('权限 3 / 5，称呼 小林，编码工具 1 / 2');
  await guide.getByRole('button', { name: /开始对话/ }).click();
  await expect(page.locator('main[data-route-id="chat"]')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^首次设置/ })).toHaveCount(0);
  await expect(page.getByText('首次设置已完成')).toBeVisible();
  expect(errors).toEqual([]);
});

test('back from the closing screen and the left arrow return to earlier steps', async ({ page }) => {
  const guide = await open(page, 'demo=step4');
  await expect(guide).toHaveAttribute('data-step', '4');
  await guide.getByRole('button', { name: '上一步' }).click();
  await expect(guide).toHaveAttribute('data-step', '3');
  await guide.getByRole('button', { name: '上一页' }).click();
  await expect(guide).toHaveAttribute('data-step', '2');
  await guide.getByRole('button', { name: '上一页' }).click();
  await expect(guide).toHaveAttribute('data-step', '1');
  // The first page has no left arrow.
  const first = guide.getByRole('button', { name: '上一页', includeHidden: true });
  await expect(first).toBeDisabled();
  await expect(first).toBeHidden();
});

test('the right arrow turns to the next step like the primary button', async ({ page }) => {
  const guide = await open(page, 'demo=ok');
  await guide.getByRole('button', { name: '下一页' }).click();
  await expect(guide).toHaveAttribute('data-step', '2');
  await expect(guide.getByLabel('第 2 步，共 4 步')).toHaveText('02/04');
});

test('denied microphone: danger row, no trial on step 2, red footer hint', async ({ page }) => {
  const guide = await open(page, 'demo=denied-step2');
  await expect(guide.locator('[data-kind="microphone"]')).toHaveAttribute('data-state', 'denied');
  await expect(guide.getByText('按住说话不可用', { exact: true })).toBeVisible();
  await expect(guide.getByRole('region', { name: '试用按住说话' })).toHaveCount(0);
  await expect(guide.locator('footer [role="alert"]')).toContainText('麦克风与语音识别已拒绝');
});

test('sparse: nothing granted, no name, both tools show install steps', async ({ page }) => {
  const guide = await open(page, 'demo=sparse-step3');
  await expect(guide.getByRole('list', { name: '设置进度' })).toContainText('0/5 已允许');
  await expect(guide.getByRole('list', { name: '设置进度' })).toContainText('0/2 已接入');
  await expect(guide.locator('[data-hook][data-off]')).toHaveCount(2);
  await expect(guide.getByText('未接入')).toHaveCount(2);
});

test('loading and error states', async ({ page }) => {
  let guide = await open(page, 'state=loading');
  await expect(guide.getByText('正在读取权限和接入状态…')).toBeVisible();
  guide = await open(page, 'state=error');
  await expect(guide.getByRole('alert')).toContainText('没有连上桌面端，请重试');
  await expect(guide.getByRole('button', { name: '重试' })).toBeVisible();
});

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`no horizontal overflow at ${w}×${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const demo of ['ok', 'step2', 'step3', 'step4', 'sparse-step3']) {
      const guide = await open(page, `demo=${demo}`);
      await expect(guide.getByRole('button', { name: /^上一步|^继续/ }).first()).toBeVisible();
      const over = await page.evaluate(() => {
        const g = document.querySelector('[role="dialog"]') as HTMLElement;
        const wide = [...g.querySelectorAll<HTMLElement>('*')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('[aria-hidden="true"]'));
        // Scroll areas inside the guide; the layer itself clips its decorative watermark.
        const scrolls = [...g.querySelectorAll<HTMLElement>('*')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
        return { doc: document.documentElement.scrollWidth > window.innerWidth, scrolls: scrolls.map((el) => el.className), wide: wide.map((el) => el.className).slice(0, 3) };
      });
      expect(over, `${demo} at ${w}×${h}`).toEqual({ doc: false, scrolls: [], wide: [] });
    }
  });
}

test('light theme uses the paper ground', async ({ page }) => {
  const guide = await open(page, 'theme=light');
  const bg = await guide.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(242, 241, 239)');
  await guide.getByRole('button', { name: '查看可选权限' }).click();
  await expect(guide.getByRole('list', { name: '系统权限' }).getByRole('listitem')).toHaveCount(5);
});
