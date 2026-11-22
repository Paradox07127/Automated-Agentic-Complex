import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { T1, T2 } from '../../src/mock/fixtures/ids';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('detail-review: the version waiting for review is a paper on the first screen; the detail has one yellow button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/tasks?plugins=all&sel=${encodeURIComponent(T1)}&still=1`);
  const detail = page.getByRole('region', { name: '详情' });
  const accept = detail.getByRole('button', { name: '接受 v2' });
  await expect(accept).toBeInViewport();
  await expect(detail.locator('[data-variant="primary"]:visible')).toHaveCount(1);
  expect(await detail.innerText()).not.toContain('Delivery');
  expect(errors).toEqual([]);
});

test('dispatch: ⌘N opens the editor in the detail column; Esc leaves it, ⌘↵ sends it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/tasks?plugins=all&still=1');
  await expect(page.getByRole('region', { name: '任务列表' }).getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+n');
  const form = page.getByRole('form', { name: '派发任务' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('标题')).toHaveValue('');
  await expect(form.getByText('目标')).toHaveCount(0);
  await saveShot(page, { path: `.shots/${test.info().project.name}/task-detail-dispatch.png` });
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(/#\/tasks/);

  await page.keyboard.press('ControlOrMeta+n');
  await form.getByLabel('标题').fill('核对预算');
  await form.getByLabel('要求').fill('比较两份预算并说明差异。');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(form).toHaveCount(0);
  await expect(page.getByText(/^已交派：/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('产物: ⏎ on a file opens it; its menu copies the path', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/tasks?plugins=all&sel=${encodeURIComponent(T1)}&still=1`);
  const files = page.getByRole('group', { name: '产物' }).getByRole('button');
  await files.first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^已打开：/)).toBeVisible();
  await files.first().focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: '复制路径' }).click();
  await expect(page.getByText(/^已复制路径：/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('approval: Esc on the approval paper only leaves; nothing is denied', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/tasks?plugins=all&sel=${encodeURIComponent(T2)}&still=1`);
  const card = page.getByRole('region', { name: '详情' }).locator('[data-focus-card]').first();
  await card.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/^已拒绝/)).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/tasks/);
  await page.goBack();
  await expect(page.getByRole('region', { name: '详情' }).locator('[data-focus-card]').first()).toBeVisible();
  expect(errors).toEqual([]);
});
