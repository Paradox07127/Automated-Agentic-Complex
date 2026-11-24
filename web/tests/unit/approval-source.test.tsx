import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fromApproval, type Approval } from '../../src/domain';
import { ApprovalCard, DiffPreview } from '../../src/features/approval';
import { APPROVALS, NOW, pick } from '../../src/mock/fixtures';
import { A1, A2, S_5E10, S_C07A } from '../../src/mock/fixtures/ids';
import { WIRE_APPROVALS } from '../../src/mock/fixtures/wire/work';
import { Select } from '../../src/ui';

// Approval cards name the agent and project, never the raw session id; a Select trigger carries its chosen label.

afterEach(cleanup);

describe('approval source line', () => {
  it('fromApproval names the agent and the project directory, not the session id', () => {
    const a = fromApproval(WIRE_APPROVALS.find((x) => x.request_id === A1)!, NOW);
    expect(a.source).toBe('Claude Code │ app');
    expect(fromApproval({ ...WIRE_APPROVALS.find((x) => x.request_id === A1)!, cwd: null }, NOW).source).toBe('Claude Code');
  });

  it('the main card shows the readable line and keeps the full id in the tooltip', () => {
    for (const [id, session] of [
      [A1, S_5E10],
      [A2, S_C07A],
    ] as const) {
      const { container, unmount } = render(<ApprovalCard approval={pick(APPROVALS, id)} />);
      const line = container.querySelector('[data-stub="ApprovalCard"] p span:not(code)') as HTMLElement;
      expect(line.textContent).not.toMatch(/claude:|own:/);
      expect(line.title).toContain(session);
      unmount();
    }
  });

  it('the paper card does the same', () => {
    const { container } = render(<ApprovalCard approval={pick(APPROVALS, A1)} paper={{ top: true }} />);
    const line = [...container.querySelectorAll('p span')].find((s) => s.textContent?.startsWith('Claude Code')) as HTMLElement;
    expect(line.textContent).toBe('Claude Code │ app');
    expect(line.title).toContain(S_5E10);
  });
});

const dispatchCard = (over: Partial<NonNullable<Approval['dispatch']>> = {}): Approval => ({
  ...pick(APPROVALS, A2),
  approval_kind: 'dispatch',
  display_session: null,
  cwd: null,
  scope_ok: false,
  session_scope: null,
  dispatch: { target: 'codex', cwd: '/w/p', prompt: '修好构建', source: 'text', utterance: null, modes: ['read_only', 'workspace_write'], mode: 'read_only', verify_cmd: null, cwd_from: { source: 'explicit' }, ...over },
});

describe('what a grant or a dispatch covers', () => {
  it('a session grant says what later calls it lets through, on the main and the paper card', () => {
    const edits = { ...pick(APPROVALS, A2), session_scope: { kind: 'all_edits', detail: 'Bash(npm test)' } };
    for (const paper of [undefined, { top: true }]) {
      const { container, unmount } = render(<ApprovalCard approval={edits} paper={paper} />);
      expect(container.textContent).toContain('工作区里的所有编辑和 mkdir/touch/rm/rmdir/mv/cp/sed');
      expect(container.textContent).toContain('Bash(npm test)');
      unmount();
    }
    const { container } = render(<ApprovalCard approval={{ ...edits, session_scope: { kind: 'same_files', detail: 'a.swift\nb.swift' } }} />);
    expect(container.textContent).toContain('a.swift、b.swift');
  });

  it('a dispatch card shows its directory, where the directory came from and what was said', () => {
    const focus = render(<ApprovalCard approval={dispatchCard({ cwd_from: { source: 'focus', display_session: 'claude:5e10', state: 'thinking' } })} />);
    expect(focus.container.textContent).toContain('/w/p');
    expect(focus.container.textContent).toContain('取自焦点会话 claude:5e10（thinking）');
    focus.unmount();
    const voice = render(<ApprovalCard approval={dispatchCard({ source: 'voice', utterance: '让 Codex 修一下构建' })} />);
    expect(voice.container.textContent).toContain('让 Codex 修一下构建');
    expect(voice.container.textContent).toContain('指定的目录');
  });
});

describe('expired receipt by card kind', () => {
  it('an expired dispatch says nothing started and offers no terminal', () => {
    const { container } = render(<ApprovalCard approval={{ ...dispatchCard(), seconds_left: 0 }} onOpenSession={() => {}} />);
    const receipt = container.querySelector('[data-stub="DecisionReceipt"]')!;
    expect(receipt.textContent).not.toContain('终端');
    expect(receipt.textContent).toContain('任务没有派出');
  });

  it('an expired own-session call offers no terminal either; an external hook card does', () => {
    const own = render(<ApprovalCard approval={{ ...pick(APPROVALS, A2), seconds_left: 0 }} onOpenSession={() => {}} />);
    expect(own.container.querySelector('[data-stub="DecisionReceipt"]')!.textContent).not.toContain('终端');
    own.unmount();
    render(<ApprovalCard approval={{ ...pick(APPROVALS, A1), seconds_left: 0 }} onOpenSession={() => {}} />);
    expect(screen.getByRole('button', { name: '去终端 ↗' })).toBeTruthy();
  });
});

describe('content preview', () => {
  it('new content is not counted as a diff, and a trailing newline adds no line', () => {
    const { container, unmount } = render(<DiffPreview preview={'- a\n- b\n'} />);
    expect(container.textContent).toContain('内容预览');
    expect(container.textContent).not.toContain('−2');
    expect(container.textContent).not.toContain('全部');
    unmount();
    const six = render(<DiffPreview preview={'1\n2\n3\n4\n5\n6\n'} />);
    expect(six.container.textContent).not.toContain('全部');
    six.unmount();
    const diff = render(<DiffPreview preview={'@@ -1 +1 @@\n-a\n+b\n'} />);
    expect(diff.container.textContent).toContain('差异预览 +1 −1');
  });
});

describe('Select', () => {
  it('puts the chosen label, with its default mark, on the trigger title', () => {
    const label = '自动（优先本机 Claude / Codex 登录，API Key 备用）';
    render(<Select label="模型服务" value="auto" defaultValue="auto" options={[{ value: 'auto', label }, { value: 'x', label: 'X' }]} />);
    expect(screen.getByRole('button', { name: '模型服务' }).title).toBe(`${label}（默认）`);
  });
});
