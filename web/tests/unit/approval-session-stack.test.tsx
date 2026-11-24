import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { fromInteraction, type StackCard } from '../../src/domain';
import { approvalView, isApprovalCard } from '../../src/features/approval';
import { NOW, WIRE_INTERACTION_APPROVAL } from '../../src/mock/fixtures';
import { useStackActions } from '../../src/surfaces/stack/useStackActions';

afterEach(() => { cleanup(); delete window.agenticComplex; });

it('sends 本对话都允许 through stack.decide under the offered option label', async () => {
  const item = fromInteraction({ ...WIRE_INTERACTION_APPROVAL, data: {
    ...WIRE_INTERACTION_APPROVAL.data!, questions: [{ id: 'decision', question: '允许？', options: [
      { label: '允许' }, { label: '本对话都允许' }, { label: '拒绝' },
    ] }],
  } }, NOW);
  // StackSource preserves options but drops approval_answers.
  const card: StackCard = { id: item.id, kind: 'question', at: NOW, item };
  if (!isApprovalCard(card)) throw new Error('not an approval');
  const view = approvalView(card);
  expect(view.allowSession).toBe(true);
  const action = view.action('allow_session');
  expect(action).not.toBeNull();
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  const native = vi.spyOn(bridge.stack, 'decide').mockResolvedValue(undefined);
  const request = vi.spyOn(bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
  window.agenticComplex = bridge;
  const dispatch = vi.fn();
  const { result } = renderHook(() => useStackActions(dispatch, () => NOW, true, { toast: vi.fn(), setPause: vi.fn() }, () => card));
  result.current.act(action!);
  await waitFor(() => expect(native).toHaveBeenCalledWith(item.id, { kind: 'answer', expected_version: item.revision, answers: { decision: ['本对话都允许'] } }));
  expect(request).not.toHaveBeenCalled();
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ outcome: expect.objectContaining({ kind: 'approved' }) }) })));
});
