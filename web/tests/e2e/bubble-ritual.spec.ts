import { expect, test, type Page } from '@playwright/test';

// The ritual a tap on her may claim shows in the bubble as her thought's suggested action.

type Call = { op: string; args: unknown[] };

const STATE = {
  hidden: false,
  clickThroughAll: false,
  freeRoam: false,
  quietUntil: null,
  avatarHovered: false,
  character: { id: 'voice_a', name: '示例甲' },
  characters: [{ id: 'voice_a', name: '示例甲' }],
  screens: [{ id: '1', name: '内建显示器', current: true }],
  hotkeys: { hk_quick: '⌃Space', hk_wheel: '⌃⌥R' },
  pips: { agentd: 'running', avatar: 'running', voice: 'on' },
  computerUseActive: false,
  plugins: ['light_ai'],
};

const NO_PENDING = { questions: [], questions_more: 0, approvals: [], approvals_more: 0, results: [], results_more: 0, tasks: [], tasks_more: 0, reminders: [], reminders_more: 0 };
const IDLE = { state: 'idle', activity: '空闲', doing: '空闲', intention: null, backend: null, mood: null };

function presence(over: { ritual?: unknown } = {}) {
  return { sampled_at: Date.now() / 1000, character_id: 'voice_a', role: IDLE, sessions: [], additional_sessions: 0, pending: NO_PENDING, proactive_speech: true, thought: null, ...over };
}

/**
 * A stand-in native bridge: `on…`/`subscribe` ops keep their callback (window.onAnchor, desktop.onState and
 * desktop.onPresence get the seed at once), every other op resolves; `__calls` records them and `__push` feeds a
 * subscription.
 */
async function openNative(page: Page, seed: { state: unknown; presence: unknown; claimError?: string }) {
  await page.addInitScript((s) => {
    const w = window as unknown as Record<string, unknown>;
    const calls: Call[] = [];
    const subs: Record<string, Array<(v: unknown) => void>> = {};
    const initial: Record<string, unknown> = {
      'window.onAnchor': { panel: 'bubble', state: 'settled', side: 'left', docked: null, far: false, toHead: null, room: { width: 456, height: 820 } },
      'desktop.onState': s.state,
      'desktop.onPresence': s.presence,
    };
    const settled = () => {
      const f = (() => {}) as unknown as Record<string, unknown>;
      f.then = (ok?: (v: undefined) => void) => ok?.(undefined);
      f.catch = () => f;
      return f;
    };
    const ns = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, key) => {
            if (typeof key !== 'string' || key === 'then') return undefined;
            const op = `${name}.${key}`;
            return (...args: unknown[]) => {
              calls.push({ op, args: args.filter((a) => typeof a !== 'function') });
              const cb = args.find((a): a is (v: unknown) => void => typeof a === 'function');
              if (cb && /^(on[A-Z]|subscribe)/.test(key)) {
                (subs[op] ??= []).push(cb);
                if (op in initial) queueMicrotask(() => cb(initial[op]));
                return () => {
                  subs[op] = (subs[op] ?? []).filter((c) => c !== cb);
                };
              }
              if (op === 'desktop.action' && args[0] === 'claimRitual') {
                return s.claimError ? Promise.reject(Object.assign(new Error(`failed: ${s.claimError}`), { code: 'failed', detail: s.claimError })) : Promise.resolve();
              }
              return settled();
            };
          },
        },
      );
    w.__calls = calls;
    w.__push = (op: string, v: unknown) => (subs[op] ?? []).forEach((cb) => cb(v));
    const base: Record<string, unknown> = { surface: 'stack', capabilities: {} };
    w.agenticComplex = new Proxy(base, { get: (t, key) => (typeof key === 'string' && key in t ? t[key] : typeof key === 'string' && key !== 'then' ? ns(key) : undefined) });
  }, seed);
  await page.goto('about:blank');
  await page.goto('stack.html#/bubble?still=1');
  await expect(page.locator('[data-surface-root="bubble"]')).toBeAttached();
}

const push = (page: Page, op: string, v: unknown) => page.evaluate(([o, x]) => (window as unknown as { __push: (o: string, x: unknown) => void }).__push(o, x), [op, v] as const);
const feed = (page: Page, event: string, data: unknown) => push(page, 'feed.subscribe', { event, id: null, data: JSON.stringify(data) });
const calls = (page: Page, op: string) =>
  page.evaluate((o) => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.op === o).map((c) => c.args), op);
const ritual = (page: Page, name: string) => page.locator('[data-bubble]').getByRole('button', { name, exact: true });

test('a ritual the feed offers shows in the bubble and claims on click', async ({ page }) => {
  await openNative(page, { state: STATE, presence: presence() });
  await expect(page.locator('[data-bubble]')).toHaveCount(0);
  await feed(page, 'pending', { kinds: ['report', 'morning'], since: new Date().toISOString() });
  await expect(ritual(page, '今日汇报')).toBeVisible();
  await ritual(page, '今日汇报').click();
  await expect.poll(() => calls(page, 'desktop.action')).toEqual([['claimRitual']]);
  await expect(page.getByRole('status')).toContainText('已请角色回应');
  await feed(page, 'pending', { kinds: [], since: new Date().toISOString() });
  await expect(ritual(page, '今日汇报')).toHaveCount(0);
});

test('a refused ritual shows its reason and remains available to retry', async ({ page }) => {
  await openNative(page, {
    state: STATE,
    presence: presence({ ritual: { kind: 'water', since: Date.now() / 1000 - 1800 } }),
    claimError: '角色在忙，等这一轮做完',
  });
  const button = ritual(page, '喝水提醒');
  await button.click();
  await expect(page.getByRole('alert')).toHaveText('角色在忙，等这一轮做完');
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => calls(page, 'desktop.action')).toEqual([['claimRitual'], ['claimRitual']]);
});

test('a ritual presence names shows before the feed says anything; the feed rules after', async ({ page }) => {
  await openNative(page, { state: STATE, presence: presence({ ritual: { kind: 'water', since: Date.now() / 1000 - 1800 } }) });
  await expect(ritual(page, '喝水提醒')).toBeVisible();
  await feed(page, 'pending', { kinds: ['break'], since: new Date().toISOString() });
  await expect(ritual(page, '久坐提醒')).toBeVisible();
  await push(page, 'desktop.onPresence', presence({ ritual: { kind: 'water', since: Date.now() / 1000 } }));
  await expect(ritual(page, '久坐提醒')).toBeVisible();
  await feed(page, 'pending', { kinds: [], since: new Date().toISOString() });
  await expect(page.locator('[data-bubble]').getByRole('button', { name: /提醒$/ })).toHaveCount(0);
});
