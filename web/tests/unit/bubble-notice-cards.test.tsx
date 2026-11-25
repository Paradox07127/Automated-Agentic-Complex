import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, StackPayload } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { bubbleCards } from '../../src/surfaces/desktop/bubble/demo';
import { stubMatchMedia } from './mediaStub';

// The push-to-talk hint, the avatar loading card and the 屏幕识读 receipt native pushes on its stack, drawn in the bubble beside her head.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

const NOW = 1_800_000_000_000;
type Card = StackPayload['cards'][number];

function mountBubble() {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  window.location.hash = '#/bubble';
  let cards: ((p: StackPayload) => void) | null = null;
  vi.spyOn(bridge.stack, 'onCards').mockImplementation((cb) => {
    cards = cb;
    return () => {};
  });
  render(<BubbleRoot />);
  return {
    bridge,
    cards: (list: Card[]) => flush(async () => cards?.({ now: NOW, cards: list, history: [] })),
  };
}

const voice = (extra: Partial<Extract<Card, { variant: 'voice' }>> = {}): Card => ({
  id: 'voice-hint',
  kind: 'notice',
  variant: 'voice',
  at: NOW,
  phase: 'listening',
  title: '正在录音',
  ...extra,
});
const DENIED = voice({ phase: 'mic_denied', title: '麦克风被拒', text: 'Agentic Complex 没有麦克风权限，按住说话用不了' });
const FAILED: Card = { id: 'avatar-loading', kind: 'notice', variant: 'loading', at: NOW, phase: 'failed', title: '角色进程没能启动' };
const REMINDER: Card = { id: 'rem-c1', kind: 'notice', variant: 'reminder', at: NOW - 60_000, title: 'c1 组会', commitment_id: 'c1' };

const bubbleCard = () => document.querySelector<HTMLElement>('[data-bubble]');

describe('the bubble draws native voice and loading cards', () => {
  it('shows the push-to-talk card while she listens', async () => {
    const b = mountBubble();
    expect(bubbleCard()).toBeNull();
    await b.cards([voice({ elapsed_s: 3 })]);
    const card = screen.getByRole('status', { name: '语音：正在录音' });
    within(card).getByText('正在录音…');
    within(card).getByText('00:03');
    expect(bubbleCard()?.hasAttribute('data-region')).toBe(true);
  });

  it('shows a denied microphone with the way to settings, and both buttons act', async () => {
    const b = mountBubble();
    const open = vi.spyOn(b.bridge.window, 'openMain').mockImplementation(() => {});
    const collapse = vi.spyOn(b.bridge.stack, 'collapse').mockResolvedValue(undefined);
    await b.cards([DENIED]);
    const card = screen.getByRole('status', { name: '语音：麦克风被拒' });
    within(card).getByText('Agentic Complex 没有麦克风权限，按住说话用不了');
    fireEvent.click(within(card).getByRole('button', { name: '前往系统权限' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toContain('settings');
    fireEvent.click(within(card).getByRole('button', { name: '关闭' }));
    expect(collapse).toHaveBeenCalledWith('voice-hint');
  });

  it('shows a failed avatar with 重新启动', async () => {
    const b = mountBubble();
    const restart = vi.spyOn(b.bridge.supervisor, 'restart');
    await b.cards([FAILED]);
    const card = screen.getByRole('status', { name: '角色：角色进程没能启动' });
    within(card).getByText('角色加载失败');
    await flush(async () => fireEvent.click(within(card).getByRole('button', { name: '重新启动' })));
    expect(restart).toHaveBeenCalledWith('avatar');
  });

  it('a due reminder takes the place before the voice card', async () => {
    const b = mountBubble();
    await b.cards([voice(), REMINDER]);
    screen.getByText('c1 组会');
    expect(screen.queryByRole('status', { name: '语音：正在录音' })).toBeNull();
  });

  it('the voice card takes the place before the loading card', async () => {
    const b = mountBubble();
    await b.cards([FAILED, voice()]);
    screen.getByRole('status', { name: '语音：正在录音' });
    expect(screen.queryByRole('status', { name: '角色：角色进程没能启动' })).toBeNull();
  });

  it('does not draw a collapsed voice card', async () => {
    const b = mountBubble();
    await b.cards([voice({ collapsed: true })]);
    expect(screen.queryByRole('status', { name: '语音：正在录音' })).toBeNull();
    expect(bubbleCard()).toBeNull();
  });
});

const LOOK_TITLE = '已识读：Xcode — AppDelegate.swift';
const look = (extra: { collapsed?: boolean } = {}): Card => ({
  id: 'look-1',
  kind: 'notice',
  variant: 'look',
  at: NOW,
  title: LOOK_TITLE,
  ...extra,
});

describe('the bubble draws the 屏幕识读 receipt', () => {
  it('shows which window she read', async () => {
    const b = mountBubble();
    await b.cards([look()]);
    const card = screen.getByRole('status', { name: LOOK_TITLE });
    within(card).getByText(LOOK_TITLE);
    expect(within(card).queryByRole('button')).toBeNull();
    expect(bubbleCard()?.hasAttribute('data-region')).toBe(true);
  });

  it('the voice card takes the place before the receipt', async () => {
    const b = mountBubble();
    await b.cards([look(), voice()]);
    screen.getByRole('status', { name: '语音：正在录音' });
    expect(screen.queryByText(LOOK_TITLE)).toBeNull();
  });

  it('a due reminder takes the place before the receipt', async () => {
    const b = mountBubble();
    await b.cards([look(), REMINDER]);
    screen.getByText('c1 组会');
    expect(screen.queryByText(LOOK_TITLE)).toBeNull();
  });

  it('does not draw a collapsed receipt', async () => {
    const b = mountBubble();
    await b.cards([look({ collapsed: true })]);
    expect(screen.queryByText(LOOK_TITLE)).toBeNull();
    expect(bubbleCard()).toBeNull();
  });
});

describe('bubbleCards gives the browser preview one card per demo', () => {
  it.each([
    ['voice', 'voice'],
    ['mic', 'voice'],
    ['loading', 'loading'],
    ['look', 'look'],
  ] as const)('demo=%s gives one %s card', (demo, variant) => {
    const cards = bubbleCards(demo)?.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'notice', variant });
  });

  it('demo=mic is the denied microphone and demo=look the read window', () => {
    expect(bubbleCards('mic')?.cards[0]).toMatchObject({ phase: 'mic_denied', title: '麦克风被拒' });
    expect(bubbleCards('look')?.cards[0]).toMatchObject({ title: LOOK_TITLE });
  });

  it('no demo gives no cards', () => {
    expect(bubbleCards(null)?.cards).toEqual([]);
  });
});
