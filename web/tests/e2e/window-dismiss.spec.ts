import { expect, test } from '@playwright/test';

test('desktop tuning can close with the X or with Escape before a mouse click', async ({ page }) => {
  const route = 'stack.html#/cmd?mode=tune&demo=tune&still=1';
  const panel = page.getByRole('dialog', { name: /镜头与动作/ });
  await page.goto(route);
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(panel).toHaveCount(0);

  await page.reload();
  await expect(panel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('the reminders popover closes independently of its hover ring', async ({ page }) => {
  await page.goto('stack.html#/ring?ring=icons&hover=1&pop=reminders&still=1');
  const popover = page.getByRole('region', { name: '提醒', exact: true });
  await popover.getByRole('button', { name: '关闭提醒详情' }).click();
  await expect(popover).toHaveCount(0);
  const icon = page.locator('[data-ring-icon="reminders"]');
  await expect(icon).toHaveAttribute('aria-expanded', 'false');
  await icon.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
});

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
