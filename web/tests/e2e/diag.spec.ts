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

test('diag: 总览 lists the link rows, then the run rows, without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  await expect(page.locator('main [data-stub="SecHead"] h3')).toHaveText(['链路', '运行', '错误']);
  await expect(page.locator('[data-row]')).toHaveCount(6);
  await expect(page.getByRole('tab')).toHaveText(['总览', '进程', '帧与负载', '链路', '内部状态', '对话轮次', '事件线', '行为决策', '日志']);
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

