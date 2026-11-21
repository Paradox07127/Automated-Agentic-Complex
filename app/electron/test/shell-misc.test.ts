// `supervisor.state`'s CPU and memory, `desktop.onState`'s current screen, the hide that expires and `window.onA11y`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { a11ySource } from '../src/common/a11y.ts';
import { currentScreen } from '../src/common/current-screen.ts';
import { desktopScreens } from '../src/common/desktop-screens.ts';
import type { StreamEvent } from '../src/common/page.ts';
import { AvatarVisibility, HIDE_EXPIRY_MS } from '../src/common/visibility-reason.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { psResidentMB, supervisorOps } from '../src/main/ops/supervisor.ts';

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

test('supervisor.state lists the tunnel only with tts_tunnel_host, external as external', () => {
  assert.deepEqual(Object.keys(state({})()), ['agentd', 'avatar']);
  const base = { state: () => ({ kind: 'running' }) as const, pid: () => undefined, restart() {}, avatar: () => ({ kind: 'running' }) as const };
  assert.deepEqual(Object.keys(state({ supervisor: { ...base, tunnel: () => null } })()), ['agentd', 'avatar']);
  const external = state({ supervisor: { ...base, tunnel: () => ({ kind: 'external' }), tunnelPid: () => undefined } })();
  assert.deepEqual(external.tunnel, { state: 'external', pid: null, backoff: null, cpuPercent: null, memoryMB: null });
  const backoff = state({ supervisor: { ...base, tunnel: () => ({ kind: 'backoff', seconds: 4 }) } })();
  assert.deepEqual([backoff.tunnel!.state, backoff.tunnel!.backoff], ['backoff(4)', 4]);
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
