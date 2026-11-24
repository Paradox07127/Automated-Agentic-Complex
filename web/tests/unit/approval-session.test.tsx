import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromInteraction, type StackCard } from '../../src/domain';
import { ApprovalCard, approvalView } from '../../src/features/approval';
import { InSession } from '../../src/features/approval/inSession';
import { NOW, WIRE_INTERACTION_APPROVAL } from '../../src/mock/fixtures';
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
