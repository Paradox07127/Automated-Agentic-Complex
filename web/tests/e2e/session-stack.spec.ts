import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Presence sessions as the HUD's lines, with an approval on its session.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, demo: string, theme: 'dark' | 'light') {
  await page.goto('about:blank');
  await page.goto(`stack.html#/hud?${new URLSearchParams({ demo, theme, still: '1' }).toString()}`);
  await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function shot(page: Page, project: string, name: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await saveShot(page, { path: `${shotsDir}${project}/session-stack-${name}.png`, omitBackground: true });
}

const lines = (page: Page) => page.locator('[data-hud-row]');
const expand = (page: Page) => page.getByRole('button', { name: /^展开全部/ });

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: one running session`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'session-one', theme);
    await expect(lines(page)).toHaveCount(1);
    const line = lines(page).first();
    await expect(line).toHaveAttribute('data-status', 'running');
    await expect(line.getByRole('img', { name: '运行中' })).toBeVisible();
    await expect(line).toContainText('整理渲染管线的构建脚本');
    await expand(page).click();
    await expect(lines(page).first()).toContainText('Codex');
    await shot(page, info.project.name, `${theme}-session-one`);
    expect(errors).toEqual([]);
  });

  test(`${theme}: the running line says what she does and keeps its height between tools`, async ({ page }, info) => {
    const errors = collectErrors(page);
    const heights: number[] = [];
    // Between tools agentd's `doing` says she thinks; the line keeps its height either way.
    for (const [demo, doing] of [
      ['session-one', '│ 跑一遍 host 单元测试'],
      ['session-between', '│ 在想'],
      ['session-one', '│ 跑一遍 host 单元测试'],
    ] as const) {
      await open(page, demo, theme);
      const line = lines(page).first();
      await expect(line).toHaveAttribute('data-status', 'running');
      await expect(line.locator('[data-hud-act]')).toHaveText(doing);
      await expect(line).not.toContainText('Bash');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      heights.push((await line.boundingBox())?.height ?? 0);
      if (demo === 'session-between') await shot(page, info.project.name, `${theme}-session-between`);
    }
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights).toEqual([heights[0], heights[0], heights[0]]);
    expect(errors).toEqual([]);
  });

  test(`${theme}: three sessions folded, then expanded`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'sessions', theme);
    await expect(lines(page)).toHaveCount(1);
    const toggle = page.getByRole('button', { name: '展开全部 3 条' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle.locator('[data-edge]')).toHaveCount(2);
    await shot(page, info.project.name, `${theme}-sessions-folded`);

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(lines(page)).toHaveCount(3);
    expect(await lines(page).locator('[data-glyph]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['出错', '运行中', '完成']);
    await shot(page, info.project.name, `${theme}-sessions-expanded`);
    await page.keyboard.press('Escape');
    await expect(lines(page)).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test(`${theme}: a waiting session with its approval inline`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'session-approval', theme);
    await expand(page).click();
    const top = lines(page).first();
    await expect(top).toHaveAttribute('data-status', 'waiting');
    await expect(top.getByRole('img', { name: '待处理' })).toBeVisible();
    await expect(top.locator('[data-card-id]')).toHaveCount(1);
    await expect(top.getByRole('button', { name: '批准' })).toBeVisible();
    await expect(page.locator('[data-card-id]')).toHaveCount(1);
    // The approval stays inside the line's edges.
    const outer = await top.boundingBox();
    const inner = await top.locator('[data-card-id]').boundingBox();
    expect(outer && inner && inner.x >= outer.x && inner.x + inner.width <= outer.x + outer.width + 0.5).toBe(true);
    await shot(page, info.project.name, `${theme}-session-approval`);
    expect(errors).toEqual([]);
  });

  test(`${theme}: empty shows nothing`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'empty', theme);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    await expect(lines(page)).toHaveCount(0);
    await shot(page, info.project.name, `${theme}-empty`);
    expect(errors).toEqual([]);
  });
}
