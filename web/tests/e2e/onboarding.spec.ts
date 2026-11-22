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

test('step 1 covers the whole window with the roster, the media panel and the product name', async ({ page }) => {
  const errors = collectErrors(page);
  const guide = await open(page);
  const box = await guide.boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  // The sidebar is under the guide.
  const hit = await page.evaluate(() => document.elementFromPoint(30, 400)?.closest('[role="dialog"]') !== null);
  expect(hit).toBe(true);
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('选角色');
  await expect(guide.getByRole('region', { name: '角色' })).toContainText('示例乙');
  await expect(guide.getByLabel('第 1 步，共 3 步')).toHaveText('01/03');
  await expect(guide.locator('header')).toContainText('Agentic Complex');
  await expect(page.getByText('ENDFIELD')).toHaveCount(0);
  await expect(guide.getByRole('button', { name: '下一步' })).toBeVisible();
  await expect(guide.getByRole('button', { name: '上一步' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('只陪伴: walks the guide without a permission or a terminal command, finishes and opens the character page', async ({ page }) => {
  const errors = collectErrors(page);
  const guide = await open(page);
  await guide.getByRole('button', { name: '下一步' }).click();
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('怎么陪你');
  const choices = guide.getByRole('radiogroup', { name: '怎么陪你' });
  await expect(choices.getByRole('radio')).toHaveCount(2);
  await choices.getByRole('radio', { name: /^只陪伴/ }).click();
  await expect(choices.getByRole('radio', { name: /^只陪伴/ })).toHaveAttribute('aria-checked', 'true');
  await guide.getByRole('button', { name: '下一步' }).click();
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('示例乙 已在桌面就位');
  await expect(guide).not.toContainText(/hook|终端|权限|麦克风/i);
  await guide.getByRole('button', { name: '完成' }).click();
  await expect(page.locator('main[data-route-id="character"]')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^首次设置/ })).toHaveCount(0);
  await expect(page.getByText('首次设置已完成')).toBeVisible();
  expect(errors).toEqual([]);
});

test('陪伴加对话 ends at 设置 › 账号; 打开插件设置 at 设置 › 能做, where the capability bands are', async ({ page }) => {
  for (const [button, group] of [['完成', 'model'], ['打开插件设置', 'perm']] as const) {
    const guide = await open(page);
    await guide.getByRole('button', { name: '下一步' }).click();
    await guide.getByRole('radio', { name: /^陪伴加对话/ }).click();
    await guide.getByRole('button', { name: '下一步' }).click();
    await guide.getByRole('button', { name: button }).click();
    await expect(page.locator('main[data-route-id="settings"]')).toBeVisible();
    await expect.poll(() => page.url()).toContain(`group=${group}`);
  }
});

test('one set of page controls: 上一步 goes back, no media arrows', async ({ page }) => {
  const guide = await open(page, 'demo=step3');
  await expect(guide).toHaveAttribute('data-step', '3');
  await expect(guide.getByRole('button', { name: /上一页|下一页/, includeHidden: true })).toHaveCount(0);
  await guide.getByRole('button', { name: '上一步' }).click();
  await expect(guide).toHaveAttribute('data-step', '2');
  await expect(guide.getByLabel('第 2 步，共 3 步')).toHaveText('02/03');
  await guide.getByRole('button', { name: '上一步' }).click();
  await expect(guide).toHaveAttribute('data-step', '1');
});

test('loading and error states', async ({ page }) => {
  let guide = await open(page, 'state=loading');
  await expect(guide.getByText('正在读取首次设置…')).toBeVisible();
  guide = await open(page, 'state=error');
  await expect(guide.getByRole('alert')).toContainText('没有连上桌面端，请重试');
  await expect(guide.getByRole('button', { name: '重试' })).toBeVisible();
});

for (const [w, h] of [
  [900, 560],
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`no horizontal overflow and nothing cut off at ${w}×${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const demo of ['', 'demo=step2', 'demo=step3']) {
      const guide = await open(page, demo);
      await expect(guide.getByRole('button', { name: /^下一步|^完成/ })).toBeVisible();
      const over = await page.evaluate(() => {
        const g = document.querySelector('[role="dialog"]') as HTMLElement;
        const wide = [...g.querySelectorAll<HTMLElement>('*')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('[aria-hidden="true"]'));
        // Scroll areas inside the guide; the layer itself clips its decorative watermark.
        const scrolls = [...g.querySelectorAll<HTMLElement>('*')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
        // What does not fit vertically sits in a scroll area: the content row scrolls, it is not clipped.
        const row = g.querySelector<HTMLElement>(':scope > div')!;
        const clipped = row.scrollHeight > row.clientHeight + 1 && !/auto|scroll/.test(getComputedStyle(row).overflowY);
        return { doc: document.documentElement.scrollWidth > window.innerWidth, scrolls: scrolls.map((el) => el.className), wide: wide.map((el) => el.className).slice(0, 3), clipped };
      });
      expect(over, `${demo} at ${w}×${h}`).toEqual({ doc: false, scrolls: [], wide: [], clipped: false });
    }
  });
}

test('light theme uses the paper ground', async ({ page }) => {
  const guide = await open(page, 'theme=light');
  const bg = await guide.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(242, 241, 239)');
  await expect(guide.getByRole('list', { name: '角色名册' })).toBeVisible();
});
