import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// Trace components, DecisionBar, and the approval / delivery composites without paper, tape or eyebrow.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));
const demo = (c: string, d: string, extra = '') => `tests/fixtures/catalog/index.html#?c=${c}&d=${d}&still=1${extra}`;

async function open(page: Page, c: string, d: string, extra = '') {
  await page.goto(demo(c, d, extra));
  await expect(page.locator(`[data-stub="${c}"]`).first()).toBeVisible();
}

test('TraceLine expands from the keyboard in the browser', async ({ page }) => {
  await open(page, 'TraceLine', 'tool');
  const row = page.locator('[data-stub="TraceLine"] [role="button"]').first();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-stub="CodeBlock"]')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
});

test('RawFold keeps the raw text folded; CodeBlock previews 20 lines', async ({ page }) => {
  await open(page, 'RawFold', 'default');
  const toggle = page.getByRole('button', { name: /运行日志/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-stub="CodeBlock"]')).toHaveCount(0);
  await open(page, 'CodeBlock', 'long');
  await expect(page.locator('[data-line]')).toHaveCount(20);
  await page.getByRole('button', { name: /^全部 \d+ 行$/ }).click();
  expect(await page.locator('[data-line]').count()).toBeGreaterThan(20);
});

test('dangerous approve ignores Enter and Space; the button sits inside the card', async ({ page }) => {
  await open(page, 'ApprovalCard', 'danger');
  const card = page.locator('[data-stub="ApprovalCard"]');
  const approve = card.locator('[data-approve] button');
  await expect(approve).toHaveText('批准');
  for (const key of ['Enter', 'Space']) {
    await approve.focus();
    await page.keyboard.press(key);
    await expect(card.getByRole('alert')).toContainText('只能用鼠标点');
    await expect(card).not.toHaveAttribute('data-outcome');
  }
  const [c, b] = await Promise.all([card.boundingBox(), approve.boundingBox()]);
  expect(b && c && b.y + b.height <= c.y + c.height && b.x + b.width <= c.x + c.width).toBe(true);
  const look = await card.evaluate((el) => {
    const s = getComputedStyle(el);
    return { shadow: s.boxShadow, radius: s.borderTopRightRadius };
  });
  expect(look).toEqual({ shadow: 'none', radius: '0px' });
});

test('DeliveryChain puts the chain and the verification on one row', async ({ page }) => {
  await open(page, 'DeliveryChain', 'waiting');
  const root = page.locator('[data-stub="DeliveryChain"]');
  const [chain, verify] = await Promise.all([root.locator('[data-stub="NodeChain"]').boundingBox(), root.getByText(/已自动检查|未验证/).boundingBox()]);
  expect(chain && verify && verify.y < chain.y + chain.height && verify.x >= chain.x + chain.width - 1).toBe(true);
});

test('ArtifactList is a table with one ⋯ per row', async ({ page }) => {
  await open(page, 'ArtifactList', 'chips');
  const rows = page.locator('[data-stub="ArtifactList"] tbody tr');
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole('button', { name: /^更多操作/ }).click();
  await expect(page.getByRole('menuitem', { name: '在 Finder 中显示' })).toBeVisible();
});

const SHOTS: Array<[string, string]> = [
  ['TraceGroup', 'open'],
  ['RawFold', 'default'],
  ['DecisionBar', 'danger-hint'],
  ['ApprovalCard', 'normal'],
  ['ArtifactList', 'chips'],
  ['DeliveryChain', 'waiting'],
];

for (const [c, d] of SHOTS) {
  test(`light: ${c}-${d} renders`, async ({ page }, info) => {
    await open(page, c, d, '&theme=light');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await saveShot(page, { path: `${shotsDir}${info.project.name}/feature-composites-${c}-${d}-light.png` });
  });
}
