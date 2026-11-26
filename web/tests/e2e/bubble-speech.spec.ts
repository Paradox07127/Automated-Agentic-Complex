import { expect, test, type Page } from '@playwright/test';

// Her line in the bubble (`stack.html#/bubble`) from `/feed` `line` events: streaming, cut long lines, error and
// interruption times, the docked subtitle, and the size the page reports.

type Call = { op: string; arg: unknown };
type Anchor = { docked: string | null; side: string };

/**
 * A native-like `window.agenticComplex` that the test drives: `__line(data)` sends a `/feed` line event; `__calls` records what
 * the page asked native and agentd to do.
 */
async function nativeBridge(page: Page, anchor: Anchor = { docked: null, side: 'left' }) {
  await page.addInitScript((a: Anchor) => {
    const w = window as unknown as Record<string, unknown>;
    const calls: Call[] = [];
    const feed: Array<(e: unknown) => void> = [];
    const none = () => {};
    const once = (v: unknown) => (cb: (x: unknown) => void) => {
      queueMicrotask(() => cb(v));
      return none;
    };
    const list = (subs: Array<(x: never) => void>) => (cb: (x: never) => void) => {
      subs.push(cb);
      return () => subs.splice(subs.indexOf(cb), 1);
    };
    // Anything the bubble page does not use answers with a no-op.
    const noop: unknown = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : noop), apply: () => none });
    const deep = (o: Record<string, unknown>): unknown => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : noop) });
    let seq = 0;
    w.__calls = calls;
    w.__feedSubscribers = () => feed.length;
    w.__line = (data: Record<string, unknown>) => {
      const e = { event: 'line', id: String(++seq), data: JSON.stringify({ final: false, cancelled: false, error: null, run_id: null, lane: 'character', reason: null, ...data }) };
      feed.forEach((cb) => cb(e));
    };
    w.agenticComplex = deep({
      surface: 'stack',
      capabilities: { clickThrough: true },
      app: deep({ runtime: () => Promise.reject(new Error('not_implemented: app.runtime')), onRuntime: () => none }),
      feed: deep({ subscribe: list(feed) }),
      agentd: deep({
        request: async (method: string, path: string, body: unknown) => {
          calls.push({ op: `${method} ${path}`, arg: body });
          return { status: 202, body: {} };
        },
      }),
      window: deep({
        onAnchor: once({ panel: 'bubble', state: a.docked ? 'docked' : 'settled', side: a.side, docked: a.docked, far: false, toHead: null, room: { width: 456, height: 820 } }),
        openMain: (route: string) => calls.push({ op: 'window.openMain', arg: route }),
        setContentSize: (size: unknown) => calls.push({ op: 'window.setContentSize', arg: size }),
        setInteractiveRegions: (regions: unknown) => calls.push({ op: 'window.setInteractiveRegions', arg: regions }),
      }),
      desktop: deep({
        onState: once({ character: { id: 'nochar', name: '示例甲' }, avatarHovered: false }),
        onPresence: once(null),
      }),
    });
  }, anchor);
  return {
    // The page subscribes to `/feed` in an effect that runs after the bubble root is already attached.
    line: async (data: Record<string, unknown>) => {
      await expect.poll(() => page.evaluate(() => (window as unknown as { __feedSubscribers: () => number }).__feedSubscribers())).toBeGreaterThan(0);
      await page.evaluate((d) => (window as unknown as { __line: (d: unknown) => void }).__line(d), data);
    },
    calls: (op: string) => page.evaluate((o) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.op === o).map((c) => c.arg), op),
  };
}

async function openBubble(page: Page) {
  await page.goto('about:blank');
  await page.goto('stack.html#/bubble');
  await expect(page.locator('[data-surface-root="bubble"]')).toBeAttached();
}

const speech = (page: Page) => page.locator('[data-bubble] [data-kind="speech"]');

test('a streaming line shows as streaming until its final', async ({ page }) => {
  const native = await nativeBridge(page);
  await openBubble(page);
  await expect(speech(page)).toHaveCount(0);
  await native.line({ line_id: 't1', text_delta: '我看了你的终端，' });
  await expect(speech(page)).toHaveAttribute('data-phase', 'streaming');
  await native.line({ line_id: 't1', text_delta: '构建失败在第 42 行。' });
  await native.line({ line_id: 't1', text_delta: '', final: true });
  await expect(speech(page)).toHaveAttribute('data-phase', 'linger');
  await expect(speech(page)).toContainText('我看了你的终端，构建失败在第 42 行。');
});

test('docked noroom keeps the bubble', async ({ page }) => {
  const native = await nativeBridge(page, { docked: 'noroom', side: 'corner' });
  await openBubble(page);
  await native.line({ line_id: 'n', text_delta: '放不下也照常显示。' });
  await expect(speech(page)).toBeVisible();
  await expect(page.locator('[data-subtitle]')).toHaveCount(0);
});

