import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// One-row version and delivery chains, the shared decision bar, and the chart label fixes in a real layout.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));
const url = (c: string, d: string, extra = '') => `tests/fixtures/catalog/index.html#?c=${c}&d=${d}&still=1${extra}`;

async function open(page: Page, c: string, d: string, extra = '') {
  await page.goto(url(c, d, extra));
  await expect(page.locator(`[data-stub="${c}"]`).first()).toBeVisible();
}

async function sameRow(a: Locator, b: Locator) {
  const [ra, rb] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  expect(ra && rb).toBeTruthy();
  if (!ra || !rb) return;
  // Vertical spans overlap, and b starts to the right of a.
  expect(ra.y < rb.y + rb.height && rb.y < ra.y + ra.height).toBe(true);
  expect(rb.x).toBeGreaterThanOrEqual(ra.x + ra.width - 1);
}

test('DeliveryBox puts the version chain and the delivery chain on one row', async ({ page }) => {
  await open(page, 'DeliveryBox', 'review');
  const box = page.locator('[data-stub="DeliveryBox"]');
  await sameRow(box.locator('[data-stub="VersionChain"]'), box.locator('[data-stub="NodeChain"]'));
  await expect(box).not.toContainText('//');
});

test('the drawer version row puts both chains on one row', async ({ page }) => {
  await open(page, 'TaskDrawer', 'review');
  const drawer = page.locator('[data-stub="TaskDrawer"]');
  await sameRow(drawer.locator('[data-stub="VersionChain"]'), drawer.locator('[data-stub="NodeChain"]'));
  await expect(drawer.locator('[data-stub="DecisionBar"][data-kind="review"]')).toBeVisible();
});

test('QuestionBox answers from the question decision bar', async ({ page }) => {
  await open(page, 'QuestionBox', 'default');
  const bar = page.locator('[data-stub="QuestionBox"] [data-stub="DecisionBar"][data-kind="question"]');
  await expect(bar.getByRole('button', { name: '提交回答' })).toBeVisible();
});

const SHOTS: Array<[string, string]> = [
  ['DeliveryBox', 'review'],
  ['TaskDrawer', 'review'],
  ['QuestionBox', 'default'],
  ['DiffPreview', 'open'],
  ['DecisionReceipt', 'expired'],
  ['ApprovalCard', 'normal'],
  ['TaskDetail', 'review'],
  ['SegMeter', 'snapshot'],
];

for (const [c, d] of SHOTS) {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme}: ${c}-${d} renders`, async ({ page }, info) => {
      await open(page, c, d, theme === 'light' ? '&theme=light' : '');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await saveShot(page, { path: `${shotsDir}${info.project.name}/delivery-chains-${c}-${d}-${theme}.png` });
    });
  }
}
