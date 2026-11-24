// The Windows preview transport (src/main/preview/pipe.ts) over a fake of its addon (native/win/preview.cpp), alone and under
// the session: lines of the pipe, sends kept until a hello on the GPU process's adapter, a new hello or the efw's end as one
// `disconnected`, the ring's handles and the frames of an older ring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeDevice, ADAPTER_MISMATCH, type Adapter, type GpuDevice, MAX_LINE, type PipeAddon, PipeTransport } from '../src/main/preview/pipe.ts';
import { PreviewFailure, PreviewSession, type PreviewSelection, type PreviewSurface } from '../src/main/preview/session.ts';
import { hostPipePath, previewPipePath } from '../src/main/renderer/link.ts';

type Message = Record<string, unknown>;

const LUID = '00000000:0001a2b3';
const ADAPTER: Adapter = { luid: LUID, vendorId: 0x10de, deviceId: 0x2684, subSysId: 0x16f310de, revision: 0xa1, software: false };
const WARP: Adapter = { luid: '00000000:00009999', vendorId: 0x1414, deviceId: 0x8c, subSysId: 0, revision: 0, software: true };
const GPU: GpuDevice = { vendorId: ADAPTER.vendorId, deviceId: ADAPTER.deviceId, subSysId: ADAPTER.subSysId, revision: ADAPTER.revision };

/** The addon as the I/O thread would drive it: each connect a new connection, the last one current. */
class FakePipe implements PipeAddon {
  name = '';
  listens = 0;
  listenOk = true;
  onData: ((connection: number, data: Buffer | null) => void) | null = null;
  current = 0;
  private next = 0;
  written: { connection: number; message: Message }[] = [];
  closed: number[] = [];
  adapterList: Adapter[] = [WARP, ADAPTER];
  listen(name: string, onData: (connection: number, data: Buffer | null) => void): boolean {
    this.name = name;
    this.listens += 1;
    this.onData = onData;
    return this.listenOk;
  }
  write(connection: number, line: string): boolean {
    if (connection !== this.current) return false;
    this.written.push({ connection, message: JSON.parse(line) as Message });
    return true;
  }
  openClient(connection: number): number | null {
    return 9000 + connection;
  }
  duplicate(process: number, handle: number): number | null {
    return process > 0 ? handle + 1000 : null;
  }
  close(handle: number): void {
    this.closed.push(handle);
  }
  adapters(): Adapter[] {
    return this.adapterList;
  }
  connect(): number {
    return this.current = ++this.next;
  }
  lines(connection: number, ...lines: (Message | string)[]): void {
    this.onData!(connection, Buffer.from(lines.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join('')));
  }
  end(connection: number): void {
    this.current = 0;
    this.onData!(connection, null);
  }
  ops(): unknown[] {
    return this.written.map((w) => w.message.op ?? w.message.event);
  }
}

interface Got { message: Message; surface: PreviewSurface | null; sequence: number }

function transport(gpu: GpuDevice | null = GPU) {
  const pipe = new FakePipe(), logs: string[] = [];
  const t = new PipeTransport({ addon: pipe, name: '\\\\.\\pipe\\agentic-complex-x-preview-1', gpu: async () => gpu, log: (l) => logs.push(l) });
  const got: Got[] = [];
  const listen = (json: string, surface: PreviewSurface | null, sequence: number) => { got.push({ message: JSON.parse(json) as Message, surface, sequence }); };
  return { t, pipe, logs, got, listen };
}

const settle = () => new Promise((r) => setImmediate(r));
const hello = (luid = LUID) => ({ event: 'hello', luid });
const ring = (n: number, slots = [4, 8, 12]) => ({ event: 'ring', ring: n, width: 480, height: 576, slots });
const frame = (sequence: number, r: number, slot: number) => ({ event: 'frame', sequence, ring: r, slot, load_id: 1 });

test('the pipe name holds the C3 pipe\'s hash of the support dir and the shell\'s pid', () => {
  const support = 'C:\\Users\\A\\AppData\\Roaming\\Agentic Complex';
  assert.equal(previewPipePath(support, 42), hostPipePath(support).replace(/-avatar$/, '-preview-42'));
  assert.equal(previewPipePath('C:\\X', 7), previewPipePath('c:\\x', 7));
});

test('rendezvous makes the pipe once and is null for good when it cannot be made', () => {
  const a = transport();
  assert.equal(a.t.rendezvous(), '\\\\.\\pipe\\agentic-complex-x-preview-1');
  assert.equal(a.t.rendezvous(), '\\\\.\\pipe\\agentic-complex-x-preview-1');
  assert.equal(a.pipe.listens, 1);
  const b = transport();
  b.pipe.listenOk = false;
  assert.equal(b.t.rendezvous(), null);
  assert.equal(b.t.rendezvous(), null);
  assert.equal(b.pipe.listens, 1);
});

test('sends before a hello are kept, at most 16, and go after `connected` once the hello\'s adapter is the GPU process\'s', async () => {
  const { t, pipe, got, listen } = transport();
  t.start('ignored', listen);
  assert.equal(t.send(JSON.stringify({ op: 'view' })), true);
  assert.equal(t.send(JSON.stringify({ op: 'load' })), true);
  for (let i = 2; i < 16; i++) assert.equal(t.send(JSON.stringify({ op: 'pause' })), true);
  assert.equal(t.send(JSON.stringify({ op: 'resume' })), false, 'past 16');
  const c = pipe.connect();
  pipe.lines(c, hello());
  assert.equal(pipe.written.length, 0, 'nothing before the adapter is checked');
  await settle();
  assert.deepEqual(pipe.ops().slice(0, 3), ['connected', 'view', 'load']);
  assert.equal(pipe.written.length, 17);
  assert.equal(got.length, 0, 'the hello is not the page\'s');
  assert.equal(t.send(JSON.stringify({ op: 'resume' })), true);
  assert.equal(pipe.ops().at(-1), 'resume');
  pipe.lines(c, { event: 'loaded', load_id: 1 });
  assert.deepEqual(got.map((g) => g.message.event), ['loaded']);
});

test('a start after a usable hello sends `connected` at once; stop sends `disconnected` and nothing more reaches the page', async () => {
  const { t, pipe, got, listen } = transport();
  t.rendezvous();
  const c = pipe.connect();
  pipe.lines(c, hello());
  await settle();
  pipe.lines(c, { event: 'stats' });
  assert.equal(got.length, 0, 'not started');
  t.start('s', listen);
  assert.deepEqual(pipe.ops(), ['connected']);
  t.stop();
  assert.deepEqual(pipe.ops(), ['connected', 'disconnected']);
  assert.equal(t.send('{"op":"load"}'), false);
  pipe.lines(c, { event: 'loaded' });
  await settle();
  assert.equal(got.length, 0);
});

test('a hello on another adapter, or none that is the GPU process\'s alone, gives no `connected`: the page hears why', async () => {
  const cases: { adapters?: Adapter[]; gpu?: GpuDevice | null; luid?: string }[] = [
    { luid: '00000000:00009999' },
    { gpu: null },
    { adapters: [ADAPTER, { ...ADAPTER, luid: '00000001:00000000' }] },
    { gpu: { ...GPU, revision: 0 } },
    { luid: 'not a luid' },
    { adapters: [WARP, { ...ADAPTER, software: true }] },
  ];
  for (const k of cases) {
    const { t, pipe, logs, got, listen } = transport(k.gpu === undefined ? GPU : k.gpu);
    if (k.adapters) pipe.adapterList = k.adapters;
    t.start('s', listen);
    assert.equal(t.send('{"op":"load"}'), true);
    const c = pipe.connect();
    pipe.lines(c, hello(k.luid));
    await settle();
    assert.equal(pipe.written.length, 0, JSON.stringify(k));
    assert.match(logs.join('\n'), /^AAC_PREVIEW_ADAPTER_MISMATCH /);
    assert.deepEqual(got.map((g) => g.message), [{ event: 'disconnected', reason: ADAPTER_MISMATCH }]);
    pipe.lines(c, { event: 'loaded' });
    t.start('s', listen);
    await settle();
    assert.deepEqual(got.map((g) => g.message.reason), [ADAPTER_MISMATCH, ADAPTER_MISMATCH], 'again at the next start');
    assert.equal(pipe.written.length, 0);
  }
});

test('under the session, an adapter mismatch fails the load with the page\'s reason', async () => {
  const { t, pipe } = transport({ ...GPU, deviceId: 1 });
  const presenter = { active: true, clear() {}, present() {} };
  const s = new PreviewSession<PreviewSurface>({ transport: t, service: t.rendezvous()!, presenter, log: () => {} });
  const loaded = s.load(selection());
  pipe.lines(pipe.connect(), hello());
  await assert.rejects(loaded, new PreviewFailure(ADAPTER_MISMATCH));
});

test('a new hello ends the started connection with one `disconnected` and closes the old efw\'s handles', async () => {
  const { t, pipe, got, listen } = transport();
  t.start('s', listen);
  const c = pipe.connect();
  pipe.lines(c, hello());
  await settle();
  pipe.lines(c, ring(1));
  pipe.lines(c, hello());
  await settle();
  assert.deepEqual(got.map((g) => g.message), [{ event: 'disconnected' }]);
  assert.deepEqual(pipe.closed.sort(), [1004, 1008, 1012, 9001]);
  assert.deepEqual(pipe.ops(), ['connected'], 'no connected until the page starts again');
  t.start('s', listen);
  assert.deepEqual(pipe.ops(), ['connected', 'connected']);
  // The efw's end, then a restarted efw on the next connection.
  pipe.end(c);
  await settle();
  assert.deepEqual(got.map((g) => g.message.event), ['disconnected', 'disconnected']);
  t.start('s', listen);
  const d = pipe.connect();
  pipe.lines(d, hello());
  await settle();
  assert.deepEqual(pipe.written.at(-1), { connection: d, message: { event: 'connected' } });
  pipe.lines(c, { event: 'loaded' });
  pipe.end(c);
  await settle();
  assert.equal(got.length, 2, 'the old connection is gone');
});

test('a ring pulls its three handles; a frame carries its slot\'s handle, and a frame of an older ring comes without a surface', async () => {
  const { t, pipe, got, listen } = transport();
  t.start('s', listen);
  const c = pipe.connect();
  pipe.lines(c, hello());
  await settle();
  pipe.lines(c, ring(1), frame(7, 1, 2));
  assert.equal(got.length, 1);
  const s = got[0]!.surface!;
  assert.equal(got[0]!.sequence, 7);
  assert.equal(s.handle.length, 8);
  assert.equal(s.handle.readBigUInt64LE(), 1012n);
  assert.deepEqual({ ...s, handle: null }, { handle: null, width: 480, height: 576, pixelFormat: 87, bytesPerRow: 1920, id: 5 });
  pipe.lines(c, ring(2, [16, 20, 24]));
  assert.deepEqual(pipe.closed.sort(), [1004, 1008, 1012], 'the old ring closed');
  pipe.lines(c, frame(8, 1, 0), frame(9, 2, 3), frame(10, 2, 0));
  assert.deepEqual(got.slice(1).map((g) => [g.sequence, g.surface?.handle.readBigUInt64LE() ?? null]), [[8, null], [9, null], [10, 1016n]]);
  pipe.lines(c, { event: 'frame', sequence: -1, ring: 2, slot: 0 });
  assert.equal(got.length, 4, 'a frame without a sequence to ack is dropped');
  pipe.lines(c, ring(3, [1, 2]));
  pipe.lines(c, frame(11, 3, 0));
  assert.equal(got.at(-1)!.surface, null, 'a ring without three slots is none');
  t.stop();
  assert.ok(pipe.closed.includes(1016) && pipe.closed.includes(1024), 'stop frees the ring');
});

test('under the session, a frame of an older ring is acked and not drawn', async () => {
  const { t, pipe } = transport();
  const drawn: PreviewSurface[] = [];
  const presenter = { active: true, clear() {}, present(surface: PreviewSurface, done: (d: boolean) => void) { drawn.push(surface); done(true); } };
  const s = new PreviewSession<PreviewSurface>({ transport: t, service: t.rendezvous()!, presenter, log: () => {} });
  const loaded = s.load(selection());
  const c = pipe.connect();
  pipe.lines(c, hello());
  await settle();
  const load = pipe.written.find((w) => w.message.op === 'load')!.message;
  pipe.lines(c, ring(1), ring(2), { ...frame(3, 1, 0), load_id: load.load_id });
  assert.equal(drawn.length, 0);
  assert.deepEqual(pipe.written.at(-1)!.message, { op: 'ack', sequence: 3 });
  pipe.lines(c, { ...frame(4, 2, 1), load_id: load.load_id });
  await loaded;
  assert.equal(drawn[0]!.handle.readBigUInt64LE(), 1008n);
  assert.deepEqual(pipe.written.at(-1)!.message, { op: 'ack', sequence: 4 });
});

test('lines: one split over reads is joined, a longer one than 8192 bytes is dropped up to its newline, a non-object line is dropped', async () => {
  const { t, pipe, got, listen } = transport();
  t.start('s', listen);
  const c = pipe.connect();
  pipe.lines(c, hello());
  await settle();
  const half = JSON.stringify({ event: 'loaded', clip: 'wave' });
  pipe.onData!(c, Buffer.from(half.slice(0, 9)));
  pipe.onData!(c, Buffer.from(`${half.slice(9)}\n`));
  const long = (n: number) => JSON.stringify({ event: 'stats', pad: 'x'.repeat(n - 26) });
  assert.equal(Buffer.byteLength(long(MAX_LINE)), MAX_LINE);
  pipe.lines(c, long(MAX_LINE));
  // 8193 bytes in two reads, the rest of the line after them dropped too, then the next line.
  const over = long(MAX_LINE + 1);
  pipe.onData!(c, Buffer.from(over.slice(0, 5000)));
  pipe.onData!(c, Buffer.from(over.slice(5000)));
  pipe.onData!(c, Buffer.from('{"event":"loaded","clip":"lost"}\n{"event":"loaded","clip":"next"}\n'));
  pipe.lines(c, '[1]', 'nope', '', '"x"', { event: 'completed' });
  assert.deepEqual(got.map((g) => [g.message.event, g.message.clip]), [['loaded', 'wave'], ['stats', undefined], ['loaded', 'next'], ['completed', undefined]]);
  assert.equal(t.send('x'.repeat(MAX_LINE + 1)), false);
});

test('activeDevice reads the active device of getGPUInfo(complete), its ids unsigned', () => {
  const info = { gpuDevice: [{ active: false, vendorId: 1, deviceId: 2, subSysId: 3, revision: 4 },
    { active: true, vendorId: 5, deviceId: 6, subSysId: 7, revision: 8, deviceString: 'x' }] };
  assert.deepEqual(activeDevice(info), { vendorId: 5, deviceId: 6, subSysId: 7, revision: 8 });
  assert.deepEqual(activeDevice({ gpuDevice: [{ active: true, vendorId: 4318, deviceId: 9352, subSysId: -1999040452, revision: 161 }] }),
    { vendorId: 4318, deviceId: 9352, subSysId: 2295926844, revision: 161 }, 'Chromium\'s signed subSysId is DXGI\'s unsigned one');
  assert.equal(activeDevice({ gpuDevice: [{ active: true, vendorId: 5, deviceId: 6 }] }), null);
  assert.equal(activeDevice({}), null);
  assert.equal(activeDevice(null), null);
});

const selection = (): PreviewSelection => ({ bundle: 'C:\\lib\\si', sha256: 'a'.repeat(64), character: 'si', clip: null, facial: null, rate: 1,
  appearance: null, request: 0, modSettings: null, loop: false });
