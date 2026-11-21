import { expect, test, type Page } from '@playwright/test';
import { A1 } from '../../src/mock/fixtures/ids';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

for (const [id, demo] of [['overview', 'agentd-off'], ['chat', 'disconnected']] as const) {
  test(`${id}: ${demo} demo is listed`, async ({ page }) => {
    await page.goto('main.html#/overview?still=1');
    const demos = await page.evaluate((rid) => (window as unknown as { __EF_ROUTES__: Array<{ id: string; demos: Array<{ name: string }> }> }).__EF_ROUTES__.find((r) => r.id === rid)?.demos.map((d) => d.name), id);
    expect(demos).toContain(demo);
  });
}

test('今天: disconnected keeps the last data with its time, 查看诊断 and 重试', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?demo=disconnected&still=1');
  const bar = page.getByRole('alert').filter({ hasText: '显示上次读到的数据' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/下面是 \d\d:\d\d 的数据/);
  await expect(bar.getByRole('button', { name: '重试' })).toBeVisible();
  await expect(page.locator(`section[aria-label="待处理"] [data-item="${A1}"]`)).toBeVisible();
  await bar.getByRole('button', { name: /查看诊断/ }).click();
  await expect(page).toHaveURL(/#\/diag\?/);
  expect(errors).toEqual([]);
});
