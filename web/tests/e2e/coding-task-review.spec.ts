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
    await open(page, `/tasks?sel=${encodeURIComponent(CODE_REVIEW)}&demo=code-review&plugins=all`, theme);
    const detail = page.getByRole('region', { name: '详情' });
    const bar = detail.getByRole('heading', { name: '验收编码结果' }).locator('..');
    await expect(bar).toContainText('没有设置检查命令');
    await expect(bar.getByRole('button', { name: '驳回' })).toBeVisible();
    await expect(page.locator('main [data-variant="primary"]:visible')).toHaveCount(1);
    await expect(detail).not.toContainText('no_verify_cmd');
    await shot(page, 'code-review', theme);
    await bar.getByRole('button', { name: '验收' }).click();
    await expect(page.getByText(/已验收「/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`${theme}: a failed check shows its exit code and folds the output`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/tasks?sel=${encodeURIComponent(CODE_FAILED)}&demo=code-review&plugins=all`, theme);
    const check = page.getByRole('region', { name: '详情' }).locator('section[aria-label="检查"]');
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
    await open(page, `/tasks?sel=${encodeURIComponent(T1)}`, theme);
    const chain = page.getByRole('group', { name: '版本链' });
    await expect(chain.getByRole('button', { name: /v1/ })).toBeVisible();
    await shot(page, 'versions', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: a dangerous approval names its rule in words`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, `/overview?focus=item-${A1}`, theme);
    await expect(page.locator('main').getByText('命中危险规则：强制递归删除')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('rm_recursive');
    await shot(page, 'danger-rule', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: the chat composer's ＋ menu turns on 这句不记 for one line`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, '/chat', theme);
    await page.getByRole('button', { name: '附加' }).click();
    await page.getByRole('menu').getByText('这句不记').click();
    const chip = page.getByRole('button', { name: '取消这句不记' });
    await expect(chip).toBeVisible();
    await page.locator('textarea[aria-label="消息"]').fill('这句不用记');
    await page.getByRole('button', { name: /发送/ }).click();
    await expect(chip).toHaveCount(0);
    await shot(page, 'composer', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: overview reads 出错 in the readouts and dates the next reminder in 今日一句`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, '/overview', theme);
    await expect(page.getByRole('list', { name: '读数' }).locator('[data-item="err"]')).toContainText(/^\d+出错/);
    await expect(page.getByRole('region', { name: '今日一句' })).toContainText('下一条提醒 15:00 交报销单');
    await shot(page, 'overview', theme);
    expect(errors).toEqual([]);
  });
}
