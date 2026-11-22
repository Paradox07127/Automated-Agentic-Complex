import { expect, test, type Page } from '@playwright/test';

// First-run guide on main.html#/onboarding (fake bridge, onboarding surface): the step cells, the settings rows, the action bar.

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
  const guide = page.locator('[data-page="onboarding"]');
  await expect(guide).toBeVisible();
  return guide;
}

const bar = (page: Page) => page.getByRole('group', { name: '首次设置操作' });

test('01 fills the window: step cells, the step card, the roster and 下一步', async ({ page }) => {
  const errors = collectErrors(page);
  const guide = await open(page);
  expect(await guide.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  await expect(page.getByRole('tab')).toHaveText(['角色', '对话', '声音', '完成']);
  await expect(page.getByRole('tab', { name: '01 角色' })).toHaveAttribute('aria-selected', 'true');
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('选她');
  await expect(guide.getByRole('radiogroup', { name: '角色名册' }).getByRole('radio')).toHaveCount(3);
  await expect(bar(page).getByRole('button', { name: '下一步' })).toBeEnabled();
  await expect(bar(page).getByRole('button', { name: '上一步' })).toHaveCount(0);
  await expect(page.getByText('ENDFIELD')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('walks 对话 → 声音 → 完成 with a connected account and leaves for 主页 in the preview', async ({ page }) => {
  const errors = collectErrors(page);
  const guide = await open(page, 'demo=chat-ok');
  await expect(guide).toHaveAttribute('data-step', '2');
  await expect(guide.getByText(/^已连上 │ 回复/)).toBeVisible();
  await bar(page).getByRole('button', { name: '下一步' }).click();
  await expect(guide).toHaveAttribute('data-step', '3');
  await expect(guide.getByRole('group', { name: '按住说话' })).toBeVisible();
  await bar(page).getByRole('button', { name: '下一步' }).click();
  await expect(guide).toHaveAttribute('data-step', '4');
  await expect(guide.getByRole('heading', { level: 1 })).toHaveText('示例乙 已在桌面就位');
  expect(errors).toEqual([]);
  await bar(page).getByRole('button', { name: '打开主窗口' }).click();
  await expect(page.locator('main[data-route-id="home"]')).toBeVisible();
});

test('02 without a connected account: 下一步 waits, 稍后再连 skips the step', async ({ page }) => {
  const guide = await open(page, 'demo=chat');
  await expect(guide.getByRole('group', { name: 'ChatGPT 账号' })).toContainText('还没有连接');
  await expect(bar(page).getByRole('button', { name: '下一步' })).toBeDisabled();
  await bar(page).getByRole('button', { name: '稍后再连' }).click();
  await expect(guide).toHaveAttribute('data-step', '3');
  await expect(page.getByRole('tab', { name: '02 对话' }).locator('[data-step]')).toHaveAttribute('data-step', 'skip');
});

test('跳过引导 asks on white paper; Esc keeps the guide', async ({ page }) => {
  const guide = await open(page);
  await guide.locator('header').getByRole('button', { name: '跳过引导' }).click();
  const paper = page.getByRole('dialog', { name: '跳过首次设置？' });
  await expect(paper).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(paper).toHaveCount(0);
  await guide.locator('header').getByRole('button', { name: '跳过引导' }).click();
  await page.getByRole('dialog', { name: '跳过首次设置？' }).getByRole('button', { name: '跳过' }).click();
  await expect(page.locator('main[data-route-id="home"]')).toBeVisible();
});

test('Q and E step through the cells', async ({ page }) => {
  const guide = await open(page, 'demo=chat-ok');
  await expect(guide).toHaveAttribute('data-step', '2');
  await page.keyboard.press('q');
  await expect(guide).toHaveAttribute('data-step', '1');
  await page.keyboard.press('e');
  await expect(guide).toHaveAttribute('data-step', '2');
});

test('loading and error states', async ({ page }) => {
  let guide = await open(page, 'state=loading');
  await expect(guide.getByText('正在读取首次设置…')).toBeVisible();
  guide = await open(page, 'state=error');
  await expect(guide.getByRole('alert')).toContainText('没有连上桌面端，请重试');
  await expect(guide.getByRole('button', { name: '重试' })).toBeVisible();
});

for (const [w, h] of [
  [925, 515],
  [1280, 800],
  [1440, 900],
] as const) {
  test(`no horizontal overflow at ${w}×${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const demo of ['', 'demo=chat', 'demo=voice', 'demo=done']) {
      const guide = await open(page, demo);
      await expect(guide).toHaveAttribute('data-step', /\d/);
      const over = await page.evaluate(() => {
        const scrolls = [...document.querySelectorAll<HTMLElement>('[data-page="onboarding"] *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX));
        return { doc: document.documentElement.scrollWidth > window.innerWidth, scrolls: scrolls.map((el) => el.className) };
      });
      expect(over, `${demo} at ${w}×${h}`).toEqual({ doc: false, scrolls: [] });
    }
  });
}
