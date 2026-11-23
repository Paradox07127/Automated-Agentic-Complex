import { expect, test, type Page } from '@playwright/test';

// 主页右列：一屏五行，滚轮滚出第 6–8 行；开发者模式时第 9 行起是诊断和管线。

async function open(page: Page, dev: boolean) {
  await page.addInitScript((d) => localStorage.setItem('ef.devMode', d), dev ? '1' : '0');
  await page.setViewportSize({ width: 1385, height: 770 });
  await page.goto('main.html#/home?plugins=all&still=1');
  await expect(page.getByRole('button', { name: '派发任务' })).toBeVisible();
}

/** Names of the list's keys in view and taking the pointer at the middle of their raised face. */
const shown = (page: Page) =>
  page.locator('[data-page="home"] [aria-label="工具"]').evaluate((list) =>
    [...list.querySelectorAll('button')].flatMap((b) => {
      if (b.closest('[data-out]')) return [];
      const faces = b.querySelectorAll(':scope svg[width]');
      const r = faces[faces.length - 1]!.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === b ? [b.getAttribute('aria-label')] : [];
    }),
  );

async function wheel(page: Page, notches: number) {
  const box = (await page.getByRole('button', { name: '搜索' }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, 100);
  await page.mouse.move(5, 5);
}

const ROWS_6_8 = ['拍照', 'MMD', '角色这一天', '时间', '能力', '感知'];
const DEV_ROWS = ['诊断', '对话轮次', '日志', '管线'];

test('home list: five rows at first; the wheel brings rows 6–8 in, and the first rows go', async ({ page }) => {
  await open(page, false);
  const first = await shown(page);
  expect(first).toEqual(['派发任务', '搜索', '快速输入', '屏幕识读', '停止说话', '定时', '档案', '回顾', '外观', '动作表']);
  await wheel(page, 12);
  await expect.poll(() => shown(page)).toEqual(expect.arrayContaining(ROWS_6_8));
  const after = await shown(page);
  expect(after).not.toContain('派发任务');
  expect(after).not.toContain('诊断');
});

test('home list: in 开发者模式 the wheel reaches rows 9 on, the developer views', async ({ page }) => {
  await open(page, true);
  expect(await shown(page)).not.toContain('诊断');
  await wheel(page, 20);
  await expect.poll(() => shown(page)).toEqual(expect.arrayContaining(DEV_ROWS));
  await page.getByRole('button', { name: '对话轮次' }).click();
  await expect(page).toHaveURL(/#\/diag\?.*tab=turns/);
});
