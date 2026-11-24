import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { fromInteraction, sortPending, type StackCard } from '../../src/domain';
import { statusLabel } from '../../src/features/task/labels';
import { approvalView, isApprovalCard } from '../../src/features/approval';
import { NOW, WIRE_INTERACTION_APPROVAL, WIRE_INTERACTION_APPROVAL_DANGER } from '../../src/mock/fixtures';
import { A1, A2 } from '../../src/mock/fixtures/ids';
import { stackScenario } from '../../src/mock/stack';
import { keyActionFor } from '../../src/surfaces/stack/keys';
import { orderCards, priorityOf } from '../../src/surfaces/stack/model';
import { useStackActions } from '../../src/surfaces/stack/useStackActions';

// A role approval sorts, counts and answers keys like a broker approval.

document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Broker = Extract<StackCard, { kind: 'approval' }>;
type Question = Extract<StackCard, { kind: 'question' }>;

const broker = (id: string, secondsLeft: number): Broker => {
  const c = stackScenario('default').cards.find((x): x is Broker => x.kind === 'approval' && x.id === id)!;
  return { ...c, item: { ...c.item, seconds_left: secondsLeft } };
};
const role = (w: typeof WIRE_INTERACTION_APPROVAL, extra: Partial<Question> = {}): Question => ({ id: w.request_id, kind: 'question', at: NOW, item: fromInteraction(w, NOW), ...extra });
const withLeft = (c: Question, secondsLeft: number): Question => ({ ...c, item: { ...c.item, seconds_left: secondsLeft } });

const danger = role(WIRE_INTERACTION_APPROVAL_DANGER);
const plain = role(WIRE_INTERACTION_APPROVAL);
const stale = () => Object.assign(new Error('approval_expired'), { code: 'stale' });

function hook(card: StackCard) {
  const dispatch = vi.fn();
  const toast = vi.fn();
  const { result } = renderHook(() => useStackActions(dispatch, () => NOW, true, { toast, setPause: vi.fn() }, () => card));
  return { dispatch, toast, result };
}

describe(' order and counts', () => {
  it('a dangerous role approval is P0 and sorts before a plain broker card', () => {
    const safe = broker(A2, 40);
    expect(safe.item.dangerous).toBe(false);
    expect(priorityOf(danger)).toBe(0);
    expect(priorityOf(plain)).toBe(1);
    expect(orderCards([safe, danger]).map((c) => c.id)).toEqual([danger.id, A2]);
  });

  it('a role approval with ≤ 10 s left goes first', () => {
    const top = broker(A1, 40);
    expect(top.item.dangerous).toBe(true);
    expect(orderCards([top, withLeft(plain, 8)])[0]?.id).toBe(plain.id);
  });
});

describe(' keys', () => {
  it('esc denies a role approval and ⏎ on a dangerous one only hints', async () => {
    expect(keyActionFor(danger, 'Enter')).toEqual({ type: 'danger-hint', id: danger.id });
    const decide = vi.spyOn(getBridge().stack, 'decide').mockResolvedValue(undefined);
    const { result } = hook(danger);
    expect(result.current.onKey(danger, 'Escape')).toBe(true);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide.mock.calls[0]).toEqual([danger.id, { kind: 'answer', expected_version: danger.item.revision, answers: { decision: ['拒绝'] } }]);
  });

  it('⏎ approves a plain role approval', async () => {
    const decide = vi.spyOn(getBridge().stack, 'decide').mockResolvedValue(undefined);
    const { result } = hook(plain);
    expect(result.current.onKey(plain, 'Enter')).toBe(true);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide.mock.calls[0]).toEqual([plain.id, { kind: 'answer', expected_version: plain.item.revision, answers: { decision: ['允许'] } }]);
  });
});

describe(' answering a role approval', () => {
  const allow = (c: StackCard) => {
    if (!isApprovalCard(c)) throw new Error(`${c.id} is not an approval`);
    return approvalView(c).action('allow')!;
  };

  it('a dangerous allow carries { confirmed: true } and writes outcome approved', async () => {
    const decide = vi.spyOn(getBridge().stack, 'decide').mockResolvedValue(undefined);
    const { dispatch, result } = hook(danger);
    result.current.act(allow(danger));
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.[2]).toEqual({ confirmed: true });
    expect(dispatch).toHaveBeenCalledWith({ type: 'patch', id: danger.id, patch: expect.objectContaining({ outcome: expect.objectContaining({ kind: 'approved' }) }) });
  });

  it('a plain allow needs no confirmation', async () => {
    const decide = vi.spyOn(getBridge().stack, 'decide').mockResolvedValue(undefined);
    const { dispatch, result } = hook(plain);
    result.current.act(allow(plain));
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(decide.mock.calls[0]).toHaveLength(2);
  });

  it('keeps the expired outcome native gave the card instead of 已在别处处理', async () => {
    const expired = role(WIRE_INTERACTION_APPROVAL, { receipt: '已过期', outcome: { kind: 'expired', at: NOW } });
    const decide = vi.spyOn(getBridge().stack, 'decide').mockRejectedValue(stale());
    const { dispatch, toast, result } = hook(expired);
    result.current.act(allow(plain));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('still shows 已在别处处理 on stale when native gave no outcome', async () => {
    vi.spyOn(getBridge().stack, 'decide').mockRejectedValue(stale());
    const { dispatch, result } = hook(plain);
    result.current.act(allow(plain));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'patch', id: plain.id, patch: { receipt: '已在别处处理' } }));
  });
});

describe('an exact-call approval is an approval outside the stack too', () => {
  it('sortPending puts an exact call about to expire before a dangerous broker approval', () => {
    const exact = { id: 'exact', kind: 'question' as const, interaction_kind: 'approval' as const, seconds_left: 8, since: 2 };
    const brokerDanger = { id: 'broker', kind: 'approval' as const, dangerous: true, seconds_left: 40, since: 1 };
    expect(sortPending([brokerDanger, exact]).map((x) => x.id)).toEqual(['exact', 'broker']);
  });

  it('statusLabel counts it as an approval', () => {
    const item = fromInteraction(WIRE_INTERACTION_APPROVAL, NOW);
    expect(item.kind).toBe('question');
    expect(statusLabel({ status: 'running' }, 'waiting', [item])).toBe('待批准 │ 1 张');
  });
});
