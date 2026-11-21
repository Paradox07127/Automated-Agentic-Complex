import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// A memory run's detail, decisions narrowed by a native link, the last unspoken line.
const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const SHOTS: Array<{ name: string; hash: string; open: (page: Page) => Promise<void> }> = [
  {
    name: 'memory-run',
    hash: '/diag?still=1&kind=memory&run=mrun-01',
    open: async (page) => {
      await expect(page.getByRole('dialog', { name: '记忆生成记录' }).getByText('候选 1 │ 记下')).toBeVisible();
    },
  },
  {
    name: 'turn-by-trace',
    hash: '/diag?still=1&trace=tr2',
    open: async (page) => {
      await expect(page.getByText('轮次详情')).toBeVisible();
    },
  },
  {
    name: 'now-speech-failed',
    hash: '/diag?still=1&item=state',
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
