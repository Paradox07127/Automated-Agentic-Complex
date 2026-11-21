import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { A2, T1 } from '../../src/mock/fixtures/ids';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('detail-review: one 待处理 bar on the first screen, no repeated count, one yellow button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/overview?plugins=all&sel=${encodeURIComponent(T1)}&still=1`);
  const detail = page.locator('[data-stub="TaskView"]');
  await expect(detail).toBeVisible();
  await expect(detail.locator('[data-stub="DecisionBar"]')).toHaveCount(1);
  await expect(detail.locator('[data-stub="NeedBox"]')).toHaveCount(0);
  const bar = detail.locator('[data-stub="DecisionBar"]');
  const box = await bar.boundingBox();
  expect(box && box.y + box.height).toBeLessThan(800);
  const text = await detail.innerText();
  expect(text.match(/0\/2/g) ?? []).toHaveLength(1);
  expect(text).not.toContain('Delivery');
  // The detail sheet sits outside <main>; 今天 itself has no primary button.
  await expect(page.locator('[data-variant="primary"]:visible')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('create-code: centred solid Dialog with the whole title; Esc closes, ⌘↵ submits', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&create=code&still=1');
  const dialog = page.getByRole('dialog', { name: '新建' });
  await expect(dialog).toBeVisible();
  const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('transparent');
  expect(bg).not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)$/);
  // The whole overlay is opaque: nothing of the page shows through the panel.
  const opacity = await dialog.evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });
  expect(opacity).toBe(1);
  await saveShot(page, { path: `.shots/${test.info().project.name}/task-detail-create-code.png` });
  const title = dialog.getByRole('heading', { name: '新建' });
  const fits = await title.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().top >= 0);
  expect(fits).toBe(true);
  const dbox = await dialog.boundingBox();
  expect(Math.abs((dbox?.width ?? 0) - 560)).toBeLessThanOrEqual(1);
  await expect(dialog.getByRole('button', { name: /交派/ })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+n');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('标题').fill('核对预算');
  await dialog.getByLabel('要求').fill('比较两份预算并说明差异。');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/^已交派：/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('detail sheet: ↑↓ ↵ on the artifact table opens a file', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/overview?plugins=all&sel=${encodeURIComponent(T1)}&still=1`);
  await expect(page.locator('[data-stub="TaskView"]')).toBeVisible();
  const rows = page.getByRole('grid', { name: '产物' }).locator('tbody tr');
  await rows.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^已打开：/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('approval detail: Esc on the approval card denies it and the card leaves the 待处理 band', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`main.html#/overview?plugins=all&open=${A2}&still=1`);
  const card = page.locator('[data-focus-card]');
  await card.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/^已拒绝/)).toBeVisible();
  await expect(page.getByRole('region', { name: '待处理' }).locator(`[data-k="${A2}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('create dialog open: ⌘N keeps focus inside the dialog', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?plugins=all&still=1');
  await expect(page.getByRole('button', { name: '任务记录' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+n');
  const dialog = page.getByRole('dialog', { name: '新建' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /交派/ }).focus();
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.getByRole('dialog', { name: '新建' })).toHaveCount(1);
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  expect(errors).toEqual([]);
});

test('a new role task has empty fields and the visible X closes it', async ({ page }) => {
  await page.goto('main.html#/overview?plugins=all&still=1');
  await page.getByRole('button', { name: '派发任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建' });
  await expect(dialog.getByLabel('标题')).toHaveValue('');
  await expect(dialog.getByLabel('要求')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '交派' })).toBeDisabled();
  await dialog.getByLabel('标题').fill('比较两个预算方案');
  await dialog.getByLabel('要求').fill('核对成本和总工期并给出推荐。');
  await dialog.getByRole('button', { name: /验收条件/ }).click();
  await dialog.getByPlaceholder('例如：汇总.md').fill('结果.md');
  await dialog.getByRole('button', { name: /验收条件/ }).click();
  await expect(dialog.getByRole('button', { name: /验收条件/ })).toContainText('结果.md');
  await expect(dialog.getByRole('button', { name: '交派' })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
});
