// `supervisor.state`'s CPU and memory, `desktop.onState`'s current screen, the hide that expires and `window.onA11y`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { a11ySource } from '../src/common/a11y.ts';
import { currentScreen } from '../src/common/current-screen.ts';
import { desktopScreens } from '../src/common/desktop-screens.ts';
import type { StreamEvent } from '../src/common/page.ts';
import type { ServiceView } from '../src/common/runtime.ts';
import { AvatarVisibility, HIDE_EXPIRY_MS } from '../src/common/visibility-reason.ts';
import type { HelperReply } from '../src/main/helper/client.ts';
import { cpuSecondsReader, psCpuSeconds } from '../src/main/ops/avatar.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { ProcessHistory, psResidentMB, supervisorOps } from '../src/main/ops/supervisor.ts';

const PS = process.platform === 'win32' ? "ps is macOS's" : false;

/** `supervisor.state` over a running agentd and avatar with these pids and CPU seconds. */
function state(ctx: Partial<OpsContext>) {
  const ops = supervisorOps({ supervisor: { state: () => ({ kind: 'running' }), pid: () => process.pid, restart() {},
    avatar: () => ({ kind: 'running' }), avatarPid: () => undefined }, ...ctx } as OpsContext);
  return () => ops['supervisor.state']!([], undefined as never) as Record<string, Record<string, unknown>>;
}

test('supervisor.state: CPU as a percent of one core since the last read, null on the first; no pid, no reading', { skip: PS }, async () => {
  let seconds = 10;
  const read = state({ cpuSeconds: () => seconds });
  const before = performance.now();
  const first = read();
  const afterFirst = performance.now();
  assert.equal(first.agentd!.cpuPercent, null);
  assert.ok(typeof first.agentd!.memoryMB === 'number' && first.agentd!.memoryMB > 1, `memory ${first.agentd!.memoryMB}`);
  assert.deepEqual([first.avatar!.cpuPercent, first.avatar!.memoryMB, first.avatar!.pid], [null, null, null]);
  await new Promise((r) => setTimeout(r, 100));
  seconds += 0.05;
  const beforeSecond = performance.now();
  const share = read().agentd!.cpuPercent as number;
  // 0.05 CPU seconds over the time between the two reads, which the timer may stretch on a busy machine.
  const least = 5000 / (performance.now() - before), most = 5000 / (beforeSecond - afterFirst);
  assert.ok(share >= least && share <= most, `cpu ${share} outside ${least}..${most}`);
});

test('supervisor.state on Windows has no memory; without a CPU reader no CPU', () => {
  const read = state({ platform: 'windows', cpuSeconds: null });
  read();
  const s = read();
  assert.deepEqual([s.agentd!.cpuPercent, s.agentd!.memoryMB, s.agentd!.state], [null, null, 'running']);
});

test('supervisor.state on Windows: CPU from the helper\'s process.usage, each read showing the answer to the one before', async () => {
  let ns = 10e9;
  const asked: unknown[] = [];
  const helper = { request: async (op: string, params: Record<string, unknown>): Promise<HelperReply> => {
    asked.push([op, params]);
    return { ok: true, result: { usage: [{ pid: process.pid, cpu_time_ns: ns, resident_bytes: 1 }] } };
  } };
  const cpuSeconds = cpuSecondsReader('windows', helper)!;
  assert.equal(cpuSeconds(process.pid), null, 'no answer yet');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [['process.usage', { pids: [process.pid] }]]);
  assert.equal(cpuSeconds(process.pid), 10);
  const read = state({ platform: 'windows', cpuSeconds });
  assert.equal(read().agentd!.cpuPercent, null, 'the first read has nothing to compare');
  await new Promise((r) => setTimeout(r, 100));
  ns += 0.05e9;
  read();
  await new Promise((r) => setTimeout(r, 100));
  const share = read().agentd!.cpuPercent as number;
  assert.ok(share > 10 && share <= 50, `cpu ${share}`);
  assert.equal(cpuSecondsReader('windows', null), null, 'no helper, no CPU');
  assert.equal(cpuSecondsReader('mac', null), psCpuSeconds);
});

test('the helper CPU reader forgets a pid the helper no longer lists or fails for', async () => {
  let reply: HelperReply = { ok: true, result: { usage: [{ pid: 7, cpu_time_ns: 2e9, resident_bytes: 1 }] } };
  const cpuSeconds = cpuSecondsReader('windows', { request: async () => reply })!;
  cpuSeconds(7);
  await new Promise((r) => setImmediate(r));
  reply = { ok: true, result: { usage: [] } };
  assert.equal(cpuSeconds(7), 2);
  await new Promise((r) => setImmediate(r));
  reply = { ok: false, error: { code: 'helper_exited', message: 'gone' } };
  assert.equal(cpuSeconds(7), null, 'gone');
  await new Promise((r) => setImmediate(r));
  assert.equal(cpuSeconds(7), null);
});

test('supervisor.state lists the ssh and local services by id, external as external', () => {
  assert.deepEqual(Object.keys(state({})()), ['agentd', 'avatar']);
  const views: Record<string, ServiceView> = {
    tts: { mode: 'ssh', state: { kind: 'external' }, pid: null, detail: null },
    motion: { mode: 'url', state: null, pid: null, detail: null },
    llm: { mode: 'local', state: { kind: 'backoff', seconds: 4 }, pid: null, detail: 'exit 1' },
  };
  const services = { view: (id: string) => views[id]!, start: async () => ({ ok: true, line: null }) as const,
    stop: async () => ({ ok: true, line: null }) as const, restart: async () => ({ ok: true, line: null }) as const, saved() {} };
  const listed = state({ services })();
  assert.deepEqual(Object.keys(listed), ['agentd', 'avatar', 'tts', 'llm']);
  assert.deepEqual(listed.tts, { state: 'external', pid: null, backoff: null, cpuPercent: null, memoryMB: null, history: [] });
  assert.deepEqual([listed.llm!.state, listed.llm!.backoff], ['backoff(4)', 4]);
});

test('ProcessHistory keeps the last readings of each process, oldest first, and supervisor.state carries them', () => {
  let seconds = 10, avatarPid: number | undefined;
  const ports = { platform: 'windows' as const, cpuSeconds: () => seconds,
    supervisor: { state: () => ({ kind: 'running' as const }), pid: () => process.pid, avatar: () => ({ kind: 'stopped' as const }),
      avatarPid: () => avatarPid } };
  const history = new ProcessHistory(ports, 3);
  assert.deepEqual(history.of('agentd'), []);
  for (const at of [1000, 2000, 3000, 4000]) {
    avatarPid = at >= 3000 ? process.pid : undefined;
    history.sample(at);
    seconds += 1;
  }
  const agentd = history.of('agentd');
  assert.deepEqual(agentd.map((r) => r.at), [2000, 3000, 4000], 'past 3 the oldest goes');
  assert.ok(agentd.every((r) => typeof r.cpuPercent === 'number' && r.memoryMB === null), 'Windows reads no memory');
  assert.deepEqual(history.of('avatar').slice(0, 2).map((r) => [r.at, r.cpuPercent]), [[2000, null], [3000, null]],
    'a stopped process and a first read have no CPU');
  assert.equal(typeof history.of('avatar')[2]!.cpuPercent, 'number');
  const ops = supervisorOps({ ...ports, supervisor: { ...ports.supervisor, restart() {} }, processHistory: history } as unknown as OpsContext);
  const s = ops['supervisor.state']!([], undefined as never) as Record<string, Record<string, unknown>>;
  assert.deepEqual([s.agentd!.history, s.avatar!.history], [agentd, history.of('avatar')]);
});

test('psResidentMB reads a process\'s resident memory in MB; a gone process is null', { skip: PS }, () => {
  const mb = psResidentMB(process.pid);
  assert.ok(mb !== null && mb > 1 && mb < 100_000, `memory ${mb}`);
  assert.equal(psResidentMB(99_999_999), null);
});

test("current screen: her placement's display in the fullscreen viewport, else the screen under her window's bottom middle", () => {
  const screens = [{ id: 1, frame: { x: 0, y: 0, w: 1000, h: 800 }, visibleFrame: { x: 0, y: 0, w: 1000, h: 780 } },
    { id: 2, frame: { x: 1000, y: 0, w: 800, h: 600 }, visibleFrame: { x: 1000, y: 0, w: 800, h: 580 } }];
  assert.equal(currentScreen('fullscreen', 2, { x: 10, y: 10, w: 100, h: 100 }, screens), '2');
  assert.equal(currentScreen('fullscreen', null, { x: 10, y: 10, w: 100, h: 100 }, screens), null);
  // Her foot (x 1050, y 100) is on the second screen, though most of the window is on the first.
  assert.equal(currentScreen('window', null, { x: 900, y: 100, w: 300, h: 400 }, screens), '2');
  assert.equal(currentScreen('window', null, { x: 400, y: 0, w: 200, h: 300 }, screens), '1');
  // The right and top edges are outside, as CGRect.contains.
  assert.equal(currentScreen('window', null, { x: 1700, y: 600, w: 200, h: 100 }, screens), null);
  assert.equal(currentScreen('window', 1, null, screens), null);
});

test("desktop.onState's screens mark the one she stands on as current, none when she is on none", () => {
  const displays = [{ id: 1, label: '内建显示器' }, { id: 69733382, label: 'DELL U2720Q' }];
  assert.deepEqual(desktopScreens('69733382', displays),
    [{ id: '1', name: '内建显示器', current: false }, { id: '69733382', name: 'DELL U2720Q', current: true }]);
  assert.deepEqual(desktopScreens(null, displays).map((s) => s.current), [false, false]);
});

test('a hide for any reason but fullscreen shows her again after 30 minutes with hide_expired; the next change cancels it', () => {
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const expired: number[] = [];
  const v = new AvatarVisibility({
    after: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    expired: () => expired.push(1),
  });
  assert.equal(v.reason, null);
  v.set(true, 'user');
  assert.deepEqual([v.reason, timers.length, timers[0]!.ms], ['user', 1, HIDE_EXPIRY_MS]);
  v.set(false, 'user');
  assert.equal(timers[0]!.cancelled, true);
  v.set(true, 'fullscreen');
  assert.deepEqual([v.reason, timers.length], ['fullscreen', 1]);
  v.set(true, 'hotkey');
  timers[1]!.fn();
  assert.deepEqual(expired, [1]);
  v.set(false, 'hide_expired');
  assert.deepEqual([v.reason, timers.length], ['hide_expired', 2]);
  assert.equal(HIDE_EXPIRY_MS, 30 * 60 * 1000);
});

test('hiddenUntil is when an expiring hide ends, epoch ms; null for a show and a fullscreen hide', () => {
  let now = 1_000;
  const v = new AvatarVisibility({ after: () => () => {}, expired: () => {}, now: () => now });
  assert.equal(v.hiddenUntil, null);
  v.set(true, 'user');
  assert.equal(v.hiddenUntil, 1_000 + HIDE_EXPIRY_MS);
  now = 5_000;
  v.set(true, 'fullscreen');
  assert.equal(v.hiddenUntil, null);
  v.set(true, 'hotkey');
  assert.equal(v.hiddenUntil, 5_000 + HIDE_EXPIRY_MS);
  v.set(false, 'user');
  assert.equal(v.hiddenUntil, null);
});

test('window.onA11y sends the system display options with glass false at once and again on each change', () => {
  let now = { reduceMotion: false, reduceTransparency: true, increaseContrast: false };
  let changed: () => void = () => {};
  const source = a11ySource(() => now, (fn) => { changed = fn; });
  const got: unknown[] = [];
  source.subscribe(null, (e: StreamEvent) => got.push([e.event, JSON.parse(e.data)]));
  now = { ...now, reduceMotion: true };
  changed();
  changed();
  assert.deepEqual(got, [
    ['a11y', { glass: false, increaseContrast: false, reduceMotion: false, reduceTransparency: true }],
    ['a11y', { glass: false, increaseContrast: false, reduceMotion: true, reduceTransparency: true }],
  ]);
});
