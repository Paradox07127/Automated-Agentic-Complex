import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';
import { DESKTOP_DEMOS } from '../../src/surfaces/desktop/demos.ts';

// stack.html serves the desktop panels by hash path; each tells native its regions and content size.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

type Op = { op: string; arg: unknown };
type Box = { x: number; y: number; width: number; height: number; drag?: boolean };

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Records what the page tells the fake bridge's native side. */
async function watchOps(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __ops: Op[] };
    w.__ops = [];
    window.addEventListener('endfield-fake-op', (e) => w.__ops.push((e as CustomEvent<Op>).detail));
  });
  return async (op: string) => {
    const ops = await page.evaluate(() => (window as unknown as { __ops: Op[] }).__ops);
    return ops.filter((o) => o.op === op).map((o) => o.arg);
  };
}

async function open(page: Page, path: string, params: Record<string, string>) {
  await page.goto('about:blank');
  await page.goto(`stack.html#${path}?${new URLSearchParams({ ...params, still: '1' }).toString()}`);
}

for (const theme of ['dark', 'light'] as const) {
  for (const demo of DESKTOP_DEMOS) {
    test(`${theme} ${demo.name}: the panel renders without errors`, async ({ page }, info) => {
      const errors = collectErrors(page);
      await open(page, demo.path, { ...demo.params, theme });
      const root = page.locator(`[data-surface-root="${demo.path.slice(1)}"]`);
      await expect(root).toBeAttached();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      if (demo.path === '/cmd') await expect(root.locator(`[data-slot="${demo.params.mode}"]`)).toBeVisible();
      if (demo.path === '/console') await expect(root.locator('[data-slot="console"]')).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await saveShot(page, { path: `${shotsDir}${info.project.name}/desktop-panels-${theme}-${demo.name}.png`, omitBackground: true });
      expect(errors).toEqual([]);
    });
  }
}

test('cmd opens the layer the command names and nothing before it', async ({ page }) => {
  await open(page, '/cmd', { mode: 'tune' });
  const root = page.locator('[data-surface-root="cmd"]');
  await expect(root).toHaveAttribute('data-mode', 'tune');
  await expect(root.locator('[data-slot]')).toHaveCount(1);
  await expect(root.locator('[data-slot="tune"]')).toBeVisible();
});

for (const [path, params] of [['/bubble', {}], ['/hud', { hud: 'three' }]] as const) {
  const name = path.slice(1);
  test(`${name}: reports its regions and its content size`, async ({ page }) => {
    const sent = await watchOps(page);
    await open(page, path, params);
    const root = page.locator(`[data-surface-root="${name}"]`);
    await expect(root).toBeAttached();
    await expect.poll(async () => ((await sent('window.setInteractiveRegions')).at(-1) as Box[] | undefined)?.length ?? 0).toBeGreaterThan(0);

    // The page reports a size only once it moves by 2 px or more.
    const box = await root.boundingBox();
    await expect
      .poll(async () => {
        const s = (await sent('window.setContentSize')).at(-1) as { width: number; height: number } | undefined;
        return !!s && !!box && Math.abs(s.width - box.width) < 2 && Math.abs(s.height - box.height) < 2;
      })
      .toBe(true);
  });
}

test('hud: with no session and no card it shows nothing and reports no region', async ({ page }) => {
  const sent = await watchOps(page);
  await open(page, '/hud', { demo: 'empty' });
  await expect(page.locator('[data-surface-root="hud"]')).toBeAttached();
  await expect.poll(async () => (await sent('window.setInteractiveRegions')).at(-1)).toEqual([]);
  // The cards arrive after mount; the last report must still be empty once they have.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  expect((await sent('window.setInteractiveRegions')).at(-1)).toEqual([]);
  await expect(page.locator('[data-hud-row]')).toHaveCount(0);
});

test('console reports a new content size when it opens', async ({ page }) => {
  const sent = await watchOps(page);
  await open(page, '/console', {});
  await expect(page.locator('[data-slot="console"]')).toBeVisible();
  await expect.poll(async () => ((await sent('window.setContentSize')).at(-1) as { width: number } | undefined)?.width ?? 0).toBeGreaterThan(300);
});
