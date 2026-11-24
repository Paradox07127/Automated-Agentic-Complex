import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, StackPayload } from '../../src/bridge/protocol';
import { CONFIRM_MS } from '../../src/features/approval/ApprovalCard';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { bubbleCards } from '../../src/surfaces/desktop/bubble/demo';
import { DECLINED_TOAST } from '../../src/surfaces/stack/useStackActions';
import { stubMatchMedia } from './mediaStub';

// 要你批准 on the white paper card beside her head: 详情 lands on its row on 每日简报, and a dangerous one wears the red tape.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

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
  return { bridge, cards: (list: Card[]) => flush(async () => cards?.({ now: Date.now(), cards: list, history: [] })) };
}

/** The bubble's own demo approvals, read before the bridge is installed. */
const demoCard = (demo: string): Card => bubbleCards(demo)!.cards[0]!;

describe('the bubble approval card', () => {
  it('详情 opens 每日简报 on the approval itself, so the page stays there instead of forwarding to 任务', async () => {
    const approval = demoCard('confirm');
    const b = mountBubble();
    const open = vi.spyOn(b.bridge.window, 'openMain').mockImplementation(() => {});
    await b.cards([approval]);
    const card = screen.getByRole('alertdialog', { name: /^要你批准：/ });
    fireEvent.click(within(card).getByRole('button', { name: '详情' }));
    expect(open).toHaveBeenCalledTimes(1);
    const route = open.mock.calls[0]![0];
    expect(route.startsWith('/overview?')).toBe(true);
    const q = new URLSearchParams(route.slice(route.indexOf('?') + 1));
    expect(q.get('focus')).toBe(`item-${approval.id}`);
    expect(q.get('sel')).toBe(approval.id);
  });

  it('a dangerous approval wears the red tape; a plain one does not', async () => {
    const danger = demoCard('confirm-danger');
    const plain = demoCard('confirm');
    const b = mountBubble();
    await b.cards([danger]);
    expect(screen.getByRole('alertdialog', { name: /^要你批准：/ }).hasAttribute('data-danger')).toBe(true);
    await b.cards([plain]);
    expect(screen.getByRole('alertdialog', { name: /^要你批准：/ }).hasAttribute('data-danger')).toBe(false);
  });
});

describe('the bubble approval card: a dangerous 批准', () => {
  const allowButton = () => within(screen.getByRole('alertdialog', { name: /^要你批准：/ })).getByRole('button', { name: /批准$/ });

  it('takes two clicks: the first turns it into 确认批准, only the second decides with { confirmed: true }', async () => {
    const danger = demoCard('confirm-danger');
    const b = mountBubble();
    const decide = vi.spyOn(b.bridge.stack, 'decide').mockResolvedValue(undefined);
    await b.cards([danger]);
    fireEvent.click(allowButton());
    expect(decide).not.toHaveBeenCalled();
    expect(allowButton().textContent).toContain('确认批准');
    fireEvent.click(allowButton());
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![2]).toEqual({ confirmed: true });
  });

  it('a declined native confirm shows on the card, which keeps its buttons', async () => {
    const plain = demoCard('confirm');
    const b = mountBubble();
    vi.spyOn(b.bridge.stack, 'decide').mockRejectedValue(Object.assign(new Error('declined: native confirmation'), { code: 'declined' }));
    await b.cards([plain]);
    await flush(async () => fireEvent.click(allowButton()));
    const card = screen.getByRole('alertdialog', { name: /^要你批准：/ });
    expect(within(card).getByRole('alert').textContent).toBe(DECLINED_TOAST);
    expect(within(card).getByRole('button', { name: '拒绝' })).toBeTruthy();
    expect(allowButton()).toBeTruthy();
  });

  it('starts over after CONFIRM_MS, and a plain one decides on one click without confirmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const danger = demoCard('confirm-danger');
      const plain = { ...demoCard('confirm'), id: 'bubble-a2' } as Card;
      const b = mountBubble();
      const decide = vi.spyOn(b.bridge.stack, 'decide').mockResolvedValue(undefined);
      await b.cards([danger]);
      fireEvent.click(allowButton());
      flush(() => void vi.advanceTimersByTime(CONFIRM_MS + 1));
      expect(allowButton().textContent).not.toContain('确认');
      fireEvent.click(allowButton());
      expect(decide).not.toHaveBeenCalled();
      await b.cards([plain]);
      fireEvent.click(allowButton());
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide.mock.calls[0]).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
