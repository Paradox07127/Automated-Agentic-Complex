// Where the avatar stands (src/common/placement.ts, src/common/keepclear.ts, src/main/placement/, src/main/platform/screens.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Display, Rectangle } from 'electron';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import type { C3Message } from '../src/common/c3.ts';
import { capsuleBounds, KEEP_CLEAR, keepClearId, type KeepClearKind, type KeepClearRect, KeepClearState, shownFrame } from '../src/common/keepclear.ts';
import {
  clamp, defaultAnchor, defaultOrigin, fixed, launchDisplay, placementArgument, type Rect, readPlacement, type ScreenInfo, windowTarget,
  withPosition,
} from '../src/common/placement.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { loadConfig } from '../src/main/config.ts';
import { avatarOps } from '../src/main/ops/avatar.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { AvatarPlacer, type PlacementLink } from '../src/main/placement/controller.ts';
import { PlacementFiles, readState, saveLastDisplay, saveWindowScale } from '../src/main/placement/store.ts';
import { placementSpace, type PlacementSpace } from '../src/main/platform/screens.ts';
import type { LinkEvent } from '../src/main/renderer/link.ts';
import { rendererArguments } from '../src/main/renderer/supervisor.ts';

const main: ScreenInfo = { id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 70, w: 1440, h: 805 } };
const side: ScreenInfo = { id: 2, frame: { x: 1440, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1440, y: 0, w: 1920, h: 1055 } };
const frame = (x: number, y: number): Rect => ({ x, y, w: 360, h: 520 });
const size = { w: 360, h: 520 };

function tempDir(prefix = 'e2b-p-'): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('WindowPlacementTests: the default is the main screen bottom-right with margins; the fullscreen anchor 200 in on the bottom', () => {
  assert.deepEqual(defaultOrigin(size, [main]), { x: 1056, y: 94 });
  assert.deepEqual(defaultOrigin(size, [main, side]), { x: 1056, y: 94 });
  assert.equal(defaultOrigin(size, []), null);
  assert.deepEqual(windowTarget({}, 'aster', frame(10, 10), [main]), { x: 1056, y: 94 });
  assert.deepEqual(defaultAnchor(side.visibleFrame), { x: 3360 - 200, y: 0 });
  assert.deepEqual(defaultAnchor(main.visibleFrame), { x: 1240, y: 70 });
});

test('WindowPlacementTests: remembered per character and display, clamped into the visible frame, the default when the display is gone', () => {
  let p = withPosition({}, 'aster', frame(1600, 300), [main, side])!;
  p = withPosition(p, 'aster', frame(100, 200), [main, side])!;
  assert.deepEqual(p.aster, { 2: { x: 1600, y: 300 }, 1: { x: 100, y: 200 } });
  assert.equal(p.birch, undefined);
  assert.deepEqual(windowTarget(p, 'aster', frame(2000, 500), [main, side]), { x: 1600, y: 300 });
  assert.deepEqual(windowTarget(p, 'aster', frame(500, 500), [main, side]), { x: 100, y: 200 });
  assert.deepEqual(windowTarget(p, 'birch', frame(2000, 500), [main, side]), { x: 1056, y: 94 });
  assert.equal(withPosition({}, 'aster', frame(9000, 9000), [main, side]), null, 'a frame on no display is dropped');

  assert.deepEqual(clamp({ x: 3300, y: -50 }, size, side.visibleFrame), { x: 3000, y: 0 });
  assert.deepEqual(clamp({ x: -20, y: 800 }, size, main.visibleFrame), { x: 0, y: 355 });
  assert.deepEqual(clamp({ x: 200, y: 300 }, size, main.visibleFrame), { x: 200, y: 300 });
  const high = withPosition({}, 'aster', frame(3200, 900), [main, side])!;
  assert.deepEqual(windowTarget(high, 'aster', frame(2000, 500), [main, side]), { x: 3000, y: 535 });
  const gone = withPosition({}, 'aster', frame(1600, 300), [main, side])!;
  assert.deepEqual(windowTarget(gone, 'aster', frame(1600, 300), [main]), { x: 1056, y: 94 });
});

test('HostLinkTests: a placement out of range, on display 0, with an unknown reason or a coordinate past the limit is rejected', () => {
  const base = { v: 1, type: 'placement', x: 1200, y: 70, scale: 1, display_id: 1, reason: 'drag' };
  assert.deepEqual(readPlacement({ ...base, scale: 3 }), { rejected: 'scale' });
  assert.deepEqual(readPlacement({ ...base, display_id: 0 }), { rejected: 'display_id' });
  assert.deepEqual(readPlacement({ ...base, display_id: 1.5 }), { rejected: 'display_id' });
  assert.deepEqual(readPlacement({ ...base, reason: 'teleport' }), { rejected: 'reason' });
  assert.deepEqual(readPlacement({ ...base, x: 1e9 }), { rejected: 'coordinate' });
  assert.deepEqual(readPlacement({ ...base, scale: undefined }), { rejected: 'missing_field' });
  assert.deepEqual(readPlacement({ ...base, x: 1200.5, scale: 1.25, display_id: 69733248 }), { x: 1200.5, y: 70, scale: 1.25, displayId: 69733248 });
});

test("the launch argument is printf's %.1f,%.1f,%.3f, ties to even", () => {
  assert.equal(placementArgument({ x: 1200.5, y: 70, scale: 1.25 }), '1200.5,70.0,1.250');
  assert.equal(placementArgument({ x: -878, y: 117.25, scale: 1.0625 }), '-878.0,117.2,1.062');
  assert.deepEqual([fixed(0.25, 1), fixed(0.35, 1), fixed(-0.25, 1), fixed(2.5, 0), fixed(3.5, 0), fixed(-0.04, 1), fixed(1.0005, 3)],
    ['0.2', '0.3', '-0.2', '2', '4', '-0.0', '1.000']);
});

test('AppliedPlacementTests: viewports persist to separate stores across a restart; an unknown viewport writes neither', () => {
  const t = tempDir();
  try {
    const store = new PlacementFiles(t.dir);
    store.recordReported({ x: 100, y: 200, scale: 1.2, displayId: 11 }, 'fullscreen', 'si');
    store.recordReported({ x: 999, y: 888, scale: 0.7, displayId: 22 }, 'window', 'si');
    const restarted = new PlacementFiles(t.dir);
    assert.deepEqual(restarted.placements.si, { 11: { x: 100, y: 200, scale: 1.2 } });
    restarted.recordReported({ x: -100, y: 50, scale: 1.4, displayId: 22 }, 'fullscreen', 'si');
    const final = new PlacementFiles(t.dir), state = readState(t.dir);
    assert.deepEqual(final.placements.si?.[22], { x: -100, y: 50, scale: 1.4 });
    assert.equal(launchDisplay(state, 'si', [11, 22], 11), 22);
    assert.deepEqual(state.window_scale, { si: 0.7 });
    assert.equal(final.placements.aster, undefined);

    const other = tempDir();
    try {
      const s = new PlacementFiles(other.dir);
      for (const viewport of [null, 'invalid']) s.recordReported({ x: 1, y: 2, scale: 3, displayId: 9 }, viewport, 'si');
      assert.deepEqual(readState(other.dir), {});
      assert.deepEqual(new PlacementFiles(other.dir).placements, {});
    } finally {
      other.done();
    }
  } finally {
    t.done();
  }
});

test('a malformed file reads as empty, as a failed JSONDecoder decode', () => {
  const t = tempDir();
  try {
    writeFileSync(join(t.dir, 'window-positions.json'), JSON.stringify({ aster: { 1: { x: 1, y: 2 } }, birch: { 1: { x: 'a', y: 2 } } }));
    writeFileSync(join(t.dir, 'placements.json'), '[');
    const files = new PlacementFiles(t.dir);
    assert.deepEqual(files.positions, {});
    assert.deepEqual(files.placements, {});
  } finally {
    t.done();
  }
});

test('the launch display is the last one while connected', () => {
  const t = tempDir();
  try {
    assert.equal(launchDisplay(readState(t.dir), 'aster', [1, 2], 1), 1, 'nothing saved');
    saveLastDisplay(t.dir, 'aster', 2);
    assert.equal(launchDisplay(readState(t.dir), 'aster', [1, 2], 1), 2);
    assert.equal(launchDisplay(readState(t.dir), 'aster', [1], 1), 1, 'unplugged');
    assert.equal(launchDisplay(readState(t.dir), 'birch', [1, 2], 1), 1, 'per character');
  } finally {
    t.done();
  }
});

/** A HostLink stand-in: records what the placement sends. */
class FakeLink implements PlacementLink {
  capabilities = ['placement', 'keep_clear', 'ack'];
  currentCharacter: string | null = 'aster';
  hidden = false;
  readonly sent: C3Message[] = [];
  private listeners = new Set<(e: LinkEvent) => void>();
  on(listener: (e: LinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: LinkEvent): void { for (const l of this.listeners) l(e); }
  message(m: Record<string, unknown>): void { this.emit({ kind: 'message', message: { v: 1, ...m } as C3Message }); }
  hello(): void { this.emit({ kind: 'hello', hello: { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: [] } }); }
  send(m: C3Message): boolean { this.sent.push(m); return true; }
  sendMoveWindow(x: number, y: number): boolean { this.sent.push({ v: 1, type: 'move_window', x, y }); return true; }
  sendSetPlacement(p: { x?: number; y?: number; scale?: number }): boolean {
    if (!this.capabilities.includes('placement')) return false;
    this.sent.push({ v: 1, type: 'set_placement', ...p });
    return true;
  }
  take(): C3Message[] { return this.sent.splice(0); }
}

const identity: Omit<PlacementSpace, 'screens'> = { fromDip: () => ({ x: 0, y: 0, w: 0, h: 0 }), rectFromC3: (r) => r, rectToC3: (r) => r,
  pointFromC3: (p) => p, pointToC3: (p) => p };

function placer(screens: ScreenInfo[] = [main, side],
  extra: { mainWindow?: () => Rect | null; space?: PlacementSpace; keepClearSources?: () => KeepClearRect[] } = {}) {
  const t = tempDir(), link = new FakeLink(), clock = { now: 0 }, logs: string[] = [];
  const space = extra.space ?? { ...identity, screens: () => screens };
  const p = new AvatarPlacer({ link, supportDir: t.dir, space, stayInPlace: () => false, keyIdle: () => 60,
    mainWindow: extra.mainWindow ?? (() => null), log: (l) => logs.push(l), clock: () => clock.now,
    ...(extra.keepClearSources && { keepClearSources: extra.keepClearSources }) });
  p.start();
  const windowFrame = (f: Rect, viewport: string, display = 1) => link.message({ type: 'window_frame', frame: f, scale: 2, window_number: 7, viewport, display_id: display });
  return { p, link, dir: t.dir, clock, logs, windowFrame, done: () => { p.stop(); t.done(); } };
}

test('the first window_frame after a hello sends the window to its remembered or default place; later ones and fullscreen do not', () => {
  const s = placer();
  try {
    s.link.hello();
    s.windowFrame(frame(10, 10), 'window');
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 1056, y: 94 }]);
    s.windowFrame(frame(1056, 94), 'window');
    assert.deepEqual(s.link.take(), []);
    // A drag on the side screen is remembered there (the last window_frame comes before the end).
    s.link.message({ type: 'drag', phase: 'begin', x: 0, y: 0 });
    s.windowFrame(frame(1600, 300), 'window', 2);
    s.link.message({ type: 'drag', phase: 'end', x: 0, y: 0 });
    assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'window-positions.json'), 'utf8')), { aster: { 2: { x: 1600, y: 300 } } });
    s.link.hello();
    s.windowFrame(frame(2000, 500), 'window', 2);
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 1600, y: 300 }]);
    s.link.message({ type: 'character_changed', id: 'aster' });
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 1600, y: 300 }], 'a switch places the window again');
    s.link.hello();
    s.windowFrame({ x: 0, y: 0, w: 1440, h: 875 }, 'fullscreen');
    assert.deepEqual(s.link.take(), [], 'a fullscreen avatar ignores move_window');
  } finally {
    s.done();
  }
});

test('HostLinkTests: a fullscreen drag end records no window position; a window one records its last frame', () => {
  const s = placer();
  try {
    s.link.hello();
    s.windowFrame({ x: 0, y: 0, w: 1512, h: 949 }, 'fullscreen');
    s.link.message({ type: 'drag', phase: 'begin', x: 600, y: 600 });
    s.link.message({ type: 'drag', phase: 'end', x: 640, y: 610 });
    assert.deepEqual(new PlacementFiles(s.dir).positions, {});
    s.windowFrame({ x: 300, y: 250, w: 200, h: 300 }, 'window');
    s.link.message({ type: 'drag', phase: 'begin', x: 400, y: 400 });
    s.link.message({ type: 'drag', phase: 'end', x: 400, y: 400 });
    assert.deepEqual(new PlacementFiles(s.dir).positions, { aster: { 1: { x: 300, y: 250 } } });
  } finally {
    s.done();
  }
});

test('HostLink onDragging: anchorSample is dragging from a begin to its end, and not after the link drops mid-drag', () => {
  const s = placer();
  try {
    s.link.hello();
    assert.equal(s.p.anchorSample().dragging, false);
    s.link.message({ type: 'drag', phase: 'begin' });
    assert.equal(s.p.anchorSample().dragging, true);
    s.link.message({ type: 'drag', phase: 'end' });
    assert.equal(s.p.anchorSample().dragging, false);
    s.link.message({ type: 'drag', phase: 'begin' });
    s.link.emit({ kind: 'lost', reason: 'eof' });
    assert.equal(s.p.anchorSample().dragging, false);
  } finally {
    s.done();
  }
});

test('currentScreen: the screen under her window in a window, her placement\'s display in fullscreen, none before a frame', () => {
  const s = placer();
  try {
    s.link.hello();
    assert.equal(s.p.currentScreen(), null);
    s.windowFrame({ x: 1500, y: 100, w: 200, h: 300 }, 'window');
    assert.equal(s.p.currentScreen(), '2');
    s.windowFrame({ x: 0, y: 0, w: 1440, h: 900 }, 'fullscreen');
    assert.equal(s.p.currentScreen(), null, 'no placement yet');
    s.link.message({ type: 'placement', x: 1600, y: 0, scale: 1, display_id: 2, reason: 'drag' });
    assert.equal(s.p.currentScreen(), '2');
  } finally {
    s.done();
  }
});

test('placements are remembered by the applied viewport: fullscreen per display with the last display, window only the scale', () => {
  const s = placer();
  try {
    s.link.hello();
    s.link.message({ type: 'placement', x: 1, y: 2, scale: 1, display_id: 1, reason: 'start' });
    assert.deepEqual(readState(s.dir), {}, 'no viewport yet');
    s.windowFrame({ x: 1440, y: 0, w: 1920, h: 1080 }, 'fullscreen', 2);
    s.link.message({ type: 'placement', x: 3000.5, y: 0, scale: 1.25, display_id: 2, reason: 'drag' });
    s.link.message({ type: 'placement', x: 3000.5, y: 0, scale: 9, display_id: 2, reason: 'drag' });
    assert.deepEqual(new PlacementFiles(s.dir).placements, { aster: { 2: { x: 3000.5, y: 0, scale: 1.25 } } });
    assert.deepEqual(readState(s.dir), { last_display: { aster: 2 } });
    s.windowFrame(frame(100, 100), 'window');
    s.link.message({ type: 'placement', x: 280, y: 100, scale: 0.75, display_id: 1, reason: 'set_placement' });
    assert.deepEqual(readState(s.dir), { last_display: { aster: 2 }, window_scale: { aster: 0.75 } });
    assert.equal(new PlacementFiles(s.dir).placements.aster?.[1], undefined);
  } finally {
    s.done();
  }
});

test('AvatarScaleRequests: the first value is the baseline, each change sends one set_placement {scale}, a reported scale is the new baseline', () => {
  const s = placer();
  try {
    s.link.hello();
    s.p.setScale(1);
    assert.deepEqual(s.link.take(), [], 'the value at load is the baseline');
    s.p.setScale(1);
    assert.deepEqual(s.link.take(), []);
    s.p.setScale(1.25);
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'set_placement', scale: 1.25 }]);
    s.p.setScale(1.25);
    assert.deepEqual(s.link.take(), [], 'one each');
    s.link.message({ type: 'placement', x: 1, y: 2, scale: 0.8, display_id: 1, reason: 'set_placement' });
    s.p.setScale(0.8);
    assert.deepEqual(s.link.take(), [], 'the reported scale is the new baseline');
  } finally {
    s.done();
  }
});

test('放回默认位置: set_placement to the default anchor in fullscreen; move_window to the default origin, remembered, in a window', () => {
  const s = placer();
  try {
    s.link.hello();
    s.windowFrame({ x: 1440, y: 0, w: 1920, h: 1080 }, 'fullscreen', 2);
    s.link.message({ type: 'placement', x: 2000, y: 500, scale: 1, display_id: 2, reason: 'drag' });
    s.p.resetPosition();
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'set_placement', x: 3160, y: 0 }], "the anchor's screen");

    s.windowFrame(frame(500, 500), 'window');
    s.p.resetPosition();
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 1056, y: 94 }]);
    assert.deepEqual(new PlacementFiles(s.dir).positions, { aster: { 1: { x: 1056, y: 94 } } });
  } finally {
    s.done();
  }
});

test('调整大小 starts on her window frame or her fullscreen anchor at the reported scale, on the screen under her foot', () => {
  const s = placer();
  try {
    s.link.hello();
    assert.equal(s.p.resizeStart(), null, 'no frame yet');
    s.windowFrame({ x: 300, y: 200, w: 540, h: 780 }, 'window');
    assert.deepEqual(s.p.resizeStart(), { frame: { x: 300, y: 200, w: 540, h: 780 }, scale: 1, maximumScale: 805 / 780,
      visible: main.visibleFrame });
    s.windowFrame({ x: 1440, y: 0, w: 1920, h: 1080 }, 'fullscreen', 2);
    s.link.message({ type: 'placement', x: 2000, y: 100, scale: 1.25, display_id: 2, reason: 'drag' });
    assert.deepEqual(s.p.resizeStart(), { frame: { x: 1662.5, y: 100, w: 675, h: 975 }, scale: 1.25, maximumScale: 2,
      visible: side.visibleFrame });
  } finally {
    s.done();
  }
});

test('HostLinkTests.testResizeCommitKeepsThePreviewFrame and testResizePreviewUpdatesActualPlacement: the window moves its bottom centre onto the preview\'s and takes the scale, remembered on 完成; fullscreen sends the anchor', () => {
  const preview = { x: 100, y: 50, w: 675, h: 975 };
  const s = placer();
  try {
    s.link.hello();
    s.windowFrame({ x: 300, y: 200, w: 540, h: 780 }, 'window');
    s.link.take();
    s.p.resizePreview(1.25, preview);
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 167.5, y: 50 }, { v: 1, type: 'set_placement', scale: 1.25 }]);
    assert.deepEqual(new PlacementFiles(s.dir).positions, {}, 'a preview is not remembered');
    s.p.resizeCommit(1.25, preview);
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 167.5, y: 50 }, { v: 1, type: 'set_placement', scale: 1.25 }]);
    assert.deepEqual(new PlacementFiles(s.dir).positions, { aster: { 1: { x: 100, y: 50 } } });

    s.windowFrame({ x: 0, y: 0, w: 1920, h: 1080 }, 'fullscreen');
    s.p.resizePreview(0.5, { x: 400, y: 100, w: 270, h: 390 });
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'set_placement', x: 535, y: 100, scale: 0.5 }]);
    s.p.resizeCommit(1.25, preview);
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'set_placement', x: 437.5, y: 50, scale: 1.25 }]);
    assert.deepEqual(new PlacementFiles(s.dir).positions, { aster: { 1: { x: 100, y: 50 } } }, 'fullscreen remembers no window');
  } finally {
    s.done();
  }
});

test('a display change sends the window back to its place, the default once its display is gone', () => {
  const screens = [main, side];
  const s = placer(screens);
  try {
    s.link.hello();
    s.windowFrame(frame(1600, 300), 'window', 2);
    s.link.take();
    s.link.message({ type: 'drag', phase: 'begin' });
    s.windowFrame(frame(3200, 900), 'window', 2);
    s.link.message({ type: 'drag', phase: 'end' });
    s.p.screensChanged();
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 3000, y: 535 }], 'clamped into the visible frame');
    screens.pop();
    s.p.screensChanged();
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 1056, y: 94 }]);
  } finally {
    s.done();
  }
});

test("testViewportAndPlacementPassedToUnity: fullscreen passes the launch display's placement between the viewport and the scale", () => {
  const s = placer([main, side]);
  const dir = mkdtempSync(join(tmpdir(), 'a-'));
  try {
    const files = new PlacementFiles(s.dir);
    files.recordPlacement('aster', 1, { x: 1200.5, y: 70, scale: 1.25 });
    files.recordPlacement('birch', 1, { x: 10, y: 10, scale: 0.5 });
    files.recordPlacement('aster', 999999, { x: 5, y: 5, scale: 2 });
    saveLastDisplay(s.dir, 'aster', 999999);
    saveWindowScale(s.dir, 'aster', 1.5);
    assert.equal(s.p.launchPlacement('aster'), '1200.5,70.0,1.250', 'the last display is not connected');
    assert.equal(s.p.launchPlacement('cedar'), null);
    saveLastDisplay(s.dir, 'birch', 2);
    assert.equal(s.p.launchPlacement('birch'), null, 'the last display is connected but has no placement there');
    files.recordPlacement('birch', 2, { x: 2000, y: 0, scale: 0.75 });
    assert.equal(s.p.launchPlacement('birch'), '2000.0,0.0,0.750');

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'A.app') }], agentd_dir: dir, python: '/py', agentd_port: 1,
      support_dir: s.dir, agentd_state_dir: join(dir, 'state') }));
    const config = loadConfig(join(dir, 'config.json'));
    for (const viewport of ['fullscreen', 'window']) {
      const args = rendererArguments({ config, character: 'aster', parentPid: 1, startupPath: '/s', socketPath: '/r', captureDir: '/p',
        settings: { viewport }, state: readState(s.dir), placement: s.p.launchPlacement('aster') });
      const at = args.indexOf('--agentic-complex-viewport');
      if (viewport === 'fullscreen') {
        assert.deepEqual(args.slice(at, at + 6), ['--agentic-complex-viewport', 'fullscreen', '--agentic-complex-placement', '1200.5,70.0,1.250',
          '--agentic-complex-scale', '1.500']);
      } else {
        assert.ok(!args.includes('--agentic-complex-placement'), 'the window viewport passes no placement');
        assert.deepEqual(args.slice(at, at + 4), ['--agentic-complex-viewport', 'window', '--agentic-complex-scale', '1.500']);
      }
    }
  } finally {
    s.done();
    rmSync(dir, { recursive: true, force: true });
  }
});

const body: Rect = { x: 100, y: 100, w: 40, h: 140 };
const field: KeepClearRect = { kind: 'text_input', frame: { x: 90, y: 150, w: 200, h: 24 } };
const away: KeepClearRect = { kind: 'text_input', frame: { x: 600, y: 600, w: 200, h: 24 } };
const kc = (kind: KeepClearKind, x: number, y: number, w = 20, h = 20): KeepClearRect => ({ kind, frame: { x, y, w, h } });
const sentId = (o: ReturnType<KeepClearState['update']>) => (o !== null && o !== 'drop' ? o.send.id : null);

test('KeepClearTests: settle, typing pause, each id once, cooldown, dialog skips it, drop, block, margin, priority', () => {
  let s = new KeepClearState();
  assert.equal(s.update([field], body, Infinity, false, 0), null);
  assert.equal(s.update([field], body, Infinity, false, 1.1), null);
  const first = s.update([field], body, Infinity, false, 1.2);
  assert.deepEqual(first, { send: { id: 'kc-f1f8795945d43932', kind: 'text_input', rects: [field.frame] } }, "Swift's id for this hit");
  assert.equal(s.update([field], body, Infinity, false, 20), null);
  assert.equal(s.update([away], body, Infinity, false, 21), 'drop');
  assert.equal(s.update([field], body, Infinity, false, 40), null, 'the same id again');

  s = new KeepClearState();
  assert.equal(s.update([field], body, 0.1, false, 0), null);
  assert.equal(s.update([field], body, 1.4, false, 1.4), null);
  assert.notEqual(sentId(s.update([field], body, 1.5, false, 1.5)), null, 'the first tick after the pause');

  s = new KeepClearState();
  s.update([field], body, Infinity, false, 0);
  s.update([field], body, Infinity, false, 1.2);
  const moved = kc('text_input', 90, 200, 200, 24);
  assert.equal(s.update([moved], body, Infinity, false, 9.1), null, 'within 8 s of the last send');
  assert.notEqual(sentId(s.update([moved], body, Infinity, false, 9.2)), null);
  const dialog = s.update([moved, kc('dialog', 110, 110)], body, Infinity, false, 10.5);
  assert.equal(dialog !== null && dialog !== 'drop' && dialog.send.kind, 'dialog', 'a dialog skips the cooldown');

  s = new KeepClearState();
  s.update([field], body, Infinity, false, 0);
  s.update([field], body, Infinity, false, 1.2);
  assert.equal(s.update([field], body, Infinity, true, 1.3), 'drop');
  assert.equal(s.update([field], body, Infinity, true, 1.4), null);
  assert.equal(s.update([field], null, Infinity, false, 1.5), null, 'nothing to drop again; no body is no hit');

  const near = new KeepClearState(), far = new KeepClearState();
  near.update([kc('control', 147, 150)], body, Infinity, false, 0);
  assert.notEqual(sentId(near.update([kc('control', 147, 150)], body, Infinity, false, 1.2)), null, '7 pt off is within the margin');
  far.update([kc('control', 149, 150)], body, Infinity, false, 0);
  assert.equal(far.update([kc('control', 149, 150)], body, Infinity, false, 1.2), null);

  const order: KeepClearKind[] = ['dialog', 'banner', 'caret', 'text_input', 'ime', 'control', 'near_clicks', 'video', 'game'];
  order.forEach((kind, i) => {
    const one = new KeepClearState(), rects = order.slice(i).reverse().map((k) => kc(k, 110, 110));
    one.update(rects, body, Infinity, false, 0);
    const out = one.update(rects, body, Infinity, false, 1.2);
    assert.equal(out !== null && out !== 'drop' && out.send.kind, kind);
  });
  const video = new KeepClearState(), screen = kc('video', 0, 0, 1920, 1080), over = kc('dialog', 90, 120, 300, 200);
  video.update([screen, over], body, Infinity, false, 0);
  assert.deepEqual(video.update([screen, over], body, Infinity, false, 1.2), { send: { id: keepClearId([screen, over]), kind: 'dialog', rects: [over.frame] } });
  assert.equal(KEEP_CLEAR.maxRects, 8);
  assert.equal(keepClearId([kc('dialog', 100, 200, 1385, 770), kc('caret', -48, -16, 2, 18)]), 'kc-eca86e5813b793c3', 'halves round away from 0');
});

test('WindowKeepClearTests and capsule bounds: a hidden, minimised or covered window is no rect; capsules give her box', () => {
  const f = { x: 100, y: 200, w: 1385, h: 770 };
  assert.equal(shownFrame(f, false, false, false), null);
  assert.equal(shownFrame(f, true, true, false), null);
  assert.equal(shownFrame(f, true, false, true), null);
  assert.deepEqual(shownFrame(f, true, false, false), f);
  assert.deepEqual(capsuleBounds([{ a: [10, 20], b: [10, 120], r: 5 }, { a: [30, 50], b: [0, 60], r: 2 }, { a: [1] }]), { x: -2, y: 15, w: 34, h: 110 });
  assert.equal(capsuleBounds([]), null);
});

test('keep_clear: the screen targets and the main window are one source, read every 0.25 s while she is not blocked', () => {
  let reads = 0;
  const caret: KeepClearRect = { kind: 'caret', frame: { x: 110, y: 150, w: 20, h: 20 } };
  const shown: Rect = { x: 50, y: 50, w: 600, h: 400 };
  const s = placer([main, side], { mainWindow: () => shown, keepClearSources: () => { reads += 1; return [caret]; } });
  try {
    s.link.hello();
    s.windowFrame(frame(100, 100), 'window');
    s.link.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [120, 110], b: [120, 230], r: 10 }] });
    s.p.tick();
    assert.equal(reads, 0, 'not read outside the fullscreen viewport');
    s.windowFrame({ x: 0, y: 0, w: 1440, h: 875 }, 'fullscreen');
    s.p.keepClearOfMain(true);
    s.p.tick();
    s.clock.now = 0.2;
    s.p.tick();
    assert.equal(reads, 1);
    s.clock.now = 0.25;
    s.p.tick();
    assert.equal(reads, 2);
    s.link.take();
    s.clock.now = 1.2;
    s.p.tick();
    const [sent] = s.link.take();
    assert.deepEqual({ ...sent, id: '' }, { v: 1, type: 'keep_clear', id: '', kind: 'dialog', rects: [shown, caret.frame] });
  } finally {
    s.done();
  }
});

test('avatar.keepClearOfMain: in fullscreen the main window over her body goes out as a dialog after 1.2 s, and its end drops it', () => {
  let shown: Rect | null = { x: 50, y: 50, w: 600, h: 400 };
  const s = placer([main, side], { mainWindow: () => shown });
  try {
    s.link.hello();
    s.windowFrame({ x: 0, y: 0, w: 1440, h: 875 }, 'fullscreen');
    s.link.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [120, 110], b: [120, 230], r: 10 }] });
    s.p.tick();
    s.clock.now = 2;
    s.p.tick();
    assert.deepEqual(s.link.take(), [], 'off');
    s.p.keepClearOfMain(true);
    // The sources are read every 0.25 s: the main window counts from the next read.
    s.p.tick();
    s.clock.now = 2.25;
    s.p.tick();
    s.clock.now = 3.4;
    s.p.tick();
    assert.deepEqual(s.link.take(), []);
    s.clock.now = 3.45;
    s.p.tick();
    const [sent] = s.link.take();
    assert.deepEqual({ ...sent, id: '' }, { v: 1, type: 'keep_clear', id: '', kind: 'dialog', rects: [{ x: 50, y: 50, w: 600, h: 400 }] });
    assert.match(String(sent!.id), /^kc-[0-9a-f]{16}$/);
    shown = null;
    s.clock.now = 4;
    s.p.tick();
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'keep_clear', id: null }], 'the window went: the request is dropped');
    s.p.keepClearOfMain(false);
    s.p.tick();
    assert.deepEqual(s.link.take(), []);

    shown = { x: 50, y: 50, w: 600, h: 400 };
    s.windowFrame(frame(100, 100), 'window');
    s.p.keepClearOfMain(true);
    for (const t of [10, 12, 14]) {
      s.clock.now = t;
      s.p.tick();
    }
    assert.deepEqual(s.link.take(), [], 'give-way only acts in the fullscreen viewport');
    s.link.capabilities = ['placement'];
    s.windowFrame({ x: 0, y: 0, w: 1440, h: 875 }, 'fullscreen');
    for (const t of [20, 22, 24]) {
      s.clock.now = t;
      s.p.tick();
    }
    assert.deepEqual(s.link.take(), [], 'not without the renderer listing keep_clear');
  } finally {
    s.done();
  }
});

const display = (id: number, bounds: Rectangle, workArea: Rectangle) => ({ id, bounds, workArea }) as unknown as Display;

test('macOS: Electron DIPs (y down from the primary top-left) are AppKit points (y up from its bottom-left), the primary first', () => {
  const primary = display(1, { x: 0, y: 0, width: 1440, height: 900 }, { x: 0, y: 25, width: 1440, height: 805 });
  const right = display(2, { x: 1440, y: -180, width: 1920, height: 1080 }, { x: 1440, y: -155, width: 1920, height: 1055 });
  const space = placementSpace({ getAllDisplays: () => [right, primary], getPrimaryDisplay: () => primary }, 'mac');
  assert.deepEqual(space.screens(), [main, side]);
  assert.deepEqual(space.fromDip({ x: 100, y: 100, width: 1385, height: 770 }), { x: 100, y: 30, w: 1385, h: 770 });
  const r = { x: 3, y: 4, w: 5, h: 6 };
  assert.deepEqual([space.rectFromC3(r), space.rectToC3(r), space.pointFromC3({ x: 1, y: 2 }), space.pointToC3({ x: 1, y: 2 })],
    [r, r, { x: 1, y: 2 }, { x: 1, y: 2 }], 'C3 on macOS is the placement space');
});

test('Windows: DIPs go to physical pixels by dipToScreenRect, then y up; C3 (physical, y down) maps to the same space', () => {
  const scale = (r: Rectangle): Rectangle => ({ x: r.x * 1.5, y: r.y * 1.5, width: r.width * 1.5, height: r.height * 1.5 });
  const primary = display(7, { x: 0, y: 0, width: 1280, height: 720 }, { x: 0, y: 0, width: 1280, height: 690 });
  const space = placementSpace({ getAllDisplays: () => [primary], getPrimaryDisplay: () => primary, dipToScreenRect: (_w, r) => scale(r) }, 'windows');
  const [screen] = space.screens();
  assert.deepEqual(screen, { id: 7, frame: { x: 0, y: -1080, w: 1920, h: 1080 }, visibleFrame: { x: 0, y: -1035, w: 1920, h: 1035 } });
  // The default window sits MARGIN above the taskbar: its top-left in C3 is 231, its bottom 1011 = 1035 - 24.
  const origin = defaultOrigin({ w: 540, h: 780 }, [screen!])!;
  assert.deepEqual(space.rectToC3({ ...origin, w: 540, h: 780 }), { x: 1356, y: 231, w: 540, h: 780 });
  assert.deepEqual(space.pointToC3(defaultAnchor(screen!.visibleFrame)), { x: 1720, y: 1035 }, 'the anchor stands on the taskbar');
  assert.deepEqual(space.rectFromC3({ x: 1356, y: 231, w: 540, h: 780 }), { x: 1356, y: -1011, w: 540, h: 780 });
  assert.deepEqual(space.pointFromC3({ x: 1720, y: 1035 }), { x: 1720, y: -1035 });
  assert.deepEqual(space.fromDip({ x: 100, y: 100, width: 200, height: 100 }), { x: 150, y: -300, w: 300, h: 150 });

  // The same placement as on a Mac, over C3's pixels: the default window's top-left, and the anchor on the taskbar.
  const s = placer([], { space });
  try {
    s.link.hello();
    s.windowFrame({ x: 10, y: 10, w: 540, h: 780 }, 'window', 7);
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'move_window', x: 1356, y: 231 }]);
    s.windowFrame({ x: 0, y: 0, w: 1920, h: 1035 }, 'fullscreen', 7);
    s.p.resetPosition();
    assert.deepEqual(s.link.take(), [{ v: 1, type: 'set_placement', x: 1720, y: 1035 }]);
  } finally {
    s.done();
  }
});

test('avatar.setScale and avatar.keepClearOfMain check their arguments and reach the placement', async () => {
  const calls: string[] = [];
  const placement = { setScale: (v: number) => calls.push(`scale ${v}`),
    keepClearOfMain: (on: boolean) => calls.push(`keepClear ${on}`) };
  const call = (ctx: Partial<OpsContext>, op: string, ...args: unknown[]) => handle('main', { mainFrame: true, origin: ORIGIN }, { op, args },
    new Map(Object.entries(avatarOps({ surface: 'main', routes, ...ctx } as OpsContext))), new PageSession(() => {}));
  for (const bad of [0.4, 2.1, Number.NaN, '1', null]) {
    assert.deepEqual(await call({ placement }, 'avatar.setScale', bad), { ok: false, error: { code: 'invalid_args', detail: 'scale 0.5...2.0' } }, String(bad));
  }
  assert.deepEqual(await call({ placement }, 'avatar.keepClearOfMain', 'yes'), { ok: false, error: { code: 'invalid_args', detail: 'on' } });
  for (const [op, arg] of [['avatar.setScale', 0.5], ['avatar.setScale', 2], ['avatar.keepClearOfMain', true]] as const) {
    assert.deepEqual(await call({ placement }, op, arg), { ok: true, value: null }, op);
  }
  assert.deepEqual(calls, ['scale 0.5', 'scale 2', 'keepClear true']);
  assert.deepEqual(await call({ placement: null }, 'avatar.setScale', 1), { ok: false, error: { code: 'failed', detail: '角色还没连上（配置出错）' } });
});
