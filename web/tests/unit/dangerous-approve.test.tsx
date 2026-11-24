import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { ApprovalCard, CONFIRM_MS } from '../../src/features/approval/ApprovalCard';
import { APPROVALS, pick } from '../../src/mock/fixtures';
import { A1, A3 } from '../../src/mock/fixtures/ids';
import { stackScenario } from '../../src/mock/stack';
import type { CardAction } from '../../src/surfaces/stack/actions';
import type { StackCard } from '../../src/surfaces/stack/model';
import { DECLINED_TOAST, useStackActions } from '../../src/surfaces/stack/useStackActions';
import { stubMatchMedia } from './mediaStub';

// A dangerous approve on the desktop paper card takes two clicks within CONFIRM_MS, and only that
// second click sends `stack.decide` with `{ confirmed: true }`.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const approveButton = () => screen.getByRole('button', { name: /批准/ });

describe('ApprovalCard: 确认批准', () => {
  it('turns the first click into 确认批准 and decides on the second', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={pick(APPROVALS, A1)} surface="desk" paper={{ top: true }} onDecide={onDecide} />);
    fireEvent.click(approveButton());
    expect(onDecide).not.toHaveBeenCalled();
    expect(approveButton().textContent).toContain('确认批准');
    fireEvent.click(approveButton());
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('allow', undefined);
  });

  it('falls back to 批准 after the window, so a late click starts over', () => {
    vi.useFakeTimers();
    const onDecide = vi.fn();
    render(<ApprovalCard approval={pick(APPROVALS, A1)} surface="desk" paper={{ top: true }} onDecide={onDecide} />);
    fireEvent.click(approveButton());
    act(() => void vi.advanceTimersByTime(CONFIRM_MS + 1));
    expect(approveButton().textContent).not.toContain('确认');
    fireEvent.click(approveButton());
    expect(onDecide).not.toHaveBeenCalled();
    expect(approveButton().textContent).toContain('确认批准');
  });

  it('decides a safe approval on one click, and the main window card keeps one click unless asked', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={pick(APPROVALS, A3)} surface="desk" paper={{ top: true }} onDecide={onDecide} />);
    fireEvent.click(approveButton());
    expect(onDecide).toHaveBeenCalledTimes(1);
    cleanup();
    const main = vi.fn();
    render(<ApprovalCard approval={pick(APPROVALS, A1)} onDecide={main} />);
    fireEvent.click(approveButton());
    expect(main).toHaveBeenCalledTimes(1);
  });
});

describe('useStackActions: confirmed', () => {
  const approvals = stackScenario('default').cards.filter((c): c is Extract<StackCard, { kind: 'approval' }> => c.kind === 'approval');

  function decideWith(card: Extract<StackCard, { kind: 'approval' }>, decision: 'allow' | 'deny', confirmed?: true) {
    const decide = vi.spyOn(getBridge().stack, 'decide').mockResolvedValue(undefined);
    const { result } = renderHook(() => useStackActions(() => {}, () => 0, true, { toast: () => {}, setPause: () => {} }, () => card));
    result.current.act({ type: 'decide', id: card.id, decision, generation: card.item.generation, ...(confirmed ? { confirmed } : {}) });
    return decide;
  }

  it('passes { confirmed: true } only when the action carries it, never from the danger flag', () => {
    const danger = approvals.find((c) => c.item.dangerous);
    const safe = approvals.find((c) => !c.item.dangerous);
    if (!danger || !safe) throw new Error('the default scenario has a dangerous and a safe approval');
    expect(decideWith(danger, 'allow', true).mock.calls[0]?.[2]).toEqual({ confirmed: true });
    vi.restoreAllMocks();
    expect(decideWith(danger, 'allow').mock.calls[0]).toHaveLength(2);
    vi.restoreAllMocks();
    expect(decideWith(danger, 'deny').mock.calls[0]).toHaveLength(2);
    vi.restoreAllMocks();
    expect(decideWith(safe, 'allow').mock.calls[0]).toHaveLength(2);
  });

  it('forwards an answer\'s confirmed as given, and infers none from a dangerous role approval', () => {
    const decide = vi.spyOn(getBridge().stack, 'decide').mockResolvedValue(undefined);
    const role = { id: 'q1', kind: 'question', at: 0, item: { id: 'q1', interaction_kind: 'approval', revision: 2, dangerous: true, questions: [] } } as unknown as StackCard;
    const { result } = renderHook(() => useStackActions(() => {}, () => 0, true, { toast: () => {}, setPause: () => {} }, () => role));
    const answer: CardAction = { type: 'answer', id: 'q1', expected_version: 2, answers: { decision: ['允许'] }, text: '允许' };
    result.current.act(answer);
    result.current.act({ ...answer, confirmed: true } as CardAction);
    expect(decide.mock.calls[0]).toHaveLength(2);
    expect(decide.mock.calls[1]?.[2]).toEqual({ confirmed: true });
  });
});

describe('useStackActions: a decision that did not go out', () => {
  const card = stackScenario('default').cards.find((c): c is Extract<StackCard, { kind: 'approval' }> => c.kind === 'approval')!;
  const failure = (code: string) => Object.assign(new Error(`${code}: x`), { code });

  it.each([['declined', failure('declined')], ['busy', failure('busy')], ['offline', failure('offline')], ['a transport error', new TypeError('fetch failed')]])(
    '%s leaves the card live and raises a toast',
    async (_name, e) => {
      vi.spyOn(getBridge().stack, 'decide').mockRejectedValue(e);
      const dispatch = vi.fn();
      const toast = vi.fn();
      const { result } = renderHook(() => useStackActions(dispatch, () => 0, true, { toast, setPause: () => {} }, () => card));
      await act(async () => result.current.act({ type: 'decide', id: card.id, decision: 'allow', generation: card.item.generation }));
      expect(dispatch.mock.calls.filter(([ev]) => ev.type === 'patch' && 'outcome' in ev.patch)).toEqual([]);
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast.mock.calls[0]![0].tone).toBe('danger');
    },
  );

  it('a declined native confirm says so in words', async () => {
    vi.spyOn(getBridge().stack, 'decide').mockRejectedValue(failure('declined'));
    const toast = vi.fn();
    const { result } = renderHook(() => useStackActions(() => {}, () => 0, true, { toast, setPause: () => {} }, () => card));
    await act(async () => result.current.act({ type: 'decide', id: card.id, decision: 'allow', generation: card.item.generation }));
    expect(toast.mock.calls[0]![0].text).toBe(DECLINED_TOAST);
  });
});
