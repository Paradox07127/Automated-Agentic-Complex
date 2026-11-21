import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Ready } from '../../src/pages/onboarding/Ready';

describe('首次设置 · 完成：读取范围的建议', () => {
  it('suggests 窗口文字 and 读取编码会话 and leaves through 隐私 settings', () => {
    const onOpen = vi.fn();
    const onPrivacy = vi.fn();
    render(<Ready id={null} name="示例甲" title="已在桌面就位" lead="点她互动" perm="3 / 5" callName="" hooks="1 / 2" busy={false} onOpen={onOpen} onPrivacy={onPrivacy} />);
    expect(screen.getByText(/窗口文字/).textContent).toContain('读取编码会话');
    fireEvent.click(screen.getByRole('button', { name: '完成并打开隐私设置' }));
    expect(onPrivacy).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
