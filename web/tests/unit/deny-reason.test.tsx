import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromInteraction, type ApprovalDispatch } from '../../src/domain';
import { approvalDecision } from '../../src/domain/bodies';
import { ApprovalCard, approvalView, DecisionReceipt, type ApprovalStackItem } from '../../src/features/approval';
import { APPROVALS, NOW, pick, WIRE_INTERACTION_APPROVAL } from '../../src/mock/fixtures';
import { A1 } from '../../src/mock/fixtures/ids';

// A deny may carry one line of reason for the coding tool; an expired hook card says where the call went.

afterEach(cleanup);

const tool = pick(APPROVALS, A1);
const dispatch = { ...tool, approval_kind: 'dispatch' as const, dispatch: { target: 'codex', prompt: '修', cwd: '/w', mode: 'read_only', modes: ['read_only'] } as unknown as ApprovalDispatch };

describe('deny with a reason', () => {
  it('拒绝 still decides with one click and no reason', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={tool} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /^拒绝(?!并)/ }));
    expect(onDecide).toHaveBeenCalledWith('deny');
  });

  it('the reason button opens a field whose Enter denies with that reason', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={tool} onDecide={onDecide} />);
    expect(screen.queryByRole('textbox', { name: '拒绝理由' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '拒绝并附一句理由' }));
    const field = screen.getByRole('textbox', { name: '拒绝理由' });
    fireEvent.change(field, { target: { value: '  换到 build 目录再跑 ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onDecide).toHaveBeenCalledWith('deny', undefined, '换到 build 目录再跑');
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('Esc in the field folds it away without deciding; Enter while composing does not send', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={{ ...tool, dangerous: true }} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝并附一句理由' }));
    const field = screen.getByRole('textbox', { name: '拒绝理由' });
    fireEvent.change(field, { target: { value: '不要' } });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(screen.getByRole('textbox', { name: '拒绝理由' })).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: '拒绝理由' })).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('dispatch, paper and compact cards offer no reason', () => {
    const { unmount } = render(<ApprovalCard approval={dispatch} onDecide={() => {}} />);
    expect(screen.queryByRole('button', { name: '拒绝并附一句理由' })).toBeNull();
    unmount();
    render(<ApprovalCard approval={tool} paper={{ top: true }} onDecide={() => {}} />);
    expect(screen.queryByRole('button', { name: '拒绝并附一句理由' })).toBeNull();
  });

  it('the body carries the reason only with a deny that has one', () => {
    expect(approvalDecision(tool, 'deny', undefined, ' 换个目录 ')).toEqual({ generation: tool.generation, decision: 'deny', message: '换个目录' });
    expect(approvalDecision(tool, 'deny', undefined, '  ')).toEqual({ generation: tool.generation, decision: 'deny' });
    expect(approvalDecision(tool, 'allow', undefined, '好')).toEqual({ generation: tool.generation, decision: 'allow' });
  });
});

describe('expired receipt', () => {
  it('a hook card says the call went back to the terminal', () => {
    const { container } = render(<ApprovalCard approval={{ ...tool, seconds_left: 0 }} />);
    expect(container.querySelector('[data-stub="DecisionReceipt"]')?.textContent).toContain('已超时 │ 已交回终端处理');
  });

  it('a dispatch card, a role card and a bare receipt keep 请求已失效', () => {
    const { container, unmount } = render(<ApprovalCard approval={{ ...dispatch, seconds_left: 0 }} />);
    expect(container.querySelector('[data-stub="DecisionReceipt"]')?.textContent).toContain('已超时 │ 请求已失效');
    unmount();
    const role = { id: WIRE_INTERACTION_APPROVAL.request_id, kind: 'question', at: NOW, item: fromInteraction(WIRE_INTERACTION_APPROVAL, NOW) } as ApprovalStackItem;
    const view = approvalView(role);
    const r = render(<ApprovalCard view={view} outcome={{ kind: 'expired', at: NOW }} />);
    expect(r.container.textContent).toContain('已超时 │ 请求已失效');
    expect(r.container.textContent).toContain(view.expiredNote);
    r.unmount();
    const bare = render(<DecisionReceipt outcome={{ kind: 'expired', at: NOW }} origin="own" />);
    expect(bare.container.textContent).toContain('已超时 │ 请求已失效');
  });
});
