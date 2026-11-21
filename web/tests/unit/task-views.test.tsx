import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactList, DeliveryBox } from '../../src/features/delivery';
import { RejectBox, TaskDrawer } from '../../src/features/task';
import { activeRunOf, DELIVERIES, NOW, pick, TASKS } from '../../src/mock/fixtures';
import { CreateForm, draftFor } from '../../src/pages/tasks/CreateForm';
import { DLV_T1_V2, T1 } from '../../src/mock/fixtures/ids';

afterEach(cleanup);

const v2 = pick(DELIVERIES, DLV_T1_V2);

describe('delivery views', () => {
  it('counts opened artifacts instead of saying "viewed"', () => {
    render(<ArtifactList artifacts={v2.artifacts} canReveal />);
    expect(screen.getByText(/打开过/).textContent).toBe('产物 0/2 打开过');
    // Reveal sits in each row's ⋯ menu.
    const more = screen.getAllByRole('button', { name: /^更多操作：/ });
    expect(more).toHaveLength(2);
    fireEvent.click(more[0]!);
    expect(screen.getByRole('menuitem', { name: '在 Finder 中显示' })).toBeTruthy();
  });

  it('Enter on an artifact row opens it', () => {
    const onOpen = vi.fn();
    render(<ArtifactList artifacts={v2.artifacts} onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByLabelText('产物，回车打开').querySelector('tbody tr')!, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(v2.artifacts[0]?.path);
  });

  it('the review box is marked for the gradient and never says 已查看', () => {
    const { container } = render(<DeliveryBox deliveries={DELIVERIES.filter((d) => d.task_id === T1)} now={NOW} />);
    expect(container.querySelector('[data-review]')).not.toBeNull();
    expect(container.textContent).not.toContain('已查看');
    expect(container.textContent).toContain('已送达 │ 待决定');
  });
});

describe('reject and drawer', () => {
  it('驳回并继续 stays disabled until a requirement is written', () => {
    const onSubmit = vi.fn();
    render(<RejectBox kernelName="Codex" onSubmit={onSubmit} />);
    const btn = screen.getByText('驳回并继续').closest('button')!;
    // Disabled Btn stays focusable: it sets aria-disabled, not the disabled attribute.
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '按作者拆一列' } });
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledWith('按作者拆一列', true);
  });

  it('the drawer opens the requirement box before rejecting', () => {
    render(<TaskDrawer task={pick(TASKS, T1)} effective="waiting" now={NOW} delivery={v2} activeRun={activeRunOf(T1)} />);
    expect(screen.queryByText('驳回并继续')).toBeNull();
    fireEvent.click(screen.getByText('驳回…'));
    expect(screen.getByText('驳回并继续')).toBeTruthy();
  });

  it('a stopped job offers neither accept / reject nor a resume agentd would refuse', () => {
    render(<TaskDrawer task={pick(TASKS, T1)} effective="waiting" now={NOW} delivery={v2} stoppedAt={NOW} onAction={vi.fn()} />);
    expect(screen.queryByText('接受这一版')).toBeNull();
    expect(screen.queryByText('重新交派')).toBeNull();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
  });
});

describe('create dialog form', () => {
  it('the menu item preselects the kind', () => {
    expect(draftFor('code').kind).toBe('code');
    expect(draftFor('role').kind).toBe('role');
  });

  it('the coding tool Seg is wired', () => {
    const onChange = vi.fn();
    render(<CreateForm draft={draftFor('code')} onChange={onChange} goals={[]} canPick onPickFolder={() => {}} />);
    expect(screen.getByLabelText('目录')).toBeTruthy();
  });
});
