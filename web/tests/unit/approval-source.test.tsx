import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fromApproval } from '../../src/domain';
import { ApprovalCard } from '../../src/features/approval';
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

describe('Select', () => {
  it('puts the chosen label, with its default mark, on the trigger title', () => {
    const label = '自动（优先本机 Claude / Codex 登录，API Key 备用）';
    render(<Select label="模型服务" value="auto" defaultValue="auto" options={[{ value: 'auto', label }, { value: 'x', label: 'X' }]} />);
    expect(screen.getByRole('button', { name: '模型服务' }).title).toBe(`${label}（默认）`);
  });
});
