import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// The last unspoken line on 诊断 › 内部状态; memory runs and single turns moved to 记忆管线 and 诊断 › 对话轮次.
const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const SHOTS: Array<{ name: string; hash: string; open: (page: Page) => Promise<void> }> = [
  {
    name: 'now-speech-failed',
    hash: '/diag?still=1&tab=state',
    open: async (page) => {
      await expect(page.getByText('上次没说出口')).toBeVisible();
    },
  },
];

for (const s of SHOTS) {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme}: ${s.name}`, async ({ page }, info) => {
      await page.goto(`main.html#${s.hash}${theme === 'light' ? '&theme=light' : ''}`);
      await s.open(page);
      await settle(page);
      await saveShot(page, { path: `${shotsDir}${info.project.name}/memory-run-diag-${s.name}-${theme}.png` });
    });
  }
}
