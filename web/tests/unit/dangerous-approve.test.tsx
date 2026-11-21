import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { ApprovalCard, CONFIRM_MS } from '../../src/features/approval/ApprovalCard';
import { APPROVALS, pick } from '../../src/mock/fixtures';
import { A1, A3 } from '../../src/mock/fixtures/ids';
import { stackScenario } from '../../src/mock/stack';
import type { StackCard } from '../../src/surfaces/stack/model';
import { useStackActions } from '../../src/surfaces/stack/useStackActions';
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

  function decideWith(card: Extract<StackCard, { kind: 'approval' }>, decision: 'allow' | 'deny') {
    const decide = vi.spyOn(getBridge().stack, 'decide').mockResolvedValue(undefined);
    const { result } = renderHook(() => useStackActions(() => {}, () => 0, true, { toast: () => {}, setPause: () => {} }, () => card));
    result.current.act({ type: 'decide', id: card.id, decision, generation: card.item.generation });
    return decide;
  }

  it('passes { confirmed: true } on a dangerous allow only', () => {
    const danger = approvals.find((c) => c.item.dangerous);
    const safe = approvals.find((c) => !c.item.dangerous);
    if (!danger || !safe) throw new Error('the default scenario has a dangerous and a safe approval');
    expect(decideWith(danger, 'allow').mock.calls[0]?.[2]).toEqual({ confirmed: true });
    vi.restoreAllMocks();
    expect(decideWith(danger, 'deny').mock.calls[0]).toHaveLength(2);
    vi.restoreAllMocks();
    expect(decideWith(safe, 'allow').mock.calls[0]).toHaveLength(2);
  });
});
