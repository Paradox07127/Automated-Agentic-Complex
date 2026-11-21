import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '../../src/domain';
import { type TaskDetailProps } from '../../src/features/task';
import { TaskDetailDemos } from '../../src/features/task/TaskDetail.demos';
import { ACTIVE_RUNS, APPROVALS, DELIVERIES, GOALS, NOW, pick, QUESTIONS, SESSIONS, TASKS } from '../../src/mock/fixtures';
import { ArtifactTable } from '../../src/pages/tasks/ArtifactTable';
import { CreateDialog } from '../../src/pages/tasks/CreateDialog';
import { draftFor } from '../../src/pages/tasks/CreateForm';
import { deriveView, emptyLocal } from '../../src/pages/tasks/model';
import { PendingDetail } from '../../src/pages/tasks/PendingDetail';
import { TaskView } from '../../src/pages/tasks/TaskView';
import type { TasksBase } from '../../src/pages/tasks/useTasksData';
import { A1, A2, DLV_T1_V2, DLV_T4_V1, Q1, T4 } from '../../src/mock/fixtures/ids';

afterEach(cleanup);

const demo = (name: string): TaskDetailProps => {
  const d = TaskDetailDemos.find((x) => x.name === name);
  if (!d) throw new Error(`no demo ${name}`);
  return d.props;
};
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe(' task detail: one 待处理 bar', () => {
  it('review plus question: one DecisionBar, no NeedBox, opened count once, one yellow button', () => {
    const onAction = vi.fn();
    const { container } = render(<TaskView {...demo('review')} onAction={onAction} />);
    expect(container.querySelectorAll('[data-stub="DecisionBar"]')).toHaveLength(1);
    expect(container.querySelector('[data-stub="NeedBox"]')).toBeNull();
    expect(count(container.textContent ?? '', /0\/2/g)).toBe(1);
    expect(container.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'open_pending', pendingId: Q1 });
    fireEvent.click(screen.getByRole('button', { name: '接受 v2' }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'accept', deliveryId: DLV_T1_V2 });
  });

  it('approvals only: the bar sends you to approve and counts them once', () => {
    const onAction = vi.fn();
    const { container } = render(<TaskView {...demo('waiting')} onAction={onAction} />);
    const bar = container.querySelector('[data-stub="DecisionBar"]') as HTMLElement;
    expect(container.querySelectorAll('[data-stub="DecisionBar"]')).toHaveLength(1);
    expect(bar.textContent).toContain('2 张');
    fireEvent.click(within(bar).getByRole('button', { name: '前往审批' }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'open_pending', pendingId: A2 });
  });

  it('failed task: a short failure summary comes first and the raw output stays folded', () => {
    const { container } = render(<TaskView {...demo('failed')} />);
    const fold = container.querySelector('[data-stub="RawFold"]') as HTMLElement;
    const lines = [...fold.querySelectorAll('[data-summary] li')].map((l) => l.textContent ?? '');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toContain('下载索引');
    expect(lines[0]).toContain('资料授权已撤销');
    expect(within(fold).getByRole('button', { expanded: false })).toBeTruthy();
    expect(container.textContent).not.toContain('这次运行没有读写文件');
    expect(container.querySelector('[data-stub="ErrBar"]')).toBeNull();
  });
});

describe(' artifacts table', () => {
  const arts = pick(DELIVERIES, DLV_T1_V2).artifacts;

  it('Enter on a row opens it; the row-end ⋯ holds copy path', () => {
    const onOpen = vi.fn();
    const onCopyPath = vi.fn();
    render(<ArtifactTable artifacts={arts} onOpen={onOpen} onCopyPath={onCopyPath} />);
    const table = screen.getByRole('grid', { name: '产物' });
    const first = table.querySelector('tbody tr') as HTMLElement;
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(arts[0]?.absolute_path);
    const more = screen.getAllByRole('button', { name: /^更多操作：/ });
    expect(more).toHaveLength(arts.length);
    fireEvent.click(more[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制路径' }));
    expect(onCopyPath).toHaveBeenCalledWith(arts[0]?.absolute_path);
  });
});

describe(' pending detail', () => {
  it('approval: position shows once, no queue bar, no dev note, no rule paragraph', () => {
    const view = deriveView({ tasks: TASKS, deliveries: DELIVERIES, sessions: SESSIONS, approvals: APPROVALS, questions: QUESTIONS, goals: GOALS, activeRuns: ACTIVE_RUNS, roleMissing: false }, emptyLocal());
    const item = pick(APPROVALS, A1) as Approval;
    const noop = () => {};
    const { container } = render(
      <PendingDetail item={item} pending={view.pending} now={NOW} onApprove={noop} onAnswer={noop} onCancelQuestion={noop} onOpenSession={noop} onOpenChat={noop} onMouseOnly={noop} />,
    );
    const text = container.textContent ?? '';
    expect(count(text, new RegExp(`1/${view.pending.length}`, 'g'))).toBe(1);
    expect(container.querySelector('[data-stub="QueueBar"]')).toBeNull();
    expect(text).not.toContain('需新增');
    expect(text).not.toContain('悬停不暂停倒计时');
  });
});

describe(' create dialog', () => {
  it('opens as a Dialog with a full title and ⌘↵ submits', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCreated = vi.fn();
    const draft = { ...draftFor('code'), brief: '验证报表差异', cwd: { handle: 'h-1', displayName: 'agent' } };
    render(
      <QueryClientProvider client={client}>
        <CreateDialog draft={draft} setDraft={() => {}} goals={[]} push={() => {}} onCreated={onCreated} />
      </QueryClientProvider>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('[data-stub="Dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-stub="Modal"]')).toBeNull();
    expect(within(dialog).getByRole('heading').textContent).toBe('新建');
    expect(dialog.textContent).not.toContain('NEW');
    fireEvent.keyDown(within(dialog).getByDisplayValue(draft.brief), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});

describe(' review fixes', () => {
  // agentd's reject takes no note (http.py:63-64), so the chain names no 补充要求.
  it('delivery: 自检 column, no rejected note under the chain, verification once', () => {
    const { container } = render(<TaskView {...demo('review')} />);
    const table = screen.getByRole('grid', { name: '产物' });
    expect(within(table).getByRole('columnheader', { name: '检查' })).toBeTruthy();
    expect(table.closest('[data-stub="Table"]')?.hasAttribute('data-scroll')).toBe(true);
    const text = container.textContent ?? '';
    expect(text).not.toContain('退回：');
    expect(count(text, /已自动检查|未验证/g)).toBe(1);
  });

  it('decided delivery: the chain line names the verification', () => {
    const t4 = pick(DELIVERIES, DLV_T4_V1);
    const { container } = render(<TaskView {...demo('review')} task={pick(TASKS, T4)} effective="done" deliveries={[t4]} pending={[]} />);
    const chain = container.querySelector('section[aria-label="产物"] p') as HTMLElement;
    expect(chain.textContent).toContain(t4.verification_source === 'auto' ? '│ 已自动检查' : '│ 未验证');
  });

  it('coding session: the summary states the last line, not a line count', () => {
    const sessionLines = ['读取 Sources/CompanionCore/HostLink.swift', '修改 reconnect()：心跳超时从 1.5 s 放宽到 3 s', '待批准：修改 HostLink.swift、运行 swift test'];
    const { container } = render(<TaskView {...demo('waiting')} sessionLines={sessionLines} />);
    const fold = container.querySelector('section[aria-label="会话"] [data-stub="RawFold"]') as HTMLElement;
    const lines = [...fold.querySelectorAll('[data-summary] li')].map((l) => l.textContent ?? '');
    expect(lines).toEqual(['待批准：修改 HostLink.swift、运行 swift test']);
  });

  it('steps error: no endpoint path in the bar text', () => {
    const { container } = render(<TaskView {...demo('failed')} stepsStatus="error" />);
    expect(container.textContent).not.toContain('/agent/tasks');
  });
});
