import { expect, test, type Page } from '@playwright/test';

// Diag: five tabs — 总览 rows, 进程 curves, 渲染 frames, 管道 flow with hours and model calls, 状态 blocks.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const node = (page: Page, label: string) => page.locator(`button[aria-label^="${label} │ "]`);
const TABS = ['overview', 'proc', 'render', 'flow', 'state'] as const;

test('diag: 总览 lists the link rows, then the run rows, without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  await expect(page.locator('main [data-stub="SecHead"] h3')).toHaveText(['链路', '运行']);
  await expect(page.locator('[data-row]')).toHaveCount(6);
  await expect(page.getByRole('tab')).toHaveText(['总览', '进程', '帧与负载', '链路', '内部状态', '对话轮次', '事件线', '行为决策', '日志']);
  expect(errors).toEqual([]);
});

test('diag: the tabs switch by click and by 1–9; a row › opens its tab', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  await page.getByRole('tab', { name: '链路' }).click();
  await expect(node(page, '模型')).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.getByRole('radiogroup', { name: '曲线' })).toBeVisible();
  await page.keyboard.press('1');
  await page.locator('[data-row="gate"]').getByRole('button', { name: '去内部状态' }).click();
  await expect(page.getByRole('region', { name: '主动发言闸门' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('diag 管道: a node opens its failures; Esc clears it before leaving the page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('main.html#/diag?still=1&tab=flow&demo=full');
  await node(page, '语音').click();
  await expect(node(page, '语音')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '在对话轮次里看' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(node(page, '语音')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-page="diag"]')).toBeVisible();
});

test('diag: 暂停 stops the live lamp; 重启 asks first', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1&tab=proc');
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已暂停' })).toBeVisible();
  await page.locator('[data-nav-target="proc-avatar"]').getByRole('button', { name: '重启' }).click();
  await expect(page.getByRole('dialog', { name: '重启角色？' })).toBeVisible();
  await page.getByRole('button', { name: '不重启' }).click();
  expect(errors).toEqual([]);
});

test('diag: 运行来源 names the packaged app, or marks a dev deployment with its commit', async ({ page }) => {
  await page.goto('main.html#/diag?still=1');
  const line = page.locator('p').filter({ hasText: '运行来源' });
  await expect(line).toHaveText(/运行来源正式打包fake/);
  await expect(line).not.toHaveAttribute('data-dev');
  await page.goto('main.html#/diag?still=1&source=dev');
  await page.reload();
  await expect(line).toHaveText('▲运行来源开发目录09c8967d0含未提交改动');
  await expect(line).toHaveAttribute('data-dev', 'true');
});

test('diag error: agentd gone shows the alert with the one yellow 重启后台服务; the lamp says 已断开', async ({ page }) => {
  await page.goto('main.html#/diag?still=1&state=error');
  const alert = page.getByRole('alert').filter({ hasText: '后台服务没有响应' });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: /重启后台服务/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已断开' })).toBeVisible();
  await expect(page.locator('[data-row="agentd"]')).toBeVisible();
});

test('diag 管道: no text under 12 px outside marks', async ({ page }) => {
  await page.goto('main.html#/diag?still=1&tab=flow&demo=sparse');
  await expect(node(page, '会话')).toHaveAttribute('data-st', 'idle');
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="管道"] *')]
      // Section heads are shared; aria-hidden glyphs and belt counts are marks, not text.
      .filter((e) => !e.closest('[aria-hidden="true"], [data-stub="SecHead"], [data-stub="MicroLabel"]'))
      .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && /[一-鿿]/.test(n.textContent ?? '')) && (e as HTMLElement).getBoundingClientRect().width > 0)
      .map((e) => parseFloat(getComputedStyle(e).fontSize))
      .filter((px) => px < 12),
  );
  expect(small).toEqual([]);
});

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`diag at ${w}×${h} has no horizontal overflow on any tab`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const tab of TABS) {
      await page.goto(`main.html#/diag?still=1&demo=full&tab=${tab}`);
      await expect(page.locator(`[data-page="diag"][data-tab="${tab}"]`)).toBeVisible();
      const over = await page.evaluate(() => {
        const els = [document.documentElement, ...document.querySelectorAll('main, [data-page="diag"], [data-page="diag"] section')];
        return els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName}.${el.getAttribute('aria-label') ?? ''} ${el.scrollWidth}>${el.clientWidth}`);
      });
      expect(over, tab).toEqual([]);
    }
  });
}
