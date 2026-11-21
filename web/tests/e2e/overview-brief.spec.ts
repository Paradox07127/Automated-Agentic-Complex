import { expect, test } from '@playwright/test';

test('overview brief: reminders are ▼ on the ruler and keep their full title and time for screen readers and hover', async ({ page }) => {
  await page.goto('main.html#/overview?still=1');
  const ruler = page.locator('section[aria-label="今日简报"] [data-nav-target="reminders"]');
  await expect(ruler.locator('[role="img"][aria-label="提醒 │ 交报销单 15:00"]')).toHaveCount(1);
  await expect(ruler.locator('[role="img"][aria-label="提醒 │ 站会，已提醒，已显示 10:30"]')).toHaveCount(1);
  await expect(page.locator('section[aria-label="今日简报"]')).toContainText('下一条提醒 15:00 交报销单');
});
