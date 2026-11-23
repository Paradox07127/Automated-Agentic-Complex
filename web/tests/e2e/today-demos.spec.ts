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

test('今天: disconnected says 后台 未接入 over the last data with its time, 重新读取 and 重启后台', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/overview?demo=disconnected&plugins=daily_brief&still=1');
  const strip = page.getByRole('status', { name: '后台' });
  await expect(strip).toContainText('未接入');
  await expect(strip).toContainText(/下面是 \d\d:\d\d 读到的数据/);
  await expect(strip.getByRole('button', { name: '重新读取' })).toBeVisible();
  await expect(strip.getByRole('button', { name: /重启后台/ })).toBeVisible();
  await expect(page.locator(`section[aria-label="待处理"] [data-item="${A1}"]`)).toBeVisible();
  expect(errors).toEqual([]);
});
