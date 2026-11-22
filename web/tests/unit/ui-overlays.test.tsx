import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Banner, ContextMenu, CountBadge, Fraction, Menu, Modal, Select, StatusTag, Toast, type MenuItem } from '../../src/ui';

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

  it('renders the list on body, outside the row, so a later row cannot paint over it', () => {
    const onChange = vi.fn();
    render(
      <div data-testid="row" data-theme="light" style={{ isolation: 'isolate', overflow: 'hidden' }}>
        <Select label="休息提醒" value="m" options={options} onChange={onChange} />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: '休息提醒' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox', { name: '休息提醒' });
    expect(list.parentElement).toBe(document.body);
    expect(screen.getByTestId('row').contains(list)).toBe(false);
    expect(list.getAttribute('data-theme')).toBe('light');
    expect(trigger.getAttribute('aria-controls')).toBe(list.id);
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: '安静' }).id);
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks with the mouse inside the list and closes on a click outside', () => {
    const onChange = vi.fn();
    render(<Select label="主动程度" value="m" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '主动程度' }));
    const quiet = screen.getByRole('option', { name: '安静' });
    fireEvent.mouseDown(quiet);
    fireEvent.click(quiet);
    expect(onChange).toHaveBeenCalledWith('q');
    fireEvent.click(screen.getByRole('button', { name: '主动程度' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens upward inside the window when there is no room below the caption', () => {
    const tall = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(100);
    try {
      render(<Select label="主动程度" value="m" options={options} />);
      const drop = document.querySelector('[data-stub="Select"]') as HTMLElement;
      const vh = window.innerHeight;
      drop.getBoundingClientRect = () => ({ top: vh - 40, bottom: vh - 8, left: 100, right: 340, width: 240, height: 32, x: 100, y: vh - 40, toJSON: () => ({}) });
      fireEvent.click(screen.getByRole('button', { name: '主动程度' }));
      const list = screen.getByRole('listbox');
      expect(list.style.top).toBe('');
      expect(vh - parseFloat(list.style.bottom)).toBeLessThanOrEqual(vh - 40);
      expect(parseFloat(list.style.maxHeight)).toBeLessThanOrEqual(vh - 40 - 8);
      expect(list.style.left).toBe('96px');
      expect(list.style.width).toBe('248px');
      expect(drop.hasAttribute('data-up')).toBe(true);
    } finally {
      tall.mockRestore();
    }
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

  it('renders the popup outside the trigger\'s ancestors so their overflow cannot clip it', () => {
    const { container } = render(
      <div data-testid="clip" style={{ overflow: 'hidden', isolation: 'isolate' }}>
        <Menu label="管理" items={items} />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: /管理/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: '管理' });
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(screen.getByTestId('clip').contains(menu)).toBe(false);
    expect(document.activeElement?.textContent).toBe('重命名');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('carries the trigger\'s theme onto the popup', () => {
    render(
      <nav data-theme="dark">
        <Menu label="管理" items={items} open />
      </nav>,
    );
    expect(screen.getByRole('menu').getAttribute('data-theme')).toBe('dark');
  });

  it('closes on a click outside, but not on a click inside the popup', () => {
    render(<Menu label="管理" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: /管理/ }));
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: /归档/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('caps a long menu below the viewport and scrolls the focused item into view', () => {
    const many: MenuItem[] = Array.from({ length: 24 }, (_, h) => ({ kind: 'item', label: `${String(h).padStart(2, '0')}:00` }));
    render(<Menu label="开始" items={many} />);
    const trigger = screen.getByRole('button', { name: /开始/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    const cap = parseFloat(menu.style.maxHeight);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(320);
    expect(cap).toBeLessThanOrEqual(window.innerHeight - 16);
    // jsdom does no layout: give the popup a 100 px window onto 24 rows of 32 px.
    Object.defineProperty(menu, 'clientHeight', { configurable: true, value: 100 });
    screen.getAllByRole('menuitem').forEach((el, i) => {
      Object.defineProperty(el, 'offsetTop', { configurable: true, value: 4 + i * 32 });
      Object.defineProperty(el, 'offsetHeight', { configurable: true, value: 32 });
    });
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('23:00');
    expect(menu.scrollTop).toBe(4 + 24 * 32 - 100);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(menu.scrollTop).toBe(4);
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

describe('ContextMenu', () => {
  const items = (run = vi.fn()): MenuItem[] => [
    { kind: 'item', label: '置顶', onSelect: run },
    { kind: 'sep' },
    { kind: 'item', label: '删除…', danger: true },
  ];

  it('opens at the pointer with no trigger button and focuses the first item', () => {
    render(<ContextMenu label="管理「周报」" items={items()} at={{ x: 120, y: 80 }} onClose={() => {}} />);
    const menu = screen.getByRole('menu', { name: '管理「周报」' });
    expect(screen.queryByRole('button', { name: /管理/ })).toBeNull();
    expect(parseFloat(menu.style.left)).toBe(120);
    expect(parseFloat(menu.style.top)).toBe(80);
    expect(document.activeElement?.textContent).toBe('置顶');
  });

  it('asks to close on a press outside, Esc, a resize, a scroll and the window losing focus, not on a press inside', () => {
    const onClose = vi.fn();
    render(<ContextMenu label="管理" items={items()} at={{ x: 10, y: 10 }} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: '置顶' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent(window, new Event('resize'));
    fireEvent.scroll(document.body);
    fireEvent(window, new Event('blur'));
    expect(onClose).toHaveBeenCalledTimes(5);
  });

  it('runs the chosen item and closes', () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu label="管理" items={items(run)} at={{ x: 10, y: 10 }} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives focus back to the element that opened it on Esc, Tab and a press outside', () => {
    const Host = () => {
      const [at, setAt] = useState<{ x: number; y: number } | null>(null);
      return (
        <>
          <button type="button" onClick={() => setAt({ x: 10, y: 10 })}>行</button>
          <ContextMenu label="管理" items={items()} at={at} onClose={() => setAt(null)} />
        </>
      );
    };
    render(<Host />);
    const row = screen.getByRole('button', { name: '行' });
    for (const close of [() => fireEvent.keyDown(document.activeElement!, { key: 'Escape' }), () => fireEvent.keyDown(document.activeElement!, { key: 'Tab' }), () => fireEvent.pointerDown(document.body)]) {
      row.focus();
      fireEvent.click(row);
      expect(screen.getByRole('menu')).toBeTruthy();
      close();
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(row);
    }
  });

  it('scrolls the focused item into view while the arrow keys move', () => {
    render(<ContextMenu label="管理" items={items()} at={{ x: 10, y: 10 }} onClose={() => {}} />);
    const menu = screen.getByRole('menu');
    Object.defineProperty(menu, 'clientHeight', { value: 100 });
    const last = screen.getByRole('menuitem', { name: '删除…' });
    Object.defineProperty(last, 'offsetTop', { value: 200 });
    Object.defineProperty(last, 'offsetHeight', { value: 30 });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
    expect(menu.scrollTop).toBe(130);
  });

  it('renders nothing while closed', () => {
    render(<ContextMenu label="管理" items={items()} at={null} onClose={() => {}} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
