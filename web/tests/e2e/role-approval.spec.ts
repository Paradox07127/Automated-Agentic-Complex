import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { Q_APPROVAL, Q_APPROVAL_DANGER } from '../../src/mock/fixtures/ids';

// A role approval on the HUD is the compact approval block; 拒绝 leaves a receipt, and a dangerous 批准
// decides only on the second click within a second (确认批准).

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

const frame = (page: Page, id: string) => page.locator(`[data-card-id="${id}"]`);
const card = (page: Page, id: string) => frame(page, id).locator('[data-stub="SessionApproval"]');
const approve = (page: Page, id: string) => frame(page, id).locator('[data-approve] button');

test('拒绝 on a role approval leaves a 已回答：拒绝 receipt', async ({ page }, info) => {
  await page.goto('stack.html#/hud?demo=role-approval&still=1');
  await page.getByRole('button', { name: /^展开全部/ }).click();
  await expect(card(page, Q_APPROVAL)).not.toHaveAttribute('data-dangerous');
  await expect(card(page, Q_APPROVAL).locator('[data-action]')).toHaveText('允许写入 ~/Documents/开销/10 月.xlsx？');
  await expect(approve(page, Q_APPROVAL)).toHaveText('批准');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await saveShot(page, { path: `${shotsDir}${info.project.name}/role-approval.png` });

  await frame(page, Q_APPROVAL).getByRole('button', { name: '拒绝' }).click();
  await expect(card(page, Q_APPROVAL)).toHaveAttribute('data-outcome', 'denied');
  await expect(card(page, Q_APPROVAL).locator('[data-stub="DecisionReceipt"]')).toContainText('已回答：拒绝');
});

test('a dangerous role 批准 needs 确认批准 within a second', async ({ page }, info) => {
  await page.goto('stack.html#/hud?demo=role-approval-danger&still=1');
  await page.getByRole('button', { name: /^展开全部/ }).click();
  await expect(card(page, Q_APPROVAL_DANGER)).toHaveAttribute('data-dangerous', 'true');
  await expect(card(page, Q_APPROVAL_DANGER).locator('[data-danger-mark]')).toHaveText('强制递归删除');
  await expect(approve(page, Q_APPROVAL_DANGER)).toHaveText('批准');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await saveShot(page, { path: `${shotsDir}${info.project.name}/role-approval-danger.png` });

  await approve(page, Q_APPROVAL_DANGER).click();
  await expect(approve(page, Q_APPROVAL_DANGER)).toHaveText('确认批准');
  await expect(approve(page, Q_APPROVAL_DANGER)).toHaveText('批准', { timeout: 3000 });
  await expect(card(page, Q_APPROVAL_DANGER)).not.toHaveAttribute('data-outcome');

  await approve(page, Q_APPROVAL_DANGER).click();
  await expect(approve(page, Q_APPROVAL_DANGER)).toHaveText('确认批准');
  await approve(page, Q_APPROVAL_DANGER).click();
  await expect(card(page, Q_APPROVAL_DANGER)).toHaveAttribute('data-outcome', 'approved');
});
