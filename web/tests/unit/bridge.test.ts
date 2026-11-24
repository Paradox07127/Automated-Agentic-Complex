import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { A11yState, StreamEvent } from '../../src/bridge/protocol';
import { stubMatchMedia } from './mediaStub';

describe('motion metadata and onboarding', () => {
  it('includes motion metadata and missing-asset explanations', async () => {
    const actions = await createFakeBridge({ surface: 'main', still: true }).avatar.actions();
    expect(actions.find((a) => a.id === 'nod')).toMatchObject({ trigger: '批准之后', durationS: 1.2, isNew: false, playable: true });
    expect(actions.find((a) => a.id === 'think')).toMatchObject({ missingReason: '缺少 think_02', playable: false });
    expect(actions.find((a) => a.id === 'idle')).toMatchObject({ durationS: null, missingReason: null });
    expect(actions.filter((a) => a.section === 'move').every((a) => a.playable === false)).toBe(true);
    expect(actions.some((a) => a.isNew)).toBe(true);
    for (const a of actions) {
      expect(typeof a.trigger).toBe('string');
      expect(a.missingReason != null).toBe(a.missing === true);
      if (a.missing) expect(a.playable).toBe(false);
    }
  });

  it('gives the onboarding surface push-to-talk, system settings and the terminal', () => {
    const caps = createFakeBridge({ surface: 'onboarding', still: true }).capabilities;
    expect(caps).toMatchObject({ pushToTalk: true, systemSettings: true, avatar: false, runInTerminal: true });
  });

  it('runs 角色 → 对话 → 声音 → 完成 with per-step results, jumps, and completes only at the end like the native host', async () => {
    const onboarding = createFakeBridge({ surface: 'onboarding', still: true }).onboarding;
    await expect(onboarding.back()).rejects.toMatchObject({ code: 'invalid_state' });
    const initial = await onboarding.state();
    expect(initial.steps.map((s) => s.title)).toEqual(['角色', '对话', '声音', '完成']);
    expect(initial).toMatchObject({ step: 1, done: false, canAdvance: true });
    await expect(onboarding.complete()).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await onboarding.advance()).toMatchObject({ step: 2 });
    expect(await onboarding.back()).toMatchObject({ step: 1 });
    await onboarding.advance();
    const skipped = await onboarding.advance({ skip: true });
    expect(skipped.steps.map((s) => s.result)).toEqual(['done', 'skipped', 'todo', 'todo']);
    expect(await onboarding.goto(1)).toMatchObject({ step: 1 });
    expect(await onboarding.goto(4)).toMatchObject({ step: 4, canAdvance: false });
    await expect(onboarding.advance()).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(onboarding.goto(5 as never)).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(onboarding.complete({ destination: 'plugins' } as never)).rejects.toMatchObject({ code: 'invalid_args' });
    expect(await onboarding.complete({ destination: 'talk' })).toMatchObject({ done: true });
    await expect(onboarding.skip()).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('跳过引导 ends the guide from any step', async () => {
    const onboarding = createFakeBridge({ surface: 'onboarding', still: true }).onboarding;
    await onboarding.advance();
    expect(await onboarding.skip()).toMatchObject({ done: true, step: 2 });
  });

  it('denies onboarding operations on main and stack', async () => {
    for (const surface of ['main', 'stack'] as const) {
      const onboarding = createFakeBridge({ surface, still: true }).onboarding;
      expect(onboarding).toBeDefined();
      await expect(onboarding.state()).rejects.toMatchObject({ code: 'not_implemented' });
    }
  });
});

describe('fake bridge agentd.request', () => {
  const bridge = createFakeBridge({ surface: 'main', still: true });

  it('serves the example endpoints', async () => {
    for (const path of ['/health', '/agent/runs', '/approvals', '/memory']) {
      const res = await bridge.agentd.request('GET', path);
      expect(res.status, path).toBe(200);
      expect(res.body, path).not.toBeNull();
    }
  });

  it('passes query and path params to handlers', async () => {
    expect((await bridge.agentd.request('GET', '/agent/tasks')).status).toBe(200);
    expect((await bridge.agentd.request('GET', '/agent/tasks?fail=1')).status).toBe(404);
    expect((await bridge.agentd.request('GET', '/memory/days/x')).status).toBe(400);
    expect((await bridge.agentd.request('GET', '/memory/days/1999-01-01')).status).toBe(404);
  });

  it('answers 404 with an error for unknown paths and methods', async () => {
    const res = await bridge.agentd.request('GET', '/nope');
    expect(res).toEqual({ status: 404, body: { error: 'not_found' }, error: { code: 'not_found' } });
    expect((await bridge.agentd.request('DELETE', '/health')).status).toBe(404);
  });

  it('lets later mock routes override the examples', async () => {
    const b = createFakeBridge({
      surface: 'main',
      still: true,
      routes: [{ method: 'GET', path: '/health', handler: () => ({ status: 503, body: null, error: { code: 'down' } }) }],
    });
    expect(await b.agentd.request('GET', '/health')).toEqual({ status: 503, body: null, error: { code: 'down' } });
  });

  it('reports surface and capability bits', () => {
    expect(bridge.surface).toBe('main');
    expect(createFakeBridge({ surface: 'stack', capabilities: { screenCapture: false } }).capabilities.screenCapture).toBe(false);
  });
});

describe('fake bridge feed', () => {
  afterEach(() => vi.useRealTimers());

  it('pushes scripted events over time', () => {
    vi.useFakeTimers();
    const events: StreamEvent[] = [];
    const stop = createFakeBridge({ surface: 'main', still: false }).feed.subscribe((e) => events.push(e), () => {});
    vi.advanceTimersByTime(10_000);
    stop();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.id).toBe('1');
  });

  it('pushes nothing when still', () => {
    vi.useFakeTimers();
    const events: StreamEvent[] = [];
    createFakeBridge({ surface: 'main', still: true }).feed.subscribe((e) => events.push(e), () => {});
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
  });
});

describe('fake bridge glass', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports no native glass in a browser', () => {
    stubMatchMedia();
    const pushes: A11yState[] = [];
    createFakeBridge({ surface: 'stack' }).window.onA11y((a) => pushes.push(a))();
    expect(pushes).toEqual([{ reduceMotion: false, reduceTransparency: false, increaseContrast: false, glass: false }]);
  });

  it('passes the glass rects of a region report on to the fake-op event', () => {
    const details: unknown[] = [];
    const watch = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener('endfield-fake-op', watch);
    const b = createFakeBridge({ surface: 'stack' });
    const region = { x: 0, y: 0, width: 420, height: 300 };
    b.window.setInteractiveRegions([region], [{ x: 0, y: 0, w: 420, h: 300 }]);
    b.window.setInteractiveRegions([region]);
    window.removeEventListener('endfield-fake-op', watch);
    expect(details).toEqual([
      { op: 'window.setInteractiveRegions', arg: [region], glass: [{ x: 0, y: 0, w: 420, h: 300 }] },
      { op: 'window.setInteractiveRegions', arg: [region] },
    ]);
  });
});
