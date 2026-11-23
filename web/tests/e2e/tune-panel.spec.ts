import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

// 控制台 on its own console panel. Demo states run on the fake bridge; the wiring tests swap in a bridge that records
// every call, so each control is checked against the op it sends.

const shotsDir = fileURLToPath(new URL('../../.shots/', import.meta.url));

const DEMOS = [
  { name: 'console', mode: 'console', path: '/console' },
  { name: 'console-offline', mode: 'console', path: '/console' },
  { name: 'empty', mode: 'console', path: '/console' },
] as const;

type Call = { op: string; args: unknown[] };

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, params: Record<string, string>, path = '/console') {
  await page.goto('about:blank');
  await page.goto(`stack.html#${path}?${new URLSearchParams({ ...params, still: '1' }).toString()}`);
}

/**
 * Installs `window.agenticComplex` as a recorder: subscriptions get the fixture under their op name once, every other op
 * resolves to its fixture (or null). Returns a reader for the calls of one op.
 */
async function recordBridge(page: Page, fx: Record<string, unknown>) {
  await page.addInitScript((fixtures: Record<string, unknown>) => {
    const w = window as unknown as { __calls: Call[]; agenticComplex: unknown };
    w.__calls = [];
    const make = (path: string[]): unknown =>
      new Proxy(function () {}, {
        get: (_t, key) => (key === 'then' ? undefined : make([...path, String(key)])),
        apply: (_t, _self, args: unknown[]) => {
          const op = path.join('.');
          w.__calls.push({ op, args: JSON.parse(JSON.stringify(args.filter((a) => typeof a !== 'function'))) as unknown[] });
          if (op === 'feed.subscribe' || /^on[A-Z]/.test(path[path.length - 1] ?? '')) {
            const cb = args[0] as (v: unknown) => void;
            if (op in fixtures) queueMicrotask(() => cb(fixtures[op]));
            return () => {};
          }
          return Promise.resolve(fixtures[op] ?? null);
        },
      });
    w.agenticComplex = make([]);
  }, fx);
  return async (op: string) => {
    const calls = await page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);
    return calls.filter((c) => c.op === op).map((c) => c.args);
  };
}

const proc = (state: string) => ({ state, pid: state === 'running' ? 1 : null });

function desktopState(o: { hidden?: boolean; agentd?: string } = {}) {
  return {
    hidden: o.hidden ?? false,
    clickThroughAll: false,
    freeRoam: false,
    quietUntil: null,
    dock: { open: false, side: 'right', compact: false },
    character: { id: 'si', name: '示例乙' },
    characters: [{ id: 'si', name: '示例乙' }],
    screens: [],
    hotkeys: { hk_quick: '⌃Space', hk_look: '⌃⌥L', hk_hide: '⌃⌥H' },
    pips: { agentd: proc(o.agentd ?? 'running'), avatar: proc('running'), voice: 'on' },
    computerUseActive: false,
    plugins: ['light_ai'],
  };
}

const session = (id: string, title: string, state: string) => ({ id, backend: 'codex', title, state, updated_at: 1_790_000_000 });
const CONSOLE_PRESENCE = {
  role: { state: 'running_tool', activity: '在跑' },
  sessions: [session('s1', '修 HostLink', 'running'), session('s2', '周报', 'awaiting_approval'), session('s3', '换装测试', 'error')],
  additional_sessions: 1,
  pending: { approvals: [{ id: 'a1' }, { id: 'a2' }], approvals_more: 0, questions: [{ id: 'q1' }], questions_more: 0 },
};

for (const theme of ['dark', 'light'] as const) {
  for (const demo of DEMOS) {
    test(`${theme} ${demo.name}: renders without errors`, async ({ page }, info) => {
      const errors = collectErrors(page);
      await open(page, { demo: demo.name, theme }, demo.path);
      const slot = page.locator(`[data-surface-root="${demo.path.slice(1)}"] [data-slot="${demo.mode}"]`);
      await expect(slot).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      if (demo.mode === 'console') await expect(slot.locator('[lang="en"]')).toHaveCount(0);
      if (demo.mode === 'console') await expect(slot.getByRole('button', { name: '打开主窗口' })).toBeVisible();
      if (demo.name === 'console') await expect(slot.locator('[data-sec="waiting"]')).toBeVisible();
      if (demo.name === 'console-offline') await expect(slot.locator('[data-fix="后台"]')).toContainText('重启后台');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await saveShot(page, { path: `${shotsDir}${info.project.name}/tune-panel-${theme}-${demo.name}.png`, omitBackground: true });
      expect(errors).toEqual([]);
    });
  }
}

test('menu bar: primary action opens the main window and closes the panel', async ({ page }) => {
  const calls = await recordBridge(page, { 'desktop.onCommand': { kind: 'openConsole' }, 'desktop.onState': desktopState() });
  await open(page, {}, '/console');
  const menu = page.getByRole('dialog', { name: 'Agentic Complex 菜单' });
  await expect(menu.getByRole('button')).toHaveText(['', '打开主窗口', /快速输入/, '命令环', '设置', '桌面选项']);
  await menu.getByRole('button', { name: '打开主窗口' }).click();
  await expect.poll(() => calls('window.openMain')).toEqual([['/overview?focus=page&still=1']]);
  await expect.poll(() => calls('window.close')).toEqual([[]]);
  await expect(menu).toHaveCount(0);
});

test('menu bar: the command ring opens through its native action before the menu closes', async ({ page }) => {
  const calls = await recordBridge(page, { 'desktop.onCommand': { kind: 'openConsole' }, 'desktop.onState': desktopState() });
  await open(page, {}, '/console');
  const menu = page.getByRole('dialog', { name: 'Agentic Complex 菜单' });
  await menu.getByRole('button', { name: '命令环' }).click();
  await expect.poll(() => calls('desktop.action')).toEqual([['cmdMode', 'ring']]);
  await expect.poll(() => calls('window.close')).toEqual([[]]);
  await expect(menu).toHaveCount(0);
});

test('menu bar: pending approvals, questions and reviews land on the full inbox', async ({ page }) => {
  const calls = await recordBridge(page, { 'desktop.onCommand': { kind: 'openConsole' }, 'desktop.onState': desktopState(), 'desktop.onPresence': CONSOLE_PRESENCE });
  await open(page, {}, '/console');
  await page.getByRole('button', { name: '3 项待处理' }).click();
  await expect.poll(() => calls('window.openMain')).toEqual([['/overview?focus=pending&still=1']]);
  await expect.poll(() => calls('desktop.action')).toEqual([]);
  await expect(page.locator('[data-slot="console"]')).toHaveCount(0);
});

test('menu bar: settings opens its route and desktop controls appear on demand', async ({ page }) => {
  const calls = await recordBridge(page, { 'desktop.onCommand': { kind: 'openConsole' }, 'desktop.onState': desktopState() });
  await open(page, {}, '/console');
  const menu = page.getByRole('dialog', { name: 'Agentic Complex 菜单' });
  const details = menu.getByRole('button', { name: '桌面选项' });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(menu.getByRole('switch')).toHaveCount(0);
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  const states = menu.getByRole('group', { name: '桌面选项' });
  await expect(states.getByRole('switch')).toHaveCount(3);
  await expect(states.getByRole('switch', { name: '显示角色' })).toHaveAttribute('aria-checked', 'true');
  await states.getByRole('switch', { name: '免打扰' }).click();
  await expect(menu.getByRole('status')).toContainText('免打扰已开始');
  await states.getByRole('switch', { name: '全部点穿' }).click();
  await states.getByRole('switch', { name: '显示角色' }).click();
  await expect.poll(() => calls('desktop.action')).toEqual([['quiet'], ['clickThroughAll'], ['hide']]);
  await expect(menu.getByText(/陪我专注/)).toHaveCount(0);
  await menu.getByRole('button', { name: '设置' }).click();
  await expect.poll(() => calls('window.openMain')).toEqual([['/settings?focus=page&still=1']]);
  await expect(menu).toHaveCount(0);
});

test('menu bar: offline hides stale pending, offers recovery and leaves window and role controls available', async ({ page }) => {
  const calls = await recordBridge(page, { 'desktop.onCommand': { kind: 'openConsole' }, 'desktop.onState': desktopState({ agentd: 'stopped', hidden: true }), 'desktop.onPresence': CONSOLE_PRESENCE });
  await open(page, {}, '/console');
  const menu = page.getByRole('dialog', { name: 'Agentic Complex 菜单' });
  await expect(menu.locator('[data-fix="后台"]')).toContainText('后台服务未连接');
  await expect(menu.getByRole('button', { name: '打开主窗口' })).toBeEnabled();
  await expect(menu.locator('[data-sec="waiting"]')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /快速输入/ })).toBeDisabled();
  await menu.getByRole('button', { name: '重启后台' }).click();
  await expect.poll(() => calls('supervisor.restart')).toEqual([['agentd']]);
  await expect(menu.getByText('已请求重启后台')).toBeVisible();
  await menu.getByRole('button', { name: '桌面选项' }).click();
  await expect(menu.getByRole('switch', { name: '免打扰' })).toBeDisabled();
  const role = menu.getByRole('switch', { name: '显示角色' });
  await expect(role).toHaveAttribute('aria-checked', 'false');
  await role.click();
  await expect.poll(() => calls('desktop.action')).toEqual([['show']]);
  await menu.getByRole('button', { name: '查看诊断' }).click();
  await expect.poll(() => calls('window.openMain')).toEqual([['/diag?item=agentd&focus=proc-agentd&still=1']]);
});

test('menu bar: quick input hands off only on success, and its X closes on the first click', async ({ page }) => {
  const calls = await recordBridge(page, { 'desktop.onCommand': { kind: 'openConsole' }, 'desktop.onState': desktopState() });
  await open(page, {}, '/console');
  const menu = page.getByRole('dialog', { name: 'Agentic Complex 菜单' });
  await menu.getByRole('button', { name: /快速输入/ }).click();
  await expect.poll(() => calls('desktop.action')).toEqual([['quickInput']]);
  await expect.poll(() => calls('window.close')).toEqual([[]]);
  await expect(menu).toHaveCount(0);
  await open(page, {}, '/console');
  await menu.getByRole('button', { name: '关闭菜单' }).click();
  await expect.poll(() => calls('window.close')).toEqual([[]]);
  await expect(menu).toHaveCount(0);
});

test('menu bar: Escape closes before any control has focus', async ({ page }) => {
  const calls = await recordBridge(page, { 'desktop.onCommand': { kind: 'openConsole' } });
  await open(page, {}, '/console');
  const menu = page.getByRole('dialog', { name: 'Agentic Complex 菜单' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => calls('window.close')).toEqual([[]]);
  await expect(menu).toHaveCount(0);
});
