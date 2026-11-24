// 提示队列：新的撤销提示替换旧的，不会堆成两个「撤销」。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast, ToastHost } from '../../src/shell/toast';
import { Toast } from '../../src/ui/Toast';

afterEach(cleanup);

describe('toast queue', () => {
  it('a new 撤销 toast replaces the older one; other toasts stay', () => {
    render(<ToastHost />);
    act(() => {
      toast('已重新读取');
      toast('已更改「静音」', { action: { label: '撤销', onClick: () => {} } });
      toast('已更改「录屏时隐藏角色」', { action: { label: '撤销', onClick: () => {} } });
    });
    expect(screen.getAllByRole('button', { name: '撤销' })).toHaveLength(1);
    expect(screen.queryByText('已更改「静音」')).toBeNull();
    expect(screen.getByText('已更改「录屏时隐藏角色」')).toBeTruthy();
    expect(screen.getByText('已重新读取')).toBeTruthy();
  });

  it('an action runs once, however often it is pressed while the toast leaves', () => {
    const onClick = vi.fn();
    render(<Toast message="已暂停" action={{ label: '继续', onClick }} />);
    const button = screen.getByRole('button', { name: '继续' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').hasAttribute('inert')).toBe(true);
  });
});
