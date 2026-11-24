import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromInteraction, type StackCard } from '../../src/domain';
import { ApprovalCard, approvalView } from '../../src/features/approval';
import { InSession } from '../../src/features/approval/inSession';
import { APPROVALS, NOW, pick, WIRE_INTERACTION_APPROVAL } from '../../src/mock/fixtures';
import { A2 } from '../../src/mock/fixtures/ids';
import { QuestionCard } from '../../src/pages/chat/QuestionCard';
import { ToolRow } from '../../src/pages/chat/ToolRow';

// Role approval offer, action encoding and both card surfaces.
afterEach(cleanup);
const question = (offered = true, dangerous = false) => fromInteraction({
  ...WIRE_INTERACTION_APPROVAL,
  data: { ...WIRE_INTERACTION_APPROVAL.data!, dangerous,
    approval_answers: offered ? ['allow', 'allow_session', 'deny'] : ['allow', 'deny'] },
}, NOW);
const view = (offered = true, dangerous = false) => approvalView({
  id: WIRE_INTERACTION_APPROVAL.request_id, kind: 'question', at: NOW,
  item: question(offered, dangerous),
} as Extract<StackCard, { kind: 'question' }> & { item: { interaction_kind: 'approval' } });

describe('conversation tool allowance', () => {
  it.each(['main', 'paper', 'session'] as const)('%s button sends allow_session only when offered and safe', (surface) => {
    for (const [offered, dangerous] of [[true, false], [false, false], [true, true]]) {
      const decide = vi.fn();
      render(<InSession.Provider value={surface === 'session'}>
        <ApprovalCard view={view(offered, dangerous)} onDecide={decide} paper={surface !== 'main' ? { top: true } : undefined} />
      </InSession.Provider>);
      const button = screen.queryByRole('button', { name: '本对话都允许' });
      expect(Boolean(button)).toBe(offered && !dangerous);
      if (button) {
        fireEvent.click(button);
        expect(decide).toHaveBeenCalledWith('allow_session', undefined);
        expect(view().action('allow_session')).toMatchObject({ type: 'answer', answers: { decision: ['本对话都允许'] } });
      } else expect(view(offered, dangerous).action('allow_session')).toBeNull();
      cleanup();
    }
  });

  it('inline chat approval sends the session answer and hides it for danger', () => {
    const answer = vi.fn();
    for (const dangerous of [false, true]) {
      render(<QuestionCard at={NOW} question={question(true, dangerous)} roleName="角色" now={NOW} answered={null} onAnswer={answer} onCancel={() => {}} />);
      const button = screen.queryByRole('button', { name: '本对话都允许' });
      expect(Boolean(button)).toBe(!dangerous);
      if (button) { fireEvent.click(button); expect(answer).toHaveBeenCalledWith({ decision: ['allow_session'] }); }
      cleanup();
    }
  });

  it('auto allowed calls show an informational receipt without an empty expand button', () => {
    render(<ToolRow label="remote/run" ms={0} summary="" sessionAllowed />);
    expect(screen.getByText('已按本对话设置允许')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the compact approval in a session card says what it grants', () => {
  it('states the session scope beside 本对话都允许, and a dispatch its directory and its source under 详情', () => {
    const a = { ...pick(APPROVALS, A2), session_scope: { kind: 'all_edits', detail: '' } };
    const { container, unmount } = render(<InSession.Provider value><ApprovalCard approval={a} paper={{ top: true }} /></InSession.Provider>);
    expect(screen.getByRole('button', { name: '本对话都允许' })).toBeTruthy();
    expect(container.textContent).toContain('工作区里的所有编辑和 mkdir/touch/rm/rmdir/mv/cp/sed');
    unmount();
    const d = {
      ...pick(APPROVALS, A2), approval_kind: 'dispatch' as const, cwd: null, scope_ok: false, session_scope: null,
      dispatch: { target: 'codex', cwd: '/w/p', prompt: '修好构建', source: 'text' as const, utterance: null, modes: ['read_only'], mode: 'read_only', verify_cmd: null, cwd_from: { source: 'focus' as const, display_session: 'claude:5e10', state: 'thinking' } },
    };
    const r = render(<InSession.Provider value><ApprovalCard approval={d} paper={{ top: true }} /></InSession.Provider>);
    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(r.container.textContent).toContain('/w/p');
    expect(r.container.textContent).toContain('取自焦点会话 claude:5e10（thinking）');
  });
});
