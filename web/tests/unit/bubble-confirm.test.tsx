import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, StackPayload } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { bubbleCards } from '../../src/surfaces/desktop/bubble/demo';
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
