import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from '../../src/ui';

describe('Toast hover pause', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pauses while hovered and times out after the pointer leaves', () => {
    const onClose = vi.fn();
    render(<Toast message="已更改「窗口文字」" onClose={onClose} />);
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(10_000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(4_000));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still times out when the window loses focus while the toast is hovered', () => {
    const onClose = vi.fn();
    render(<Toast message="已更改「窗口文字」" onClose={onClose} />);
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    act(() => vi.advanceTimersByTime(4_000));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still times out when the pointer leaves the window from the toast', () => {
    const onClose = vi.fn();
    render(<Toast message="已更改「窗口文字」" onClose={onClose} />);
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => {
      document.documentElement.dispatchEvent(new MouseEvent('mouseleave'));
    });
    act(() => vi.advanceTimersByTime(4_000));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Toast danger hold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('times out a danger toast without an action', () => {
    const onClose = vi.fn();
    render(<Toast message="角色暂时无法切换动作，稍后再播" severity="danger" onClose={onClose} />);
    act(() => vi.advanceTimersByTime(4_000));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a danger toast with an action, and a persistent one', () => {
    const onClose = vi.fn();
    render(
      <>
        <Toast message="重新派发失败" severity="danger" action={{ label: '看出错' }} onClose={onClose} />
        <Toast message="没有保存" severity="warning" persistent onClose={onClose} />
      </>,
    );
    act(() => vi.advanceTimersByTime(10_000));
    expect(onClose).not.toHaveBeenCalled();
  });
});
