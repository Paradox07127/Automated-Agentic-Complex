import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// An approval or question on a HUD session line is a compact block of about 88–110 px.

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
  await page.getByRole('button', { name: /^展开全部/ }).click();
}

async function shot(page: Page, project: string, name: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await saveShot(page, { path: `${shotsDir}${project}/session-approval-${name}.png`, omitBackground: true });
}

async function heightOf(page: Page, selector: string) {
  const box = await page.locator('[data-hud-row]').first().locator(selector).boundingBox();
  return box?.height ?? 0;
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: an edit approval in its session`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'session-approval', theme);
    const block = page.locator('[data-hud-row]').first().locator('[data-stub="SessionApproval"]');
    await expect(block.locator('[data-action]')).toHaveText('改 HostLink.swift');
    await expect(block.locator('[data-danger-mark]')).toHaveCount(0);
    await expect(block.getByRole('button', { name: '本对话都允许' })).toBeVisible();
    await expect(page.locator('[data-stub="CountdownRing"]')).toHaveCount(0);
    const h = await heightOf(page, '[data-stub="SessionApproval"]');
    expect(h).toBeGreaterThanOrEqual(88);
    expect(h).toBeLessThanOrEqual(110);
    await shot(page, info.project.name, `${theme}-session-approval`);
    await block.getByRole('button', { name: /^差异/ }).click();
    await expect(block).toContainText('let timeout: TimeInterval = 3.0');
    await shot(page, info.project.name, `${theme}-session-approval-diff`);
    await block.getByRole('button', { name: '详情' }).click();
    await expect(block).toContainText('Sources/CompanionCore/HostLink.swift');
    await shot(page, info.project.name, `${theme}-session-approval-details`);
    expect(errors).toEqual([]);
  });

  test(`${theme}: a dangerous command in its session`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'session-danger', theme);
    const block = page.locator('[data-hud-row]').first().locator('[data-stub="SessionApproval"]');
    await expect(block.locator('[data-action]')).toContainText('运行 rm -rf build/');
    await expect(block.locator('[data-danger-mark]')).toHaveText('强制递归删除');
    await expect(block.getByRole('button', { name: '本对话都允许' })).toHaveCount(0);
    const h = await heightOf(page, '[data-stub="SessionApproval"]');
    expect(h).toBeGreaterThanOrEqual(88);
    expect(h).toBeLessThanOrEqual(110);
    await shot(page, info.project.name, `${theme}-session-danger`);
    await block.getByRole('button', { name: '命令' }).click();
    await expect(block.locator('[data-stub="CmdBlock"]')).toBeVisible();
    await shot(page, info.project.name, `${theme}-session-danger-cmd`);
    expect(errors).toEqual([]);
  });

  test(`${theme}: a question in its session`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await open(page, 'session-question', theme);
    const form = page.locator('[data-hud-row]').first().locator('[data-stub="QuestionBox"][data-session]');
    await expect(form).toContainText('周报里要不要包含外部会话的提交？');
    await expect(form.getByRole('button', { name: '包含', exact: true })).toBeVisible();
    await expect(form.getByRole('textbox', { name: '写下回答' })).toBeVisible();
    await expect(page.locator('[data-art-slot]')).toHaveCount(0);
    await shot(page, info.project.name, `${theme}-session-question`);
    expect(errors).toEqual([]);
  });
}
