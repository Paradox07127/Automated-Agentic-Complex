// src/common/give-way.ts: the user's screen targets to keep clear and the fullscreen hide. Rule 35 is test/surfaces.test.ts's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionSample } from '../src/common/attention.ts';
import {
  decodeFocus, decodeRects, FEED, feedRects, type FeedReading, FullscreenHider, fullscreenStep, fullscreenWatching, captureHides,
  fromHelper, othersFocus,
} from '../src/common/give-way.ts';

const MAIN = 900;
const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const reading = (over: Partial<FeedReading> = {}): FeedReading => ({ focus: null, buttons: [], banners: [], ime: [], reflex: null, ...over });

test('helper rects flip into the placement space against the main display height', () => {
  assert.deepEqual(fromHelper(r(100, 50, 200, 30), MAIN), { x: 100, y: 820, w: 200, h: 30 });
});

test('ax.focused decodes pid, frame, caret and editable; anything malformed reads as no focus (CONTRACT §7.12 focus)', () => {
  const v = { pid: 7, role: 'AXTextField', native_role: 'AXTextField', subrole: null, frame: r(1, 2, 3, 4), caret: null, editable: true };
  assert.deepEqual(decodeFocus(v), { pid: 7, frame: r(1, 2, 3, 4), caret: null, editable: true });
  assert.deepEqual(decodeFocus({ ...v, caret: r(5, 6, 2, 14) })?.caret, r(5, 6, 2, 14));
  assert.equal(decodeFocus(null), null);
  assert.equal(decodeFocus({ ...v, frame: null }), null);
  assert.equal(decodeFocus({ ...v, pid: 'x' }), null);
  assert.deepEqual(decodeRects([r(0, 0, 1, 1), { x: 1 }, 'no']), [r(0, 0, 1, 1)]);
  assert.deepEqual(decodeRects(undefined), []);
});

test('her own focus is no target', () => {
  const f = { pid: 4000, frame: r(0, 0, 10, 10), caret: null, editable: true };
  assert.equal(othersFocus(f, [4000, 4001]), null);
  assert.equal(othersFocus({ ...f, pid: 702 }, [4000])?.pid, 702);
  assert.equal(othersFocus(null, [4000]), null);
});

test('an editable field up to 800×160 is a text_input; a larger one counts by its caret only', () => {
  const small = feedRects(reading({ focus: { pid: 1, frame: r(100, 100, 800, 160), caret: null, editable: true } }), MAIN);
  assert.deepEqual(small, [{ kind: 'text_input', frame: { x: 100, y: 640, w: 800, h: 160 } }]);
  assert.deepEqual(feedRects(reading({ focus: { pid: 1, frame: r(100, 100, 801, 160), caret: null, editable: true } }), MAIN), []);
  assert.deepEqual(feedRects(reading({ focus: { pid: 1, frame: r(100, 100, 800, 161), caret: null, editable: true } }), MAIN), []);
});

test('the caret grows by 60 × 8 points on each side', () => {
  const out = feedRects(reading({ focus: { pid: 1, frame: r(0, 0, 1000, 600), caret: r(300, 200, 2, 16), editable: true } }), MAIN);
  assert.deepEqual(out, [{ kind: 'caret', frame: { x: 240, y: MAIN - 216 - 8, w: 122, h: 32 } }]);
  assert.equal(FEED.interval, 0.5);
});

test('a focus that is not editable gives neither a field nor a caret', () => {
  assert.deepEqual(feedRects(reading({ focus: { pid: 1, frame: r(0, 0, 50, 20), caret: r(1, 1, 2, 10), editable: false } }), MAIN), []);
});

test('dialog buttons, banners, input method windows and the reflex follow, in that order', () => {
  const out = feedRects(reading({
    focus: { pid: 1, frame: r(0, 0, 100, 20), caret: null, editable: true },
    buttons: [r(500, 400, 80, 24)], banners: [r(1000, 40, 360, 80)], ime: [r(300, 300, 200, 40)],
    reflex: { kind: 'video', rect: r(0, 100, 1440, 700) },
  }), MAIN);
  assert.deepEqual(out.map((x) => x.kind), ['text_input', 'dialog', 'banner', 'ime', 'video']);
  assert.deepEqual(out[1]!.frame, { x: 500, y: 476, w: 80, h: 24 });
  assert.deepEqual(out[2]!.frame, { x: 1000, y: 780, w: 360, h: 80 });
  assert.deepEqual(out[3]!.frame, { x: 300, y: 560, w: 200, h: 40 });
  // The reflex rect is in AppKit points already (AttentionSampler.reflex).
  assert.deepEqual(out[4]!.frame, { x: 0, y: 100, w: 1440, h: 700 });
  assert.deepEqual(feedRects(reading({ reflex: { kind: 'game', rect: r(0, 0, 10, 10) } }), MAIN)[0]!.kind, 'game');
});

// ---- Fullscreen

test('FullscreenHide.step: hide on entering fullscreen with 隐藏 unless the user hid her; show when it ends or the setting changes', () => {
  const base = { fullscreen: true, wasFullscreen: false, behavior: 'hide', hiddenByUser: false, hiddenByFullscreen: false };
  assert.equal(fullscreenStep(base), 'hide');
  assert.equal(fullscreenStep({ ...base, wasFullscreen: true }), 'none');
  assert.equal(fullscreenStep({ ...base, wasFullscreen: true, captureStarted: true }), 'hide');
  assert.equal(fullscreenStep({ ...base, behavior: 'corner' }), 'none');
  assert.equal(fullscreenStep({ ...base, hiddenByUser: true }), 'none');
  assert.equal(fullscreenStep({ ...base, fullscreen: false, hiddenByFullscreen: true }), 'show');
  assert.equal(fullscreenStep({ ...base, behavior: 'corner', hiddenByFullscreen: true }), 'show');
  assert.equal(fullscreenStep({ ...base, wasFullscreen: true, hiddenByFullscreen: true }), 'none');
});

test('a fullscreen video or game keeps her watching until the front app changes or fullscreen ends', () => {
  assert.equal(fullscreenWatching(false, true, true, false), true);
  assert.equal(fullscreenWatching(true, true, false, true), true);
  assert.equal(fullscreenWatching(true, true, false, false), false);
  assert.equal(fullscreenWatching(true, false, true, true), false);
});

test('a screen capture counts only while hide_on_screen_capture is on', () => {
  assert.equal(captureHides(true, () => true), true);
  assert.equal(captureHides(true, () => false), false);
  assert.equal(captureHides(null, () => { throw new Error('read'); }), false);
});

const sample = (over: Partial<AttentionSample> = {}): AttentionSample => ({
  ts: 0, front: { app: 'X', bundleId: 'x', pid: 702, windowId: 1, title: null, urlHost: null }, frontIncognito: false, mouse: null,
  idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false, fullscreen: false, cameraActive: false, micActive: false,
  userSpeaking: null, focusWindow: null, input: null, frontAudioOut: null, frontVideo: null, frontGpu: null, screenCaptured: false,
  edge: null, frontBounds: null, ...over,
});

function hider() {
  const h = new FullscreenHider();
  let behavior = 'hide', hideOnCapture = true, reads = 0;
  const config = { behavior: () => { reads += 1; return behavior; }, hideOnScreenCapture: () => hideOnCapture };
  return {
    h, set behavior(v: string) { behavior = v; }, set hideOnCapture(v: boolean) { hideOnCapture = v; }, get reads() { return reads; },
    run: (s: Partial<AttentionSample>, o: { reflex?: boolean; hidden?: boolean } = {}) => h.sampled(sample(s), o.reflex ?? false, o.hidden ?? false, config),
  };
}

test('fullscreenSampled hides on entering, shows on leaving, and reads config.json only when something changed', () => {
  const t = hider();
  assert.equal(t.run({}), null);
  assert.equal(t.reads, 0);
  assert.deepEqual(t.run({ fullscreen: true }), { hide: true, behavior: 'hide', captured: false });
  assert.equal(t.h.hidden, true);
  assert.equal(t.run({ fullscreen: true }, { hidden: true }), null);
  assert.deepEqual(t.run({ fullscreen: false }, { hidden: true }), { hide: false, behavior: 'hide', captured: false });
  assert.equal(t.h.hidden, false);
});

test('an unread fullscreen keeps the last one', () => {
  const t = hider();
  t.run({ fullscreen: true });
  assert.equal(t.run({ fullscreen: null }, { hidden: true }), null);
  assert.equal(t.h.hidden, true);
});

test('a fullscreen video or game is watched from the edge, not hidden', () => {
  const t = hider();
  assert.equal(t.run({ fullscreen: true }, { reflex: true }), null);
  assert.equal(t.run({ fullscreen: true }), null);
  // Another front app in fullscreen without a reflex is fullscreen again.
  assert.equal(t.run({ fullscreen: true, front: { app: 'Y', bundleId: 'y', pid: 800, windowId: 2, title: null, urlHost: null } })?.hide, true);
});

test('a screen capture hides her whatever fullscreen_behavior says', () => {
  const t = hider();
  t.behavior = 'corner';
  assert.deepEqual(t.run({ screenCaptured: true }), { hide: true, behavior: 'hide', captured: true });
  assert.deepEqual(t.run({ screenCaptured: false }, { hidden: true }), { hide: false, behavior: 'corner', captured: false });
  const off = hider();
  off.hideOnCapture = false;
  assert.equal(off.run({ screenCaptured: true }), null);
});

test('an unread capture keeps the last read one, so unmuting during a share does not show her', () => {
  const t = hider();
  assert.deepEqual(t.run({ screenCaptured: true }), { hide: true, behavior: 'hide', captured: true });
  assert.equal(t.run({ screenCaptured: null, micActive: true }, { hidden: true }), null);
  assert.equal(t.h.hidden, true);
  assert.deepEqual(t.run({ screenCaptured: false }, { hidden: true }), { hide: false, behavior: 'hide', captured: false });
});

test('a capture that starts while she is hidden for another reason hides her once that reason shows her', () => {
  const t = hider();
  assert.equal(t.run({ screenCaptured: true }, { hidden: true }), null);
  assert.equal(t.run({ screenCaptured: true }, { hidden: true }), null);
  t.h.userSet();
  assert.deepEqual(t.run({ screenCaptured: true }), { hide: true, behavior: 'hide', captured: true });
  // Shown again by the user after that hide: theirs, as in fullscreen.
  t.h.userSet();
  assert.equal(t.run({ screenCaptured: true }), null);
  const ended = hider();
  ended.run({ screenCaptured: true }, { hidden: true });
  assert.equal(ended.run({ screenCaptured: false }), null);
  assert.equal(ended.run({ screenCaptured: false }), null);
});

test('a hide or show by the user during fullscreen is theirs; leaving fullscreen does not undo it', () => {
  const t = hider();
  t.run({ fullscreen: true });
  t.h.userSet();
  assert.equal(t.h.hidden, false);
  assert.equal(t.run({ fullscreen: false }, { hidden: true }), null);
  const user = hider();
  assert.equal(user.run({ fullscreen: true }, { hidden: true }), null);
});
