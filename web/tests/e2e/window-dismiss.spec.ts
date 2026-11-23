import { expect, test } from '@playwright/test';

test('the memory dialog closes with the header X at the minimum window size; the schedule editor leaves with 取消', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('main.html#/tasks?tab=sched&plugins=all&still=1');
  await page.locator('[data-tasks-bar]').getByRole('button', { name: '新建定时任务' }).click();
  const form = page.getByRole('form', { name: '新建定时任务' });
  await expect(form).toBeVisible();
  await page.locator('[data-tasks-bar]').getByRole('button', { name: /^取消/ }).click();
  await expect(form).toHaveCount(0);
  for (const [path, trigger] of [['/memory?plugins=all&still=1&view=activity', '查看 核对渲染测试结果']] as const) {
    await page.goto(`main.html#${path}`);
    const opener = page.getByRole('button', { name: trigger, exact: true });
    await opener.click();
    const panel = page.getByRole('dialog');
    await panel.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
});

test('the project detail sheet releases its click target when dismissed', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('main.html#/memory?plugins=all&still=1&view=projects');
  const project = page.locator('[data-project]').first().getByRole('button');
  await project.click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(project).toBeFocused();
});
