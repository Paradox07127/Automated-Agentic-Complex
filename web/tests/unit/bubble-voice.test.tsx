import { act as flush, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, DesktopState, RuntimeSnapshot, StreamEvent } from '../../src/bridge';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { lingerMs } from '../../src/surfaces/desktop/comm/commReducer';
import { stubMatchMedia } from './mediaStub';

// Her voiced line in the bubble: 语音准备中 until her voice starts, and the line stays until a second after it ended.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

const PREPARING = '语音准备中';
const TEXT = '构建失败在第 42 行，补上分号再跑一次。';

/** BubbleRoot on the fake bridge with `/feed` lines, desktop.onState's `playback` and app.runtime's voice state pushed by the test. */
async function mountBubble(tts: RuntimeSnapshot['tts']['state'] = 'cold') {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  window.location.hash = '#/bubble';
  const feed = new Set<(e: StreamEvent) => void>();
  let state: ((s: DesktopState) => void) | null = null;
  let shown: DesktopState | null = null;
  const base = await new Promise<DesktopState>((resolve) => bridge.desktop.onState(resolve));
  vi.spyOn(bridge.desktop, 'onPresence').mockImplementation(() => () => {});
  vi.spyOn(bridge.stack, 'onCards').mockImplementation(() => () => {});
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation((cb) => {
    feed.add(cb);
    return () => feed.delete(cb);
  });
  vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => {
    state = cb;
    return () => {};
  });
  const snapshot = await bridge.app.runtime();
  vi.spyOn(bridge.app, 'runtime').mockResolvedValue({ ...snapshot, tts: { ...snapshot.tts, state: tts } });
  render(<BubbleRoot />);
  await flush(async () => {});
  const push = (playback: DesktopState['playback']) =>
    flush(async () => {
      shown = { ...(shown ?? base), playback };
      state?.(shown);
    });
  await push({});
  return {
    playback: push,
    line: (id: string, text: string, extra: Record<string, unknown> = {}) =>
      flush(async () => {
        const data = JSON.stringify({ line_id: id, text_delta: text, final: false, cancelled: false, error: null, lane: 'character', reason: null, ...extra });
        feed.forEach((cb) => cb({ event: 'line', id, data }));
      }),
  };
}

const said = (text: string) => screen.queryByText(text, { ignore: '[inert] *, script, style' });
const wait = (ms: number) => flush(async () => vi.advanceTimersByTime(ms));

describe('her voiced line', () => {
  it('says 语音准备中 under her text until her voice starts', async () => {
    const b = await mountBubble();
    await b.line('l1', '你好，', { speak: true });
    screen.getByText('你好，');
    screen.getByText(PREPARING);
    await b.line('l1', '我在。', { speak: true, utterance_id: 'u1' });
    screen.getByText(PREPARING);
    await b.playback({ u1: 'playing' });
    expect(said(PREPARING)).toBeNull();
  });

  it('says nothing of a voice for a line agentd does not voice, or while the voice is off or unreachable', async () => {
    const b = await mountBubble();
    await b.line('l1', '只是文字。');
    expect(said(PREPARING)).toBeNull();
    cleanup();
    for (const tts of ['off', 'unreachable'] as const) {
      const c = await mountBubble(tts);
      await c.line('l2', '没有声音。', { speak: true, utterance_id: 'u2' });
      screen.getByText('没有声音。');
      expect(said(PREPARING)).toBeNull();
      cleanup();
    }
  });

  it('stays until a second after her voice ended when that is past its words\' time', async () => {
    vi.useFakeTimers();
    const b = await mountBubble();
    await b.line('l1', TEXT, { speak: true, utterance_id: 'u1' });
    await b.playback({ u1: 'playing' });
    await b.line('l1', '', { speak: true, utterance_id: 'u1', final: true });
    await wait(lingerMs(TEXT) + 5000);
    expect(said(TEXT)).not.toBeNull();
    await b.playback({ u1: 'ended' });
    await wait(900);
    expect(said(TEXT)).not.toBeNull();
    await wait(200);
    expect(said(TEXT)).toBeNull();
  });

  it('goes after its words\' time when her voice ended before it, and as soon as that is past when it was cut', async () => {
    vi.useFakeTimers();
    const b = await mountBubble();
    await b.line('l1', TEXT, { speak: true, utterance_id: 'u1' });
    await b.playback({ u1: 'playing' });
    await b.line('l1', '', { speak: true, utterance_id: 'u1', final: true });
    await b.playback({ u1: 'ended' });
    await wait(lingerMs(TEXT) - 300);
    expect(said(TEXT)).not.toBeNull();
    await wait(400);
    expect(said(TEXT)).toBeNull();

    await b.line('l2', TEXT, { speak: true, utterance_id: 'u2' });
    await b.playback({ u1: 'ended', u2: 'playing' });
    await b.line('l2', '', { speak: true, utterance_id: 'u2', final: true });
    await wait(lingerMs(TEXT) + 2000);
    expect(said(TEXT)).not.toBeNull();
    await b.playback({ u1: 'ended', u2: 'stopped' });
    expect(said(TEXT)).toBeNull();
  });

  it('goes by its words alone 60 s after its voice started without an ended', async () => {
    vi.useFakeTimers();
    const b = await mountBubble();
    await b.line('l1', TEXT, { speak: true, utterance_id: 'u1' });
    await b.line('l1', '', { speak: true, utterance_id: 'u1', final: true });
    await b.playback({ u1: 'playing' });
    await wait(59_000);
    expect(said(TEXT)).not.toBeNull();
    await wait(1200);
    expect(said(TEXT)).toBeNull();
  });

  it('goes by its words alone while the voice is unreachable', async () => {
    vi.useFakeTimers();
    const b = await mountBubble('unreachable');
    await b.line('l1', TEXT, { speak: true, utterance_id: 'u1' });
    await b.line('l1', '', { speak: true, utterance_id: 'u1', final: true });
    await wait(lingerMs(TEXT) + 100);
    expect(said(TEXT)).toBeNull();
  });
});
