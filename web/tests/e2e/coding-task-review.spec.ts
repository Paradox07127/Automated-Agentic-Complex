import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { A1, T1 } from '../../src/mock/fixtures/ids';
import { CODE_FAILED, CODE_REVIEW } from '../../src/mock/tasks';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const THEMES = ['dark', 'light'] as const;
const open = (page: Page, hash: string, theme: (typeof THEMES)[number]) => page.goto(`main.html#${hash}${hash.includes('?') ? '&' : '?'}still=1${theme === 'light' ? '&theme=light' : ''}`);
const shot = (page: Page, name: string, theme: string) => saveShot(page, { path: `.shots/${test.info().project.name}/coding-task-review-${name}-${theme}.png` });

for (const theme of THEMES) {
  test(`${theme}: a coding task waiting for 验收 settles in the detail`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/overview?sel=${encodeURIComponent(CODE_REVIEW)}&demo=code-review`, theme);
    const detail = page.locator('[data-stub="TaskView"]');
    const bar = detail.getByRole('region', { name: '待处理' });
    await expect(bar).toContainText('没有设置检查命令');
    await expect(bar.getByRole('button', { name: '驳回' })).toBeVisible();
    // The detail sheet sits outside <main>; 今天 itself has no primary button.
    await expect(page.locator('[data-variant="primary"]:visible')).toHaveCount(1);
    await expect(detail).not.toContainText('no_verify_cmd');
    await shot(page, 'code-review', theme);
    await bar.getByRole('button', { name: '验收' }).click();
    await expect(page.getByText(/已验收「/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`${theme}: a failed check shows its exit code and folds the output`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/overview?sel=${encodeURIComponent(CODE_FAILED)}&demo=code-review`, theme);
    const check = page.locator('[data-stub="TaskView"] section[aria-label="检查"]');
    await expect(check).toContainText('检查没通过');
    await expect(check).toContainText('退出码 1');
    await expect(check).not.toContainText('XCTAssertEqual');
    await check.getByRole('button', { name: /检查输出/ }).click();
    await expect(check).toContainText('XCTAssertEqual');
    await shot(page, 'code-failed', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: earlier versions are reachable`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/overview?sel=${encodeURIComponent(T1)}`, theme);
    const section = page.locator('[data-stub="TaskView"] section[aria-label="产物"]');
    await expect(section.getByRole('button', { name: /v1/ })).toBeVisible();
    await shot(page, 'versions', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: a dangerous approval names its rule in words`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/overview?open=${A1}`, theme);
    await expect(page.getByRole('dialog').getByText('命中危险规则：强制递归删除')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('rm_recursive');
    await shot(page, 'danger-rule', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: chat composer offers 附加窗口 and 本轮不记录`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, '/chat', theme);
    const noMem = page.getByRole('button', { name: '本轮不记录' });
    await noMem.click();
    await expect(noMem).toHaveAttribute('aria-pressed', 'true');
    await page.locator('textarea[aria-label="消息"]').fill('这句不用记');
    await page.getByRole('button', { name: /发送/ }).click();
    await expect(page.getByText('这次只读，不记入历史')).toBeVisible();
    await expect(noMem).toHaveAttribute('aria-pressed', 'false');
    await shot(page, 'composer', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: overview counts today's failed task and failed turn under 出错 and dates the next reminder`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, '/overview', theme);
    const brief = page.getByRole('region', { name: '今日简报' });
    await expect(brief.getByRole('button', { name: /^出错 2，前往诊断/ })).toBeVisible();
    await expect(brief).toContainText('下一条提醒 15:00 交报销单');
    await shot(page, 'overview', theme);
    expect(errors).toEqual([]);
  });
}
