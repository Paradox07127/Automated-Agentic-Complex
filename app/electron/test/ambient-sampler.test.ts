// The ambient sampler as index.ts starts it (src/main/ambient/shell.ts), on a fake platform
// helper, a fake renderer link and a fake clock. Nothing here captures the real screen.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ambientWire, reduceAmbient } from '../src/common/ambient.ts';
import type { AttentionSample, Rect } from '../src/common/attention.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { ambientOffers, shellAmbient, type ShellAmbientOptions } from '../src/main/ambient/shell.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((res) => setImmediate(res)); };

/** A 16×16 RGBA8 image of one grey. */
function pixels(v: number): Uint8Array {
  return new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : v));
}
const colorsOf = (v: number) => ambientWire(reduceAmbient(pixels(v), 16, 16));

/** agentd's state dir with a deny-mode blacklist.json of no rules: every window but ours is read. */
const OPEN_STATE = mkdtempSync(join(tmpdir(), 'ambient-open-'));
writeFileSync(join(OPEN_STATE, 'blacklist.json'), JSON.stringify({ mode: 'deny' }));
after(() => rmSync(OPEN_STATE, { recursive: true, force: true }));

function sample(over: Partial<AttentionSample> = {}): AttentionSample {
  return {
    ts: 0, front: { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: null, urlHost: null }, frontIncognito: false,
    mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false, fullscreen: false, cameraActive: false,
    micActive: false, userSpeaking: null, focusWindow: null, input: null, frontAudioOut: null, frontVideo: null, frontGpu: null,
    screenCaptured: false, edge: null, frontBounds: null, ...over,
  };
}

interface Setup {
  argv?: string[]; platform?: 'mac' | 'windows'; mode?: string; capabilities?: string[]; stateDir?: string;
}

function setup(o: Setup = {}) {
  let clock = 0;
  const timers = new Set<{ ms: number; fn: () => void; at: number }>();
  const requests: [string, Record<string, unknown>][] = [];
  const sent: { source: string; colors: unknown }[] = [];
  const env = {
    mode: o.mode ?? 'screen' as string | undefined,
    capabilities: o.capabilities ?? ['ambient'],
    last: sample() as AttentionSample | null,
    visual: r(100, 200, 300, 400) as Rect | null,
    figure: r(100, 200, 300, 400) as Rect | null,
    screen: 128, wallpaper: 64,
    denied: false, accept: true,
    hold: null as Promise<HelperAnswer> | null,
  };
  const options: ShellAmbientOptions = {
    argv: o.argv ?? [], platform: o.platform ?? 'mac',
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        if (op === 'screens.list') {
          return ok({ screens: [{ display_id: 1, frame: r(0, 0, 1440, 900), visible: r(0, 25, 1440, 875), scale: 2, primary: true },
            { display_id: 2, frame: r(1440, 0, 1920, 1080), visible: r(1440, 0, 1920, 1080), scale: 1, primary: false }] });
        }
        if (op !== 'capture.ambient') return { ok: false, error: { code: 'unsupported' } } as HelperAnswer;
        if (env.hold) return env.hold;
        if (params.source === 'screen' && env.denied) return { ok: false, error: { code: 'permission_denied' } } as HelperAnswer;
        const v = params.source === 'screen' ? env.screen : env.wallpaper;
        return ok({ width: 16, height: 16, rgba: Buffer.from(pixels(v)).toString('base64') });
      },
    },
    link: {
      get capabilities() { return env.capabilities; },
      sendAmbientSample: (source, colors) => {
        if (!env.accept) return false;
        sent.push({ source, colors });
        return true;
      },
    },
    agentdStateDir: o.stateDir ?? OPEN_STATE,
    settings: () => (env.mode === undefined ? {} : { render_ambient: env.mode }),
    attention: () => ({ lastSample: env.last }),
    ownPids: () => [77],
    excludePids: () => [77, 4100],
    visual: () => env.visual,
    figure: () => env.figure,
    log: () => {},
    clock: {
      now: () => clock,
      every: (ms, fn) => { const t = { ms, fn, at: clock }; timers.add(t); return () => { timers.delete(t); }; },
    },
  };
  const ambient = shellAmbient(options);
  /** Runs each timer as many times as `ms` lets it. */
  const step = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers].filter((t) => t.at + t.ms <= end).sort((a, b) => a.at + a.ms - (b.at + b.ms))[0];
      if (!due) break;
      clock = due.at + due.ms;
      due.at = clock;
      due.fn();
      await settle();
    }
    clock = end;
    await settle();
  };
  const captures = () => requests.filter(([op]) => op === 'capture.ambient').map(([, p]) => p);
  return { ambient, env, sent, requests, captures, step, timers, now: () => clock };
}

test('render_ambient off, or an avatar that does not list ambient, asks the helper for nothing', async () => {
  for (const [mode, capabilities] of [[undefined, ['ambient']], ['off', ['ambient']], ['screen', []]] as [string | undefined, string[]][]) {
    const t = setup({ capabilities });
    t.env.mode = mode;
    t.ambient!.start();
    await t.step(3000);
    assert.deepEqual(t.requests, [], String(mode));
    assert.deepEqual(t.sent, []);
  }
});

test('screen: each second the screen under her visual rect without our windows, sent only when it changed', async () => {
  const t = setup();
  t.ambient!.start();
  await t.step(1000);
  // C3's AppKit rect in the helper's top-left points of a 900 pt high main display.
  assert.deepEqual(t.captures(), [{ source: 'screen', side: 16, rect: r(100, 300, 300, 400), exclude_pids: [77, 4100] }]);
  assert.deepEqual(t.sent, [{ source: 'screen', colors: colorsOf(128) }]);
  await t.step(1000);
  assert.equal(t.captures().length, 2);
  assert.equal(t.sent.length, 1, 'the same colours are not sent again');
  t.env.screen = 140;
  await t.step(1000);
  assert.deepEqual(t.sent.at(-1), { source: 'screen', colors: colorsOf(140) });
});

test('Windows: the visual rect goes to the helper as it is (C12 「坐标」, the C3 Windows appendix)', async () => {
  const t = setup({ platform: 'windows' });
  t.ambient!.start();
  await t.step(1000);
  assert.deepEqual(t.captures()[0]?.rect, r(100, 200, 300, 400));
});

test('the screen stays closed without a front window, for a blocked one or without her visual rect: the wallpaper of the display under her, at most every 30 s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ambient-'));
  writeFileSync(join(dir, 'blacklist.json'), JSON.stringify({ mode: 'deny', bundle_ids: ['com.secret.app'] }));
  const blocked: [string, (t: ReturnType<typeof setup>) => void][] = [
    ['no attention sample', (t) => { t.env.last = null; }],
    ['no front window', (t) => { t.env.last = sample({ front: null }); }],
    ['blacklisted', (t) => { t.env.last = sample({ front: { app: 'S', bundleId: 'com.secret.app', pid: 9, windowId: 1, title: null, urlHost: null } }); }],
    ['browser_unknown', (t) => { t.env.last = sample({ frontIncognito: null }); }],
    ['secure_input', (t) => { t.env.last = sample({ secureInput: true }); }],
    ['no visual rect', (t) => { t.env.visual = null; }],
  ];
  for (const [name, block] of blocked) {
    const t = setup({ stateDir: dir });
    block(t);
    t.ambient!.start();
    await t.step(1000);
    assert.deepEqual(t.captures(), [{ source: 'wallpaper', side: 16, display_id: 1 }], name);
    assert.deepEqual(t.sent, [{ source: 'wallpaper', colors: colorsOf(64) }], name);
    await t.step(29_000);
    assert.equal(t.captures().length, 1, `${name}: not again within 30 s`);
    await t.step(1000);
    assert.equal(t.captures().length, 2, `${name}: again after 30 s`);
    assert.equal(t.sent.length, 1, `${name}: the same wallpaper colours are not sent again`);
  }
});

test('the wallpaper is the one of the display her figure is on, else the main one', async () => {
  const t = setup({ mode: 'wallpaper' });
  // C3 y -100, 300 high on a 900 pt main display: helper y 700, on the second display at x 1440.
  t.env.figure = r(1600, -100, 200, 300);
  t.ambient!.start();
  await t.step(1000);
  assert.deepEqual(t.captures(), [{ source: 'wallpaper', side: 16, display_id: 2 }]);
  const none = setup({ mode: 'wallpaper' });
  none.env.figure = null;
  none.ambient!.start();
  await none.step(1000);
  assert.deepEqual(none.captures(), [{ source: 'wallpaper', side: 16, display_id: 1 }]);
});

test('without screen recording permission the wallpaper is sampled in the same second', async () => {
  const t = setup();
  t.env.denied = true;
  t.ambient!.start();
  await t.step(1000);
  assert.deepEqual(t.captures().map((p) => p.source), ['screen', 'wallpaper']);
  assert.deepEqual(t.sent, [{ source: 'wallpaper', colors: colorsOf(64) }]);
  await t.step(1000);
  assert.deepEqual(t.captures().map((p) => p.source), ['screen', 'wallpaper', 'screen'], 'the wallpaper waits its 30 s');
});

test('a screen sample lets the wallpaper be sampled at once on a fall back, and a change of source is sent with the same colours', async () => {
  const t = setup();
  t.env.screen = 64;
  t.ambient!.start();
  await t.step(1000);
  t.env.last = sample({ secureInput: true });
  await t.step(1000);
  assert.deepEqual(t.sent.map((s) => s.source), ['screen', 'wallpaper']);
  assert.deepEqual(t.sent[0]!.colors, t.sent[1]!.colors);
});

test('a sample the link does not take is not remembered: the next one goes out', async () => {
  const t = setup();
  t.env.accept = false;
  t.ambient!.start();
  await t.step(1000);
  t.env.accept = true;
  await t.step(1000);
  assert.deepEqual(t.sent, [{ source: 'screen', colors: colorsOf(128) }]);
});

test('a desktop space change samples the wallpaper again at once', async () => {
  const t = setup({ mode: 'wallpaper' });
  t.ambient!.start();
  await t.step(1000);
  t.ambient!.event('workspace.changed', { reason: 'front_app', front_pid: 1 });
  await settle();
  assert.equal(t.captures().length, 1);
  t.ambient!.event('workspace.changed', { reason: 'space', front_pid: 1 });
  await settle();
  assert.equal(t.captures().length, 2);
});

test('one sample at a time: a second waits until the helper answers', async () => {
  const t = setup();
  let answer!: (a: HelperAnswer) => void;
  t.env.hold = new Promise((res) => { answer = res; });
  t.ambient!.start();
  await t.step(3000);
  assert.equal(t.captures().length, 1);
  t.env.hold = null;
  answer(ok({ width: 16, height: 16, rgba: Buffer.from(pixels(128)).toString('base64') }));
  await settle();
  await t.step(1000);
  assert.equal(t.captures().length, 2);
});

test('our own screen capture counts as ours until 3 s after it ends; the wallpaper does not', async () => {
  const t = setup({ mode: 'wallpaper' });
  t.ambient!.start();
  await t.step(1000);
  assert.equal(t.ambient!.ownCaptureRecent, false);
  t.env.mode = 'screen';
  await t.step(1000);
  assert.equal(t.ambient!.ownCaptureRecent, true);
  t.env.mode = 'off';
  await t.step(2900);
  assert.equal(t.ambient!.ownCaptureRecent, true);
  await t.step(200);
  assert.equal(t.ambient!.ownCaptureRecent, false);
});

test('stop forgets the last sample, so the next start sends at once; nothing runs after stop', async () => {
  const t = setup();
  t.ambient!.start();
  await t.step(1000);
  t.ambient!.stop();
  assert.equal(t.timers.size, 0);
  t.ambient!.start();
  await t.step(1000);
  assert.equal(t.sent.length, 2);
});

test('--no-attention starts no sampler, and the hello lists ambient only when one runs', () => {
  assert.equal(setup({ argv: ['--no-attention'] }).ambient, null);
  assert.deepEqual(ambientOffers(['--no-attention']), []);
  assert.deepEqual(ambientOffers([]), ['ambient']);
});
