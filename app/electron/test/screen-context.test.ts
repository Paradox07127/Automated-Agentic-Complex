// The screen context rules (src/common/screen-context.ts, capture-rules.ts), one test per rule. Helper answers follow CONTRACT §7.12's field tables.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AttentionSample, type AttentionWindow, parseBlacklist } from '../src/common/attention.ts';
import type { CaptureWindow } from '../src/common/capture-rules.ts';
import {
  allowsAutomaticText, allowsOCR, allowsRequest, axObservation, captureFailure, captureTargetChange,
  CaptureTriggers, ContextConsent, contextImageBody, contextPolicy, contextTextBodies, DEFAULT_CONTEXT_POLICY, decideSelection,
  decodeWindows, feedRequest, firstClipItem, imageFailureBody, imageResult, listedBlockReason, lookResult, lookTitle, type Observation, ocrObservation,
  OwnCapture, revokedKinds, selectionBlockReason, textPages, textResult, windowNow, windowReadPlan,
} from '../src/common/screen-context.ts';

// Deny mode with no rules: every window but our own is read.
const NO_RULES = parseBlacklist({ mode: 'deny' });

const win = (over: Partial<AttentionWindow> = {}): AttentionWindow => ({
  app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null, ...over,
});
const cw = (over: Partial<AttentionWindow> = {}, incognito: boolean | null = false, secureInput = false): CaptureWindow =>
  ({ window: win(over), incognito, secureInput });
const rules = parseBlacklist({ mode: 'deny', incognito: true, bundle_ids: ['com.secret'], app_names: ['Vault'], domains: ['bank.com'], title_patterns: ['^Private'] });
const policy = (over: Partial<typeof DEFAULT_CONTEXT_POLICY> = {}) => ({ ...DEFAULT_CONTEXT_POLICY, ...over });

function sample(over: Partial<AttentionSample> = {}): AttentionSample {
  return {
    ts: 0, front: win(), frontIncognito: false, mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null,
    secureInput: false, fullscreen: false, cameraActive: null, micActive: null, userSpeaking: null, focusWindow: null, input: null,
    frontAudioOut: null, frontVideo: null, frontGpu: null, screenCaptured: null, edge: null, frontBounds: null, ...over,
  };
}

const observation = (text = 'hello', roles: string[] = ['AXStaticText']): Observation => ({
  snapshotId: 's1', text, nodes: roles.map((role, id) => ({ id, parent: -1, role, label: null, value: null, selection: null, bounds: null })),
  coverage: { status: 'complete', scope: 'visible_window', reasons: [], capturedNodes: roles.length, capturedChars: text.length, nextCursor: null },
});

// ---- Consent

test('ScreenContextPolicy: config.json keys, defaults and an unknown level as focused', () => {
  assert.deepEqual(contextPolicy({}), { allowText: false, allowImages: false, level: 'focused', redact: true });
  assert.deepEqual(contextPolicy({ share_window_text: true, share_screenshots: true, screen_context_level: 'window', redact_sensitive: false }),
    { allowText: true, allowImages: true, level: 'window', redact: false });
  assert.equal(contextPolicy({ screen_context_level: 'everything' }).level, 'focused');
});

test('ScreenContextPolicy.allowsRequest: text needs text and a level above status; OCR needs text, images and window; image needs images', () => {
  assert.equal(allowsRequest(policy({ allowText: true }), 'text'), true);
  assert.equal(allowsRequest(policy({ allowText: true, level: 'status' }), 'text'), false);
  assert.equal(allowsRequest(policy({ allowText: true, allowImages: true }), 'ocr'), false);
  assert.equal(allowsRequest(policy({ allowText: true, allowImages: true, level: 'window' }), 'ocr'), true);
  assert.equal(allowsRequest(policy({ allowText: false, allowImages: true, level: 'window' }), 'ocr'), false);
  assert.equal(allowsRequest(policy({ allowImages: true }), 'image'), true);
  assert.equal(allowsRequest(policy({ allowText: true }), 'image'), false);
  assert.equal(allowsRequest(policy({ allowText: true, allowImages: true }), 'video'), false);
  assert.equal(allowsOCR(policy({ allowText: true, allowImages: true, level: 'window' })), true);
});

test('ScreenContextPolicy.allowsAutomaticText: needs the Accessibility permission too', () => {
  assert.equal(allowsAutomaticText(policy({ allowText: true }), true), true);
  assert.equal(allowsAutomaticText(policy({ allowText: true }), false), false);
  assert.equal(allowsAutomaticText(policy({ allowText: true, level: 'status' }), true), false);
});

test('ScreenContextConsent: a change bumps the generation, the same policy does not', () => {
  const c = new ContextConsent(policy());
  assert.equal(c.configure(policy()), false);
  assert.equal(c.generation, 0);
  assert.equal(c.configure(policy({ allowText: true })), true);
  assert.equal(c.generation, 1);
  c.invalidate();
  assert.equal(c.generation, 2);
});

test('ContextCapturer.configure: narrowing revokes window_text and screenshots', () => {
  assert.deepEqual(revokedKinds(policy({ allowText: true }), policy()), ['window_text']);
  assert.deepEqual(revokedKinds(policy({ allowText: true, level: 'window' }), policy({ allowText: true, level: 'focused' })), ['window_text']);
  assert.deepEqual(revokedKinds(policy({ allowText: true, level: 'focused' }), policy({ allowText: true, level: 'status' })), ['window_text']);
  assert.deepEqual(revokedKinds(policy({ allowText: true, level: 'status' }), policy()), []);
  assert.deepEqual(revokedKinds(policy({ allowImages: true }), policy()), ['screenshots']);
  assert.deepEqual(revokedKinds(policy(), policy({ allowText: true, allowImages: true })), []);
});

// ---- Triggers and memory

/** agentd's `/user/coarse` answer as CaptureTriggers reads it. */
const HERE = { presence: 'present', absence: null };
const gone = (presence: string) => ({ presence, absence: { id: '1795280400000-1', since: 0 } });

test('CaptureTriggers: a change reads at once, then backs off 5, 10, 20, 30 s', () => {
  const t = new CaptureTriggers();
  assert.equal(t.update(0, 1, 'a', null, HERE), true);
  assert.equal(t.update(4, 1, 'a', null, HERE), false);
  assert.equal(t.update(5, 1, 'a', null, HERE), true);
  assert.equal(t.update(14, 1, 'a', null, HERE), false);
  assert.equal(t.update(15, 1, 'a', null, HERE), true);
  assert.equal(t.update(35, 1, 'a', null, HERE), true);
  assert.equal(t.update(64, 1, 'a', null, HERE), false);
  assert.equal(t.update(65, 1, 'a', null, HERE), true);
  assert.equal(t.update(66, 2, 'a', null, HERE), true, 'another window');
  assert.equal(t.update(67, 2, 'a', 'f2', HERE), true, 'another focused element');
});

test('CaptureTriggers: no reads while agentd says the user is away, locked or asleep; the absence ending reads', () => {
  for (const presence of ['away', 'locked', 'asleep']) {
    const t = new CaptureTriggers();
    t.update(0, 1, 'a', null, HERE);
    assert.equal(t.update(100, 1, 'a', null, gone(presence)), false, presence);
    assert.equal(t.update(101, 1, 'a', null, { presence: 'unknown', absence: gone(presence).absence }), true,
      'unknown is not away, though the absence is still open');
    assert.equal(t.update(102, 1, 'a', null, HERE), true, 'the return');
  }
});

test('CaptureTriggers: while the user is away not even a window or focus change reads', () => {
  const t = new CaptureTriggers();
  t.update(0, 1, 'a', null, HERE);
  assert.equal(t.update(1, 2, 'b', 'f', gone('away')), false);
  assert.equal(t.update(2, 2, 'b', 'f2', gone('away')), false);
  assert.equal(t.update(3, 2, 'b', 'f2', HERE), true, 'the return');
});

test('CaptureTriggers: an AX notification reads 2 s after it, 5 s after the last read', () => {
  const t = new CaptureTriggers();
  t.update(0, 1, 'a', null, HERE);
  t.update(5, 1, 'a', null, HERE);
  t.axNotified(6);
  assert.equal(t.update(7, 1, 'a', null, HERE), false);
  assert.equal(t.update(10, 1, 'a', null, HERE), true);
  t.contentChanged();
  assert.equal(t.update(14, 1, 'a', null, HERE), false);
  assert.equal(t.update(15, 1, 'a', null, HERE), true);
});

// ---- Windows

const listed = {
  windows: [
    { window_id: 640, pid: 702, bounds: { x: 0, y: 25, width: 800, height: 600 }, layer: 0, alpha: 1, title: 'notes.txt', app_name: 'TextEdit', app_id: 'com.apple.TextEdit' },
    { window_id: 77, pid: 900, bounds: { x: 10, y: 30, width: 1200, height: 800 }, layer: 0, alpha: 1, title: 'Bank', app_name: 'Google Chrome', app_id: 'com.google.Chrome' },
    { window_id: 'x', pid: 1, bounds: null },
  ],
};

test('captureWindowNow: the listed window with the front sample’s browser state; a background browser window is unknown', () => {
  const windows = decodeWindows(listed);
  assert.equal(windows.length, 2);
  const front = windowNow(windows, 640, sample({ front: win({ urlHost: null }) }), false);
  assert.deepEqual(front?.window, cw());
  assert.deepEqual(front?.bounds, { x: 0, y: 25, width: 800, height: 600 });
  const chromeFront = sample({ front: win({ app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 900, windowId: 77, urlHost: 'bank.com' }) });
  assert.equal(windowNow(windows, 77, chromeFront, false)?.window.window.urlHost, 'bank.com');
  const chrome = windowNow(windows, 77, sample(), true);
  assert.equal(chrome?.window.incognito, null, 'whatever it showed while in front');
  assert.equal(chrome?.window.window.urlHost, null);
  assert.equal(chrome?.window.secureInput, true);
  assert.equal(windowNow(windows, 640, sample({ front: null }), false)?.window.incognito, false, 'not a browser');
  const packaged = decodeWindows({ windows: [{ ...listed.windows[0], app_id: 'Vendor.Browser_abc123!App' }] });
  assert.equal(windowNow(packaged, 640, sample({ front: null }), false)?.window.incognito, null, 'a Windows packaged app');
  assert.equal(windowNow(windows, 5, sample(), false), null);
});

test('captureTargetChange: gone, now blocked, incognito changed, another page', () => {
  const pinned = cw();
  assert.equal(captureTargetChange(pinned, cw(), NO_RULES, []), null);
  assert.equal(captureTargetChange(pinned, null, NO_RULES, []), 'window_gone');
  assert.equal(captureTargetChange(pinned, cw({ windowId: 641 }), NO_RULES, []), 'window_gone');
  assert.equal(captureTargetChange(pinned, cw({ pid: 703 }), NO_RULES, []), 'window_gone');
  assert.equal(captureTargetChange(pinned, cw({ title: 'Private notes' }), rules, []), 'permission_denied');
  assert.equal(captureTargetChange(pinned, cw({}, false, true), NO_RULES, []), 'permission_denied');
  assert.equal(captureTargetChange(cw({}, true), cw({}, false), NO_RULES, []), 'permission_denied');
  assert.equal(captureTargetChange(pinned, cw({ urlHost: 'other.com' }), NO_RULES, []), 'capture_failed');
});

test('WindowReadPlan.decide: gone, not allowed, blocked or a background window at the focused level, no Accessibility, else the level', () => {
  const focused = policy({ allowText: true }), whole = policy({ allowText: true, level: 'window' });
  assert.equal(windowReadPlan(false, whole, true, null, true), 'window_gone');
  assert.equal(windowReadPlan(true, policy(), true, null, true), 'permission_denied');
  assert.equal(windowReadPlan(true, policy({ allowText: true, level: 'status' }), true, null, true), 'permission_denied');
  assert.equal(windowReadPlan(true, whole, true, 'blacklisted', true), 'permission_denied');
  assert.equal(windowReadPlan(true, focused, false, null, true), 'permission_denied');
  assert.equal(windowReadPlan(true, whole, true, null, false), 'ax_unavailable');
  assert.deepEqual(windowReadPlan(true, focused, true, null, true), { level: 'focused' });
  assert.deepEqual(windowReadPlan(true, whole, false, null, true), { level: 'window' });
});

test('listedBlockReason: a listed window without its title is blocked while a title rule exists', () => {
  assert.equal(listedBlockReason(cw({ title: null }), rules, []), 'blacklisted');
  assert.equal(listedBlockReason(cw({ title: 'notes.txt' }), rules, []), null);
  assert.equal(listedBlockReason(cw({ title: null }), NO_RULES, []), null);
  assert.equal(listedBlockReason(cw({ title: null }), parseBlacklist({ mode: 'allow', title_patterns: ['^Private'],
    allow: { bundle_ids: ['com.apple.TextEdit'] } }), []), 'blacklisted', 'a title rule applies in allow mode too');
  assert.equal(listedBlockReason(cw({ title: null }), parseBlacklist({ mode: 'allow', allow: { bundle_ids: ['com.apple.TextEdit'] } }), []), null);
  assert.equal(listedBlockReason(cw({ bundleId: 'com.secret' }), rules, []), 'blacklisted');
});

test('captureFailure: capture.window errors as agentd failures', () => {
  assert.equal(captureFailure('permission_denied'), 'permission_denied');
  assert.equal(captureFailure('window_gone'), 'window_gone');
  assert.equal(captureFailure('too_large'), 'capture_failed');
  assert.equal(captureFailure('helper_timeout'), 'capture_failed');
});

// ---- Feed

test('FeedRequest: a request event with every field', () => {
  const data = JSON.stringify({ seq: 4, request_id: 'r1', window_id: 640, mode: 'text', reason: 'look_window' });
  assert.deepEqual(feedRequest({ event: 'request', data }), { seq: 4, requestId: 'r1', windowId: 640, mode: 'text', reason: 'look_window' });
  assert.equal(feedRequest({ event: 'line', data }), null);
  assert.equal(feedRequest({ event: 'request', data: '{"seq":4,"request_id":"r1","window_id":640,"mode":"text"}' }), null);
  assert.equal(feedRequest({ event: 'request', data: 'not json' }), null);
});

// ---- Observations

/** CONTRACT §7.4 `ax.window_text` with §7.12 `ax_node`s and `coverage`. */
const windowText = {
  snapshot_id: 'snap-1', matched: true, text: '标签: Mail\n可见文字: write to a@b.com',
  nodes: [
    { id: 0, parent: -1, role: 'AXWindow', native_role: 'AXWindow', label: 'Mail', bounds: { x: 0, y: 25, width: 800, height: 600 } },
    { id: 1, parent: 0, role: 'AXStaticText', native_role: 'AXStaticText', value: 'write to a@b.com', bounds: { x: 10, y: 40, width: 200, height: 20 } },
    { id: 2, parent: 0, role: 'AXGroup', native_role: 'AXGroup', label: 'Password' },
    { id: 3, parent: 2, role: 'AXStaticText', native_role: 'AXStaticText', value: 'hunter2' },
    { id: 4, parent: 0, role: 'AXSecureTextField', native_role: 'AXSecureTextField', value: 'x' },
  ],
  coverage: { status: 'partial', scope: 'visible_window', reasons: ['ax_time_slice'], captured_nodes: 5, captured_chars: 31, next_cursor: 'snap-1' },
};

test('ScreenContextRedaction: the text and node texts are redacted when redact_sensitive is on', () => {
  const on = axObservation(windowText, true).observation;
  assert.equal(on.text, '标签: Mail\n可见文字: write to [邮箱已遮蔽]');
  assert.equal(on.nodes[1]?.value, 'write to [邮箱已遮蔽]');
  const off = axObservation(windowText, false).observation;
  assert.equal(off.text, windowText.text);
  assert.equal(off.nodes[1]?.value, 'write to a@b.com');
});

test('ScreenContextNode.secure: password nodes and what hangs under them are left out', () => {
  const o = axObservation(windowText, false).observation;
  assert.deepEqual(o.nodes.map((n) => n.id), [0, 1]);
  assert.equal(o.coverage.capturedNodes, 2);
});

test('ObservationAX: nodes as ObservationElement, coverage counted after redaction, the cursor kept', () => {
  const r = axObservation(windowText, true);
  assert.equal(r.matched, true);
  assert.deepEqual(r.observation.nodes[0], { id: 0, parent: -1, role: 'AXWindow', label: 'Mail', value: null, selection: null, bounds: [0, 25, 800, 600] });
  assert.deepEqual(r.observation.coverage, { status: 'partial', scope: 'visible_window', reasons: ['ax_time_slice'], capturedNodes: 2,
    capturedChars: [...r.observation.text].length, nextCursor: 'snap-1' });
  assert.equal(axObservation({ ...windowText, matched: false }, true).matched, false);
});

test('OCR.recognizeObservation: lines as OCRText nodes, boxes moved to a bottom-left origin, partial coverage', () => {
  const o = ocrObservation({ text: 'Hello\nWorld', languages: ['en-US'], lines: [
    { text: 'Hello', bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, confidence: 0.9 },
    { text: 'World', bounds: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 } },
  ] }, 'ocr-1', false);
  assert.equal(o.text, 'Hello\nWorld');
  assert.deepEqual(o.nodes.map((n) => [n.id, n.parent, n.role, n.value]), [[0, -1, 'OCRText', 'Hello'], [1, -1, 'OCRText', 'World']]);
  assert.deepEqual(o.nodes[0]?.bounds?.map((v) => Math.round(v * 100) / 100), [0.1, 0.7, 0.5, 0.2]);
  assert.deepEqual(o.coverage, { status: 'partial', scope: 'window_image_ocr_normalized_bottom_left', reasons: ['ocr_can_miss_visual_content'],
    capturedNodes: 2, capturedChars: 11, nextCursor: null });
});

test('OCR.recognizeObservation: the text and each line redacted when redact_sensitive is on, chars counted after', () => {
  const result = { text: 'mail a@b.com', lines: [{ text: 'mail a@b.com', bounds: { x: 0, y: 0, width: 1, height: 0.5 } }] };
  const on = ocrObservation(result, 'ocr-1', true);
  assert.equal(on.nodes[0]?.value, 'mail [邮箱已遮蔽]');
  assert.equal(on.text, 'mail [邮箱已遮蔽]');
  assert.equal(on.coverage.capturedChars, [...'mail [邮箱已遮蔽]'].length);
  const built = contextTextBodies(cw(), on.text, 'ocr', 'r1', on, true, NO_RULES, []);
  assert.ok(built && !JSON.stringify(built.bodies).includes('a@b.com'));
  assert.equal(ocrObservation(result, 'ocr-1', false).nodes[0]?.value, 'mail a@b.com');
});

test('observationTextPages: 64000-scalar pages, an empty text as one page', () => {
  assert.deepEqual(textPages(''), ['']);
  assert.deepEqual(textPages('ab😀c', 2), ['ab', '😀c']);
});

// ---- Bodies

test('ContextSender.sendText: body fields, redacted title cut to 512, null incognito as true, request id on page 0', () => {
  const title = `token=abc ${'x'.repeat(600)}`;
  const built = contextTextBodies(cw({ title, urlHost: 'example.com' }, false), 'call +1 415 555 0100 now', 'ax', 'r1',
    observation('call', ['AXStaticText']), true, NO_RULES, []);
  assert.ok(built);
  const body = built.bodies[0]!;
  assert.equal(body.text, 'call [电话已遮蔽] now');
  assert.equal([...(body.title as string)].length, 512);
  assert.ok((body.title as string).startsWith('token=[已遮蔽]'));
  assert.deepEqual({ ...body, title: null, nodes: null }, {
    window_id: 640, app: 'TextEdit', bundle_id: 'com.apple.TextEdit', title: null, text: 'call [电话已遮蔽] now', source: 'ax',
    secure_input: false, incognito: false, url_host: 'example.com', request_id: 'r1', nodes: null,
    coverage: { status: 'complete', scope: 'visible_window', reasons: [], captured_nodes: 1, captured_chars: 4 },
    snapshot_id: 's1', snapshot_page: 0, snapshot_pages: 1, pid: 702,
  });
  assert.deepEqual(body.nodes, [{ id: 0, parent: -1, role: 'AXStaticText' }]);
  const unknown = contextTextBodies({ ...cw(), incognito: null }, 't', 'ocr', null, observation(), false, NO_RULES, []);
  assert.equal(unknown, null, 'browser_unknown is blocked');
});

test('ContextSender.sendText: a long text in pages, the request id only on the first', () => {
  const built = contextTextBodies(cw(), 'a'.repeat(64_001), 'ax', 'r1', observation(), false, NO_RULES, []);
  assert.deepEqual(built?.bodies.map((b) => [b.snapshot_page, b.snapshot_pages, b.request_id, (b.text as string).length]),
    [[0, 2, 'r1', 64_000], [1, 2, null, 1]]);
});

test('ContextSender: nothing of a blocked window is sent (blacklist, incognito, browser unknown, secure input, our own pid)', () => {
  const send = (w: CaptureWindow, own: number[] = []) => contextTextBodies(w, 't', 'ax', null, observation(), true, rules, own);
  assert.equal(send(cw({ bundleId: 'com.secret' })), null);
  assert.equal(send(cw({ app: 'vault' })), null);
  assert.equal(send(cw({ urlHost: 'www.bank.com' })), null);
  assert.equal(send(cw({ title: 'Private chat' })), null);
  assert.equal(send(cw({}, true)), null);
  assert.equal(send(cw({}, null)), null);
  assert.equal(send(cw({}, false, true)), null);
  assert.equal(send(cw(), [702]), null);
  assert.equal(send(cw({ bundleId: 'local.agenticcomplex.companion' })), null);
  assert.equal(send(cw({ windowId: null })), null);
  assert.ok(send(cw()));
  assert.equal(contextImageBody(cw({ bundleId: 'com.secret' }), 'r1', 'AAAA', rules, []), null);
});

test('ContextSender: the dedup signature changes with the text, title and node roles, not with bounds', () => {
  const sig = (title: string, text: string, roles: string[]) =>
    contextTextBodies(cw({ title }), text, 'ax', null, observation(text, roles), false, NO_RULES, [])?.signature;
  const base = sig('a', 'b', ['AXStaticText']);
  assert.equal(sig('a', 'b', ['AXStaticText']), base);
  assert.notEqual(sig('a2', 'b', ['AXStaticText']), base);
  assert.notEqual(sig('a', 'b2', ['AXStaticText']), base);
  assert.notEqual(sig('a', 'b', ['AXStaticText', 'AXButton']), base);
});

test('postContextImage and its failure report: the image with its url host; a failure without content, url host null, not held back', () => {
  assert.deepEqual(contextImageBody(cw({ urlHost: 'example.com' }), 'r1', 'AAAA', NO_RULES, []),
    { request_id: 'r1', window_id: 640, url_host: 'example.com', jpeg_base64: 'AAAA' });
  assert.deepEqual(imageFailureBody(cw({ bundleId: 'com.secret', urlHost: 'bank.com' }), 'r1', 'permission_denied'),
    { request_id: 'r1', window_id: 640, url_host: null, error: 'permission_denied' });
  assert.equal(imageFailureBody(cw({ windowId: null }), 'r1', 'window_gone'), null);
});

test('AgentdClient results: text 202 accepted or blocked, image 202, failure 200, 409 blocked, unreachable failed', () => {
  assert.deepEqual(textResult({ status: 202, body: { accepted: true } }), { kind: 'accepted' });
  assert.deepEqual(textResult({ status: 202, body: { accepted: false, reason: 'secure_input' } }), { kind: 'blocked', reason: 'secure_input' });
  assert.deepEqual(textResult({ status: 400, body: { error: 'bad' } }), { kind: 'rejected', status: 400, error: 'bad' });
  assert.deepEqual(textResult({ status: 0, body: null }), { kind: 'failed' });
  assert.deepEqual(imageResult({ status: 202, body: {} }, 202), { kind: 'accepted' });
  assert.deepEqual(imageResult({ status: 200, body: {} }, 200), { kind: 'accepted' });
  assert.deepEqual(imageResult({ status: 409, body: { error: 'blocked', reason: 'incognito' } }, 202), { kind: 'blocked', reason: 'incognito' });
  assert.deepEqual(lookResult({ status: 202, body: { request_id: 'q' } }), { kind: 'requested', requestId: 'q' });
  assert.deepEqual(lookResult({ status: 409, body: { error: 'blocked', reason: 'vision_off' } }), { kind: 'blocked', reason: 'vision_off' });
});

test('lookNow: the front title, else its app', () => {
  assert.equal(lookTitle(sample()), 'notes.txt');
  assert.equal(lookTitle(sample({ front: win({ title: '' }) })), 'TextEdit');
  assert.equal(lookTitle(null), null);
});

// ---- Selection

const pass = async () => null;

test('SelectionReadPolicy.blockReason: no window, blocked, and incognito whatever the blacklist says', () => {
  assert.equal(selectionBlockReason(null, NO_RULES, []), 'no_window');
  assert.equal(selectionBlockReason(cw({ bundleId: 'com.secret' }), rules, []), 'blacklisted');
  assert.equal(selectionBlockReason(cw({}, true), NO_RULES, []), 'incognito');
  assert.equal(selectionBlockReason(cw({}, null), NO_RULES, []), 'browser_unknown');
  assert.equal(selectionBlockReason(cw(), NO_RULES, []), null);
});

test('SelectionReadPolicy.decide: secure input and a block refuse before anything is read', async () => {
  let reads = 0;
  const ax = async () => { reads += 1; return 'x'; };
  const clip = async () => { reads += 1; return { types: ['public.utf8-plain-text'], text: 'y' }; };
  assert.deepEqual(await decideSelection(true, null, ax, pass, clip, 10), { kind: 'refused', message: '安全输入中，没有读取' });
  assert.deepEqual(await decideSelection(false, 'incognito', ax, pass, clip, 10), { kind: 'refused', message: '无痕窗口，没有读取' });
  assert.equal(reads, 0);
});

test('SelectionReadPolicy.decide: the selection, else the clipboard, cut to the limit; concealed items are not read', async () => {
  const none = async () => null;
  assert.deepEqual(await decideSelection(false, null, async () => 'abcdef', pass, none, 4),
    { kind: 'read', read: { source: 'selection', text: 'abcd', truncated: true } });
  let clipboardRead = false;
  await decideSelection(false, null, async () => 'sel', pass, async () => { clipboardRead = true; return null; }, 10);
  assert.equal(clipboardRead, false, 'the clipboard is read only without a selection');
  assert.deepEqual(await decideSelection(false, null, async () => '  ', pass, async () => ({ types: ['public.utf8-plain-text'], text: 'clip' }), 10),
    { kind: 'read', read: { source: 'clipboard', text: 'clip', truncated: false } });
  assert.deepEqual(await decideSelection(false, null, none, pass, async () => ({ types: ['public.utf8-plain-text', 'org.nspasteboard.ConcealedType'], text: 'pw' }), 10),
    { kind: 'empty' });
  assert.deepEqual(await decideSelection(false, null, none, pass, async () => ({ types: ['org.nspasteboard.TransientType'], text: 'otp' }), 10),
    { kind: 'empty' });
  assert.deepEqual(await decideSelection(false, null, none, pass, none, 10), { kind: 'empty' });
});

test('SelectionReadPolicy.decide: a block found after the selection read refuses before the clipboard', async () => {
  let clipboardRead = false;
  const clip = async () => { clipboardRead = true; return { types: ['public.utf8-plain-text'], text: 'y' }; };
  assert.deepEqual(await decideSelection(false, null, async () => null, async () => 'secure_input', clip, 10),
    { kind: 'refused', message: '安全输入中，没有读取' });
  assert.deepEqual(await decideSelection(false, null, async () => 'sel', async () => 'incognito', clip, 10),
    { kind: 'refused', message: '无痕窗口，没有读取' });
  assert.equal(clipboardRead, false);
});

test('clipboard.read: the first clip_item; a concealed clipboard has none', () => {
  assert.deepEqual(firstClipItem({ items: [{ types: ['public.utf8-plain-text'], text: 'a' }], concealed: false, truncated: false }),
    { types: ['public.utf8-plain-text'], text: 'a' });
  assert.equal(firstClipItem({ items: [], concealed: true, truncated: false }), null);
});

// ---- Own capture

test('OwnCapture: recent while running and for 3 s after', () => {
  const o = new OwnCapture();
  assert.equal(o.recent(10_000), false);
  o.note(1, 10_000);
  assert.equal(o.recent(20_000), true, 'still running');
  o.note(-1, 20_000);
  assert.equal(o.recent(22_999), true);
  assert.equal(o.recent(23_000), false);
});
