import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  behaviorCapabilities, type C3Message, companionHello, decodeLine, dropProblem, encodeLine, fpsTier, fpsTierFor, type Heartbeat, LineFramer,
  LineTooLong, MAX_LINE, touchSettings, Watchdog,
} from '../src/common/c3.ts';

const EXAMPLES = resolve(import.meta.dirname, '../../../protocol/C3-host-ipc/examples');
const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.ndjson')).sort();
const bytes = (s: string) => new TextEncoder().encode(s);

test('every C3 example line decodes, encodes back to the same message, and frames the same in 7-byte chunks', () => {
  assert.ok(files.length >= 40, `${files.length} example files`);
  let count = 0;
  for (const file of files) {
    const text = readFileSync(join(EXAMPLES, file), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      const m = decodeLine(line);
      assert.ok(m !== null, `${file}: ${line.slice(0, 80)}`);
      const encoded = encodeLine(m);
      assert.ok(encoded.endsWith('\n') && !encoded.slice(0, -1).includes('\n'), file);
      assert.deepEqual(JSON.parse(encoded), JSON.parse(line), file);
      count += 1;
    }
    const framer = new LineFramer(), all = bytes(lines.map((l) => `${l}\n`).join('')), got: string[] = [];
    for (let at = 0; at < all.length; at += 7) got.push(...framer.append(all.subarray(at, at + 7)));
    assert.deepEqual(got, lines, file);
  }
  assert.ok(count > 250, `${count} lines`);
});

test('a line of exactly 65536 bytes with its newline is read; one byte more closes, with or without its newline', () => {
  const fill = (n: number) => JSON.stringify({ v: 1, type: 'trace', pad: 'x'.repeat(n - 31) });
  const exact = fill(MAX_LINE - 1);
  assert.equal(bytes(exact).length, MAX_LINE - 1);
  assert.deepEqual(new LineFramer().append(bytes(`${exact}\n`)), [exact]);
  assert.throws(() => new LineFramer().append(bytes(`${fill(MAX_LINE)}\n`)), LineTooLong);
  assert.throws(() => new LineFramer().append(bytes(fill(MAX_LINE))), LineTooLong, 'no newline yet');
  assert.doesNotThrow(() => encodeLine(JSON.parse(exact)));
  assert.throws(() => encodeLine(JSON.parse(fill(MAX_LINE))), /over 65536/);
});

test('a multibyte character split across reads decodes whole', () => {
  const line = JSON.stringify({ v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, appearances: [{ id: 'a', name: '满潜' }] });
  const all = bytes(`${line}\n`), cut = all.indexOf(0xe6) + 1, framer = new LineFramer();
  assert.deepEqual(framer.append(all.subarray(0, cut)), []);
  assert.deepEqual(framer.append(all.subarray(cut)), [line]);
});

test('lines that are not a v1 object with a type are dropped', () => {
  for (const line of ['', 'x', '[]', 'null', '{"type":"hello"}', '{"v":2,"type":"hello"}', '{"v":1}', '{"v":1,"type":3}']) {
    assert.equal(decodeLine(line), null, line);
  }
  assert.deepEqual(decodeLine('{"v":1,"type":"future","x":1}'), { v: 1, type: 'future', x: 1 });
});

test("the Companion's hello and fps_tier", () => {
  assert.deepEqual(companionHello(7, { version: '1' }), { v: 1, type: 'hello', role: 'companion', pid: 7, protocol: 1,
    capabilities: ['capsules_global', 'watchdog', 'actions', 'keep_clear', 'action_loop', 'layers', 'mod_settings'], build: { version: '1' } });
  const fps = { userFps: 45, batteryLow: true };
  assert.deepEqual(fpsTier({ paused: false, tier: 'working', ...fps }), { v: 1, type: 'fps_tier', tier: 'working', fps: 30, user_fps: 45, battery_low: true });
  assert.deepEqual(fpsTier({ paused: false, tier: 'interactive', ...fps }), { v: 1, type: 'fps_tier', tier: 'interactive', fps: 60, user_fps: 45, battery_low: true });
  assert.deepEqual(fpsTier({ paused: true, tier: 'interactive', ...fps }), { v: 1, type: 'fps_tier', tier: 'paused', fps: 0, user_fps: 45, battery_low: true });
});

test('fps tier: interactive while idle_low_fps is off or she is active, else working', () => {
  assert.equal(fpsTierFor({ idleLowFps: false, active: false }), 'interactive');
  assert.equal(fpsTierFor({ idleLowFps: true, active: true }), 'interactive');
  assert.equal(fpsTierFor({ idleLowFps: true, active: false }), 'working');
});

test('touch settings: a missing key keeps its default, pinch off and the rest on; anything but a boolean is false', () => {
  assert.deepEqual(touchSettings({}), { regions: true, pat: true, pinch: false, greet: true });
  assert.deepEqual(touchSettings({ touch_regions: false, head_pat: false, cheek_pinch: true, greet_on_resume: false }),
    { regions: false, pat: false, pinch: true, greet: false });
  assert.deepEqual(touchSettings({ touch_regions: 1, head_pat: null, cheek_pinch: 'true', greet_on_resume: 0 }),
    { regions: false, pat: false, pinch: false, greet: false });
});

test("an error-free list's behavior_capabilities, from the renderer fixtures", () => {
  const lines = (file: string) => readFileSync(join(EXAMPLES, file), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => decodeLine(l)!);
  const list = lines('avatar-to-companion-behavior-capabilities.ndjson').find((m) => m.type === 'actions')!;
  assert.deepEqual(behaviorCapabilities(list), { short_walk: null, 'sit@window': '当前角色未配置 window_top 坐姿与接触点' });
  for (const file of readdirSync(join(EXAMPLES, 'invalid')).filter((f) => f.startsWith('a2c-actions-capability-'))) {
    assert.equal(behaviorCapabilities(lines(`invalid/${file}`).at(-1)!), null, file);
  }
  const base: C3Message = { v: 1, type: 'actions', character: 'aster', actions: [], switches: {} };
  assert.equal(behaviorCapabilities(base), null);
  assert.equal(behaviorCapabilities({ ...base, error: 'not_ready', behavior_capabilities: {} }), null);
  assert.equal(behaviorCapabilities({ ...base, character: '', behavior_capabilities: {} }), null);
  assert.equal(behaviorCapabilities({ ...base, behavior_capabilities: null }), null);
  assert.equal(behaviorCapabilities({ ...base, behavior_capabilities: { ['x'.repeat(65)]: null } }), null);
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`b${i}`, null]));
  assert.deepEqual(behaviorCapabilities({ ...base, behavior_capabilities: sixteen }), sixteen);
  assert.equal(behaviorCapabilities({ ...base, behavior_capabilities: { ...sixteen, b16: null } }), null);
  assert.deepEqual(behaviorCapabilities({ ...base, behavior_capabilities: {} }), {});
});

const beat = (clickThrough: boolean, extra: Partial<Heartbeat> = {}): Heartbeat => ({ v: 1, type: 'heartbeat', seq: 0, click_through: clickThrough, ...extra });

test('No first heartbeat for 10 s, 0.8 s silent while taking the mouse, 10 s while clicked through', () => {
  const first = new Watchdog(0);
  assert.equal(first.check(9.9, false), null);
  assert.deepEqual(first.check(10.1, false), { kill: 'first_heartbeat_timeout' });

  const receiving = new Watchdog(0);
  receiving.heartbeat(beat(false), 1);
  assert.equal(receiving.check(1.2, false), null);
  assert.deepEqual(receiving.check(1.35, false), { log: 'stale' });
  assert.equal(receiving.check(1.5, false), null, 'logged once');
  assert.deepEqual(receiving.check(1.9, false), { kill: 'heartbeat_timeout' });
  assert.deepEqual(receiving.heartbeat(beat(false), 1.6), { log: 'resumed' });

  const through = new Watchdog(0);
  through.heartbeat(beat(true), 1);
  through.check(2, false);
  assert.equal(through.check(10.9, false), null);
  assert.deepEqual(through.check(11.1, false), { kill: 'heartbeat_timeout' });

  const hidden = new Watchdog(0);
  hidden.heartbeat(beat(false), 1);
  hidden.check(1.5, true);
  assert.equal(hidden.check(5, true), null, 'hidden counts as clicked through');
});

test('Frames that stop growing while active for 4 s kill; idle does not', () => {
  const w = new Watchdog(0);
  let killedAt: number | null = null;
  for (let t = 0.1; t < 6 && killedAt === null; t += 0.1) {
    w.heartbeat(beat(true, { frames: t < 1 ? Math.round(t * 60) : 60, render: 'active' }), t);
    const v = w.check(t, false);
    if (v !== null) {
      assert.deepEqual(v, { kill: 'render_stall' });
      killedAt = t;
    }
  }
  assert.ok(killedAt !== null && killedAt > 4.8 && killedAt < 5.2, `killed at ${killedAt}`);
  const idle = new Watchdog(0);
  for (let t = 0.1; t < 8; t += 0.1) {
    idle.heartbeat(beat(true, { frames: 5, render: 'idle' }), t);
    assert.equal(idle.check(t, false), null);
  }
});

test('A drop path is POSIX absolute or Win32 absolute (a drive, UNC or \\\\?\\), nothing else', () => {
  const drop = (path: string) => dropProblem({ v: 1, type: 'drop', x: 300, y: 350, items: [{ kind: 'file', path }] });
  for (const path of ['/Users/someone/note.txt', 'C:\\Users\\someone\\note.txt', 'd:\\a b\\猫.txt', '\\\\server\\share\\note.txt',
    '\\\\?\\C:\\very\\long\\path.txt']) assert.equal(drop(path), null, path);
  for (const path of ['note.txt', 'C:note.txt', 'C:/Users/note.txt', '\\Users\\note.txt', '', '1:\\note.txt']) assert.equal(drop(path), 'item', path);
});
