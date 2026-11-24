// The timeline rules (src/common/timeline.ts): the target read from an `ax_element`, the filter and the queue.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AttentionWindow, parseBlacklist } from '../src/common/attention.ts';
import type { CaptureWindow } from '../src/common/capture-rules.ts';
import {
  DEFAULT_TIMELINE_POLICY, filterRecord, type TimelinePolicy, TimelineQueue, type TimelineRecord, toTarget,
} from '../src/common/timeline.ts';

const NO_RULES = parseBlacklist({ mode: 'deny' });
const ALL: TimelinePolicy = { allowActions: true, allowWindowText: true, allowTypedText: true, redact: false };

const front = (over: Partial<AttentionWindow> = {}): AttentionWindow => ({
  app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null, ...over,
});
const open = (over: Partial<CaptureWindow> = {}): CaptureWindow => ({ window: front(), incognito: false, secureInput: false, ...over });

const record = (over: Partial<TimelineRecord> = {}): TimelineRecord => ({
  ts: 100, kind: 'click', app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640, window_title: 'notes.txt',
  url_host: null, target: { role: 'AXButton', subrole: null, title: 'Save', description: null, identifier: null, value: 'draft' },
  keys: null, text: 'hello', tree: { mode: 'diff', text: '+ button "Saved"' }, ...over,
});

test('toTarget reads the ax_element: the label stands for the title; null without an element', () => {
  assert.deepEqual(toTarget({ role: 'AXTextArea', native_role: 'AXTextArea', subrole: null, label: 'Body', value_length: 4,
    window_title: 'notes.txt', value: 'milk' }), { role: 'AXTextArea', subrole: null, title: 'Body', description: null, identifier: null,
    value: 'milk' });
  assert.deepEqual(toTarget({ role: 'AXButton', subrole: null, label: 'OK', title: 'Save', description: 'Saves', identifier: 'save-btn' }),
    { role: 'AXButton', subrole: null, title: 'Save', description: 'Saves', identifier: 'save-btn', value: null });
  assert.equal(toTarget(null), null);
  assert.equal(toTarget('AXButton'), null);
});

test('the default policy records nothing and redacts', () => {
  assert.deepEqual(DEFAULT_TIMELINE_POLICY, { allowActions: false, allowWindowText: false, allowTypedText: false, redact: true });
});

test('filter: a blacklisted window in deny mode, or one off the allow list, is dropped', () => {
  const deny = parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] });
  assert.equal(filterRecord(record(), open(), deny, [], ALL), null);
  const allow = parseBlacklist({ mode: 'allow', allow: { bundle_ids: ['com.apple.Notes'] } });
  assert.equal(filterRecord(record(), open(), allow, [], ALL), null);
  const allowed = parseBlacklist({ mode: 'allow', allow: { bundle_ids: ['com.apple.TextEdit'] } });
  assert.deepEqual(filterRecord(record(), open(), allowed, [], ALL), record());
});

test('filter: our own pid, an incognito window and a browser of unknown state are dropped', () => {
  assert.equal(filterRecord(record(), open(), NO_RULES, [702], ALL), null);
  const safari = front({ app: 'Safari', bundleId: 'com.apple.Safari', urlHost: 'example.com' });
  assert.equal(filterRecord(record(), open({ window: safari, incognito: true }), parseBlacklist({ mode: 'deny', incognito: true }), [], ALL), null);
  assert.equal(filterRecord(record(), open({ window: safari, incognito: null }), NO_RULES, [], ALL), null);
});

test('filter: the url host is the window\'s', () => {
  const safari = front({ app: 'Safari', bundleId: 'com.apple.Safari', urlHost: 'example.com' });
  assert.equal(filterRecord(record(), open({ window: safari }), NO_RULES, [], ALL)!.url_host, 'example.com');
});

test('filter: secure input or a secure target loses the text, the value and the tree', () => {
  const secure = filterRecord(record(), open({ secureInput: true }), NO_RULES, [], ALL)!;
  assert.deepEqual([secure.text, secure.target!.value, secure.tree, secure.target!.title], [null, null, null, 'Save']);
  const field = record({ target: { role: 'AXTextField', subrole: 'AXSecureTextField', title: null, description: null, identifier: null,
    value: 'hunter2' } });
  const out = filterRecord(field, open(), NO_RULES, [], ALL)!;
  assert.deepEqual([out.text, out.target!.value, out.tree], [null, null, null]);
  const labelled = filterRecord(record({ target: { ...record().target!, title: '密码' } }), open(), NO_RULES, [], ALL)!;
  assert.deepEqual([labelled.text, labelled.target!.value, labelled.tree], [null, null, null]);
});

test('filter: without share_typed_text the text and the value go, the tree stays', () => {
  const out = filterRecord(record(), open(), NO_RULES, [], { ...ALL, allowTypedText: false })!;
  assert.deepEqual([out.text, out.target!.value, out.tree], [null, null, { mode: 'diff', text: '+ button "Saved"' }]);
  assert.equal(filterRecord(record({ target: null }), open(), NO_RULES, [], { ...ALL, allowTypedText: false })!.target, null);
});

test('filter: without share_window_text the tree goes, the text stays', () => {
  const out = filterRecord(record(), open(), NO_RULES, [], { ...ALL, allowWindowText: false })!;
  assert.deepEqual([out.tree, out.text], [null, 'hello']);
});

test('filter: a clicked static text is named by its text, which is window text', () => {
  const text = record({ target: { role: 'AXStaticText', subrole: null, title: 'Count 2', description: null, identifier: null, value: null } });
  assert.equal(filterRecord(text, open(), NO_RULES, [], ALL)!.target!.title, 'Count 2');
  assert.equal(filterRecord(text, open(), NO_RULES, [], { ...ALL, allowWindowText: false })!.target!.title, null);
  assert.equal(filterRecord(record(), open(), NO_RULES, [], { ...ALL, allowWindowText: false })!.target!.title, 'Save');
  assert.equal(filterRecord({ ...text, target: { ...text.target!, title: 'secret' } }, open({ secureInput: true }), NO_RULES, [], ALL)!
    .target!.title, null, 'secure input keeps no shown text either');
});

test('filter: without share_actions every record is dropped', () => {
  assert.equal(filterRecord(record(), open(), NO_RULES, [], { ...ALL, allowActions: false }), null);
  assert.equal(filterRecord(record({ kind: 'window', target: null }), open(), NO_RULES, [], { ...ALL, allowActions: false }), null);
});

test('filter: redact masks the target\'s title and description too', () => {
  const r = record({ target: { ...record().target!, title: 'to a.b@example.com', description: 'a.b@example.com' } });
  const out = filterRecord(r, open(), NO_RULES, [], { ...ALL, redact: true })!;
  assert.deepEqual([out.target!.title, out.target!.description], ['to [邮箱已遮蔽]', '[邮箱已遮蔽]']);
});

test('filter: redact masks the text, the value, the tree and the window title', () => {
  const mail = 'mail me at a.b@example.com';
  const r = record({ text: mail, window_title: `Inbox ${mail}`, tree: { mode: 'full', text: `row "${mail}"` },
    target: { ...record().target!, value: 'token=abc123' } });
  const out = filterRecord(r, open(), NO_RULES, [], { ...ALL, redact: true })!;
  assert.deepEqual([out.text, out.window_title, out.tree!.text, out.target!.value],
    ['mail me at [邮箱已遮蔽]', 'Inbox mail me at [邮箱已遮蔽]', 'row "mail me at [邮箱已遮蔽]"', 'token=[已遮蔽]']);
  assert.deepEqual(filterRecord(r, open(), NO_RULES, [], ALL), r);
});

test('queue: 50 a batch, 500 at most dropping the oldest, a failed batch goes back to the front', () => {
  const q = new TimelineQueue();
  q.append(Array.from({ length: 520 }, (_, i) => record({ ts: i })));
  assert.deepEqual([q.count, q.dropped], [500, 20]);
  const batch = q.drain();
  assert.deepEqual([batch.length, batch[0]!.ts, q.count], [50, 20, 450]);
  q.putBack(batch);
  assert.deepEqual([q.count, q.records[0]!.ts], [500, 20]);
});
