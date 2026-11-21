import { act as run, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InSession } from '../../src/features/approval';
import { stackScenario } from '../../src/mock/stack';
import { NOW } from '../../src/mock/fixtures';
import { A1, A2, A3, Q1, Q_APPROVAL, S_5E10, S_C07A } from '../../src/mock/fixtures/ids';
import type { CardAction } from '../../src/surfaces/stack/actions';
import type { StackCard } from '../../src/surfaces/stack/model';
import { groupStack, type SessionRow } from '../../src/surfaces/stack/sessions';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import { stubMatchMedia } from './mediaStub';

// An approval or question on a HUD session line is a compact block: action and target once, toggles, small buttons.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const find = (scenario: string, id: string): StackCard => {
  const c = stackScenario(scenario).cards.find((x) => x.id === id);
  if (!c) throw new Error(`no ${id} in ${scenario}`);
  return { ...c, collapsed: undefined };
};

const row = (id: string, approvals: string[]): SessionRow => ({ id, backend: 'codex', title: '修 HostLink 断线重连', status: 'needs_you', live: false, activity: '等待你批准', tool: null, target: null, updatedAt: NOW - 30_000, approvals });

/** Mounts the cards on one session the way the expanded HUD draws them under the session's line (HudRoot). */
function mountOn(card: StackCard, sessionId = S_C07A) {
  const act = vi.fn<(a: CardAction) => void>();
  const [group] = groupStack([card], [row(sessionId, [card.id])]).sessions;
  render(
    <div data-hud-row={sessionId}>
      <InSession.Provider value>
        {group!.cards.map((c, k) => (
          <StackCardView key={c.id} card={c} index={k + 1} total={group!.cards.length} top={false} now={NOW} act={act} />
        ))}
      </InSession.Provider>
    </div>,
  );
  const session = document.querySelector<HTMLElement>(`[data-hud-row="${sessionId}"]`)!;
  return { act, session };
}

const block = (root: HTMLElement) => {
  const el = root.querySelector<HTMLElement>('[data-stub="SessionApproval"]');
  if (!el) throw new Error('no compact approval block');
  return el;
};

describe('compact approval inside a session card', () => {
  it('says the action and its target once, with no paper sheet, ring, tool tag or code block', () => {
    const { session } = mountOn(find('default', A2));
    const b = block(session);
    expect(b.querySelector('[data-action]')?.textContent).toBe('改 HostLink.swift');
    expect(b.textContent).not.toContain('Sources/CompanionCore/HostLink.swift');
    expect(session.querySelector('[data-stub="ApprovalCard"]')).toBeNull();
    expect(session.querySelector('[data-stub="CountdownRing"]')).toBeNull();
    expect(session.querySelector('[data-stub="CmdBlock"]')).toBeNull();
    expect(session.querySelector('[data-art-slot]')).toBeNull();
    expect(b.querySelector('[data-stub="CountdownLine"]')).toBeTruthy();
  });

  it('reads a command as 运行 and a role approval by its question', () => {
    expect(block(mountOn(find('default', A3)).session).querySelector('[data-action]')?.textContent).toBe('运行 swift test --filter HostLinkTests');
    cleanup();
    const role = stackScenario('role-approval').cards.find((c) => c.id === Q_APPROVAL)!;
    expect(block(mountOn(role).session).querySelector('[data-action]')?.textContent).toBe('允许写入 ~/Documents/开销/10 月.xlsx？');
  });

  it('shows a danger mark with the rule only when the approval is dangerous', () => {
    const plain = mountOn(find('default', A2));
    expect(block(plain.session).querySelector('[data-danger-mark]')).toBeNull();
    cleanup();
    const danger = block(mountOn(find('default', A1), S_5E10).session);
    expect(danger.getAttribute('data-dangerous')).toBe('true');
    expect(danger.querySelector('[data-danger-mark]')?.textContent).toContain('强制递归删除');
  });

  it('opens one of 差异 / 命令 / 详情 inline, collapsed by default', () => {
    const b = block(mountOn(find('default', A2)).session);
    expect(within(b).queryByRole('button', { name: '命令' })).toBeNull();
    const diff = within(b).getByRole('button', { name: /^差异/ });
    expect(diff.getAttribute('aria-expanded')).toBe('false');
    expect(diff.textContent).toContain('+1');
    expect(b.textContent).not.toContain('TimeInterval = 3.0');
    fireEvent.click(diff);
    expect(diff.getAttribute('aria-expanded')).toBe('true');
    expect(b.textContent).toContain('+    let timeout: TimeInterval = 3.0');
    fireEvent.click(within(b).getByRole('button', { name: '详情' }));
    expect(b.textContent).not.toContain('TimeInterval = 3.0');
    expect(b.textContent).toContain('~/Endfield/app');
    expect(b.textContent).toContain('Sources/CompanionCore/HostLink.swift');
    cleanup();

    const run3 = block(mountOn(find('default', A3)).session);
    expect(run3.querySelector('[data-stub="CmdBlock"]')).toBeNull();
    fireEvent.click(within(run3).getByRole('button', { name: '命令' }));
    expect(run3.querySelector('[data-stub="CmdBlock"]')?.textContent).toContain('swift test --filter HostLinkTests');
  });

  it('拒绝 / 批准 / 本对话都允许 send what the full card sends', () => {
    const full = vi.fn<(a: CardAction) => void>();
    render(<StackCardView card={find('default', A2)} index={1} total={1} top now={NOW} act={full} />);
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    cleanup();

    const { act, session } = mountOn(find('default', A2));
    const b = block(session);
    fireEvent.click(within(b).getByRole('button', { name: '批准' }));
    fireEvent.click(within(b).getByRole('button', { name: '拒绝' }));
    expect(act.mock.calls).toEqual(full.mock.calls);
    expect(act.mock.calls[0]?.[0]).toEqual({ type: 'decide', id: A2, decision: 'allow', generation: 7 });
    fireEvent.click(within(b).getByRole('button', { name: '本对话都允许' }));
    expect(act).toHaveBeenLastCalledWith({ type: 'decide', id: A2, decision: 'allow_session', generation: 7 });
  });

  it('a dangerous approval has no 本对话都允许 and approves on a second click only', () => {
    const { act, session } = mountOn(find('default', A1), S_5E10);
    const b = block(session);
    expect(within(b).queryByRole('button', { name: '本对话都允许' })).toBeNull();
    fireEvent.click(within(b).getByRole('button', { name: '批准' }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(within(b).getByRole('button', { name: '确认批准' }));
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ type: 'decide', id: A1, decision: 'allow' }));
  });

  it('a role approval answers 允许 the same way', () => {
    const role = stackScenario('role-approval').cards.find((c) => c.id === Q_APPROVAL)!;
    const { act, session } = mountOn(role);
    fireEvent.click(within(block(session)).getByRole('button', { name: '批准' }));
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', id: Q_APPROVAL, text: '允许' }));
  });

  it('esc denies and ⏎ approves from the focused block; a dangerous one only hints', () => {
    const { act, session } = mountOn(find('default', A2));
    const b = block(session);
    expect(b.tabIndex).toBe(0);
    fireEvent.keyDown(b, { key: 'Escape' });
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'deny' }));
    fireEvent.keyDown(b, { key: 'Enter' });
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'allow' }));
    cleanup();

    const danger = mountOn(find('default', A1), S_5E10);
    fireEvent.keyDown(block(danger.session), { key: 'Enter' });
    expect(danger.act).not.toHaveBeenCalled();
    expect(within(danger.session).getByRole('alert').textContent).toBe('危险操作只能用鼠标点击「批准」');
  });

  it('counts the seconds down in small text', () => {
    vi.useFakeTimers();
    const b = block(mountOn(find('default', A2)).session);
    expect(b.querySelector('[data-left]')?.textContent).toBe('剩余 23 秒');
    run(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(b.querySelector('[data-left]')?.textContent).toBe('剩余 20 秒');
  });

  it('a standalone approval keeps the full paper card', () => {
    render(<StackCardView card={find('default', A2)} index={1} total={1} top now={NOW} act={vi.fn()} />);
    expect(document.querySelector('[data-stub="ApprovalCard"]')).toBeTruthy();
    expect(document.querySelector('[data-stub="SessionApproval"]')).toBeNull();
  });
});

describe('compact question inside a session card', () => {
  const q1 = () => find('question', Q1) as Extract<StackCard, { kind: 'question' }>;

  it('shows the question, then its options as buttons that send at once', () => {
    const { act, session } = mountOn(q1());
    const form = session.querySelector<HTMLElement>('[data-stub="QuestionBox"][data-session]')!;
    expect(form).toBeTruthy();
    expect(session.querySelector('[data-art-slot]')).toBeNull();
    expect(form.textContent).toContain('周报里要不要包含外部会话的提交？');
    fireEvent.click(within(form).getByRole('button', { name: '包含' }));
    expect(act).toHaveBeenCalledWith({ type: 'answer', id: Q1, expected_version: q1().item.revision, answers: { scope: ['包含'] }, text: '包含' });
  });

  it('sends a typed answer from the one-line input with 发送', () => {
    const { act, session } = mountOn(q1());
    const form = session.querySelector<HTMLElement>('[data-stub="QuestionBox"][data-session]')!;
    const send = within(form).getByRole('button', { name: '发送' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    const input = within(form).getByRole('textbox', { name: '写下回答' });
    expect(input.tagName).toBe('INPUT');
    fireEvent.change(input, { target: { value: '只列提交数' } });
    fireEvent.click(send);
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', id: Q1, answers: { scope: ['只列提交数'] } }));
  });
});
