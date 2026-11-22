// The character page's live preview: the session over the preview XPC service, the show logic, the motion library it
// reads and the `avatar.preview.*` ops.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { BridgeFailure, handle } from '../src/common/bridge.ts';
import { ORIGIN } from '../src/common/ui.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { type PreviewHost, previewOps } from '../src/main/ops/preview.ts';
import { PreviewController, type PreviewView } from '../src/main/preview/controller.ts';
import { loadMotionLibrary, type MotionLibrary } from '../src/main/preview/library.ts';
import { PreviewFailure, previewOutput, PreviewSession, type PreviewSelection } from '../src/main/preview/session.ts';
import { lookArguments, renderArguments } from '../src/main/renderer/supervisor.ts';

type Message = Record<string, unknown>;

/** The addon's client end as a test drives it: each start is one connection, the last one current. */
class FakeTransport {
  connections: ((json: string, surface: string | null, sequence: number) => void)[] = [];
  sent: Message[] = [];
  stops = 0;
  start(_service: string, onMessage: (json: string, surface: string | null, sequence: number) => void): void {
    this.connections.push(onMessage);
  }
  send(json: string): boolean {
    this.sent.push(JSON.parse(json) as Message);
    return true;
  }
  stop(): void {
    this.stops += 1;
  }
  emit(message: Message, surface: string | null = null, sequence = 0, connection = this.connections.length - 1): void {
    this.connections[connection]!(JSON.stringify(message), surface, sequence);
  }
  ops(): unknown[] {
    return this.sent.map((m) => m.op);
  }
}

/** Draws nothing until the test says the GPU is done. */
class FakePresenter {
  active = true;
  drawing: { surface: string; done: (drawn: boolean) => void }[] = [];
  present(surface: string, done: (drawn: boolean) => void): void {
    this.drawing.push({ surface, done });
  }
  finish(drawn = true): void {
    this.drawing.shift()!.done(drawn);
  }
}

const selection = (o: Partial<PreviewSelection> = {}): PreviewSelection => ({ bundle: '/lib/si/runtime/bundle.json', sha256: 'a'.repeat(64),
  character: 'si', clip: null, facial: null, rate: 1, appearance: null, request: 0, modSettings: null, loop: false, ...o });

function session(firstFrameTimeout = 5000) {
  const transport = new FakeTransport(), presenter = new FakePresenter(), logs: string[] = [];
  const s = new PreviewSession<string>({ transport, service: 'test.preview', presenter,
    log: (l) => logs.push(l), firstFrameTimeout });
  return { s, transport, presenter, logs };
}

/** Lets the promise callbacks run. */
const settle = () => new Promise((r) => setImmediate(r));

test('a load connects, sends the selection and resolves once its first frame is drawn; the frame is acked after the GPU', async () => {
  const { s, transport, presenter } = session();
  let live = false;
  const loaded = s.load(selection({ clip: 'wave', appearance: 'summer', loop: true })).then(() => { live = true; });
  assert.equal(transport.connections.length, 1);
  assert.deepEqual(transport.sent, [{ op: 'load', bundle: '/lib/si/runtime/bundle.json', sha256: 'a'.repeat(64), character: 'si', rate: 1,
    load_id: 1, clip: 'wave', appearance: 'summer', loop: true }]);
  transport.emit({ event: 'loaded', load_id: 1, character: 'si', clip: 'wave' });
  transport.emit({ event: 'frame', load_id: 0 }, 'old', 7);
  assert.deepEqual(transport.sent.at(-1), { op: 'ack', sequence: 7 }, 'a frame of an older load is acked, not drawn');
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-a', 8);
  assert.equal(presenter.drawing.length, 1);
  await settle();
  assert.equal(live, false, 'not live before the GPU is done');
  presenter.finish();
  await loaded;
  assert.deepEqual(transport.sent.at(-1), { op: 'ack', sequence: 8 });
  // The same selection again does not load again.
  await s.load(selection({ clip: 'wave', appearance: 'summer', loop: true }));
  assert.equal(transport.ops().filter((o) => o === 'load').length, 1);
  // A new revision of the same action plays it again on the same connection.
  s.load(selection({ clip: 'wave', appearance: 'summer', loop: true, request: 2 })).catch(() => {});
  assert.deepEqual(transport.sent.at(-1), { op: 'load', bundle: '/lib/si/runtime/bundle.json', sha256: 'a'.repeat(64), character: 'si',
    rate: 1, load_id: 2, clip: 'wave', appearance: 'summer', loop: true });
  assert.equal(transport.connections.length, 1);
  s.disconnect();
});

test('off screen it pauses the service and acks frames undrawn; back on screen it resumes', async () => {
  const { s, transport, presenter } = session();
  presenter.active = false;
  const loaded = s.load(selection());
  assert.deepEqual(transport.ops(), ['load', 'pause']);
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-a', 3);
  assert.equal(presenter.drawing.length, 0);
  assert.deepEqual(transport.sent.at(-1), { op: 'ack', sequence: 3 });
  s.syncPlayback();
  assert.deepEqual(transport.ops(), ['load', 'pause', 'ack'], 'no change, nothing sent');
  presenter.active = true;
  s.syncPlayback();
  assert.deepEqual(transport.sent.at(-1), { op: 'resume' });
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-a', 4);
  presenter.finish();
  await loaded;
  presenter.active = false;
  s.syncPlayback();
  assert.deepEqual(transport.sent.at(-1), { op: 'pause' });
  s.disconnect();
});

test('an error of the current load fails it and pauses; an error of another load is ignored', async () => {
  const { s, transport, logs } = session();
  const loaded = s.load(selection());
  transport.emit({ event: 'error', load_id: 9, reason: 'old' });
  transport.emit({ event: 'error', load_id: 1, reason: 'Invalid independent preview request' });
  await assert.rejects(loaded, new PreviewFailure('Invalid independent preview request'));
  assert.deepEqual(transport.sent.at(-1), { op: 'pause' });
  assert.match(logs.join('\n'), /load_id=1 failed: Invalid independent preview request/);
  // A failed selection loads again when asked again.
  s.load(selection()).catch(() => {});
  assert.deepEqual(transport.sent.at(-1)?.load_id, 2);
  s.disconnect();
});

test('when the service goes away the load fails, and the next load connects again and takes over', async () => {
  const { s, transport, presenter } = session();
  const loaded = s.load(selection());
  transport.emit({ event: 'disconnected' });
  await assert.rejects(loaded, new PreviewFailure('预览服务断开了'));
  const again = s.load(selection());
  assert.equal(transport.connections.length, 2, 'a new connection');
  // The first connection's late messages are dropped.
  transport.emit({ event: 'frame', load_id: 2 }, 'stale', 1, 0);
  assert.equal(presenter.drawing.length, 0);
  transport.emit({ event: 'frame', load_id: 2 }, 'surface-b', 2);
  presenter.finish();
  await again;
  s.disconnect();
});

test('closing the window ends the connection: the pending load fails, its messages and GPU completions are dropped, and a new window connects anew', async () => {
  const { s, transport, presenter } = session();
  const loaded = s.load(selection());
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-a', 5);
  s.disconnect();
  assert.equal(transport.stops, 1);
  await assert.rejects(loaded, new PreviewFailure('预览已关闭'));
  const before = transport.sent.length;
  presenter.finish();
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-a', 6, 0);
  assert.equal(transport.sent.length, before, 'no ack on a closed connection');
  assert.equal(presenter.drawing.length, 0);
  // Within the service's 0.25 s the new connection takes over the same process; either way it starts fresh.
  const next = s.load(selection());
  assert.equal(transport.connections.length, 2);
  transport.emit({ event: 'frame', load_id: 2 }, 'surface-a', 1);
  presenter.finish();
  await next;
  s.disconnect();
});

test('sequence needs a drawn load, sends a new load_id and resolves on its first frame', async () => {
  const { s, transport, presenter } = session();
  await assert.rejects(s.sequence(['a'], []), new PreviewFailure('预览还没有载入'));
  const loaded = s.load(selection());
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-a', 1);
  presenter.finish();
  await loaded;
  const played = s.sequence(['think_start', 'idle_loop'], [0.25]);
  await settle();
  assert.deepEqual(transport.sent.at(-1), { op: 'sequence', clips: ['think_start', 'idle_loop'], blend_s: [0.25], load_id: 2 });
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-b', 2);
  assert.equal(presenter.drawing.length, 0, 'the load\'s frame is not the sequence\'s');
  transport.emit({ event: 'frame', load_id: 2 }, 'surface-b', 3);
  presenter.finish();
  await played;
  s.disconnect();
});

test('a load whose first frame never comes fails after the timeout', async () => {
  const { s } = session(20);
  await assert.rejects(s.load(selection()), new PreviewFailure('预览等待首帧超时'));
  s.disconnect();
});

test('off screen the first-frame wait does not run out: the service is paused, so no frame can come', async () => {
  const { s, transport, presenter } = session(20);
  presenter.active = false;
  let outcome = 'pending';
  const loaded = s.load(selection()).then(() => { outcome = 'drawn'; }, (e: Error) => { outcome = e.message; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(outcome, 'pending');
  presenter.active = true;
  s.syncPlayback();
  transport.emit({ event: 'frame', load_id: 1 }, 'surface-a', 1);
  presenter.finish();
  await loaded;
  assert.equal(outcome, 'drawn');
  s.disconnect();
});

test('a load the transport cannot send fails at once with why', async () => {
  const { s, transport } = session(2000);
  transport.send = (json: string) => { transport.sent.push(JSON.parse(json) as Message); return false; };
  const started = performance.now();
  await assert.rejects(s.load(selection()), new PreviewFailure('预览请求发不出去（太大或连接已断）'));
  assert.ok(performance.now() - started < 1000);
  s.disconnect();
});

/** Draws the current load's first frame. */
async function draw(s: PreviewSession<string>, transport: FakeTransport, presenter: FakePresenter, loaded: Promise<void>) {
  transport.emit({ event: 'frame', load_id: transport.sent.filter((m) => m.load_id !== undefined).at(-1)!.load_id }, 'surface', 1);
  presenter.finish();
  await loaded;
}

test('a load answers for its own frame only: the load it replaced is rejected, not resolved by the newer frame', async () => {
  const { s, transport, presenter } = session();
  const a = s.load(selection({ request: 1 })).then(() => 'drawn', (e: Error) => e.message);
  const b = s.load(selection({ request: 2 }));
  // The same selection again waits for its frame with it.
  const again = s.load(selection({ request: 2 }));
  await draw(s, transport, presenter, b);
  await again;
  assert.equal(await a, '预览换成了新的请求');
  // A sequence a load replaces does not resolve on the load's frame.
  const chain = s.sequence(['think_start'], []).then(() => 'drawn', (e: Error) => e.message);
  const c = s.load(selection({ request: 3 }));
  await draw(s, transport, presenter, c);
  assert.equal(await chain, '预览换成了新的请求');
  s.disconnect();
});

test('a rebuild for new render arguments or output does not replay a drawn one-shot; a loop keeps looping; after a sequence it is her idle', async () => {
  const load = (m: Message) => ({ op: 'load', bundle: '/lib/si/runtime/bundle.json', sha256: 'a'.repeat(64), character: 'si', rate: 1, ...m });
  {
    const { s, transport, presenter } = session();
    // Rebuilt before its first frame, the clip still plays.
    s.load(selection({ clip: 'wave', request: 1 })).catch(() => {});
    const first = s.load(selection({ clip: 'wave', request: 1, output: [720, 864] }));
    assert.deepEqual(transport.sent.at(-1), load({ load_id: 2, clip: 'wave', output: [720, 864] }));
    await draw(s, transport, presenter, first);
    s.load(selection({ clip: 'wave', request: 1, output: [960, 1152] })).catch(() => {});
    assert.deepEqual(transport.sent.at(-1), load({ load_id: 3, output: [960, 1152] }));
    s.load(selection({ clip: 'wave', request: 1, output: [960, 1152], renderArgs: ['--agentic-complex-filter', 'mono'] })).catch(() => {});
    assert.deepEqual(transport.sent.at(-1), load({ load_id: 4, output: [960, 1152], render_args: ['--agentic-complex-filter', 'mono'] }));
    // Asked again (a new revision), it plays again.
    s.load(selection({ clip: 'wave', request: 2, output: [960, 1152] })).catch(() => {});
    assert.deepEqual(transport.sent.at(-1), load({ load_id: 5, clip: 'wave', output: [960, 1152] }));
    s.disconnect();
  }
  {
    const { s, transport, presenter } = session();
    await draw(s, transport, presenter, s.load(selection({ clip: 'wave', loop: true, request: 1 })));
    const rebuilt = s.load(selection({ clip: 'wave', loop: true, request: 1, output: [720, 864] }));
    assert.deepEqual(transport.sent.at(-1), load({ load_id: 2, clip: 'wave', loop: true, output: [720, 864] }));
    await draw(s, transport, presenter, rebuilt);
    await draw(s, transport, presenter, s.sequence(['think_start', 'idle_loop'], [0.25]));
    s.load(selection({ clip: 'wave', loop: true, request: 1, output: [960, 1152] })).catch(() => {});
    assert.deepEqual(transport.sent.at(-1), load({ load_id: 4, output: [960, 1152] }));
    s.disconnect();
  }
});

/** A view that records what the controller asks of it. */
class FakeView implements PreviewView {
  placed: unknown[] = [];
  loads: PreviewSelection[] = [];
  hides = 0;
  place(rect: unknown): void { this.placed.push(rect); }
  async load(s: PreviewSelection): Promise<boolean> { this.loads.push(s); return true; }
  async sequence(): Promise<void> {}
  hide(): void { this.hides += 1; }
}

const library: MotionLibrary = { bundle: '/b.json', sha256: 'f'.repeat(64), character: 'si',
  clips: [{ clip: 'A_idle', actionID: null }, { clip: 'A_wave', actionID: 'wave' }, { clip: 'A_wave2', actionID: 'wave' }] };

test('show plays the first clip of the action as the current character, idle without one, and reloads a library that lacks it', async () => {
  const view = new FakeView();
  let character: string | null = null, reads = 0;
  const c = new PreviewController({ view, avatar: () => ({ character, appearance: 'summer' }),
    library: async () => { reads += 1; return library; } });
  const rect = { x: 10, y: 20.5, w: 300, h: 400 };
  await assert.rejects(c.show(rect, null, false, 0), new BridgeFailure('failed', '角色还没连上'));
  character = 'si';
  assert.equal(await c.show(rect, 'wave', true, 4), true);
  assert.equal(await c.show(rect, null, true, 5), true);
  assert.deepEqual(view.loads.map((s) => [s.clip, s.loop, s.request, s.appearance, s.bundle, s.sha256]),
    [['A_wave', true, 4, 'summer', '/b.json', 'f'.repeat(64)], [null, false, 5, 'summer', '/b.json', 'f'.repeat(64)]]);
  assert.equal(reads, 1, 'read once per character');
  await assert.rejects(c.show(rect, 'jump', false, 6), new BridgeFailure('failed', '这个动作不能单独预览'));
  assert.equal(reads, 2, 'a missing action reads the library again');
  assert.equal(view.placed.length, 4);
});

test('a hide or a character switch while the library loads makes the show answer false', async () => {
  const view = new FakeView();
  let release: () => void = () => {};
  let character = 'si';
  const c = new PreviewController({ view, avatar: () => ({ character, appearance: null }),
    library: () => new Promise((r) => { release = () => r(library); }) });
  const shown = c.show({ x: 0, y: 0, w: 10, h: 10 }, null, false, 0);
  c.hide();
  release();
  assert.equal(await shown, false);
  const switched = c.show({ x: 0, y: 0, w: 10, h: 10 }, null, false, 0);
  character = 'aster';
  release();
  assert.equal(await switched, false);
  assert.equal(view.loads.length, 0);
  assert.equal(view.hides, 1);
});

test('a package change (an outfit import restarts her) drops the read library: the next show plays the new bundle', async () => {
  const view = new FakeView();
  let current = library, appearance = 'summer', reads = 0;
  const c = new PreviewController({ view, avatar: () => ({ character: 'si', appearance }), library: async () => { reads += 1; return current; } });
  const rect = { x: 0, y: 0, w: 300, h: 400 };
  await c.show(rect, null, false, 0);
  current = { ...library, bundle: '/b2.json', sha256: 'e'.repeat(64) };
  c.packagesChanged();
  appearance = 'imported';
  await c.show(rect, null, false, 0);
  assert.deepEqual(view.loads.map((s) => [s.bundle, s.sha256, s.appearance]), [['/b.json', 'f'.repeat(64), 'summer'], ['/b2.json', 'e'.repeat(64), 'imported']]);
  assert.equal(reads, 2);
});

test('a burst of new sizes, as the stage\'s 300 ms transition makes, moves the canvas each time and loads once the size settles', async () => {
  const view = new FakeView();
  const c = new PreviewController({ view, avatar: () => ({ character: 'si', appearance: null }), library: async () => library });
  assert.equal(await c.show({ x: 0, y: 0, w: 300, h: 400 }, null, false, 0), true);
  // One rect a frame, each show answered before the next frame comes.
  const frames: Promise<boolean>[] = [];
  for (let i = 1; i <= 18; i += 1) {
    frames.push(c.show({ x: 0, y: 0, w: 300 + 20 * i, h: 400 - 5 * i }, null, false, 0));
    await new Promise((r) => setTimeout(r, 16));
  }
  assert.equal(view.placed.length, 19, 'the canvas follows each rect');
  assert.deepEqual(await Promise.all(frames), [...Array(17).fill(false), true]);
  assert.equal(view.loads.length, 2);
  // A move that keeps the size loads at once.
  const started = performance.now();
  assert.equal(await c.show({ x: 30, y: 10, w: 660, h: 310 }, null, false, 0), true);
  assert.ok(performance.now() - started < 50);
  assert.equal(view.loads.length, 3);
});

test('the show a settings save brings answers the page: a failed load rejects it, and the same show again loads again', async () => {
  const view = new FakeView();
  let fail = false;
  view.load = async (s: PreviewSelection) => { view.loads.push(s); if (fail) throw new PreviewFailure('预览等待首帧超时'); return true; };
  let settings: Record<string, unknown> = {};
  const c = new PreviewController({ view, avatar: () => ({ character: 'si', appearance: null }), library: async () => library,
    renderArgs: () => lookArguments(settings) });
  const rect = { x: 0, y: 0, w: 300, h: 400 };
  await c.show(rect, null, false, 0);
  fail = true;
  settings = { render_filter: 'filter_1' };
  await assert.rejects(c.show(rect, null, false, 0), new PreviewFailure('预览等待首帧超时'));
  fail = false;
  assert.equal(await c.show(rect, null, false, 0), true);
  assert.deepEqual(view.loads.map((s) => s.renderArgs?.at(-3)), ['none', 'filter_1', 'filter_1']);
});

test('a selection with render arguments and an output sends them as render_args and output; one without sends neither', async () => {
  const { s, transport } = session();
  s.load(selection()).catch(() => {});
  assert.deepEqual(Object.keys(transport.sent.at(-1)!).sort(), ['bundle', 'character', 'load_id', 'op', 'rate', 'sha256']);
  s.load(selection({ renderArgs: ['--agentic-complex-ssaa', '1'], output: [720, 864] })).catch(() => {});
  assert.deepEqual(transport.sent.at(-1), { op: 'load', bundle: '/lib/si/runtime/bundle.json', sha256: 'a'.repeat(64), character: 'si', rate: 1,
    load_id: 2, render_args: ['--agentic-complex-ssaa', '1'], output: [720, 864] });
  // Another output is another selection.
  s.load(selection({ renderArgs: ['--agentic-complex-ssaa', '1'], output: [960, 1152] })).catch(() => {});
  assert.deepEqual(transport.sent.at(-1)?.load_id, 3);
  s.disconnect();
});

test('the output rounds the rect in device pixels up to a height bucket, the width from its aspect to a multiple of 16', () => {
  assert.deepEqual(previewOutput({ w: 250, h: 300 }, 1), [480, 576]);
  assert.deepEqual(previewOutput({ w: 250, h: 300 }, 2), [720, 864]);
  // A few pixels more or less keep the output.
  assert.deepEqual(previewOutput({ w: 252, h: 303 }, 2), [720, 864]);
  assert.deepEqual(previewOutput({ w: 400, h: 480 }, 2), [960, 1152]);
  assert.deepEqual(previewOutput({ w: 100, h: 100 }, 1), [576, 576]);
  // Past the last bucket it stays there; each side within 240–2048.
  assert.deepEqual(previewOutput({ w: 1000, h: 1200 }, 2), [1440, 1728]);
  assert.deepEqual(previewOutput({ w: 50, h: 1000 }, 1), [240, 1152]);
  // At the width limit the height comes down to keep the stage's aspect, to a multiple of 16 within 240–2048.
  assert.deepEqual(previewOutput({ w: 1200, h: 620 }, 2), [2048, 1056]);
  assert.deepEqual(previewOutput({ w: 4000, h: 300 }, 1), [2048, 240]);
});

test("each show takes the desktop renderer's look arguments and her mod settings as they are then", async () => {
  const view = new FakeView();
  let settings: Record<string, unknown> = { render_ssaa: false, render_shadow: '512', render_outline: 'subtle', render_camera_yaw: 30 };
  let mods: Record<string, Record<string, number>> = {};
  const c = new PreviewController({ view, avatar: () => ({ character: 'si', appearance: null }), library: async () => library,
    renderArgs: () => lookArguments(settings), modSettings: () => mods });
  const desktop = renderArguments(settings, '/p'), look = lookArguments(settings);
  assert.deepEqual(desktop.slice(0, look.length), look, 'the desktop starts with the same list');
  for (const flag of ['--agentic-complex-camera-yaw', '--agentic-complex-render-fps', '--agentic-complex-display-resolution',
    '--agentic-complex-capture-dir', '--agentic-complex-ambient', '--agentic-complex-speech-expressions']) {
    assert.ok(desktop.includes(flag) && !look.includes(flag), flag);
  }
  const rect = { x: 0, y: 0, w: 256, h: 307 };
  await c.show(rect, 'wave', true, 1);
  assert.deepEqual(view.loads.at(-1)?.renderArgs, look);
  assert.equal(view.loads.at(-1)?.modSettings, null);
  settings = { ...settings, render_ssaa: true };
  mods = { summer: { coat: 0 } };
  await c.show(rect, 'wave', true, 1);
  assert.deepEqual(view.loads[1], { ...view.loads[0], renderArgs: lookArguments(settings), modSettings: mods });
  assert.equal(view.loads[1]!.renderArgs![1], '2');
});

test('a controller without render arguments or mod settings sends a selection without them', async () => {
  const view = new FakeView();
  const c = new PreviewController({ view, avatar: () => ({ character: 'si', appearance: null }), library: async () => library });
  await c.show({ x: 0, y: 0, w: 10, h: 10 }, null, false, 0);
  assert.deepEqual(view.loads, [{ bundle: '/b.json', sha256: 'f'.repeat(64), character: 'si', clip: null, facial: null, rate: 1,
    appearance: null, request: 0, modSettings: null, loop: false }]);
});

const sha = (data: string) => createHash('sha256').update(data).digest('hex');

test('the motion library takes the bundle and its sha256 from character.json and maps each archive clip to its first playable action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'library-'));
  try {
    const write = (path: string, value: unknown) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      const text = JSON.stringify(value);
      writeFileSync(join(dir, path), text);
      return { file: path.split('/').at(-1)!, sha256: sha(text), byte_count: Buffer.byteLength(text) };
    };
    const pkg = 'packages/si/1';
    const actions = write(`${pkg}/runtime/c7/animation/actions.json`, { actions: [
      { id: 'walk', section: 'move', clips: ['A_walk'] }, { id: 'gone', section: 'talk', clips: ['A_wave'], unavailable_reason: 'no' },
      { id: 'wave', section: 'talk', clips: ['A_wave', 'A_wave2'] }, { id: 'wave_again', section: 'talk', clips: ['A_wave'] }] });
    const pack = write(`${pkg}/runtime/c7/pack.json`, { animation: { data: [actions] } });
    const archive = write(`${pkg}/runtime/actor/manifest.json`, { clips: [{ name: 'A_idle', length: 2 }, { name: 'A_walk', length: 1 },
      { name: 'A_wave', length: 1.5 }, { name: 'bad' }] });
    const bundle = write(`${pkg}/runtime/bundle.json`, { characters: [{ id: 'si', actor_archive: { ...archive, file: 'actor/manifest.json' },
      c7: { ...pack, file: 'c7/pack.json' } }] });
    write(`${pkg}/character.json`, { id: 'si', components: { render: { native_bundle: { ...bundle, file: 'runtime/bundle.json' } } } });
    write('current.json', { schema: 'endfield-character-library/v1', characters: [{ id: 'si', definition: { file: `${pkg}/character.json` } }] });
    const got = loadMotionLibrary(join(dir, 'current.json'), 'si')!;
    assert.match(got.bundle, /packages[\\/]si[\\/]1[\\/]runtime[\\/]bundle\.json$/);
    assert.equal(got.sha256, bundle.sha256);
    assert.deepEqual(got.clips, [{ clip: 'A_idle', actionID: null }, { clip: 'A_walk', actionID: null }, { clip: 'A_wave', actionID: 'wave' }]);
    assert.equal(loadMotionLibrary(join(dir, 'current.json'), 'nobody'), null);
    writeFileSync(join(dir, pkg, 'runtime/c7/animation/actions.json'), '{"actions":[]}');
    assert.throws(() => loadMotionLibrary(join(dir, 'current.json'), 'si'), /motion_identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sender = { mainFrame: true, origin: ORIGIN };
const call = (preview: PreviewHost | null, op: string, args: unknown[] = []) =>
  handle('main', sender, { op, args }, new Map(Object.entries(previewOps({ preview } as unknown as OpsContext))));

test('without a preview host (Windows) the three ops answer not_implemented, after the sequence argument check', async () => {
  for (const [op, args] of [['avatar.preview.show', [{ x: 0, y: 0, w: 10, h: 10 }]], ['avatar.preview.hide', []],
    ['avatar.preview.sequence', [{ clips: ['a'], blend_s: [] }]]] as const) {
    assert.deepEqual(await call(null, op, [...args]), { ok: false, error: { code: 'not_implemented', detail: op } }, op);
  }
  assert.equal(((await call(null, 'avatar.preview.sequence', [{ clips: [] }])) as { error: { code: string } }).error.code, 'invalid_args');
});

test('the ops check their arguments and reach the preview host', async () => {
  const shown: unknown[][] = [], sequences: unknown[][] = [];
  let hides = 0;
  const host: PreviewHost = {
    show: async (rect, action, loop, revision) => {
      shown.push([rect, action, loop, revision]);
      if (action === 'broken') throw new BridgeFailure('failed', '没画出来');
      return true;
    },
    hide: () => { hides += 1; },
    sequence: async (clips, blends) => {
      if (clips[0] === 'old') throw new BridgeFailure('unavailable', 'no live preview');
      sequences.push([clips, blends]);
    },
  };
  const rect = { x: 10, y: 20.5, w: 300, h: 400 };
  assert.deepEqual(await call(host, 'avatar.preview.show', [rect]), { ok: true, value: true });
  await call(host, 'avatar.preview.show', [{ ...rect, action: 'wave', request: 4 }]);
  await call(host, 'avatar.preview.show', [{ ...rect, action: null, request: 4 }]);
  await call(host, 'avatar.preview.show', [{ ...rect, action: 'wave', request: 4, loop: true }]);
  assert.deepEqual(await call(host, 'avatar.preview.show', [{ ...rect, action: 'broken', request: 4, loop: false }]),
    { ok: false, error: { code: 'failed', detail: '没画出来' } });
  const bad = ['rect', { x: 0, y: 0, w: 0, h: 10 }, { x: '0', y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: Number.NaN },
    { x: true, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10, action: '' }, { x: 0, y: 0, w: 10, h: 10, action: 3 },
    { x: 0, y: 0, w: 10, h: 10, loop: 'yes' }, { x: 0, y: 0, w: 10, h: 10, loop: 1 }, { x: 0, y: 0, w: 10, h: 10, request: -1 }];
  for (const value of bad) {
    const r = await call(host, 'avatar.preview.show', [value]) as { ok: boolean; error?: { code: string } };
    assert.equal(r.error?.code, 'invalid_args', JSON.stringify(value));
  }
  assert.deepEqual(shown.map((s) => s[0]), Array(5).fill(rect));
  assert.deepEqual(shown.map((s) => s[1]), [null, 'wave', null, 'wave', 'broken']);
  assert.deepEqual(shown.map((s) => s[2]), [false, false, false, true, false]);
  assert.deepEqual(shown.map((s) => s[3]), [0, 4, 4, 4, 4]);
  assert.deepEqual(await call(host, 'avatar.preview.hide'), { ok: true, value: null });
  assert.equal(hides, 1);
  assert.deepEqual(await call(host, 'avatar.preview.sequence', [{ clips: ['a', 'b'], blend_s: [0.25] }]), { ok: true, value: true });
  await call(host, 'avatar.preview.sequence', [{ clips: ['c'.repeat(128)], blend_s: [] }]);
  await call(host, 'avatar.preview.sequence', [{ clips: Array(32).fill('a'), blend_s: Array(31).fill(2) }]);
  const badSequences = ['a', { clips: [], blend_s: [] }, { clips: Array(33).fill('a'), blend_s: Array(32).fill(0) }, { clips: ['a', ''], blend_s: [0] },
    { clips: ['c'.repeat(129)], blend_s: [] }, { clips: ['a', 1], blend_s: [0] }, { clips: ['a', 'b'], blend_s: [] }, { clips: ['a'], blend_s: [0] },
    { clips: ['a', 'b'], blend_s: [2.5] }, { clips: ['a', 'b'], blend_s: [-0.1] }, { clips: ['a', 'b'], blend_s: [true] }, { clips: ['a'] }];
  for (const value of badSequences) {
    const r = await call(host, 'avatar.preview.sequence', [value]) as { ok: boolean; error?: { code: string } };
    assert.equal(r.error?.code, 'invalid_args', JSON.stringify(value));
  }
  assert.equal(sequences.length, 3);
  assert.deepEqual(await call(host, 'avatar.preview.sequence', [{ clips: ['old'], blend_s: [] }]),
    { ok: false, error: { code: 'unavailable', detail: 'no live preview' } });
});

test('her hidden layers go to the service as hidden_layers, and showing them all again is another load', async () => {
  let hidden: string[] = ['coat'];
  const view = new FakeView();
  const c = new PreviewController({ view, avatar: () => ({ character: 'si', appearance: null, hiddenLayers: hidden }), library: async () => library });
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  await c.show(rect, null, false, 0);
  assert.deepEqual(view.loads.at(-1)?.hiddenLayers, ['coat']);
  hidden = [];
  await c.show(rect, null, false, 0);
  assert.equal(view.loads.at(-1)?.hiddenLayers, undefined);
  const { s, transport } = session();
  s.load(selection({ hiddenLayers: ['coat', 'gloves'] })).catch(() => {});
  assert.deepEqual(transport.sent.at(-1)?.hidden_layers, ['coat', 'gloves']);
  s.disconnect();
});
