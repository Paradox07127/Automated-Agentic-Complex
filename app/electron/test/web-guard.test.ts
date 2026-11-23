// A page's guards (src/main/web-guard.ts, src/common/web-guard.ts): the navigation policy, the context menu and ui.log,
// over a fake WebContents and a temp log directory.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrowserWindow, WebContents } from 'electron';
import type { ErrorInput } from '../src/common/error-record.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { clipMessage, editMenu, type EditItem, navigationAllowed, WEB_LOG, WebErrorLog } from '../src/common/web-guard.ts';
import { DesktopPanel } from '../src/main/desktop/panel.ts';
import { guardWebContents, type WebGuardPorts } from '../src/main/web-guard.ts';

/** A WebContents with the events and calls the guard uses; `url` is its page. */
function fakeContents(url = `${ORIGIN}/main.html#/settings`) {
  let openHandler: ((d: { url: string }) => { action: string }) | null = null;
  const contents = Object.assign(new EventEmitter(), {
    id: 3, send() {}, isDestroyed: () => false, getURL: () => url,
    setWindowOpenHandler(h: (d: { url: string }) => { action: string }) { openHandler = h; },
  });
  return { contents, open: (u: string) => openHandler!({ url: u }) };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const opened: string[] = [], menus: EditItem[][] = [];
  const ports: WebGuardPorts = { origin: ORIGIN, openExternal: (u) => opened.push(u), popUpMenu: (_c, items) => menus.push(items),
    logsDir: join(dir, 'logs') };
  return { dir, opened, menus, ports, log: () => readFileSync(join(dir, 'logs', 'ui.log'), 'utf8'),
    done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Emits `will-frame-navigate`; true when the guard cancelled it. */
function navigate(contents: EventEmitter, url: string, isMainFrame = true): boolean {
  let prevented = false;
  contents.emit('will-frame-navigate', { url, isMainFrame, preventDefault: () => { prevented = true; } });
  return prevented;
}

test('navigation: the pages stay on the UI scheme; an http(s) link in the main frame goes to the system browser, nothing else does', () => {
  const h = harness();
  try {
    const { contents, open } = fakeContents();
    guardWebContents(contents as unknown as WebContents, 'main', h.ports);
    assert.equal(navigate(contents, `${ORIGIN}/stack.html#/bubble`), false);
    assert.equal(navigate(contents, 'https://example.com/a?b=1'), true);
    assert.equal(navigate(contents, 'http://example.com/'), true);
    assert.equal(navigate(contents, 'file:///etc/passwd'), true);
    assert.equal(navigate(contents, 'agentic-complex-ui://other/main.html'), true);
    // A frame inside the page is cancelled without opening anything (decidePolicyFor's targetFrame).
    assert.equal(navigate(contents, 'https://example.com/frame', false), true);
    assert.deepEqual(h.opened, ['https://example.com/a?b=1', 'http://example.com/']);
    // No page opens a window: an http(s) URL goes to the browser, the UI's own and the rest nowhere.
    assert.deepEqual(open('https://example.com/new'), { action: 'deny' });
    assert.deepEqual(open(`${ORIGIN}/main.html`), { action: 'deny' });
    assert.deepEqual(open('mailto:a@b.c'), { action: 'deny' });
    assert.deepEqual(h.opened.slice(2), ['https://example.com/new']);
    assert.equal(navigationAllowed(`${ORIGIN}/x`, ORIGIN), true);
    assert.equal(navigationAllowed('not a url', ORIGIN), false);
  } finally {
    h.done();
  }
});

test('context menu: cut, copy and paste in a text field as the system edit flags allow; copy over selected text; none elsewhere', () => {
  const h = harness();
  try {
    const { contents } = fakeContents();
    guardWebContents(contents as unknown as WebContents, 'main', h.ports);
    const flags = { canCut: false, canCopy: false, canPaste: true, canSelectAll: true };
    contents.emit('context-menu', {}, { isEditable: true, selectionText: '', editFlags: flags });
    contents.emit('context-menu', {}, { isEditable: false, selectionText: 'hello', editFlags: { ...flags, canCopy: true } });
    contents.emit('context-menu', {}, { isEditable: false, selectionText: '', editFlags: flags });
    assert.deepEqual(h.menus, [
      [{ role: 'cut', label: '剪切', enabled: false }, { role: 'copy', label: '复制', enabled: false }, { role: 'paste', label: '粘贴', enabled: true }],
      [{ role: 'copy', label: '复制', enabled: true }],
    ]);
    assert.deepEqual(editMenu({ isEditable: false, selectionText: '', editFlags: flags }), []);
  } finally {
    h.done();
  }
});

test("ui.log: a page's console errors as one line (time, surface, #fragment, message, source), other levels not", () => {
  const h = harness();
  try {
    const { contents } = fakeContents();
    guardWebContents(contents as unknown as WebContents, 'main', h.ports);
    contents.emit('console-message', { level: 'error', message: 'Uncaught Error: boom\tnow', lineNumber: 12, sourceId: `${ORIGIN}/assets/a.js` });
    contents.emit('console-message', { level: 'warning', message: 'just a warning', lineNumber: 1, sourceId: 'x' });
    const lines = h.log().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const [time, surface, fragment, message, stack] = lines[0]!.split('\t');
    assert.match(time!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual([surface, fragment, message, stack], ['main', '#/settings', 'Uncaught Error: boom now', `${ORIGIN}/assets/a.js:12`]);
  } finally {
    h.done();
  }
});

test("a page's exception is also an error record: its message and first component frame, or an uncaught one's source", () => {
  const h = harness();
  try {
    const records: ErrorInput[] = [];
    const { contents } = fakeContents();
    guardWebContents(contents as unknown as WebContents, 'main', { ...h.ports, recordError: (r) => records.push(r) });
    contents.emit('console-message', { level: 'error', message: 'page_exception: /home: TypeError: x is undefined\n    at Disc (agentic-complex-ui://app/assets/main.js:1:2)\n    at div\nTypeError: x is undefined\n    at f',
      lineNumber: 3, sourceId: `${ORIGIN}/assets/main.js` });
    contents.emit('console-message', { level: 'error', message: 'Uncaught (in promise) Error: no texture', lineNumber: 12, sourceId: `${ORIGIN}/assets/a.js` });
    contents.emit('console-message', { level: 'error', message: 'Encountered two children with the same key, `%s`.', lineNumber: 1, sourceId: 'x' });
    contents.emit('console-message', { level: 'warning', message: 'page_exception: not an error level', lineNumber: 1, sourceId: 'x' });
    assert.deepEqual(records, [
      { component: 'page', code: 'page_exception', message: '/home: TypeError: x is undefined', detail: 'at Disc (agentic-complex-ui://app/assets/main.js:1:2)' },
      { component: 'page', code: 'page_exception', message: 'Uncaught (in promise) Error: no texture', detail: `${ORIGIN}/assets/a.js:12` },
    ]);
    assert.equal(h.log().split('\n').filter(Boolean).length, 3);
  } finally {
    h.done();
  }
});

test('ui.log moves to ui.log.1 once it has reached 1 MiB', () => {
  const h = harness();
  try {
    const { contents } = fakeContents();
    guardWebContents(contents as unknown as WebContents, 'stack', h.ports);
    contents.emit('console-message', { level: 'error', message: 'first', lineNumber: 1, sourceId: 's' });
    writeFileSync(join(h.ports.logsDir, 'ui.log'), 'x'.repeat(WEB_LOG.maxFileBytes));
    contents.emit('console-message', { level: 'error', message: 'second', lineNumber: 1, sourceId: 's' });
    assert.equal(readFileSync(join(h.ports.logsDir, 'ui.log.1'), 'utf8').length, WEB_LOG.maxFileBytes);
    assert.match(h.log(), /^[^\t]+\tstack\t#\/settings\tsecond\ts:1\n$/);
  } finally {
    h.done();
  }
});

test('WebErrorLog: 60 a minute, the dropped count written with the next minute\'s first; a long message clipped to 4096 bytes', () => {
  const lines: string[] = [];
  const log = new WebErrorLog('stack', (l) => lines.push(l));
  for (let i = 0; i < 65; i++) log.record(`e${i}\nstack ${i}`, '/bubble', 1000 + i);
  assert.equal(lines.length, 60);
  assert.ok(lines[0]!.endsWith('\tstack\t#/bubble\te0\tstack 0\n'));
  log.record('later', '/bubble', 61_000);
  assert.equal(lines.length, 62);
  assert.ok(lines[60]!.endsWith('\t#/bubble\tdropped 5 web errors over 60 a minute\t\n'));
  assert.ok(lines[61]!.endsWith('\tlater\t\n'));
  log.record('a\r\nb\nc', '', 62_000);
  assert.ok(lines[62]!.endsWith('\tstack\t#\ta\tb\\nc\n'));
  const clipped = clipMessage('字'.repeat(2000));
  assert.ok(new TextEncoder().encode(clipped).length <= WEB_LOG.maxMessageBytes);
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipMessage('short'), 'short');
});

test('a desktop panel guards its page when it is given the ports', () => {
  const h = harness();
  try {
    const { contents } = fakeContents(`${ORIGIN}/stack.html#/bubble`);
    const win = Object.assign(new EventEmitter(), { webContents: contents, setFocusable() {}, loadURL: async () => {}, isDestroyed: () => false });
    const p = new DesktopPanel({ kind: 'bubble', route: '/bubble', url: `${ORIGIN}/stack.html#/bubble`, aliveOn: 'window.onAnchor',
      makeWindow: () => win as unknown as BrowserWindow, toDip: (f) => ({ x: f.x, y: f.y, width: f.w, height: f.h }),
      cursor: () => ({ x: 0, y: 0 }), mouse: () => ({ x: 0, y: 0 }), register() {}, unregister() {}, log() {}, guard: h.ports });
    p.start();
    assert.equal(navigate(contents, 'https://example.com/'), true);
    assert.deepEqual(h.opened, ['https://example.com/']);
    contents.emit('console-message', { level: 'error', message: 'oops', lineNumber: 3, sourceId: 'p.js' });
    assert.match(h.log(), /\tstack\t#\/bubble\toops\tp\.js:3\n$/);
    assert.equal(existsSync(join(h.ports.logsDir, 'ui.log.1')), false);
  } finally {
    h.done();
  }
});
