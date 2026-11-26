// The activity rules (src/common/activity.ts), one test per rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ActivityCoalescer, type ActivityElement, type ActivityEvent, ActivityEventQueue, type ActivityPolicy, appElement,
  captureWindow, DEFAULT_POLICY, decodeElement, eventsBody, filterEvent,
} from '../src/common/activity.ts';
import { type AttentionWindow, EMPTY_BLACKLIST, parseBlacklist } from '../src/common/attention.ts';
import { captureBlockReason, isSecureNode } from '../src/common/capture-rules.ts';

const field = (over: Partial<ActivityElement> = {}): ActivityElement => ({
  key: 'f1', pid: 702, app: 'TextEdit', bundleId: 'com.apple.TextEdit', role: 'AXTextArea', subrole: null, label: 'Body',
  valueLength: 10, windowTitle: 'notes.txt', doc: '/Users/u/notes.txt', selectedText: null, value: null, ...over,
});

const event = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  ts: 100, kind: 'value', app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, window: 'notes.txt', urlHost: null,
  doc: '/Users/u/notes.txt', role: 'AXTextArea', subrole: null, label: 'Body', value: 'hello', valueLen: 5, shrink: 1, edits: 3, ...over,
});

const front = (over: Partial<AttentionWindow> = {}): AttentionWindow => ({
  app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null, ...over,
});

const ALL: ActivityPolicy = { allowTypedText: true, senseCounts: true, redact: false };
const open = (e: ActivityEvent) => captureWindow(e, front(), false, false);

// ---- ActivityCoalescer

test('app: the same pid and bundle is one event; a new app forgets the window and focus seen', () => {
  const c = new ActivityCoalescer();
  c.app(appElement(702, 'TextEdit', 'com.apple.TextEdit'), 1);
  c.app(appElement(702, 'TextEdit', 'com.apple.TextEdit'), 2);
  c.window(appElement(702, 'TextEdit', 'com.apple.TextEdit', 'notes.txt'), 2);
  c.app(appElement(800, 'Notes', 'com.apple.Notes'), 3);
  c.app(appElement(702, 'TextEdit', 'com.apple.TextEdit'), 4);
  c.window(appElement(702, 'TextEdit', 'com.apple.TextEdit', 'notes.txt'), 4);
  assert.deepEqual(c.tick(5).map((e) => [e.kind, e.pid, e.ts]), [['app', 702, 1], ['window', 702, 2], ['app', 800, 3], ['app', 702, 4], ['window', 702, 4]]);
});

test('window: the same title and doc is one event', () => {
  const c = new ActivityCoalescer();
  c.window(appElement(702, 'TextEdit', 'com.apple.TextEdit', 'a', '/a'), 1);
  c.window(appElement(702, 'TextEdit', 'com.apple.TextEdit', 'a', '/a'), 2);
  c.window(appElement(702, 'TextEdit', 'com.apple.TextEdit', 'a', '/b'), 3);
  assert.deepEqual(c.tick(4).map((e) => [e.kind, e.window, e.doc]), [['window', 'a', '/a'], ['window', 'a', '/b']]);
});

test('focus: the same element, role and label is one event', () => {
  const c = new ActivityCoalescer();
  c.focus(field(), 1);
  c.focus(field(), 2);
  c.focus(field({ key: 'f2', label: 'Title' }), 3);
  assert.deepEqual(c.tick(4).map((e) => [e.kind, e.label]), [['focus', 'Body'], ['focus', 'Title']]);
});

test('value: changes merge into one event with edits and shrink, closed after 1.5 s quiet', () => {
  const c = new ActivityCoalescer();
  c.focus(field({ valueLength: 10 }), 0);
  c.valueChanged(field({ valueLength: 11 }), 1);
  c.valueChanged(field({ valueLength: 8 }), 1.5);
  c.valueChanged(field({ valueLength: 9 }), 2);
  assert.deepEqual(c.tick(3).map((e) => e.kind), ['focus']);
  const [value] = c.tick(3.5);
  assert.deepEqual([value!.kind, value!.ts, value!.valueLen, value!.shrink, value!.edits, value!.value], ['value', 3.5, 9, 3, 3, null]);
});

test('value: a group is closed after 10 s of changes even while typing goes on', () => {
  const c = new ActivityCoalescer();
  for (let t = 0; t <= 10; t += 1) c.valueChanged(field({ valueLength: 10 + t }), t);
  const out = c.tick(10.5);
  assert.deepEqual(out.map((e) => [e.ts, e.edits]), [[10, 10]]);
  assert.deepEqual(c.tick(12).map((e) => [e.ts, e.edits]), [[12, 1]]);
});

test('value: focus on another element closes the open group; its known length starts from the new focus', () => {
  const c = new ActivityCoalescer();
  c.valueChanged(field({ valueLength: 5 }), 0);
  c.focus(field({ key: 'f2', label: 'Other', valueLength: 40 }), 0.5);
  c.valueChanged(field({ key: 'f2', label: 'Other', valueLength: 38 }), 0.6);
  const out = c.tick(5);
  assert.deepEqual(out.map((e) => [e.kind, e.label, e.ts, e.shrink]), [['value', 'Body', 0.5, 0], ['focus', 'Other', 0.5, null], ['value', 'Other', 5, 2]]);
});

test('value: a field emptied in one change (sent on Return) ends the run at its last edit, so the typed text is kept', () => {
  const c = new ActivityCoalescer();
  c.focus(field({ valueLength: 0, value: '' }), 0);
  c.valueChanged(field({ valueLength: 4, value: 'hell' }), 0.2);
  c.valueChanged(field({ valueLength: 5, value: 'hello' }), 0.4);
  c.window(field({ windowTitle: 'sent' }), 0.5);
  c.valueChanged(field({ valueLength: 0, value: '' }), 0.6);
  const out = c.tick(5);
  assert.deepEqual(out.map((e) => [e.kind, e.ts, e.value, e.shrink, e.edits]),
    [['focus', 0, null, null, null], ['value', 0.4, 'hello', 0, 2], ['window', 0.5, null, null, null], ['value', 5, '', 5, 1]]);
  // Backspacing the last character away stays one run.
  c.valueChanged(field({ valueLength: 1, value: 'h' }), 6);
  c.valueChanged(field({ valueLength: 0, value: '' }), 6.2);
  assert.deepEqual(c.tick(9).filter((e) => e.kind === 'value').map((e) => [e.value, e.edits]), [['', 2]]);
});

test('value: a change on another element than the focused one does not count shrink from the old length', () => {
  const c = new ActivityCoalescer();
  c.focus(field({ valueLength: 50 }), 0);
  c.valueChanged(field({ key: 'f2', valueLength: 3 }), 1);
  assert.equal(c.tick(5).find((e) => e.kind === 'value')!.shrink, 0);
});

test('selection: sent after 0.8 s quiet with its text and length; empty and repeated selections are not', () => {
  const c = new ActivityCoalescer();
  c.selectionChanged(field({ selectedText: 'h' }), 0);
  c.selectionChanged(field({ selectedText: 'héllo 😀' }), 0.5);
  assert.deepEqual(c.tick(1), []);
  const [sel] = c.tick(1.3);
  assert.deepEqual([sel!.kind, sel!.value, sel!.valueLen, sel!.ts], ['selection', 'héllo 😀', 7, 1.3]);
  c.selectionChanged(field({ selectedText: 'héllo 😀' }), 2);
  c.selectionChanged(field({ selectedText: null }), 4);
  assert.deepEqual(c.tick(3), []);
  assert.deepEqual(c.tick(5), []);
});

// ---- Blocking

const window = (over: Partial<AttentionWindow> = {}, incognito: boolean | null = false, secureInput = false) => ({ window: front(over), incognito, secureInput });
// Deny mode with no rules: every window but our own is read.
const NO_RULES = parseBlacklist({ mode: 'deny' });

test('block reason order: blacklisted, incognito, browser_unknown, secure_input', () => {
  const rules = parseBlacklist({ mode: 'deny', incognito: true, bundle_ids: ['com.secret'] });
  assert.equal(captureBlockReason(window({ bundleId: 'com.secret' }, null, true), rules, []), 'blacklisted');
  assert.equal(captureBlockReason(window({}, true, true), rules, []), 'incognito');
  assert.equal(captureBlockReason(window({}, true, false), NO_RULES, []), null);
  assert.equal(captureBlockReason(window({}, null, true), rules, []), 'browser_unknown');
  assert.equal(captureBlockReason(window({}, false, true), rules, []), 'secure_input');
  assert.equal(captureBlockReason(window({ pid: 4000 }), rules, [4000]), 'blacklisted');
});

test('block reason in allow mode: a window not on the allow list is blacklisted, an allowed incognito one is incognito', () => {
  const rules = parseBlacklist({ mode: 'allow', allow: { bundle_ids: ['com.apple.TextEdit'] } });
  assert.equal(captureBlockReason(window({ app: 'Notes', bundleId: 'com.apple.Notes' }), rules, []), 'blacklisted');
  assert.equal(captureBlockReason(window(), EMPTY_BLACKLIST, []), 'blacklisted');
  assert.equal(captureBlockReason(window(), rules, []), null);
  assert.equal(captureBlockReason(window({}, true), rules, []), 'incognito');
});

test('a password-like node by role, subrole, title or description', () => {
  assert.equal(isSecureNode('AXSecureTextField', null, null), true);
  assert.equal(isSecureNode('AXTextField', null, 'Password'), true);
  assert.equal(isSecureNode('AXTextField', null, '登录密码'), true);
  assert.equal(isSecureNode('AXTextField', null, '口令'), true);
  assert.equal(isSecureNode('AXTextField', null, 'PIN passcode'), true);
  assert.equal(isSecureNode('AXTextField', null, null, 'secure entry'), true);
  assert.equal(isSecureNode('AXTextField', null, 'Search'), false);
});

test('captureWindow trusts the front sample only for the same pid and title', () => {
  const tab = front({ app: 'Safari', bundleId: 'com.apple.Safari', title: 'Inbox', urlHost: 'mail.example.com' });
  const safari = { app: 'Safari', bundleId: 'com.apple.Safari' };
  const same = captureWindow(event({ ...safari, window: 'Inbox' }), tab, false, true);
  assert.deepEqual([same.window.urlHost, same.window.title, same.incognito, same.secureInput], ['mail.example.com', 'Inbox', false, true]);
  const untitled = captureWindow(event({ ...safari, window: null }), tab, true, false);
  assert.deepEqual([untitled.window.title, untitled.window.urlHost, untitled.incognito], ['Inbox', 'mail.example.com', true]);
  const other = captureWindow(event({ ...safari, window: 'Bank' }), tab, false, false);
  assert.deepEqual([other.window.title, other.window.urlHost, other.incognito], ['Bank', null, null]);
  const app = captureWindow(event({ pid: 9, window: 'x' }), tab, null, false);
  assert.deepEqual([app.window.urlHost, app.incognito], [null, false]);
  assert.equal(captureWindow(event(), null, null, false).incognito, false);
});

test('captureWindow: a Windows packaged app without a matching front sample is not known to be non-private', () => {
  const e = event({ app: 'Browser', bundleId: 'Vendor.Browser_abc123!App', pid: 9, window: 'x' });
  assert.equal(captureWindow(e, front(), false, false).incognito, null);
});

test('filter: a blacklisted event is dropped', () => {
  const e = event({ window: 'Payroll' });
  const rules = parseBlacklist({ mode: 'deny', title_patterns: ['Payroll'] });
  assert.equal(filterEvent(e, open(e), rules, [], ALL), null);
  assert.equal(filterEvent(event({ pid: 4000 }), open(event({ pid: 4000 })), NO_RULES, [4000], ALL), null);
});

test('filter: an incognito or unknown browser window keeps only ts, kind, app, bundle and pid', () => {
  const only = { ts: 100, kind: 'value', app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, window: null, urlHost: null, doc: null,
    role: null, subrole: null, label: null, value: null, valueLen: null, shrink: null, edits: null };
  const rules = parseBlacklist({ mode: 'deny', incognito: true });
  assert.deepEqual(filterEvent(event(), window({}, true), rules, [], ALL), only);
  assert.deepEqual(filterEvent(event(), window({}, null), NO_RULES, [], ALL), only);
});

test('filter: the url host comes from the capture window', () => {
  assert.equal(filterEvent(event(), window({ urlHost: 'example.com' }), NO_RULES, [], ALL)!.urlHost, 'example.com');
});

test('filter: secure input clears the value and counts', () => {
  const out = filterEvent(event(), window({}, false, true), NO_RULES, [], ALL)!;
  assert.deepEqual([out.value, out.valueLen, out.shrink, out.edits, out.label], [null, null, null, null, 'Body']);
});

test('filter: an AXSecureTextField role or subrole clears the value and counts', () => {
  for (const over of [{ role: 'AXSecureTextField' }, { role: 'AXTextField', subrole: 'AXSecureTextField' }]) {
    const e = event(over);
    const out = filterEvent(e, open(e), NO_RULES, [], ALL)!;
    assert.deepEqual([out.value, out.valueLen, out.shrink, out.edits], [null, null, null, null]);
  }
});

test('filter: a node labelled like a password clears the value and counts', () => {
  const e = event({ role: 'AXTextField', label: '支付密码' });
  const out = filterEvent(e, open(e), NO_RULES, [], ALL)!;
  assert.deepEqual([out.value, out.valueLen, out.shrink, out.edits], [null, null, null, null]);
});

test('filter: share_typed_text off drops the value', () => {
  const e = event({ kind: 'selection' });
  const out = filterEvent(e, open(e), NO_RULES, [], { ...ALL, allowTypedText: false })!;
  assert.deepEqual([out.value, out.valueLen], [null, 5]);
});

test('filter: sense_input_counts off drops the counts', () => {
  const e = event();
  const out = filterEvent(e, open(e), NO_RULES, [], { ...ALL, senseCounts: false })!;
  assert.deepEqual([out.value, out.valueLen, out.shrink, out.edits], ['hello', null, null, null]);
});

test('filter: redact_sensitive redacts the window, label and value', () => {
  const e = event({ window: 'mail a@b.com', label: 'token=abcdef', value: 'call 13800138000' });
  const out = filterEvent(e, open(e), NO_RULES, [], { ...ALL, redact: true })!;
  assert.deepEqual([out.window, out.label, out.value], ['mail [邮箱已遮蔽]', 'token=[已遮蔽]', 'call [电话已遮蔽]']);
  const kept = filterEvent(e, open(e), NO_RULES, [], ALL)!;
  assert.equal(kept.window, 'mail a@b.com');
});

test('filter: window, doc and label are cut to 256, 512 and 120 code points; the value is not', () => {
  const e = event({ window: '😀'.repeat(300), doc: 'd'.repeat(600), label: 'l'.repeat(200), value: 'v'.repeat(900) });
  const out = filterEvent(e, open(e), NO_RULES, [], ALL)!;
  assert.deepEqual([[...out.window!].length, out.doc!.length, out.label!.length, out.value!.length], [256, 512, 120, 900]);
});

test('the default policy sends no text and no counts, redacted', () => {
  assert.deepEqual(DEFAULT_POLICY, { allowTypedText: false, senseCounts: false, redact: true });
});

// ---- Queue and body

test('queue: past 500 the oldest are dropped and counted; drain takes 50; a failed batch goes back to the front', () => {
  const q = new ActivityEventQueue();
  q.append(Array.from({ length: 520 }, (_, i) => event({ ts: i })));
  assert.deepEqual([q.count, q.dropped, q.events[0]!.ts], [500, 20, 20]);
  const batch = q.drain();
  assert.deepEqual([batch.length, batch[0]!.ts, q.count], [50, 20, 450]);
  q.append([event({ ts: 600 })]);
  q.putBack(batch);
  assert.deepEqual([q.count, q.events[0]!.ts, q.dropped], [500, 21, 21]);
});

test('body: every field in snake case, null as null', () => {
  assert.deepEqual(eventsBody([event({ value: null })]), { events: [{
    ts: 100, kind: 'value', app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702, window: 'notes.txt', url_host: null,
    doc: '/Users/u/notes.txt', role: 'AXTextArea', subrole: null, label: 'Body', value: null, value_len: 5, shrink: 1, edits: 3,
  }] });
});

// ---- The helper's element

test('decodeElement reads an ax_element with the watched app; the same roles and label give the same key', () => {
  const raw = { role: 'AXTextArea', native_role: 'AXTextArea', subrole: null, label: 'Body', value_length: 12, window_title: 'notes.txt',
    doc: '/Users/u/notes.txt', selected_text: 'hi' };
  const e = decodeElement(raw, 702, 'TextEdit', 'com.apple.TextEdit')!;
  assert.deepEqual([e.pid, e.app, e.bundleId, e.role, e.label, e.valueLength, e.windowTitle, e.doc, e.selectedText],
    [702, 'TextEdit', 'com.apple.TextEdit', 'AXTextArea', 'Body', 12, 'notes.txt', '/Users/u/notes.txt', 'hi']);
  assert.equal(decodeElement({ ...raw, value_length: 3, window_title: 'x' }, 702, null, null)!.key, e.key);
  assert.notEqual(decodeElement({ ...raw, label: 'Title' }, 702, null, null)!.key, e.key);
  assert.equal(decodeElement(null, 702, null, null), null);
  const bare = decodeElement({ role: 'AXTextField' }, 702, null, null)!;
  assert.deepEqual([bare.valueLength, bare.doc, bare.selectedText], [null, null, null]);
});
