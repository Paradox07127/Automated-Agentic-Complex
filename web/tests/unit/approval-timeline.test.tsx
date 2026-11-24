// 审批卡「时间线 ↗」：卡记到回合时跳诊断「对话轮次」里那一轮；没记到时禁用并说明原因。
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalStackItem } from '../../src/features/approval';
import { NOW } from '../../src/mock/fixtures';
import { APPROVALS } from '../../src/mock/fixtures/approvals';
import { A1, A2 } from '../../src/mock/fixtures/ids';
import { stackScenario } from '../../src/mock/stack';
import { PendingSection } from '../../src/pages/overview/PendingSection';
import { ApprovalStackCard } from '../../src/surfaces/stack/cards/ApprovalStackCard';
import { stubMatchMedia } from './mediaStub';

stubMatchMedia();
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const noop = async () => {};
const READY = { status: 'success', data: true } as const;
const pick = (id: string) => APPROVALS.find((a) => a.id === id)!;

function brief(id: string, go = vi.fn()) {
  render(<PendingSection q={READY} items={[pick(id)]} now={NOW} at={NOW} sessions={[]} receipt={null} go={go} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
  fireEvent.click(screen.getByRole('button', { name: /^详情/ }));
  return { go, link: screen.getByRole('button', { name: '时间线 ↗' }) };
}

function stack(id: string, act = vi.fn()) {
  const card = stackScenario('default').cards.find((c) => c.id === id) as ApprovalStackItem;
  const { container } = render(<ApprovalStackCard card={card} index={1} total={1} top act={act} />);
  fireEvent.click(within(container).getByRole('button', { name: /详情/ }));
  return { act, link: within(container).getByRole('button', { name: '时间线 ↗' }) };
}

describe('审批卡「时间线 ↗」', () => {
  it('the fixture card A2 was opened in turn tr7 and A1 outside a turn', () => {
    expect(pick(A2).trace_id).toBe('tr7');
    expect(pick(A1).trace_id).toBeUndefined();
  });

  it('on the brief, opens that turn in 诊断 › 对话轮次', () => {
    const { go, link } = brief(A2);
    expect(link.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(link);
    expect(go).toHaveBeenCalledWith({ page: 'diag', tab: 'turns', turn: 'tr7' });
  });

  it('on the brief, stays disabled with its reason when the card has no turn', () => {
    const { go, link } = brief(A1);
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.getAttribute('title')).toBe('这次审批没有记到对话轮次');
    fireEvent.click(link);
    expect(go).not.toHaveBeenCalled();
  });

  it('on the stack, opens that turn in the main window', () => {
    const { act, link } = stack(A2);
    fireEvent.click(link);
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ type: 'open', to: { page: 'diag', tab: 'turns', turn: 'tr7' } }));
  });

  it('on the stack, stays disabled with its reason when the card has no turn', () => {
    const { act, link } = stack(A1);
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.getAttribute('title')).toBe('这次审批没有记到对话轮次');
    fireEvent.click(link);
    expect(act).not.toHaveBeenCalled();
  });
});
