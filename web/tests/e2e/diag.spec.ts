import { expect, test, type Page } from '@playwright/test';

// Diag: one page — health, pipeline flow, turn timeline and details, resources, processes, internal state.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const node = (page: Page, label: string) => page.locator(`button[aria-label^="${label} │ "]`);

test('diag: processes in the health strip, then the sections in order, without horizontal overflow', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  await expect(node(page, '模型')).toBeVisible();
  await expect(page.locator('main [data-stub="SecHead"] h3')).toHaveText(['流程图', '轮次时间轴', '资源']);
  const procs = (await page.getByRole('region', { name: '进程' }).boundingBox())!;
  const flow = (await page.getByRole('region', { name: '流程图' }).boundingBox())!;
  expect(procs.y + procs.height).toBeLessThanOrEqual(flow.y);
  await expect(page.getByText('内部状态', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /轮次时间轴：\d+ 轮/ })).toBeVisible();
  await expect(page.getByText('今日用量')).toBeVisible();
  expect(errors).toEqual([]);
});

test('diag: a node filters the turns; clicking a turn replays it and opens 轮次详情', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  await node(page, '解读').click();
  await expect(page.getByText(/下方时间轴已按此节点筛选/)).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  const tl = page.getByRole('img', { name: /轮次时间轴/ });
  const box = (await tl.boundingBox())!;
  await page.mouse.move(box.x + box.width - 14, box.y + 60);
  await page.mouse.click(box.x + box.width - 14, box.y + 60);
  await expect(page.getByText('轮次详情')).toBeVisible();
  await expect(page.getByText(/已回放|回放中/)).toBeVisible();
  await page.getByRole('button', { name: '退出回放' }).click();
  await expect(page.getByText('轮次详情')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('diag: 暂停 stops the live label; 重启 asks first', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('main.html#/diag?still=1');
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByText(/只存本机 │ 已暂停/)).toBeVisible();
  await page.locator('[data-nav-target="proc-avatar"]').getByRole('button', { name: '重启' }).click();
  await expect(page.getByRole('dialog', { name: '重启角色？' })).toBeVisible();
  await page.getByRole('button', { name: '不重启' }).click();
  await page.getByText('内部状态', { exact: true }).click();
  await expect(page.getByText('主动发言闸门', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('diag: 运行来源 names the packaged app, or marks a dev deployment with its commit', async ({ page }) => {
  await page.goto('main.html#/diag?still=1');
  const line = page.locator('p').filter({ hasText: '运行来源' });
  await expect(line).toHaveText(/运行来源正式打包 │ fake/);
  await expect(line).not.toHaveAttribute('data-dev');
  await page.goto('main.html#/diag?still=1&source=dev');
  await page.reload();
  await expect(line).toHaveText('▲运行来源开发目录 │ 09c8967d0 │ 含未提交改动');
  await expect(line).toHaveAttribute('data-dev', 'true');
});

test('diag sparse: nine turns today', async ({ page }) => {
  await page.goto('main.html#/diag?still=1&demo=sparse');
  await expect(page.getByRole('img', { name: /^轮次时间轴：9 轮，失败 1 轮/ })).toBeVisible();
  await expect(page.getByText('$0.06')).toBeVisible();
});

test('diag error: agentd gone shows the alert; the flow stays readable and the processes still read', async ({ page }) => {
  await page.goto('main.html#/diag?still=1&state=error');
  const alert = page.getByRole('alert').filter({ hasText: '后台服务无响应' });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: /重启后台服务/ })).toBeVisible();
  await expect(page.locator('[data-dead]')).toHaveCount(1);
  expect(await page.locator('[data-dead]').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  await expect(page.locator('[data-nav-target="proc-agentd"]')).toBeVisible();
  await expect(page.getByText(/只存本机 │ 已断开/)).toBeVisible();
});

test('diag flow: idle nodes are dashed at full opacity, no ordinals, no text under 12 px', async ({ page }) => {
  await page.goto('main.html#/diag?still=1&demo=sparse');
  const idle = node(page, '会话');
  await expect(idle).toHaveAttribute('data-st', 'idle');
  expect(await idle.evaluate((e) => [getComputedStyle(e).borderTopStyle, getComputedStyle(e).opacity])).toEqual(['dashed', '1']);
  expect(await idle.textContent()).not.toMatch(/^\d/);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('[data-dead], section[aria-label="流程图"] *')]
      // Section heads are shared; aria-hidden glyphs (■ ▲) are marks, not text.
      .filter((e) => !e.closest('[aria-hidden="true"], [data-stub="SecHead"]'))
      .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) && (e as HTMLElement).getBoundingClientRect().width > 0)
      .map((e) => parseFloat(getComputedStyle(e).fontSize))
      .filter((px) => px < 12),
  );
  expect(small).toEqual([]);
});

for (const [w, h] of [
  [900, 600],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`diag at ${w}×${h} has no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('main.html#/diag?still=1&sel=tr3');
    await expect(page.getByText('轮次详情')).toBeVisible();
    const over = await page.evaluate(() => {
      const els = [document.documentElement, ...document.querySelectorAll('main, [data-page="diag"], [data-page="diag"] section')];
      return els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName}.${el.getAttribute('aria-label') ?? ''} ${el.scrollWidth}>${el.clientWidth}`);
    });
    expect(over).toEqual([]);
  });
}
