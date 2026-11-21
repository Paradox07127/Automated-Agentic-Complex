import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard, DecisionBar } from '../../src/features/approval';
import { ArtifactList } from '../../src/features/delivery';
import { APPROVALS, DELIVERIES, pick } from '../../src/mock/fixtures';
import { A1, A2, DLV_T1_V2 } from '../../src/mock/fixtures/ids';

afterEach(cleanup);

describe('DecisionBar', () => {
  it('never approves a dangerous item from Enter or Space', () => {
    const approve = vi.fn();
    render(<DecisionBar kind="approval" dangerous primary={{ label: '批准', onClick: approve }} />);
    const btn = screen.getByRole('button', { name: '批准' });
    // A cancelled keydown (Enter) or keyup (Space) is what stops the browser from synthesising the click.
    expect(fireEvent.keyDown(btn, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(btn, { key: ' ' })).toBe(false);
    expect(fireEvent.keyUp(btn, { key: ' ' })).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/只能用鼠标点击/);
    fireEvent.click(btn);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter alone on a normal item and puts the primary button last', () => {
    const { container } = render(
      <DecisionBar kind="review" title="周报 v2" primary={{ label: '接受 v2', kbd: '⏎' }} secondary={[{ label: '退回…' }]} more={[{ kind: 'item', label: '复制路径' }]} />,
    );
    const btn = screen.getByRole('button', { name: /接受 v2/ });
    expect(fireEvent.keyDown(btn, { key: 'Enter' })).toBe(true);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.at(-1)).toBe(btn);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('runs onEscape from inside the bar', () => {
    const esc = vi.fn();
    render(<DecisionBar kind="question" primary={{ label: '提交' }} onEscape={esc} />);
    fireEvent.keyDown(screen.getByRole('button', { name: '提交' }), { key: 'Escape' });
    expect(esc).toHaveBeenCalledTimes(1);
  });
});

describe('ApprovalCard', () => {
  it('drops the paper card, tape and eyebrow and keeps its buttons inside', () => {
    const { container } = render(<ApprovalCard approval={pick(APPROVALS, A2)} position={{ index: 2, total: 3 }} />);
    expect(container.querySelector('[data-stub="PaperCard"]')).toBeNull();
    expect(container.textContent).not.toMatch(/APPROVAL|\/\/|悬停不暂停/);
    const card = container.querySelector('[data-stub="ApprovalCard"]') as HTMLElement;
    expect(within(card).getByRole('button', { name: /批准/ })).toBeTruthy();
    expect(card.querySelector('[data-stub="DecisionBar"]')).not.toBeNull();
  });

  it('labels the dangerous approve button just 批准', () => {
    render(<ApprovalCard approval={pick(APPROVALS, A1)} />);
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();
  });

  it('opens a command that overflows two lines in place with 展开全部', () => {
    // jsdom lays nothing out: report every box as taller than it shows.
    const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(52);
    try {
      const { container } = render(<ApprovalCard approval={{ ...pick(APPROVALS, A2), cmd: 'x '.repeat(200) }} />);
      const more = screen.getByRole('button', { name: '展开全部' });
      expect(more.getAttribute('aria-expanded')).toBe('false');
      const code = container.querySelector('[data-stub="CmdBlock"] pre') as HTMLElement;
      expect(code.hasAttribute('data-full')).toBe(false);
      fireEvent.click(more);
      expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
      expect(code.hasAttribute('data-full')).toBe(true);
    } finally {
      sh.mockRestore();
      ch.mockRestore();
    }
  });

  it('shows a command agentd cut short in full with its length and no 展开全部', () => {
    const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(52);
    try {
      const { container } = render(<ApprovalCard approval={pick(APPROVALS, A1)} />);
      expect(screen.queryByRole('button', { name: '展开全部' })).toBeNull();
      expect(container.querySelector('[data-stub="CmdBlock"] pre')?.hasAttribute('data-full')).toBe(true);
      expect(container.textContent).toMatch(/命令已截断：原长 212 字符/);
    } finally {
      sh.mockRestore();
      ch.mockRestore();
    }
  });

  it('keeps a command that fits without 展开全部', () => {
    render(<ApprovalCard approval={pick(APPROVALS, A2)} />);
    expect(screen.queryByRole('button', { name: '展开全部' })).toBeNull();
  });
});

describe('delivery', () => {
  const v2 = pick(DELIVERIES, DLV_T1_V2);

  it('lists artifacts as table rows with one ⋯ each; Enter on a row opens it', () => {
    const onOpen = vi.fn();
    const { container } = render(<ArtifactList artifacts={v2.artifacts} canReveal onOpen={onOpen} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(v2.artifacts.length);
    expect(screen.getAllByRole('button', { name: /更多操作/ })).toHaveLength(v2.artifacts.length);
    expect(screen.queryByText('在 Finder 中显示')).toBeNull();
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(v2.artifacts[1]?.path);
  });
});
