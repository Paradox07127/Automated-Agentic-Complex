// src/common/computer-control.ts: consent, interruption and the control host's request checks, one test per rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_BLACKLIST, parseBlacklist } from '../src/common/attention.ts';
import {
  actParams, appRefusal, canRequest, chooseApp, computerUseState, CONSENT, ControlConsent, ControlError, ControlInterruption,
  type ControlTarget, decodeApps, decodeRequest, errorResponse, helperFailure, initialPanelState, observedElements, okResponse,
  requestedInteger, type RunningApp, sameTarget, scrollDelta, targetJSON, titleRefusal, validSession,
} from '../src/common/computer-control.ts';

// Deny mode with no rules: every window but our own is read.
const NO_RULES = parseBlacklist({ mode: 'deny' });

const T: ControlTarget = { bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, launchedAt: 1000, frame: { x: 0, y: 25, width: 800, height: 600 } };
const NOW = 1_763_539_200;

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ControlError, String(e));
    return e.code;
  }
  return 'none';
};

test('sameTarget compares process generation and geometry, not just the window id', () => {
  assert.ok(sameTarget(T, { ...T, frame: { ...T.frame } }));
  assert.ok(!sameTarget(T, { ...T, launchedAt: 1001 }));
  assert.ok(!sameTarget(T, { ...T, frame: { ...T.frame, x: 1 } }));
  assert.ok(sameTarget(null, null));
  assert.ok(!sameTarget(T, null));
});

test('no grant: every check fails and nothing is granted', () => {
  const c = new ControlConsent();
  assert.equal(code(() => c.check('s1', T, 'observation', NOW)), 'grant_expired');
  assert.equal(code(() => c.check('s1', T, 'control', NOW)), 'approval_required');
  assert.deepEqual([...c.granted(NOW)], []);
});

test('a grant is for one session, one exact window and one permission', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'observation', NOW);
  assert.equal(code(() => c.check('s1', T, 'observation', NOW)), 'none');
  assert.equal(code(() => c.check('s2', T, 'observation', NOW)), 'session_not_granted');
  assert.equal(code(() => c.check('s1', { ...T, windowId: 641 }, 'observation', NOW)), 'target_changed');
  assert.equal(code(() => c.check('s1', T, 'text', NOW)), 'permission_required');
  assert.equal(code(() => c.check('s1', T, 'control', NOW)), 'approval_required');
});

test('the task grant lasts 600 s', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'observation', NOW);
  assert.equal(code(() => c.check('s1', T, 'observation', NOW + 599.9)), 'none');
  assert.equal(code(() => c.check('s1', T, 'observation', NOW + 600)), 'grant_expired');
});

test('control allows 5 acts within 120 s', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'control', NOW);
  for (let i = 0; i < CONSENT.controlActions; i += 1) {
    assert.equal(code(() => c.check('s1', T, 'control', NOW)), 'none');
    c.consumeControl(false);
  }
  assert.equal(code(() => c.check('s1', T, 'control', NOW)), 'approval_required');
  const d = new ControlConsent();
  d.grant('s1', T, 'control', NOW);
  assert.equal(code(() => d.check('s1', T, 'control', NOW + 119.9)), 'none');
  assert.equal(code(() => d.check('s1', T, 'control', NOW + 120)), 'approval_required');
  assert.ok(!d.granted(NOW + 120).has('control'));
});

test('a text write uses the whole control grant', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'control', NOW);
  c.consumeControl(true);
  assert.equal(c.controlActionsLeft, 0);
  assert.equal(code(() => c.check('s1', T, 'control', NOW)), 'approval_required');
});

test('a stop revokes everything and leaves the consent stopped; release leaves it unstopped', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'observation', NOW);
  c.revoke();
  assert.equal(code(() => c.check('s1', T, 'observation', NOW)), 'stopped');
  const d = new ControlConsent();
  d.grant('s1', T, 'observation', NOW);
  assert.equal(d.release('s2', NOW), false);
  assert.equal(d.sessionId, 's1');
  assert.equal(d.release('s1', NOW), true);
  assert.equal(d.stopped, false);
  assert.equal(d.sessionId, null);
});

test('revoking one permission keeps the others and their lifetime', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'observation', NOW);
  c.grant('s1', T, 'text', NOW + 10);
  c.revokeOne('text');
  assert.equal(code(() => c.check('s1', T, 'text', NOW + 10)), 'permission_required');
  assert.equal(code(() => c.check('s1', T, 'observation', NOW + 10)), 'none');
  assert.equal(c.expiresAt, NOW + 600);
});

test('a grant for another window replaces the first one; asking for another window ends control', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'control', NOW);
  c.targetRequested('s1', { ...T, windowId: 641 });
  assert.equal(code(() => c.check('s1', T, 'control', NOW)), 'approval_required');
  c.grant('s1', { ...T, windowId: 641 }, 'observation', NOW);
  assert.equal(code(() => c.check('s1', T, 'observation', NOW)), 'target_changed');
});

test('snapshots live 15 s, only for the epoch they were taken in and the same window', () => {
  const c = new ControlConsent();
  c.grant('s1', T, 'observation', NOW);
  c.snapshot('s1', T, NOW, 'o-1');
  assert.equal(code(() => c.validate('o-1', 's1', T, 'observation', NOW + 14.9)), 'none');
  assert.equal(code(() => c.validate('o-1', 's1', T, 'observation', NOW + 15)), 'stale_snapshot');
  assert.equal(code(() => c.validate('o-2', 's1', T, 'observation', NOW)), 'stale_snapshot');
  c.invalidateSnapshots();
  assert.equal(code(() => c.validate('o-1', 's1', T, 'observation', NOW)), 'stale_snapshot');
});

test('a snapshot needs the observation grant; at most 16 are kept', () => {
  const c = new ControlConsent();
  assert.equal(code(() => c.snapshot('s1', T, NOW, 'o-1')), 'grant_expired');
  c.grant('s1', T, 'observation', NOW);
  for (let i = 0; i < 17; i += 1) c.snapshot('s1', T, NOW + i * 0.1, `o-${i}`);
  assert.equal(code(() => c.validate('o-0', 's1', T, 'observation', NOW + 2)), 'stale_snapshot');
  assert.equal(code(() => c.validate('o-16', 's1', T, 'observation', NOW + 2)), 'none');
});

test('nextExpiry is the earlier of the control window and the task grant', () => {
  const c = new ControlConsent();
  assert.equal(c.nextExpiry(NOW), null);
  c.grant('s1', T, 'observation', NOW);
  assert.equal(c.nextExpiry(NOW), NOW + 600);
  c.grant('s1', T, 'control', NOW);
  assert.equal(c.nextExpiry(NOW), NOW + 120);
});

test('the interruption: a ticket taken before a stop cannot activate', () => {
  const i = new ControlInterruption();
  const ticket = i.ticket();
  i.interrupt();
  assert.ok(i.isStopped);
  assert.equal(i.activate(ticket, 's1'), false);
  assert.ok(i.isStopped);
  assert.equal(i.activate(i.ticket(), 's1'), true);
  assert.ok(!i.isStopped);
});

test('the interruption: a cancel only stops the session that owns it', () => {
  const i = new ControlInterruption();
  i.prepare('s1');
  assert.equal(i.interruptSession('s2'), false);
  assert.ok(!i.isStopped);
  assert.equal(i.interruptSession('s1'), true);
  assert.ok(i.isStopped);
});

test('requests: decoded fields, session ids up to 128 bytes', () => {
  assert.equal(decodeRequest([1]), null);
  assert.deepEqual(decodeRequest({ id: 'a', method: 'desktop_observe', session_id: 's', params: { pid: 1 }, wait_for_permission: true }),
    { id: 'a', method: 'desktop_observe', sessionId: 's', params: { pid: 1 }, waitForPermission: true, waitForResume: false });
  assert.ok(validSession('s'.repeat(128)));
  assert.ok(!validSession('s'.repeat(129)));
  assert.ok(!validSession('é'.repeat(65)));
  assert.ok(!validSession(''));
});

test('answers: retryable only where given', () => {
  assert.deepEqual(okResponse('a', { x: 1 }), { id: 'a', result: { x: 1 } });
  assert.deepEqual(errorResponse(undefined, 'c', 'm'), { id: null, error: { code: 'c', message: 'm' } });
  assert.deepEqual(errorResponse('a', 'c', 'm', false), { id: 'a', error: { code: 'c', message: 'm', retryable: false } });
});

test('requestedInteger: a whole positive number in range; booleans and fractions are invalid_target', () => {
  assert.equal(requestedInteger({}, 'pid', 10), null);
  assert.equal(requestedInteger({ pid: 7 }, 'pid', 10), 7);
  for (const bad of [0, -1, 1.5, 11, true, '7', Number.NaN]) assert.equal(code(() => requestedInteger({ pid: bad }, 'pid', 10)), 'invalid_target');
});

test('scroll delta: integer, at most 10000, clamped to 600', () => {
  assert.equal(scrollDelta(-9000), -600);
  assert.equal(scrollDelta(120), 120);
  for (const bad of [1.5, 10001, true, null]) assert.equal(code(() => scrollDelta(bad)), 'invalid_scroll');
});

test('actParams: each action needs its fields; the point must be inside the window', () => {
  const f = T.frame;
  assert.deepEqual(actParams('o', { action: 'press', element_id: 'e1' }, f, true), { snapshot_id: 'o', action: 'press', element_id: 'e1' });
  assert.equal(code(() => actParams('o', { action: 'press', element_id: 'e9' }, f, false)), 'element_required');
  assert.equal(code(() => actParams('o', { action: 'set_value', element_id: 'e1', text: 'x'.repeat(4097) }, f, true)), 'invalid_text');
  assert.equal(code(() => actParams('o', { action: 'type', text: 'x' }, f, false)), 'invalid_text');
  assert.deepEqual(actParams('o', { action: 'scroll', x: 10, y: 10, delta_y: 900 }, f, false),
    { snapshot_id: 'o', action: 'scroll', x: 10, y: 10, delta_y: 600 });
  assert.equal(code(() => actParams('o', { action: 'click', x: 800, y: 10 }, f, false)), 'invalid_point');
  assert.equal(code(() => actParams('o', { action: 'click', x: -1, y: 10 }, f, false)), 'invalid_point');
  assert.equal(code(() => actParams('o', { action: 'drag' }, f, false)), 'unsupported');
  assert.equal(code(() => actParams('o', {}, f, false)), 'invalid_action');
});

test('helper failures map to the control error codes; unknown ones are native_error', () => {
  assert.equal(helperFailure('permission_denied').code, 'ax_permission_required');
  assert.equal(helperFailure('element_gone').code, 'element_required');
  assert.equal(helperFailure('too_large').code, 'image_too_large');
  assert.equal(helperFailure('foreground_required').code, 'foreground_required');
  assert.equal(helperFailure('helper_exited').code, 'native_error');
  assert.equal(helperFailure('helper_timeout').code, 'native_error');
});

const APPS: RunningApp[] = decodeApps({ apps: [
  { pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit', launched_at: 1000 },
  { pid: 900, name: 'Safari', app_id: 'com.apple.Safari' },
  { pid: 50, name: 'Endfield', app_id: 'local.agenticcomplex.companion' },
  { pid: 60, name: 'Helper', app_id: 'x.helper' },
  { pid: 61, name: 'NoBundle', app_id: '' },
] });

test('chooseApp: exactly one running app, never this shell, never one without a bundle id', () => {
  assert.equal(chooseApp(APPS, 702, null, [50]).launchedAt, 1000);
  assert.equal(chooseApp(APPS, null, 'com.apple.TextEdit', [50]).pid, 702);
  assert.equal(code(() => chooseApp(APPS, null, null, [50])), 'target_ambiguous');
  assert.equal(code(() => chooseApp(APPS, 50, null, [50])), 'target_ambiguous');
  assert.equal(code(() => chooseApp(APPS, 60, null, [50, 60])), 'target_ambiguous');
  assert.equal(code(() => chooseApp(APPS, 61, null, [50])), 'target_ambiguous');
  assert.equal(code(() => chooseApp(APPS, 702, 'com.apple.Notes', [50])), 'target_ambiguous');
});

test('appRefusal and titleRefusal: browsers, the blacklisted app and the blacklisted or unreadable window title', () => {
  const app = (pid: number) => APPS.find((a) => a.pid === pid)!;
  assert.equal(appRefusal(app(900), NO_RULES, [])?.code, 'browser_driver_required');
  assert.equal(appRefusal(app(702), NO_RULES, []), null);
  assert.equal(appRefusal(app(702), parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] }), [])?.code, 'blacklisted');
  assert.equal(appRefusal(app(702), parseBlacklist({ mode: 'deny', app_names: ['textedit'] }), [])?.code, 'blacklisted');
  assert.equal(appRefusal(app(50), NO_RULES, [])?.code, 'blacklisted');
  const titles = parseBlacklist({ mode: 'deny', title_patterns: ['bank'] });
  assert.equal(titleRefusal(app(702), 'notes.txt', titles, []), null);
  assert.equal(titleRefusal(app(702), 'my bank.txt', titles, [])?.message, '此窗口标题被排除');
  assert.equal(titleRefusal(app(702), null, titles, [])?.code, 'blacklisted');
  assert.equal(titleRefusal(app(702), null, parseBlacklist({ mode: 'deny', app_names: ['notes'] }), []), null);
});

test('appRefusal and titleRefusal in allow mode: an app allowed by its name is controlled, whatever its window title', () => {
  const app = (pid: number) => APPS.find((a) => a.pid === pid)!;
  const allowed = parseBlacklist({ mode: 'allow', title_patterns: ['bank'], allow: { app_names: [app(702).name] } });
  assert.equal(appRefusal(app(702), allowed, []), null);
  assert.equal(titleRefusal(app(702), 'my bank.txt', allowed, []), null);
  assert.equal(titleRefusal(app(702), null, allowed, []), null);
  assert.equal(appRefusal(app(702), EMPTY_BLACKLIST, [])?.code, 'blacklisted');
});

test('observedElements: text only when asked, redacted and at most 512 characters; only AXPress', () => {
  const raw = [{ element_id: 'e0', role: 'AXTextField', native_role: 'AXTextField', enabled: true, title: 'To', value: 'mail a@b.com',
    bounds: { x: 1, y: 2, width: 3, height: 4 }, actions: ['AXPress', 'AXShowMenu'] }, { role: 'AXGroup' }];
  assert.deepEqual(observedElements(raw, false), [{ element_id: 'e0', role: 'AXTextField', enabled: true,
    bounds: { x: 1, y: 2, width: 3, height: 4 }, actions: ['AXPress'] }]);
  const [withText] = observedElements([{ ...raw[0], title: 'x'.repeat(600) }], true);
  assert.equal(withText.value, 'mail [邮箱已遮蔽]');
  assert.equal([...(withText.title as string)].length, 512);
});

test('targetJSON is the wire shape', () => {
  assert.deepEqual(targetJSON(T), { bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640, process_generation: 1000,
    bounds: { x: 0, y: 25, width: 800, height: 600 } });
});

test('computerUseState: the allowed scopes and whether a session is at work', () => {
  const s = { ...initialPanelState(), phase: 'executing' as const, permissions: { observation: 'allowed' as const, control: 'off' as const } };
  assert.deepEqual(computerUseState(s), { granted: ['observation'], active: true });
  assert.deepEqual(computerUseState({ ...s, phase: 'paused' }), { granted: ['observation'], active: false });
});

test('canRequest: not while the same grant is being confirmed', () => {
  const s = initialPanelState();
  assert.ok(canRequest(s, 'text'));
  assert.ok(!canRequest({ ...s, pendingGrants: ['text'] }, 'text'));
  assert.ok(!canRequest({ ...s, permissions: { text: 'unavailable' } }, 'text'));
});
