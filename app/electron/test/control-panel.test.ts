// The 电脑操作 panel's placement, display text and window (src/main/control/panel.ts) over a fake BrowserWindow and a fake host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import {
  type ComputerUsePanelState, displayState, displayText, headAnchor, initialPanelState, PANEL_WIDTH, panelFrame,
} from '../src/common/computer-control.ts';
import { PageSession } from '../src/common/page.ts';
import type { Rect, ScreenInfo } from '../src/common/placement.ts';
import { CONTROL_PANEL_WINDOW, ControlPanel, type ControlPanelOptions } from '../src/main/control/panel.ts';

const VISIBLE = { x: 0, y: 0, w: 1440, h: 875 };
const SCREENS: ScreenInfo[] = [{ id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: VISIBLE },
  { id: 2, frame: { x: 1440, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1440, y: 0, w: 1920, h: 1050 } }];

test('ComputerUseDisplayText.clean: redacted, whitespace runs as one space, cut to the limit with an ellipsis', () => {
  assert.equal(displayText('  write\n to   a@b.com  ', 180), 'write to [邮箱已遮蔽]');
  assert.equal(displayText('token=abc123 rest', 180), 'token=[已遮蔽] rest');
  assert.equal(displayText('一二三四五', 3), '一二三…');
  assert.equal(displayText('一二三', 3), '一二三');
  const s: ComputerUsePanelState = { ...initialPanelState(), targetApp: 'A'.repeat(60), action: 'x'.repeat(200),
    scopeChips: ['窗口 640', '会话 abcdefghijklmnopqrstuvwxyz0123', '10分钟', 'four', 'five'] };
  const shown = displayState(s);
  assert.equal(shown.targetApp, `${'A'.repeat(48)}…`);
  assert.equal(shown.action, `${'x'.repeat(180)}…`);
  assert.deepEqual(shown.scopeChips, ['窗口 640', '会话 abcdefghijklmnopqrstu…', '10分钟', 'four']);
});

test('BubbleController.headRect: her body\'s top quarter on her head\'s screen; without her, 16 pt in from the main screen\'s top right', () => {
  assert.deepEqual(headAnchor({ x: 1600, y: 100, w: 200, h: 400 }, SCREENS),
    { head: { x: 1600, y: 400, w: 200, h: 100 }, visible: SCREENS[1].visibleFrame });
  assert.deepEqual(headAnchor(null, SCREENS), { head: { x: 1424, y: 859, w: 0, h: 0 }, visible: VISIBLE });
});

test('ComputerUsePanelPlacement.frame: 336 wide over her head, below it without room, a shown panel keeps its top', () => {
  const head = { x: 600, y: 400, w: 200, h: 100 };
  assert.deepEqual(panelFrame(head, VISIBLE, 300, null, { x: 0, y: 0 }), { x: 532, y: 512, w: PANEL_WIDTH, h: 300 });
  assert.deepEqual(panelFrame(head, VISIBLE, 100, null, { x: 0, y: 0 }).h, 220);
  assert.deepEqual(panelFrame({ ...head, y: 700 }, VISIBLE, 300, null, { x: 0, y: 0 }), { x: 532, y: 388, w: PANEL_WIDTH, h: 300 });
  assert.deepEqual(panelFrame({ ...head, x: 1400 }, VISIBLE, 300, null, { x: 0, y: 0 }).x, 1440 - PANEL_WIDTH - 12);
  const current = { x: 532, y: 512, w: PANEL_WIDTH, h: 300 };
  assert.deepEqual(panelFrame(head, VISIBLE, 360, current, { x: 0, y: 0 }), { x: 532, y: 452, w: PANEL_WIDTH, h: 360 });
  assert.deepEqual(panelFrame(head, VISIBLE, 360, current, { x: 600, y: 600 }), current);
});

/** A BrowserWindow in miniature: what the panel calls, recorded. */
function fakeWindow() {
  const calls: string[] = [];
  const handlers = new Map<string, () => void>();
  const win = {
    webContents: { id: 31, isDestroyed: () => false, send: () => {}, on: () => {} },
    on: (name: string, fn: () => void) => handlers.set(name, fn),
    loadURL: async (url: string) => { calls.push(`load ${url}`); },
    showInactive: () => calls.push('showInactive'),
    hide: () => calls.push('hide'),
    setBounds: (b: { x: number; y: number; width: number; height: number }) => calls.push(`bounds ${b.x},${b.y} ${b.width}x${b.height}`),
    destroy: () => calls.push('destroy'),
  };
  return { win: win as unknown as BrowserWindow, calls };
}

function panelWith(o: { webDesktop?: boolean; screens?: ScreenInfo[]; toDip?: ControlPanelOptions['toDip']; body?: Rect } = {}) {
  const { win, calls } = fakeWindow();
  const clicks: string[] = [];
  let state = initialPanelState();
  const host = {
    get state() { return state; },
    set state(s: ComputerUsePanelState) { state = s; },
    grant: async (p: string, challenge: string | null) => { clicks.push(`grant ${p} ${challenge}`); },
    resume: async () => { clicks.push('resume'); },
    dismiss: async () => { clicks.push('dismiss'); },
  };
  let ops: ReadonlyMap<string, (args: unknown[], page: PageSession) => unknown> = new Map();
  const panel = new ControlPanel({
    host, url: 'agentic-complex-ui://app/stack.html#/computer', makeWindow: () => win,
    toDip: o.toDip ?? ((r) => ({ x: r.x, y: 900 - (r.y + r.h), width: r.w, height: r.h })),
    body: () => o.body ?? { x: 600, y: 100, w: 200, h: 400 }, screens: () => o.screens ?? SCREENS, mouse: () => ({ x: 0, y: 0 }),
    webDesktop: () => o.webDesktop ?? false,
    register: (_c, _p, m) => { ops = m; }, unregister: () => {},
    baseOps: new Map([['computerUse.stop', () => { clicks.push('stop'); return null; }]]),
  });
  panel.start();
  const pushed: unknown[] = [];
  const page = new PageSession((_sub, _stream, _kind, payload) => { if (payload) pushed.push(JSON.parse(payload.data)); });
  const call = (op: string, ...args: unknown[]) => ops.get(op)!(args, page);
  return { panel, host, calls, clicks, call, pushed };
}

const waiting = (): ComputerUsePanelState => ({ ...initialPanelState(), phase: 'waitingPermission', targetApp: 'TextEdit',
  scopeChips: ['窗口 640', '会话 s1', '10分钟'] });

test('the panel shows on a raised state over her head, updates in place without raise, and loads stack.html#/computer', () => {
  assert.deepEqual(CONTROL_PANEL_WINDOW, { transparent: false, backgroundColor: '#141414', hasShadow: true, width: 336, height: 220 });
  const p = panelWith();
  assert.deepEqual(p.calls, ['load agentic-complex-ui://app/stack.html#/computer']);
  p.panel.present({ ...initialPanelState(), phase: 'ready' }, false);
  assert.equal(p.panel.isShown, false);
  p.panel.present(waiting(), true);
  assert.deepEqual(p.calls.slice(1), ['bounds 532,168 336x220', 'showInactive']);
  // The top edge stays where it was.
  p.call('window.setContentSize', { width: 336, height: 260 });
  assert.deepEqual(p.calls.slice(3), ['bounds 532,168 336x260']);
  p.call('computerUse.onPanel', 4);
  assert.deepEqual(p.pushed, [waiting()]);
});

test('on a 200 % display the panel window is the page\'s CSS size, placed as on a 100 % one', () => {
  const screens: ScreenInfo[] = [{ id: 1, frame: { x: 0, y: 0, w: 2880, h: 1800 }, visibleFrame: { x: 0, y: 0, w: 2880, h: 1750 } }];
  const p = panelWith({ screens, body: { x: 1200, y: 200, w: 400, h: 800 },
    toDip: (r) => ({ x: r.x / 2, y: (1800 - (r.y + r.h)) / 2, width: r.w / 2, height: r.h / 2 }) });
  p.panel.present(waiting(), true);
  assert.deepEqual(p.calls.slice(1), ['bounds 532,168 336x220', 'showInactive']);
  p.call('window.setContentSize', { width: 336, height: 260 });
  assert.deepEqual(p.calls.slice(3), ['bounds 532,168 336x260']);
});

test('收起 stops the task and keeps the panel hidden until a session asks again; the page\'s buttons reach the host', () => {
  const p = panelWith();
  p.panel.present(waiting(), true);
  p.host.state = { ...waiting(), permissions: { observation: 'allowed' } };
  p.call('computerUse.grant', ['observation', 'control'], 'c-1');
  p.call('computerUse.revoke', ['observation', 'text'], 'c-1');
  p.call('computerUse.grant', ['image']);
  p.call('computerUse.resume');
  p.call('computerUse.stop');
  assert.throws(() => p.call('computerUse.grant', ['everything']), /invalid_args/);
  p.call('computerUse.dismiss');
  assert.deepEqual(p.clicks, ['grant control c-1', 'grant observation c-1', 'grant image null', 'resume', 'stop', 'dismiss']);
  assert.equal(p.calls.at(-1), 'hide');
  p.panel.present({ ...waiting(), phase: 'paused' }, true);
  assert.equal(p.panel.isShown, false);
  p.panel.present(waiting(), true);
  assert.equal(p.panel.isShown, true);
});

test('with the web desktop up, a working or paused session is a stack card and the panel hides', () => {
  const p = panelWith({ webDesktop: true });
  p.panel.present(waiting(), true);
  assert.equal(p.panel.isShown, true);
  p.panel.present({ ...waiting(), phase: 'executing' }, true);
  assert.equal(p.panel.isShown, false);
  p.panel.present({ ...waiting(), phase: 'completed' }, false);
  assert.equal(p.panel.isShown, false);
  p.panel.present({ ...waiting(), phase: 'completed' }, true);
  assert.equal(p.panel.isShown, true);
});
