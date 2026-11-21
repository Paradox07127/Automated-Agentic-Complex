import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Banner, CountBadge, Fraction, Menu, Modal, Select, StatusTag, Toast, type MenuItem } from '../../src/ui';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Select', () => {
  const options = [
    { value: 'q', label: '安静' },
    { value: 'm', label: '适中' },
    { value: 'a', label: '活跃', risky: true },
  ];

  it('opens from the keyboard, moves the active option and picks with ⏎', () => {
    const onChange = vi.fn();
    render(<Select label="主动程度" value="m" defaultValue="m" options={options} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: '主动程度' });
    expect(trigger.textContent).toContain('适中（默认）');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox');
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /活跃/ }).id);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on esc without choosing, and stays shut while disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Select label="主动程度" value="m" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '主动程度' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Select label="主动程度" value="m" options={options} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('button', { name: '主动程度' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('marks risky options for screen readers too', () => {
    render(<Select label="主动程度" value="m" options={options} open />);
    expect(screen.getByRole('option', { name: /活跃.*有风险/ })).toBeTruthy();
  });
});

describe('Menu', () => {
  const del = vi.fn();
  const archive = vi.fn();
  const items: MenuItem[] = [
    { kind: 'item', label: '重命名' },
    { kind: 'item', label: '归档', disabled: true, reason: '先停止任务', onSelect: archive },
    { kind: 'sep' },
    { kind: 'item', label: '删除…', danger: true, onSelect: del },
  ];

  it('opens with ↓, walks the items with arrows (skipping separators) and runs the focused one', () => {
    render(<Menu label="管理" items={items} />);
    const trigger = screen.getByRole('button', { name: /管理/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: '管理' });
    expect(document.activeElement?.textContent).toBe('重命名');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('删除…');
    fireEvent.click(document.activeElement as HTMLElement);
    expect(del).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not run disabled items and shows why', () => {
    render(<Menu label="管理" items={items} open />);
    const item = screen.getByRole('menuitem', { name: /归档/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain('先停止任务');
    fireEvent.click(item);
    expect(archive).not.toHaveBeenCalled();
  });

  it('esc closes and returns focus to the trigger', () => {
    render(<Menu label="管理" items={items} />);
    const trigger = screen.getByRole('button', { name: /管理/ });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('esc closes a click-opened menu wherever the focus is', () => {
    render(<Menu label="管理" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: /管理/ }));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('esc closes an open menu inside a modal without closing the modal', () => {
    const onCancel = vi.fn();
    render(
      <Modal open title="设置" confirmLabel="好" onCancel={onCancel}>
        <Menu label="管理" items={items} />
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: /管理/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('esc on the trigger closes a menu opened by click', () => {
    render(<Menu label="管理" items={items} />);
    const trigger = screen.getByRole('button', { name: /管理/ });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Modal', () => {
  it('starts on the safe choice when dangerous, closes on esc and traps Tab', () => {
    const onCancel = vi.fn();
    render(<Modal open danger title="关闭并删除 214 条？" confirmLabel="关闭并删除" onCancel={onCancel} />);
    const dialog = screen.getByRole('dialog', { name: '关闭并删除 214 条？' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '关闭并删除' });
    expect(document.activeElement).toBe(cancel);
    confirm.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps confirm inert until the confirm word is typed', () => {
    const onConfirm = vi.fn();
    render(<Modal open danger title="清空全部记忆？" confirmWord="清空" confirmLabel="清空记忆" onConfirm={onConfirm} />);
    const input = screen.getByRole('textbox', { name: /输入「清空」确认/ });
    expect(document.activeElement).toBe(input);
    const confirm = screen.getByRole('button', { name: '清空记忆' });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '清空' } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(<Modal open={false} title="x" confirmLabel="好" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Toast', () => {
  it('disappears after 2.5 s and its 167 ms exit unless it is persistent', () => {
    vi.useFakeTimers();
    render(<Toast message="已批准 2 张" severity="success" />);
    render(<Toast message="重新交派失败" severity="danger" persistent />);
    expect(screen.getByRole('status').textContent).toContain('已批准 2 张');
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByText('已批准 2 张')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('重新交派失败');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    act(() => {
      vi.advanceTimersByTime(167);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('runs the action once and dismisses after the 167 ms exit', () => {
    vi.useFakeTimers();
    const redo = vi.fn();
    render(<Toast message="已停止" action={{ label: '重新交派', onClick: redo }} />);
    fireEvent.click(screen.getByRole('button', { name: '重新交派' }));
    expect(redo).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(167);
    });
    expect(screen.queryByText('已停止')).toBeNull();
  });
});

describe('status readouts', () => {
  it('StatusTag carries text, or an accessible name when icon-only', () => {
    const { container } = render(<StatusTag state="awaiting_approval" label="◆ 等你批准 · 2 张" />);
    expect(container.textContent).toBe('等你批准 · 2 张');
    expect(container.querySelector('[data-shape="diamond"]')).not.toBeNull();
    render(<StatusTag state="interrupted" iconOnly />);
    expect(screen.getByRole('img', { name: '已中断' }).getAttribute('data-shape')).toBe('hollow-square');
  });

  it('CountBadge hides at zero and Fraction reads out unknown values', () => {
    const { container } = render(<CountBadge count={0} label="等你" />);
    expect(container.innerHTML).toBe('');
    render(<Fraction value={null} total={5} label="步骤" />);
    expect(screen.getByRole('img', { name: '步骤 未知 / 5' }).textContent).toBe('—/5');
  });

  it('danger banners are alerts', () => {
    render(<Banner severity="danger" title="后台服务断开" timer="已断开 00:42" />);
    expect(screen.getByRole('alert').textContent).toContain('已断开 00:42');
  });
});
