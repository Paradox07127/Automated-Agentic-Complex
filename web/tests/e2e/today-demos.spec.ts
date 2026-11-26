import { expect, test } from '@playwright/test';

for (const [id, demo] of [['overview', 'agentd-off'], ['chat', 'disconnected']] as const) {
  test(`${id}: ${demo} demo is listed`, async ({ page }) => {
    await page.goto('main.html#/overview?still=1');
    const demos = await page.evaluate((rid) => (window as unknown as { __EF_ROUTES__: Array<{ id: string; demos: Array<{ name: string }> }> }).__EF_ROUTES__.find((r) => r.id === rid)?.demos.map((d) => d.name), id);
    expect(demos).toContain(demo);
  });
}

