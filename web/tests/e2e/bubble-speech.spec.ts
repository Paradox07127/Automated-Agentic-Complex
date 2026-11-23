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

test('a long line remains scrollable and opens in the chat page', async ({ page }) => {
  const native = await nativeBridge(page);
  await openBubble(page);
  await native.line({ line_id: 'long', text_delta: '这一段很长的回答会占满很多行。'.repeat(30), final: true });
  const reply = speech(page).getByLabel('完整回复，可滚动');
  await expect(reply).toBeVisible();
  expect(await reply.evaluate((el) => el.scrollHeight)).toBeGreaterThan(198);
  await reply.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await reply.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await speech(page).getByRole('button', { name: '在对话里看全文' }).click();
  expect(await native.calls('window.openMain')).toEqual(['/chat?turn=long']);
});

test('an error stays 8 s, an interruption 4 s', async ({ page }) => {
  await page.clock.install();
  const native = await nativeBridge(page);
  await openBubble(page);
  await page.mouse.move(1270, 790);
  await native.line({ line_id: 'e', text_delta: '我去读一下日志' });
  await native.line({ line_id: 'e', text_delta: '', final: true, error: 'kernel_timeout' });
  const failed = page.locator('[data-bubble][data-kind="error"]');
  await expect(failed).toContainText('这一轮出错了');
  await page.clock.runFor(7_500);
  await expect(failed).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(failed).toHaveCount(0);

  await native.line({ line_id: 'c', text_delta: '说到一半' });
  await native.line({ line_id: 'c', text_delta: '', final: true, cancelled: true });
  await expect(speech(page)).toContainText('已打断');
  await page.clock.runFor(3_500);
  await expect(speech(page)).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(speech(page)).toHaveCount(0);
});

for (const docked of ['hidden', 'fullscreen', 'offscreen', 'stale'] as const) {
  test(`docked ${docked}: the line shows as a subtitle with 在对话中打开`, async ({ page }) => {
    const native = await nativeBridge(page, { docked, side: 'menubar' });
    await openBubble(page);
    await native.line({ line_id: 'sub', text_delta: '我在这儿，' });
    const sub = page.locator('[data-subtitle]');
    await expect(sub).toBeVisible();
    await expect(sub).toContainText('示例甲');
    await expect(sub).toContainText('我在这儿，');
    await expect(page.locator('[data-bubble]')).toHaveCount(0);
    await sub.getByRole('button', { name: '在对话中打开 ↗' }).click();
    expect(await native.calls('window.openMain')).toEqual(['/chat?turn=sub']);
  });
}

test('docked noroom keeps the bubble', async ({ page }) => {
  const native = await nativeBridge(page, { docked: 'noroom', side: 'corner' });
  await openBubble(page);
  await native.line({ line_id: 'n', text_delta: '放不下也照常显示。' });
  await expect(speech(page)).toBeVisible();
  await expect(page.locator('[data-subtitle]')).toHaveCount(0);
});

test('sized to the content it reports, the panel page shows no scrollbars', async ({ page }) => {
  const native = await nativeBridge(page);
  await openBubble(page);
  await native.line({ line_id: 'g', text_delta: '嗯，招呼收到了。这两句拿来试试，瞧瞧有没有缺字或遮挡！', final: true });
  await expect(speech(page)).toBeVisible();
  const root = page.locator('[data-surface-root="bubble"]');
  // The page reports a size only once it moves by 2 px or more.
  const rootSize = () => root.evaluate((el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
  const near = async () => {
    const s = (await native.calls('window.setContentSize')).at(-1) as { width: number; height: number } | undefined;
    const r = await rootSize();
    return !!s && Math.abs(s.width - r.width) < 2 && Math.abs(s.height - r.height) < 2;
  };
  await expect.poll(near).toBe(true);
  const { width, height } = (await native.calls('window.setContentSize')).at(-1) as { width: number; height: number };
  await page.setViewportSize({ width, height });
  const viewport = () =>
    page.evaluate(() => {
      const d = document.documentElement;
      return { client: [d.clientWidth, d.clientHeight], inner: [window.innerWidth, window.innerHeight] };
    });
  await expect.poll(async () => { const v = await viewport(); return v.client.join('x') === v.inner.join('x'); }).toBe(true);
  expect(await viewport()).toEqual({ client: [width, height], inner: [width, height] });
});
