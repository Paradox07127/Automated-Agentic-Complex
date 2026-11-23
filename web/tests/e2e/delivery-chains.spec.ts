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

test('dark HUD question card: button text reads at 4.5:1 on its own background', async ({ page }) => {
  await page.goto('stack.html#/hud?demo=question&still=1&theme=dark');
  await page.getByRole('button', { name: /^展开全部/ }).click();
  const box = page.locator('[data-stub="QuestionBox"]').first();
  await expect(box).toBeVisible();
  const buttons = box.locator('[data-stub="Btn"]:not([aria-disabled="true"])');
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const btn of await buttons.all()) {
    const ratio = await btn.evaluate((el) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r = 0, g = 0, b = 0]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      // First opaque background colour from the button up; a ::before backdrop (the popup band) counts as its element's.
      let bg = 'rgb(0, 0, 0)';
      for (let n: Element | null = el; n; n = n.parentElement) {
        const before = getComputedStyle(n, '::before');
        const c = [getComputedStyle(n).backgroundColor, before.content === 'none' ? '' : before.backgroundColor].find(
          (v) => v && (rgb(v)[3] ?? 1) > 0.5,
        );
        if (c) {
          bg = c;
          break;
        }
      }
      const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(bg))];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio, await btn.innerText()).toBeGreaterThanOrEqual(4.5);
  }
});

test('SmallMultiples: 暂停 does not sit on the dashed target line', async ({ page }) => {
  await open(page, 'SmallMultiples', 'render');
  // getBBox in SVG units: WebKit's client rect for a <text> under a CSS `font` shorthand lands at the svg origin.
  const gap = await page.locator('svg[data-series="fps"]').evaluate((svg) => {
    const label = [...svg.querySelectorAll('text')].find((t) => t.textContent === '暂停') as SVGTextElement;
    const b = label.getBBox();
    const y = Number(svg.querySelector('line[data-ref]')?.getAttribute('y1'));
    return y < b.y ? b.y - y : y - (b.y + b.height);
  });
  expect(gap).toBeGreaterThan(0);
});

const SHOTS: Array<[string, string]> = [
  ['DeliveryBox', 'review'],
  ['TaskDrawer', 'review'],
  ['QuestionBox', 'default'],
  ['DiffPreview', 'open'],
  ['DecisionReceipt', 'expired'],
  ['ApprovalCard', 'normal'],
  ['TaskDetail', 'review'],
  ['SmallMultiples', 'render'],
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
